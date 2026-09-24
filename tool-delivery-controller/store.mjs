import { needsWebReview } from './web-visual.mjs';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { digest, hash } from './files.mjs';
import { assertDesignReceipt } from './product-design.mjs';

const TERMINAL = new Set(['passed', 'failed', 'cancelled', 'invalidated']);
const transitions = {
  design: ['designing', 'blocked', 'failed', 'cancelled'],
  designing: ['collecting', 'implement', 'blocked', 'failed', 'cancelled'],
  collecting: ['implement', 'blocked', 'cancelled'],
  queued: ['implement', 'blocked', 'cancelled'],
  implement: ['implementing', 'blocked', 'cancelled'],
  implementing: ['verify', 'failed', 'blocked', 'cancelled'],
  verify: ['verify', 'verifying', 'syncing', 'blocked', 'cancelled'],
  verifying: ['passed', 'syncing', 'verify', 'repair', 'failed', 'blocked', 'cancelled'],
  syncing: ['syncing', 'passed', 'verify', 'blocked', 'cancelled'],
  repair: ['repairing', 'blocked', 'cancelled'],
  repairing: ['verify', 'failed', 'blocked', 'cancelled'],
  blocked: ['design', 'collecting', 'queued', 'implement', 'repair', 'verify', 'syncing', 'failed', 'cancelled'],
  passed: ['invalidated'],
  failed: [], cancelled: [], invalidated: [],
};
export class Store {
  constructor(root) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.root = resolve(root);
    this.db = new DatabaseSync(resolve(root, 'delivery.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, owner TEXT NOT NULL, workspace TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, run TEXT NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS decisions(id TEXT PRIMARY KEY, run TEXT NOT NULL, owner TEXT NOT NULL, version INTEGER NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS snapshots(hash TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS upstream_backoff(route TEXT PRIMARY KEY, until_ms INTEGER NOT NULL, reason TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS locks(workspace TEXT PRIMARY KEY, pid INTEGER NOT NULL, host TEXT NOT NULL, token TEXT NOT NULL);`);
  }
  upstreamBackoff(route) {
    const row = this.db.prepare('SELECT until_ms,reason FROM upstream_backoff WHERE route=?').get(route);
    return row && row.until_ms > Date.now() ? { retryNotBefore: row.until_ms, reason: row.reason } : null;
  }
  deferUpstream(route, until, reason) {
    this.db.prepare('INSERT INTO upstream_backoff VALUES(?,?,?) ON CONFLICT(route) DO UPDATE SET until_ms=MAX(until_ms,excluded.until_ms),reason=excluded.reason').run(route, until, reason);
  }
  close() { this.db.close(); }
  recoverInterrupted() {
    const resume = { designing: 'design', implementing: 'implement', repairing: 'repair', verifying: 'verify' };
    const interrupted = this.db.prepare("SELECT data FROM runs WHERE json_extract(data,'$.state') IN ('designing','implementing','repairing','verifying')").all();
    const recovered = [];
    for (const row of interrupted) {
      const run = JSON.parse(row.data);
      const lockKey = run.mode === 'partial' ? run.id : run.workspace;
      const lock = this.db.prepare('SELECT * FROM locks WHERE workspace=?').get(lockKey);
      if (lock) {
        let live = lock.host !== hostname();
        if (lock.host === hostname()) {
          try { process.kill(lock.pid, 0); live = true; }
          catch (error) { live = error.code !== 'ESRCH'; }
        }
        if (live) continue;
        this.db.prepare('DELETE FROM locks WHERE workspace=?').run(lockKey);
      }
      this.move(run, 'blocked', { resumeState: resume[run.state], reason: 'Controller restarted during active execution; delivery can be resumed safely.' }, 'interrupted.recovered');
      recovered.push(run.id);
    }
    return recovered;
  }
  assertStartAllowed(owner, workspace, mode = 'project', now = Date.now()) {
    if (mode !== 'project') return;
    const previous = this.db.prepare('SELECT data FROM runs WHERE workspace=?').all(resolve(workspace)).map(r => JSON.parse(r.data));
    for (const run of previous) {
      const expiredPreDispatch = run.mode === 'project' && !run.parentId && run.state === 'blocked' && run.resumeState === 'implement'
        && Number.isFinite(run.retryNotBefore) && run.retryNotBefore <= now && run.snapshot === run.baseSnapshot
        && (run.syncAttempts ?? 0) === 0 && (run.verifyCalls ?? 0) === 0 && (run.repairCount ?? 0) === 0
        && !(run.conflicts?.length) && !(run.tasks?.length) && !(run.sourceDeliveries?.length);
      if (!expiredPreDispatch) continue;
      const reason = `Expired pre-dispatch reservation retired before replacement; previous reason: ${run.reason ?? 'unknown'}`;
      const next = { ...run, state: 'failed', reason, version: run.version + 1 };
      const changed = this.db.prepare('UPDATE runs SET data=? WHERE id=? AND data=?').run(JSON.stringify(next), run.id, JSON.stringify(run)).changes;
      if (changed) {
        this.event(run.id, 'reservation.expired', { from: run.state, to: 'failed', version: next.version, reason });
        Object.assign(run, next);
      }
    }
    const blocker = previous.find(run => run.mode !== 'partial' && !TERMINAL.has(run.state)
      && !(run.owner === owner && !run.parentId && run.state === 'blocked' && run.reason === 'Worker did not complete: max-tokens'));
    if (blocker) throw new Error(`Workspace has unfinished delivery ${blocker.id} (${blocker.state}${blocker.owner === owner ? '' : ', owned by another session'}); resume or cancel it from its owning session first`);
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  event(id, kind, data = {}) {
    this.db.prepare('INSERT INTO events(run,at,kind,data) VALUES(?,?,?,?)').run(id, new Date().toISOString(), kind, JSON.stringify(data));
  }
  create({ owner, workspace, objective, contract, taskIR = null, files, designGate = null, qualityGate = null, reviewPolicy = 'required', reviewRoute = null, reportRefs = [], mode = 'partial', assurance = 'verified', sourceDeliveries = [], initialFiles = files, tasks = [] }) {
    return this.transaction(() => {
      this.assertStartAllowed(owner, workspace, mode);
      if (!['verified', 'unverified'].includes(assurance)) throw new Error('Invalid assurance');
      const run = { id: randomUUID(), owner, workspace, objective, contract, taskIR, designGate, designAttempts: 0, productDesign: null, qualityGate, reviewPolicy, reviewRoute, reportRefs, mode, assurance, sourceDeliveries, tasks: tasks.map(t => ({ ...t, runId: randomUUID() })), syncAttempts: 0, state: designGate ? 'design' : tasks.length || sourceDeliveries.length ? 'collecting' : 'implement', repairCount: 0,
        workerCalls: 0, verifyCalls: 0, snapshot: this.snapshot(initialFiles), baseSnapshot: this.snapshot(files), evidence: [], version: 0,
        contractHash: hash(JSON.stringify(contract)) };
      run.taskManifestHash = hash(JSON.stringify(run.tasks));
      for (const task of run.tasks) {
        const childContract = { ...contract, editablePaths: task.editablePaths, checks: task.checkIds ? contract.checks.filter(c => task.checkIds.includes(c.id)) : contract.checks };
        childContract.checkIds = childContract.checks.map(c => c.id);
        const child = { ...run, id: task.runId, parentId: run.id, taskKey: task.id, taskContext: task,
          tasks: [], taskManifestHash: hash('[]'), sourceDeliveries: [], reportRefs: [], mode: 'partial', state: 'queued',
          objective: task.objective, taskIR: taskIR ? { ...taskIR, goal: task.objective, editablePaths: task.editablePaths,
            availableChecks: childContract.checks, validation: taskIR.validation.filter(v => v.taskId === task.id) } : null, contract: childContract, contractHash: hash(JSON.stringify(childContract)) };
        this.db.prepare('INSERT INTO runs VALUES(?,?,?,?)').run(child.id, owner, workspace, JSON.stringify(child));
        this.event(child.id, 'task.registered', { parentId: run.id, task });
      }
      this.db.prepare('INSERT INTO runs VALUES(?,?,?,?)').run(run.id, owner, workspace, JSON.stringify(run));
      this.event(run.id, 'created', run);
      if (taskIR) this.event(run.id, 'contract.compiled', { taskIR, contractHash: run.contractHash, checkIds: contract.checkIds });
      return run;
    });
  }
  assertTasks(run, sources = run.sourceDeliveries) {
    if (run.taskManifestHash && hash(JSON.stringify(run.tasks)) !== run.taskManifestHash) throw new Error('Task manifest changed');
    for (const task of run.tasks ?? []) {
      const child = this.get(task.runId, run.owner);
      if (child.parentId !== run.id || child.taskKey !== task.id || child.workspace !== run.workspace
        || child.state !== 'passed' || !sources.some(s => s.id === child.id && s.snapshot === child.snapshot))
        throw new Error('Required task missing, unfinished or not integrated: ' + task.id);
    }
  }
  openDecision(id, run, files, questions) {
    const current = this.get(run.id, run.owner);
    if (current.version !== run.version || current.state !== 'blocked' || !current.conflicts?.length) throw new Error('Decision no longer applies');
    const data = { current: digest(files.current), proposed: digest(files.proposed), questions };
    this.db.prepare('INSERT INTO decisions VALUES(?,?,?,?,?,?)').run(id, run.id, run.owner, run.version, 'pending', JSON.stringify(data));
    this.event(run.id, 'decision.requested', { id, version: run.version, ...data });
  }
  answerDecision(id, resolutions) {
    const row = this.db.prepare('SELECT * FROM decisions WHERE id=?').get(id);
    if (!row || row.state !== 'pending') throw new Error('Decision not pending');
    this.db.prepare('UPDATE decisions SET state=?,data=? WHERE id=?').run('answered', JSON.stringify({ ...JSON.parse(row.data), resolutions }), id);
    this.event(row.run, 'decision.answered', { id, resolutions, source: 'host.userQuestions' });
  }
  rejectDecision(id, reason) {
    const row = this.db.prepare('SELECT * FROM decisions WHERE id=?').get(id);
    if (row && row.state !== 'consumed') {
      this.db.prepare('UPDATE decisions SET state=? WHERE id=?').run('rejected', id);
      this.event(row.run, 'decision.rejected', { id, reason });
    }
  }
  rejectRunDecisions(run, reason) {
    const rows = this.db.prepare("SELECT id FROM decisions WHERE run=? AND state IN ('pending','answered')").all(run.id);
    for (const row of rows) this.rejectDecision(row.id, reason);
    return rows.map(row => row.id);
  }
  snapshot(files) {
    const id = digest(files);
    this.db.prepare('INSERT OR IGNORE INTO snapshots VALUES(?,?)').run(id, JSON.stringify(files));
    return id;
  }
  files(id) {
    const row = this.db.prepare('SELECT data FROM snapshots WHERE hash=?').get(id);
    if (!row) throw new Error('Snapshot missing');
    const files = JSON.parse(row.data);
    if (digest(files) !== id) throw new Error('Snapshot integrity failure');
    return files;
  }
  get(id, owner) {
    const row = this.db.prepare('SELECT data FROM runs WHERE id=?').get(id);
    if (!row || (owner !== undefined && JSON.parse(row.data).owner !== owner)) throw new Error('Delivery not found in this session');
    return JSON.parse(row.data);
  }
  list(owner) { return this.db.prepare('SELECT data FROM runs WHERE owner=? ORDER BY rowid DESC').all(owner).map(r => JSON.parse(r.data)); }
  workspaceRuns(workspace) {
    return this.db.prepare('SELECT data FROM runs WHERE workspace=? ORDER BY rowid DESC').all(resolve(workspace)).map(row => JSON.parse(row.data));
  }
  history(id) { return this.db.prepare('SELECT seq,at,kind,data FROM events WHERE run=? ORDER BY seq').all(id).map(e => ({ ...e, data: JSON.parse(e.data) })); }
  move(run, state, patch = {}, kind = state) {
    return this.transaction(() => {
      const current = this.get(run.id);
      if (current.version !== run.version) throw new Error('Concurrent delivery update');
      if (!transitions[current.state]?.includes(state)) throw new Error(`Invalid transition ${current.state} -> ${state}`);
      const finishingDesign = current.state === 'designing' && ['collecting', 'implement'].includes(state);
      if (Object.hasOwn(patch, 'productDesign') && !finishingDesign) throw new Error('Product design is immutable outside design completion');
      if (finishingDesign) {
        assertDesignReceipt(current, patch.productDesign);
        const expectedGate = current.assurance !== 'unverified' && current.reviewPolicy === 'risk_based' && patch.productDesign.plan.riskLevel === 'high'
          ? current.reviewRoute : current.qualityGate;
        if (JSON.stringify(patch.qualityGate ?? null) !== JSON.stringify(expectedGate ?? null)) throw new Error('Invalid design review gate');
        if (current.reviewPolicy === 'risk_based' && patch.productDesign.plan.riskLevel === 'high' && current.assurance !== 'unverified' && !expectedGate)
          throw new Error('High-risk design requires an independent reviewer');
      }
      for (const key of ['owner', 'workspace', 'objective', 'baseSnapshot', 'designGate', 'parentId', 'taskKey', 'taskContext', 'tasks', 'taskManifestHash', 'mode', 'assurance', ...(!finishingDesign ? ['qualityGate'] : []), 'reviewPolicy', 'reviewRoute', 'contract', 'contractHash', 'taskIR']) {
        if (Object.hasOwn(patch, key) && JSON.stringify(patch[key]) !== JSON.stringify(current[key])) throw new Error('Immutable task identity/contract: ' + key);
      }
      if (['implement', 'verifying', 'syncing', 'passed'].includes(state) && current.tasks?.length)
        this.assertTasks(current, patch.sourceDeliveries ?? current.sourceDeliveries);
      if (['collecting', 'implement', 'implementing', 'repairing', 'verifying', 'syncing', 'passed'].includes(state) && current.designGate) {
        const ownerRun = current.parentId ? this.get(current.parentId, current.owner) : current;
        assertDesignReceipt(ownerRun, finishingDesign ? patch.productDesign : ownerRun.productDesign);
      }
      if (current.conflicts?.length && state !== 'cancelled' && state !== 'blocked') {
        const receipt = this.db.prepare('SELECT * FROM decisions WHERE id=?').get(patch.decisionId ?? '');
        if (!receipt || receipt.run !== current.id || receipt.owner !== current.owner || receipt.version !== current.version || receipt.state !== 'answered')
          throw new Error('Trusted user decision required');
        this.db.prepare('UPDATE decisions SET state=? WHERE id=?').run('consumed', receipt.id);
      }
      if (state === 'syncing' && current.assurance === 'unverified'
        && !((current.state === 'verify' && patch.evidence?.length === 0 && patch.quality === null
          && typeof patch.artifact === 'string' && Array.isArray(patch.syncPlan))
          || (current.state === 'blocked' && current.resumeState === 'syncing' && patch.evidence?.length === 0 && patch.quality === null)))
        throw new Error('Invalid unverified synchronization transition');
      const webRequired = current.assurance !== 'unverified' && ['passed', 'syncing'].includes(state) && needsWebReview(this.files(current.snapshot));
      const expectedChecks = [...current.contract.checks, ...(webRequired ? [{ id: 'web-visual' }] : [])];
      if (webRequired && !patch.evidence?.find(e => e.id === 'web-visual')?.screenshots?.length) throw new Error('Missing browser screenshot evidence');
      if (current.assurance !== 'unverified' && ['passed', 'syncing'].includes(state) && ((!['verifying', 'syncing'].includes(current.state) && !(state === 'syncing' && current.state === 'blocked' && current.resumeState === 'syncing')) || !Array.isArray(patch.evidence)
        || patch.evidence.length !== expectedChecks.length
        || patch.evidence.some((e, i) => e.id !== expectedChecks[i].id || e.exitCode !== 0
          || e.kind !== 'passed' || e.snapshot !== current.snapshot))) throw new Error('Missing current verification evidence');
      if (['passed', 'syncing'].includes(state) && current.qualityGate && (patch.quality?.status !== 'passed'
        || patch.quality.snapshot !== current.snapshot || patch.quality.model !== current.qualityGate.model
        || patch.quality.provider !== current.qualityGate.provider
        || !patch.quality.evidence?.some(item => typeof item === 'string' && item.trim())))
        throw new Error('Missing current independent quality evidence');
      if (state === 'passed' && current.mode === 'project' && (current.state !== 'syncing'
        || patch.syncReceipt?.snapshot !== current.snapshot
        || (current.assurance === 'unverified' ? patch.syncReceipt?.verified !== false || patch.syncReceipt?.assurance !== 'unverified' : patch.syncReceipt?.verified !== true)))
        throw new Error('Missing matching project synchronization receipt');
      if (state === 'repair' && current.state === 'verifying'
        && (patch.repairCount !== current.repairCount + 1 || patch.repairCount > current.contract.maxRepairs)) throw new Error('Repair budget exceeded');
      const next = { ...current, ...patch, state, version: current.version + 1 };
      this.db.prepare('UPDATE runs SET data=? WHERE id=?').run(JSON.stringify(next), run.id);
      this.event(run.id, kind, { from: current.state, to: state, version: next.version, ...patch });
      Object.assign(run, next);
      return run;
    });
  }
  lock(workspace) {
    const token = randomUUID();
    this.transaction(() => {
      const lock = this.db.prepare('SELECT * FROM locks WHERE workspace=?').get(workspace);
      if (lock) {
        if (lock.host !== hostname()) throw new Error('Another host owns this workspace; manual recovery required');
        let live = true;
        try { process.kill(lock.pid, 0); } catch (e) { if (e.code === 'ESRCH') live = false; }
        if (live) throw new Error('Delivery is already running for this workspace');
        this.db.prepare('DELETE FROM locks WHERE workspace=?').run(workspace);
      }
      this.db.prepare('INSERT INTO locks VALUES(?,?,?,?)').run(workspace, process.pid, hostname(), token);
    });
    return () => this.db.prepare('DELETE FROM locks WHERE workspace=? AND token=?').run(workspace, token);
  }
}

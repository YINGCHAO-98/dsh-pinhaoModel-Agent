import { compactQuality } from './request-policy.mjs';
import { realpath, mkdir, rename, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { capture, validateContract, assertRequired, applyProposal, materialize, digest, isWithin } from './files.mjs';
import { mergeSnapshots, syncPlan, applySync } from './sync.mjs';
import { validateTasks } from './task-contracts.mjs';
import { obtainDecision } from './decisions.mjs';
const CHILD_DISPATCH = Symbol('controller-owned-child');

export class DeliveryController {
  constructor({ store, worker, runner, reviewer, deliveryInputs, askUser, ownerAlive = () => true, qualityGate = null, upstreamRoute = 'worker', workerTimeoutMs = 600000 }) {
    this.store = store;
    this.upstreamRoute = upstreamRoute;
    this.askUser = askUser;
    this.worker = worker;
    this.reviewer = reviewer;
    this.qualityGate = qualityGate;
    this.runner = runner;
    this.workerTimeoutMs = workerTimeoutMs;
    this.deliveryInputs = deliveryInputs;
    this.ownerAlive = ownerAlive;
  }
  retireOrphanedOwners(owner, workspace, mode = 'project') {
    if (mode !== 'project') return;
    for (const previous of this.store.workspaceRuns(workspace)) {
      if (previous.parentId || previous.owner === owner || ['passed', 'failed', 'cancelled', 'invalidated'].includes(previous.state)) continue;
      if (this.ownerAlive(previous.owner)) continue;
      this.cancelTree(previous, `Owning session ${previous.owner} no longer exists; reservation retired before replacement`);
    }
  }
  prepareStart(owner, workspace, mode = 'project') {
    const unlock = this.store.lock(workspace);
    try {
      this.retireOrphanedOwners(owner, workspace, mode);
      this.store.assertStartAllowed(owner, workspace, mode);
    } finally { unlock(); }
  }
  assertWorkerAvailable(now = Date.now()) {
    const blocked = this.store.upstreamBackoff(this.upstreamRoute);
    if (!blocked) return;
    const error = new Error(`WORKER_COOLDOWN: implementation route is unavailable until ${new Date(blocked.retryNotBefore).toISOString()}; ${blocked.reason}`);
    error.code = 'WORKER_COOLDOWN';
    error.retryNotBefore = blocked.retryNotBefore;
    throw error;
  }
  assertResumeReady(run, now = Date.now()) {
    if (run.state === 'blocked' && Number.isFinite(run.retryNotBefore) && run.retryNotBefore > now) {
      const error = new Error(`DELIVERY_RETRY_NOT_READY: retry after ${new Date(run.retryNotBefore).toISOString()}; ${run.reason ?? 'delivery is cooling down'}`);
      error.code = 'DELIVERY_RETRY_NOT_READY';
      error.retryNotBefore = run.retryNotBefore;
      throw error;
    }
  }
  async create({ owner, workspace, objective, contract, reportRefs = [], mode = 'project', sourceDeliveryIds = [], tasks = [], assurance = 'verified', ...extra }) {
    if (Object.keys(extra).length) throw new Error('Unsupported delivery arguments; model-supplied conflict decisions are forbidden');
    if (typeof objective !== 'string' || !objective.trim() || objective.length > 16000) throw new Error('Invalid objective');
    if (!['partial', 'project'].includes(mode)) throw new Error('mode must be partial or project');
    if (!['verified', 'unverified'].includes(assurance)) throw new Error('assurance must be verified or unverified');
    if (assurance === 'unverified' && (mode !== 'project' || tasks.length || sourceDeliveryIds.length || contract.requiredOutputs?.length !== 1))
      throw new Error('Unverified delivery is limited to one standalone project output without tasks or imports');
    if (!Array.isArray(sourceDeliveryIds) || sourceDeliveryIds.length > 20 || new Set(sourceDeliveryIds).size !== sourceDeliveryIds.length) throw new Error('Invalid sourceDeliveryIds');
    workspace = await realpath(workspace);
    const stateRoot = await realpath(this.store.root);
    if (isWithin(stateRoot, workspace) || isWithin(workspace, stateRoot)) throw new Error('State directory must be outside the delivery workspace');
    contract = validateContract(contract);
    tasks = validateTasks(tasks, contract);
    if (tasks.length && mode !== 'project') throw new Error('Task groups require project mode');
    const unlock = this.store.lock(workspace);
    try {
      // A deleted/unloaded owning session cannot ever resume its persisted
      // reservation. Reclaim it under the same workspace lock before checking
      // for genuine live-session conflicts.
      this.retireOrphanedOwners(owner, workspace, mode);
      // Retire only the known legacy deterministic failure, under the workspace
      // lock and for this owner. Real environmental/conflict blocks stay intact.
      for (const previous of this.store.list(owner)) {
        if (previous.workspace === workspace && !previous.parentId && previous.state === 'blocked'
          && previous.reason === 'Worker did not complete: max-tokens')
          this.store.move(previous, 'failed', { reason: 'Worker output token budget exhausted; legacy attempt retired before replacement.' }, 'worker.output_limit');
      }
      const files = await capture(workspace);
      assertRequired(files, contract, { beforeImplementation: true });
      let initialFiles = files;
      const sourceDeliveries = [];
      for (const id of sourceDeliveryIds) {
        const source = this.store.get(id, owner);
        if (source.state !== 'passed' || source.mode !== 'partial' || source.workspace !== workspace || source.parentId) throw new Error('Source must be an accepted partial delivery in this workspace/session');
        if (digest(await capture(source.artifact, undefined, { includeExcluded: true })) !== source.snapshot) throw new Error('Source artifact changed');
        const output = this.store.files(source.snapshot);
        // Revalidate each imported change against the receiving contract.
        const changes = syncPlan(this.store.files(source.baseSnapshot), output).map(c => c.after === null
          ? { path: c.path, operation: 'delete' } : { path: c.path, operation: 'write', content: Buffer.from(c.after, 'base64').toString('utf8') });
        applyProposal(this.store.files(source.baseSnapshot), { summary: source.workerSummary ?? '', changes }, contract);

        sourceDeliveries.push({ id, snapshot: source.snapshot, objective: source.objective, summary: source.workerSummary, evidence: source.evidence });
      }
      assertRequired(initialFiles, contract, { beforeImplementation: true });
      return this.store.create({ owner, workspace, objective, contract, files, initialFiles, mode, sourceDeliveries, tasks, reportRefs,
        assurance, qualityGate: assurance === 'verified' ? this.qualityGate : null });
    } finally { unlock(); }
  }
  async resolveConflicts(id, owner, { parent, signal = new AbortController().signal, ...extra } = {}) {
    if (Object.keys(extra).length) throw new Error('Model-supplied conflict decisions are forbidden');
    const run = this.store.get(id, owner);
    if (run.state !== 'blocked' || !run.conflicts?.length || !['verify', 'collecting'].includes(run.resumeState)) throw new Error('No resolvable integration conflict');
    const collecting = run.resumeState === 'collecting';
    const current = collecting ? this.store.files(run.conflictInput.current) : await capture(run.workspace);
    const proposed = this.store.files(collecting ? run.conflictInput.proposed : run.snapshot);
    const decision = await obtainDecision({ store: this.store, askUser: this.askUser, run, current, proposed, conflicts: run.conflicts, parent, signal });
    const unlock = this.store.lock(run.workspace);
    try {
      const latest = this.store.get(id, owner);
      if (latest.version !== run.version) throw new Error('Delivery changed while awaiting user decision');
      if (!collecting && digest(await capture(run.workspace)) !== digest(current)) throw new Error('Project changed while awaiting user decision');
      const base = this.store.files(collecting ? run.conflictInput.base : run.syncBase ?? run.baseSnapshot);
      const merged = mergeSnapshots(base, proposed, current, decision.resolutions);
      assertRequired(merged, run.contract);
      if (collecting) {
        return this.store.move(run, 'collecting', { integrationDecisions: { ...run.integrationDecisions, [run.conflictInput.sourceId]: decision.resolutions },
          decisionId: decision.id, conflicts: null, conflictInput: null, reason: null }, 'conflicts.resolved');
      }
      return this.store.move(run, 'verify', { snapshot: this.store.snapshot(merged), syncBase: this.store.snapshot(current),
        decisionId: decision.id, conflicts: null, quality: null, evidence: [], reason: null }, 'conflicts.resolved');
    } catch (error) { this.store.rejectDecision(decision.id, error.message); throw error; }
    finally { unlock(); }
  }
  async checkedSource(id, owner, workspace) {
    const source = this.store.get(id, owner);
    if (source.state !== 'passed' || source.mode !== 'partial' || source.workspace !== workspace) throw new Error('Required source not accepted');
    if (digest(await capture(source.artifact, undefined, { includeExcluded: true })) !== source.snapshot) throw new Error('Required source artifact changed');
    return source;
  }
  async assertSources(run) {
    this.store.assertTasks(run);
    for (const saved of run.sourceDeliveries ?? []) {
      const source = await this.checkedSource(saved.id, run.owner, run.workspace);
      if (source.snapshot !== saved.snapshot) throw new Error('Required source version changed');
    }
  }
  async collect(run, owner, options) {
    const pending = new Set((run.tasks ?? []).map(t => t.id));
    while (pending.size) {
      options.signal.throwIfAborted();
      // Registered delivery tasks are deliberately dispatched one at a time.
      // Besides making the task list truthful, this prevents several model
      // calls from competing for the same provider/runtime budget and makes a
      // blocked task identify the exact point at which the workflow stopped.
      const ready = run.tasks.filter(t => pending.has(t.id) && t.dependsOn.every(id => !pending.has(id))).slice(0, 1);
      if (!ready.length) throw new Error('Task dependencies cannot progress');
      const results = await Promise.allSettled(ready.map(async task => {
        let child = this.store.get(task.runId, owner);
        if (child.state === 'queued') {
          let files = this.store.files(child.baseSnapshot);
          const sources = [];
          for (const dependency of task.dependsOn) {
            const source = await this.checkedSource(run.tasks.find(t => t.id === dependency).runId, owner, run.workspace);
            const decisionKey = child.id + ':' + source.id;
            try { files = mergeSnapshots(this.store.files(source.baseSnapshot), this.store.files(source.snapshot), files, run.integrationDecisions?.[decisionKey] ?? []); }
            catch (error) {
              if (error.conflicts) error.conflictInput = { sourceId: decisionKey, base: source.baseSnapshot, proposed: source.snapshot, current: this.store.snapshot(files) };
              throw error;
            }
            sources.push({ id: source.id, snapshot: source.snapshot, objective: source.objective, summary: source.workerSummary, evidence: source.evidence });
          }
          this.store.move(child, 'implement', { snapshot: this.store.snapshot(files), sourceDeliveries: sources }, 'task.inputs_bound');
        }
        child = await this.drive(child.id, owner, { ...options, delegation: CHILD_DISPATCH });
        if (child.state !== 'passed') throw new Error(`Required task ${task.id} is ${child.state}: ${child.reason ?? ''}`);
        pending.delete(task.id);
      }));
      const failed = results.find(r => r.status === 'rejected');
      if (failed) throw failed.reason;
    }
    const ids = [...new Set([...(run.sourceDeliveries ?? []).map(s => s.id), ...(run.tasks ?? []).map(t => t.runId)])];
    let files = this.store.files(run.baseSnapshot);
    const sources = [];
    for (const id of ids) {
      const source = await this.checkedSource(id, owner, run.workspace);
      const base = this.store.files(source.baseSnapshot), output = this.store.files(source.snapshot);
      try { files = mergeSnapshots(base, output, files, run.integrationDecisions?.[id] ?? []); }
      catch (error) {
        if (error.conflicts) error.conflictInput = { sourceId: id, base: source.baseSnapshot, proposed: source.snapshot, current: this.store.snapshot(files) };
        throw error;
      }
      sources.push({ id, snapshot: source.snapshot, objective: source.objective, summary: source.workerSummary, evidence: source.evidence });
    }
    assertRequired(files, run.contract);
    this.store.move(run, 'implement', { snapshot: this.store.snapshot(files), sourceDeliveries: sources }, 'tasks.integrated');
  }
  async status(id, owner) {
    const run = this.store.get(id, owner);
    if (run.state === 'passed') {
      const unlock = this.store.lock(run.mode === 'partial' ? run.id : run.workspace);
      try {
        let valid = false;
        try { valid = digest(await capture(run.artifact, undefined, { includeExcluded: true })) === run.snapshot; } catch {}
        if (!valid) this.store.move(run, 'invalidated', { reason: 'Verified artifact changed or is missing' });
      } finally { unlock(); }
    }
    if (run.mode === 'project' && run.state === 'passed') {
      try { run.projectMatchesReceipt = digest(await capture(run.workspace)) === run.syncReceipt?.snapshot; } catch { run.projectMatchesReceipt = false; }
    }
    return run;
  }
  cancelTree(run, reason) {
    this.store.rejectRunDecisions(run, reason);
    for (const task of run.tasks ?? []) {
      const child = this.store.get(task.runId, run.owner);
      if (!['passed', 'failed', 'cancelled', 'invalidated'].includes(child.state))
        this.store.move(child, 'cancelled', { reason: `Owning delivery cancelled: ${reason}` }, 'parent.cancelled');
    }
    const latest = this.store.get(run.id, run.owner);
    if (['passed', 'failed', 'cancelled', 'invalidated'].includes(latest.state)) return latest;
    return this.store.move(latest, 'cancelled', { reason });
  }
  async drive(id, owner, { signal = new AbortController().signal, parent, delegation } = {}) {
    const run = this.store.get(id, owner);
    if (run.parentId && delegation !== CHILD_DISPATCH) throw new Error('Only the owning controller may dispatch a registered child');
    if (run.conflicts?.length && run.state === 'blocked') return run;
    const unlock = this.store.lock(run.mode === 'partial' ? run.id : run.workspace);
    let stage = run.state;
    try {
      if (['passed', 'failed', 'cancelled', 'invalidated'].includes(run.state)) return run;
      // Older versions persisted a deterministic output-limit failure as resumable.
      // Do not repeat the same model generation with unchanged inputs and limits.
      if (run.state === 'blocked' && run.reason === 'Worker did not complete: max-tokens') {
        return this.store.move(run, 'failed', { reason: 'Worker output token budget exhausted; unchanged resume will not retry. Reduce scope or adjust model output budget before a new delivery.' }, 'worker.output_limit');
      }
      if (run.state === 'blocked' && run.retryNotBefore > Date.now()) return run;
      if (run.state === 'blocked') this.store.move(run, run.resumeState, { reason: null, ...(run.resumeState === 'syncing' ? { evidence: run.evidence, quality: run.quality } : {}) }, 'resumed');
      if (['implementing', 'repairing', 'verifying'].includes(run.state)) {
        const resumeState = { implementing: 'implement', repairing: 'repair', verifying: 'verify' }[run.state];
        this.store.move(run, 'blocked', { resumeState, reason: 'Interrupted execution recovered' }, 'interrupted');
        this.store.move(run, resumeState, { reason: null }, 'resumed');
      }
      stage = run.state;
      signal.throwIfAborted();
      await this.runner.preflight(signal); // No unsandboxed fallback, and no model spend before environment readiness.
      while (true) {
        signal.throwIfAborted();
        stage = run.state;
        if (run.state === 'collecting') {
          await this.collect(run, owner, { signal, parent });
        } else if (run.state === 'implement' || run.state === 'repair') {
          const backoff = this.store.upstreamBackoff(this.upstreamRoute);
          if (backoff) return this.store.move(run, 'blocked', { ...backoff, resumeState: run.state }, 'upstream.cooldown');
          if (run.workerCalls >= run.contract.maxRepairs + 3) throw new Error('Worker dispatch budget exhausted');
          const isRepair = run.state === 'repair';
          this.store.move(run, isRepair ? 'repairing' : 'implementing', { workerCalls: run.workerCalls + 1 });
          const files = this.store.files(run.snapshot);
          const timeout = AbortSignal.timeout(this.workerTimeoutMs);
          const workerSignal = AbortSignal.any([signal, timeout]);
          // The adapter must honor cancellation and dispose the child before settling.
          const upstreamReports = await this.deliveryInputs?.(run.id, owner, run.reportRefs ?? []) ?? [];
          if (upstreamReports.length) this.store.event(run.id, 'reports.handed_off', { ids: upstreamReports.map(r => r.id) });
          let proposal;
          try { proposal = await this.worker({ parent, deliveryDirectory: run.workspace, signal: workerSignal, objective: run.objective, taskContext: run.taskContext ?? null, sourceDeliveries: run.sourceDeliveries ?? [], deliveryId: run.id, assurance: run.assurance ?? 'verified', upstreamReports,
            phase: isRepair ? 'repair' : 'implement', files,
            contract: run.contract, evidence: run.quality ? [...run.evidence, { id: 'independent-quality', ...compactQuality(run.quality) }] : run.evidence, repairCount: run.repairCount,
            recovery: run.executionRetries ? { attempt: run.executionRetries, instruction: 'The preceding attempt timed out before any completed tool call. Produce a concise but complete implementation; avoid verbose commentary and decorative complexity. Preserve all required behavior and validation. Do not emit a partial skeleton as a completed HTML.' } : null });
          } catch (error) {
            // The adapter has disposed the previous child and isolated copy.
            // Retry only a timeout with confirmed zero completed tool calls;
            // cancellation, partial writes, output exhaustion and rate limits
            // never enter this path. Persist the budget before dispatch.
            const timeoutFailure = error.code === 'WORKER_EXECUTION_TIMEOUT'
              || (error.code === 'WORKER_UPSTREAM' && error.upstreamCode === 'TIMEOUT');
            if (!signal.aborted && timeoutFailure && error.executionCount === 0 && (run.executionRetries ?? 0) < 1) {
              this.store.move(run, 'blocked', { resumeState: isRepair ? 'repair' : 'implement',
                executionRetries: (run.executionRetries ?? 0) + 1, reason: error.message,
                reasonCode: error.upstreamCode ?? error.code, lastWorkerToolCalls: 0 }, 'worker.retry_scheduled');
              this.store.move(run, isRepair ? 'repair' : 'implement', { reason: null, reasonCode: null }, 'worker.retry_started');
              continue;
            }
            if (!signal.aborted && timeoutFailure && error.executionCount === 0 && (run.executionRetries ?? 0) >= 1) {
              this.store.move(run, 'failed', { reason: `Worker timeout recovery exhausted after one automatic retry: ${error.message}`,
                reasonCode: 'WORKER_TIMEOUT_RETRIES_EXHAUSTED', lastWorkerToolCalls: 0 }, 'worker.retry_exhausted');
              return run;
            }
            throw error;
          }
          workerSignal.throwIfAborted();
          await this.deliveryInputs?.(run.id, owner, run.reportRefs ?? []);
          const next = applyProposal(files, proposal, run.contract);
          this.store.event(run.id, 'worker.submitted', { summary: proposal.summary, execution: proposal.execution ?? [], tokenUsage: proposal.tokenUsage ?? null });
          const snapshot = this.store.snapshot(next);
          this.store.move(run, 'verify', { snapshot, workerSummary: proposal.summary });
        } else if (run.state === 'verify') {
          await this.assertSources(run);
          if (run.verifyCalls >= 6) throw new Error('Verification dispatch budget exhausted');
          if (run.mode === 'project') {
            const current = await capture(run.workspace);
            const merged = mergeSnapshots(this.store.files(run.syncBase ?? run.baseSnapshot), this.store.files(run.snapshot), current);
            assertRequired(merged, run.contract);
            const snapshot = this.store.snapshot(merged);
            if (snapshot !== run.snapshot || run.syncBase !== digest(current)) {
              if ((run.integrationAttempts ?? 0) >= 6) throw new Error('Integration retry budget exhausted');
              this.store.move(run, 'verify', { integrationAttempts: (run.integrationAttempts ?? 0) + 1, snapshot, syncBase: this.store.snapshot(current), quality: null, conflicts: null }, 'integration.prepared');
              continue;
            }
          }
          if (run.assurance === 'unverified') {
            const files = this.store.files(run.snapshot);
            await this.deliveryInputs?.(run.id, owner, run.reportRefs ?? []);
            const artifact = await this.publishSnapshot(run, files);
            const current = await capture(run.workspace);
            if (digest(current) !== run.syncBase) {
              this.store.move(run, 'verify', { evidence: [], quality: null }, 'integration.changed');
              continue;
            }
            this.store.move(run, 'syncing', { evidence: [], quality: null, artifact, syncAttempts: run.syncAttempts + 1,
              syncPlan: syncPlan(current, files), conflicts: null }, 'sync.prepared_unverified');
            continue;
          }
          const reviewBackoff = run.qualityGate && this.store.upstreamBackoff(`${run.qualityGate.provider}:${run.qualityGate.model}`);
          if (reviewBackoff) return this.store.move(run, 'blocked', { ...reviewBackoff, resumeState: 'verify' }, 'upstream.cooldown');
          this.store.move(run, 'verifying', { verifyCalls: run.verifyCalls + 1, quality: null });
          const files = this.store.files(run.snapshot);
          const evidence = [];
          for (const check of run.contract.checks) {
            signal.throwIfAborted();
            const result = await this.runner.check({ files, snapshot: run.snapshot, check, signal });
            if (result.id !== check.id || result.snapshot !== run.snapshot) throw new Error('Verifier returned stale/mismatched evidence');
            this.store.event(run.id, 'check.finished', result);
            evidence.push(result);
          }
          signal.throwIfAborted();
          if (evidence.some(e => e.kind === 'blocked' || e.kind === 'cancelled')) {
            this.store.move(run, 'blocked', { evidence, resumeState: 'verify', reason: 'Verification environment unavailable, timed out or interrupted' });
            return run;
          }
          let quality = null;
          if (run.qualityGate && evidence.every(e => e.kind === 'passed' && e.exitCode === 0)) {
            if (!this.reviewer) throw new Error('Required independent quality reviewer unavailable');
            const reviewSignal = AbortSignal.any([signal, AbortSignal.timeout(this.workerTimeoutMs)]);
            this.store.event(run.id, 'quality.started', { model: run.qualityGate.model, snapshot: run.snapshot });
            quality = await this.reviewer({ route: run.qualityGate, parent, deliveryDirectory: run.workspace, signal: reviewSignal,
              objective: run.objective, context: JSON.stringify({ taskContext: run.taskContext ?? null, requiredTasks: run.tasks ?? [], sources: run.sourceDeliveries ?? [] }), files, snapshot: run.snapshot, evidence, scope: run.id });
            reviewSignal.throwIfAborted();
            if (!quality || !['passed', 'failed', 'blocked'].includes(quality.status)
              || quality.snapshot !== run.snapshot || quality.model !== run.qualityGate.model
              || quality.provider !== run.qualityGate.provider) throw new Error('Invalid/stale quality report');
            this.store.event(run.id, 'quality.finished', quality);
            if (quality.status === 'blocked') {
              this.store.move(run, 'blocked', { evidence, quality, resumeState: 'verify', reason: 'Independent quality review blocked' });
              return run;
            }
          }
          signal.throwIfAborted();
          if (evidence.every(e => e.kind === 'passed' && e.exitCode === 0) && (!run.qualityGate || quality?.status === 'passed')) {
            await this.deliveryInputs?.(run.id, owner, run.reportRefs ?? []);
            await this.assertSources(run);
            const artifact = await this.publishSnapshot(run, files);
            signal.throwIfAborted();
            if (run.mode !== 'project') {
              this.store.move(run, 'passed', { evidence, quality, artifact });
              return run;
            }
            const current = await capture(run.workspace);
            if (digest(current) !== run.syncBase) {
              this.store.move(run, 'verify', { evidence, quality: null }, 'integration.changed');
              continue;
            }
            if (run.syncAttempts >= 3) throw new Error('Project kept changing; synchronization retry budget exhausted');
            this.store.move(run, 'syncing', { evidence, quality, artifact, syncAttempts: run.syncAttempts + 1,
              syncPlan: syncPlan(current, files), conflicts: null }, 'sync.prepared');
          } else {
            if (run.repairCount >= run.contract.maxRepairs) {
              this.store.move(run, 'failed', { evidence, quality, reason: 'Repair budget exhausted' });
              return run;
            }
            this.store.move(run, 'repair', { evidence, quality, repairCount: run.repairCount + 1 });
          }
        } else if (run.state === 'syncing') {
          if (run.assurance === 'unverified') {
            await this.assertSources(run);
            applySync(run.workspace, run.syncPlan, path => this.store.event(run.id, 'sync.file_applied', { path }));
            const actual = await capture(run.workspace);
            if (digest(actual) !== run.snapshot) {
              this.store.move(run, 'verify', { syncBase: run.snapshot, quality: null }, 'sync.project_changed');
              continue;
            }
            this.store.move(run, 'passed', { evidence: [], quality: null,
              syncReceipt: { snapshot: run.snapshot, verified: false, assurance: 'unverified', at: new Date().toISOString(), paths: run.syncPlan.map(c => c.path) } });
            return run;
          }
          if ((run.postVerifyCalls ?? 0) >= 6) throw new Error('Post-sync verification budget exhausted');
          this.store.move(run, 'syncing', { postVerifyCalls: (run.postVerifyCalls ?? 0) + 1, evidence: run.evidence, quality: run.quality }, 'sync.check_started');
          await this.assertSources(run);
          applySync(run.workspace, run.syncPlan, path => this.store.event(run.id, 'sync.file_applied', { path }));
          const actual = await capture(run.workspace);
          if (digest(actual) !== run.snapshot) {
            this.store.move(run, 'verify', { syncBase: run.snapshot, quality: null }, 'sync.project_changed');
            continue;
          }
          const evidence = [];
          for (const check of run.contract.checks) {
            const result = await this.runner.check({ files: actual, snapshot: run.snapshot, check, signal });
            if (result.id !== check.id || result.snapshot !== run.snapshot) throw new Error('Invalid post-sync verification evidence');
            this.store.event(run.id, 'sync.check_finished', result); evidence.push(result);
          }
          signal.throwIfAborted();
          if (digest(await capture(run.workspace)) !== run.snapshot || evidence.some(e => e.kind !== 'passed' || e.exitCode !== 0)) {
            this.store.move(run, 'verify', { syncBase: run.snapshot, quality: null, evidence }, 'sync.recheck_required');
            continue;
          }
          await this.assertSources(run);
          this.store.move(run, 'passed', { evidence, quality: run.quality, syncReceipt: { snapshot: run.snapshot, verified: true, at: new Date().toISOString(), paths: run.syncPlan.map(c => c.path) } });
          return run;
        } else throw new Error(`Unexpected active state: ${run.state}`);
      }
    } catch (error) {
      if (signal.aborted) Object.assign(run, this.cancelTree(run, 'Cancelled by caller'));
      else if (error.code === 'WORKER_UPSTREAM') {
        const upstreamFailures = (run.upstreamFailures ?? 0) + 1;
        const retryNotBefore = Date.now() + error.cooldownMs;
        this.store.deferUpstream(error.upstreamRoute ?? this.upstreamRoute, retryNotBefore, error.message);
        this.store.move(run, upstreamFailures >= 2 ? 'failed' : 'blocked', { reason: error.message,
          reasonCode: 'WORKER_UPSTREAM', upstreamCode: error.upstreamCode ?? null, upstreamFailures, retryNotBefore, resumeState: stage }, 'upstream.failed');
      }
      else if (error.code === 'WORKER_MAX_TOKENS' && ['implementing', 'repairing'].includes(run.state))
        this.store.move(run, 'failed', { reason: error.message, reasonCode: 'WORKER_MAX_TOKENS' }, 'worker.output_limit');
      else if (error.code === 'WORKER_EXECUTION_TIMEOUT' && ['implementing', 'repairing'].includes(run.state))
        this.store.move(run, 'failed', { reason: error.message, reasonCode: error.upstreamCode,
          lastWorkerToolCalls: error.executionCount ?? 0 }, 'worker.local_deadline');
      else this.store.move(run, 'blocked', { reason: String(error.message ?? error), conflicts: error.conflicts ?? null, conflictInput: error.conflictInput ?? null, resumeState: stage === 'syncing' && error.conflicts ? 'verify' : stage });
      return run;
    } finally { unlock(); }
  }
  async publishSnapshot(run, files) {
    const parent = resolve(this.store.root, 'artifacts', run.id);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const staging = resolve(parent, randomUUID());
    const target = resolve(parent, run.snapshot);
    await materialize(files, staging);
    // If a crash left an older export, reconstruct it from immutable DB data.
    await rm(target, { recursive: true, force: true });
    await rename(staging, target);
    return target;
  }
  cancel(id, owner, reason = 'Cancelled by user command') {
    const run = this.store.get(id, owner);
    if (run.parentId) throw new Error('Cancel the owning delivery, not a required child');
    const unlock = this.store.lock(run.mode === 'partial' ? run.id : run.workspace);
    try {
      return this.cancelTree(run, reason);
    } finally { unlock(); }
  }
}

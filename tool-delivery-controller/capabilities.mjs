import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { capture, capabilityPaths, digest, hash, safePath } from './files.mjs';

// Authoritative capability contracts. Skills describe methods, never routing or permissions.
export const capabilities = Object.freeze({
  research: { tool: 'task_kimi_research', description: 'Read supplied documents and produce a sourced synthesis.', input: 'text', worker: true },
  creative_writing: { tool: 'task_minimax_creative', description: 'Produce complete copy, scripts or creative variants.', input: 'optional', worker: true },
  animation_planning: { tool: 'task_doubao_animation', description: 'Design animation visuals, actions, pacing and shot-by-shot storyboards; does not implement code or generate video.', input: 'optional', worker: false },
  visual_analysis: { tool: 'task_glm_vision', description: 'Analyze supplied static images; does not generate images.', input: 'image', worker: true },
  media_analysis: { tool: 'task_doubao_media', description: 'Analyze supplied images, subtitles or text; no native audio/video.', input: 'text-or-image', worker: true },
  quality_review: { tool: 'task_kimi_quality', description: 'Independently inspect code and run checks.', input: 'code', worker: false },
});

export const requestProperties = {
  capability: { type: 'string', enum: Object.keys(capabilities) },
  objective: { type: 'string', minLength: 1, maxLength: 16000 },
  reason: { type: 'string', minLength: 1, maxLength: 2000 },
  singleModelGap: { type: 'string', minLength: 1, maxLength: 2000 },
  inputRefs: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 1000 } },
  expectedOutput: { type: 'string', minLength: 1, maxLength: 4000 },
  acceptanceCriteria: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 1000 } },
};
export const requestSchema = { type: 'object', properties: requestProperties,
  required: Object.keys(requestProperties), additionalProperties: false };

export function validateRequest(args) {
  if (!args || Object.keys(args).some(k => !Object.hasOwn(requestProperties, k))) throw new Error('Unknown capability request field');
  if (!capabilities[args.capability]) throw new Error('Capability unavailable: native generation/audio/video/network are not registered');
  for (const key of ['objective', 'reason', 'singleModelGap', 'expectedOutput']) {
    if (typeof args[key] !== 'string' || !args[key].trim() || args[key].length > requestProperties[key].maxLength)
      throw new Error(`Missing or invalid ${key}`);
  }
  for (const key of ['inputRefs', 'acceptanceCriteria']) {
    if (!Array.isArray(args[key]) || args[key].length > 20 || (key === 'acceptanceCriteria' && !args[key].length)
      || args[key].some(s => typeof s !== 'string' || !s.trim() || s.length > 1000)) throw new Error(`Invalid ${key}`);
  }
}

export class CapabilityControl {
  running = new Map();
  constructor(config, specialists, workspaces) {
    this.config = config; this.specialists = specialists; this.workspaces = workspaces;
    this.limit = config.maxCapabilityCalls ?? 12;
    if (!Number.isInteger(this.limit) || this.limit < 1 || this.limit > 30) throw new Error('maxCapabilityCalls must be 1..30');
    mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(resolve(config.stateDir, 'capabilities.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, owner TEXT NOT NULL, scope TEXT NOT NULL, signature TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_events(seq INTEGER PRIMARY KEY AUTOINCREMENT, task TEXT NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL);`);
  }
  close() { this.db.close(); }
  cancelOwner(owner, reason = 'Owning session disposed') {
    for (const entry of this.running.values()) if (entry.owner === owner) entry.abort.abort(new Error(reason));
    for (const task of this.list(owner)) {
      if (!['running', 'submitted', 'validating'].includes(task.state) || this.running.has(task.id)) continue;
      this.save(task, 'cancelled', { error: reason, elapsedMs: task.elapsedMs ?? Date.now() - Date.parse(task.startedAt) });
    }
  }
  get(id, owner) {
    const row = this.db.prepare('SELECT data FROM tasks WHERE id=? AND owner=?').get(id, owner);
    if (!row) throw new Error('Capability task not found in this session');
    return JSON.parse(row.data);
  }
  list(owner, scope) {
    const rows = scope ? this.db.prepare('SELECT data FROM tasks WHERE owner=? AND scope=? ORDER BY rowid').all(owner, scope)
      : this.db.prepare('SELECT data FROM tasks WHERE owner=? ORDER BY rowid DESC LIMIT 100').all(owner);
    return rows.map(r => JSON.parse(r.data));
  }
  public(task) {
    const { reportPath: _reportPath, reportHash: _reportHash, ...publicTask } = task;
    return { ...publicTask, artifactRef: task.artifactRef ?? (task.reportPath ? `report:${task.id}` : null) };
  }
  event(task, kind, data = {}) {
    this.db.prepare('INSERT INTO task_events(task,at,kind,data) VALUES(?,?,?,?)').run(task.id, new Date().toISOString(), kind, JSON.stringify(data));
  }
  save(task, state, patch = {}) {
    const allowed = { running: ['submitted', 'blocked', 'cancelled'], submitted: ['validating', 'blocked', 'cancelled'],
      validating: ['accepted', 'failed', 'blocked', 'cancelled'], accepted: ['invalidated'] };
    const current = this.get(task.id, task.owner);
    if (!allowed[current.state]?.includes(state)) throw new Error(`Invalid capability transition ${current.state} -> ${state}`);
    Object.assign(task, patch, { state });
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE tasks SET data=? WHERE id=?').run(JSON.stringify(task), task.id);
      this.event(task, state, patch); this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  async artifact(ref, owner) {
    if (typeof ref !== 'string' || !/^report:[a-f0-9-]{36}$/.test(ref)) throw new Error('Expected report:<task-id>');
    const task = this.get(ref.slice(7), owner);
    if (task.state !== 'accepted') throw new Error('Upstream artifact is not accepted');
    let text;
    try { text = await readFile(task.reportPath, 'utf8'); } catch {}
    if (!text || hash(text) !== task.reportHash) {
      this.save(task, 'invalidated', { error: 'Report changed or is missing' });
      throw new Error('Upstream artifact integrity failure');
    }
    return JSON.parse(text);
  }
  async reports(refs, owner) {
    if (!Array.isArray(refs) || refs.length > 20 || new Set(refs).size !== refs.length) throw new Error('Invalid report references');
    const reports = await Promise.all(refs.map(ref => this.artifact(ref, owner)));
    if (Buffer.byteLength(JSON.stringify(reports)) > 256 * 1024) throw new Error('Report context exceeds budget; narrow inputs');
    return reports;
  }
  caller(exec) {
    if (!exec.agent.session.header.parentSession) return { parent: exec.agent, owner: exec.agent.session.id,
      scope: `session:${exec.agent.session.id}`, signal: exec.signal };
    const workspace = this.workspaces.find(exec);
    if (workspace.readOnly || !workspace.deliveryId || !workspace.rootAgent) throw new Error('Specialists and reviewers cannot delegate');
    return { parent: workspace.rootAgent, owner: workspace.rootAgent.session.id, scope: workspace.deliveryId,
      signal: AbortSignal.any([exec.signal, workspace.signal]), workspace };
  }
  async request(args, exec) {
    const caller = this.caller(exec);
    try {
      validateRequest(args);
      if (caller.workspace && !capabilities[args.capability].worker) throw new Error('Worker cannot request a quality gate');
      const route = this.specialists.routes.get(capabilities[args.capability].tool);
      if (!route) throw new Error('Capability has no configured model');
      if (caller.workspace) await caller.workspace.tail;
      const root = caller.workspace?.root ?? caller.parent.session.header.cwd;
      const files = root ? await capture(root, undefined, { paths: capabilityPaths(args) }) : {};
      const result = await this.specialists.run(route, { ...caller, files, objective: args.objective, request: args });
      if (caller.workspace) this.event(this.get(result.id, caller.owner), 'handed_off', { deliveryId: caller.scope, recipient: exec.agent.session.id });
      return result;
    } catch (error) {
      if (caller.workspace) caller.workspace.capabilityFailure = String(error.message ?? error);
      throw error;
    }
  }
  async run(route, input) {
    const capability = Object.keys(capabilities).find(k => capabilities[k].tool === route.toolName);
    if (!capability) throw new Error('Unregistered capability route');
    const { parent, objective } = input;
    let signal = input.signal;
    const owner = input.owner ?? parent.session.id;
    const scope = input.scope ?? `session:${owner}`;
    const request = input.request ?? { capability, objective, reason: 'Controller-required independent quality gate',
      singleModelGap: 'Implementation requires independent review', inputRefs: [], expectedOutput: 'Independent review report',
      acceptanceCriteria: ['Inspect the exact code snapshot and execute checks'] };
    validateRequest(request);
    if (!input.request && capability !== 'quality_review') throw new Error('A specialist request contract is required');
    if (request.capability !== capability || request.objective !== objective) throw new Error('Capability contract does not match dispatch');
    const files = input.files ?? (parent.session.header.cwd ? await capture(parent.session.header.cwd, undefined, { paths: capabilityPaths(request) }) : {});
    const snapshot = digest(files);
    const refs = request.inputRefs.filter(r => r.startsWith('report:'));
    const upstream = await this.reports(refs, owner);
    const fileRefs = request.inputRefs.filter(r => !r.startsWith('report:')).map(ref => {
      if (!ref.startsWith('file:')) throw new Error('Input references must use file:<relative-path> or report:<task-id>');
      const path = safePath(ref.slice(5));
      if (!Object.hasOwn(files, path)) throw new Error(`Input file missing: ${path}`);
      return path;
    });
    const images = fileRefs.filter(p => /\.(png|jpe?g|webp|gif)$/i.test(p));
    if (capability === 'visual_analysis' && !images.length) throw new Error('Visual analysis requires an image file reference');
    if (['research', 'media_analysis'].includes(capability) && !fileRefs.length && !upstream.length)
      throw new Error('This capability requires supplied input references');
    const signature = hash(JSON.stringify({ capability, request, snapshot, refs, context: input.context ?? '' }));
    // A post-sync recheck may revisit an identical snapshot. Reuse only the automatic,
    // accepted, intact gate for this exact route/contract/snapshot; no extra model spend.
    if (!input.request && capability === 'quality_review') {
      const saved = this.db.prepare('SELECT data FROM tasks WHERE owner=? AND scope=? AND signature=?').get(owner, scope, signature);
      const previous = saved && JSON.parse(saved.data);
      if (previous?.state === 'accepted' && previous.model === route.model && previous.provider === route.provider) {
        const accepted = await this.artifact(`report:${previous.id}`, owner);
        signal.throwIfAborted();
        this.event(previous, 'reused', { snapshot, reason: 'identical automatic quality gate' });
        return accepted;
      }
    }
    const task = { id: randomUUID(), owner, scope, capability, model: route.model, provider: route.provider,
      contract: { version: 1, ...request, semanticCriteria: 'Model-assessed, not a proof of semantic correctness' },
      snapshot, state: 'running', startedAt: new Date().toISOString(), inputRefs: request.inputRefs };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const old = this.db.prepare('SELECT data FROM tasks WHERE owner=? AND scope=? AND signature=?').get(owner, scope, signature);
      if (old) throw new Error('Duplicate capability request; reuse its report or inspect capability_status');
      const count = this.db.prepare('SELECT count(*) AS n FROM tasks WHERE owner=? AND scope=?').get(owner, scope).n;
      if (count >= this.limit) throw new Error('Capability call budget exhausted');
      this.db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?)').run(task.id, owner, scope, signature, JSON.stringify(task));
      this.event(task, 'requested', { contract: task.contract, model: route.model, snapshot }); this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    const started = Date.now();
    const cancellation = new AbortController();
    signal = AbortSignal.any([signal, cancellation.signal]);
    this.running.set(task.id, { owner, abort: cancellation });
    try {
      const context = JSON.stringify({ upstream, suppliedContext: input.context ?? '', contract: task.contract });
      if (Buffer.byteLength(context) > 256 * 1024) throw new Error('Capability context exceeds budget');
      const report = await this.specialists.execute(route, { ...input, signal, files, snapshot, context });
      this.save(task, 'submitted', { modelStatus: report.status });
      this.save(task, 'validating');
      const records = report.execution ?? [];
      const violations = [];
      if (capability === 'visual_analysis' && images.some(path => !records.some(r => r.tool === 'read_image' && r.path === path && r.ok)))
        violations.push('Required images were not delivered through read_image');
      if (capability === 'quality_review' && !records.some(r => r.tool === 'bash' && r.ok
        && r.commands?.some(c => c.exitCode === 0 && !c.timedOut))) violations.push('Reviewer did not execute a successful check');
      if (['research', 'media_analysis'].includes(capability) && !upstream.length
        && !records.some(r => ['read', 'snapshot_explore', 'read_image'].includes(r.tool) && r.ok)) violations.push('No source material was read');
      const status = violations.length ? 'blocked' : report.status;
      const value = { ...report, status, id: task.id, artifactRef: `report:${task.id}`, capability, contract: task.contract,
        acceptance: { structural: !violations.length, violations, semantic: 'model-assessed' },
        elapsedMs: Date.now() - started, tokenUsage: report.tokenUsage ?? null };
      const directory = resolve(this.config.stateDir, 'specialists', task.id);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      value.reportPath = resolve(directory, 'report.json');
      const text = JSON.stringify({ ...value, owner }, null, 2);
      await writeFile(value.reportPath, text, { mode: 0o600 });
      this.save(task, status === 'passed' ? 'accepted' : status, { reportPath: value.reportPath, reportHash: hash(text),
        elapsedMs: value.elapsedMs, tokenUsage: value.tokenUsage, acceptance: value.acceptance });
      return value;
    } catch (error) {
      if (['running', 'submitted', 'validating'].includes(task.state)) this.save(task, signal.aborted ? 'cancelled' : 'blocked',
        { error: String(error.message ?? error), elapsedMs: Date.now() - started });
      throw error;
    } finally { this.running.delete(task.id); }
  }
  async deliveryInputs(id, owner, initialRefs = []) {
    const children = this.list(owner, id);
    if (children.some(t => t.capability !== 'quality_review' && t.state !== 'accepted')) throw new Error('Required capability task failed or is incomplete');
    return this.reports([...new Set([...initialRefs, ...children.filter(t => t.capability !== 'quality_review').map(t => `report:${t.id}`)])], owner);
  }
  status(owner, id) {
    const tasks = id ? [this.get(id, owner)] : this.list(owner);
    return tasks.map(task => {
      // Files under stateDir are controller-private and intentionally outside
      // the root workspace. Expose the capability reference, never an
      // unusable absolute path that invites a forbidden read attempt.
      return { ...this.public(task),
        events: this.db.prepare('SELECT seq,at,kind,data FROM task_events WHERE task=? ORDER BY seq').all(task.id)
        .map(e => ({ ...e, data: JSON.parse(e.data) })) };
    });
  }
}

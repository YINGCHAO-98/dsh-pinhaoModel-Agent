import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Recorder, streamRecorder, redact } from './recorder.mjs';
import { TYPERT } from './typert.mjs';
export const name = '模型日志';
export const inject = ['sessions', 'typert'];

export function readTasks(root, sessionId) {
  const result = [], errors = [];
  for (const [file, table] of [['capabilities.sqlite', 'tasks'], ['delivery.sqlite', 'runs']]) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    let db;
    try {
      db = new DatabaseSync(path, { readOnly: true });
      for (const { data } of db.prepare(`SELECT data FROM ${table} ${sessionId ? "WHERE json_extract(data, '$.owner')=?" : ""} ORDER BY rowid DESC LIMIT 200`).all(...(sessionId ? [sessionId] : []))) {
        const task = JSON.parse(data);
        let startedAt = Date.parse(task.startedAt) || null, endedAt = null;
        if (table === 'runs') {
          const times = db.prepare('SELECT MIN(at) AS first, MAX(at) AS last FROM events WHERE run=?').get(task.id);
          startedAt = Date.parse(times.first) || null;
          endedAt = Date.parse(times.last) || null;
        }
        const terminal = ['accepted', 'passed', 'failed', 'blocked', 'cancelled', 'invalidated'].includes(task.state);
        result.push({ id: task.id, kind: table === 'tasks' ? 'specialist' : 'delivery', sessionId: task.owner, rootSessionId: task.owner,
          model: task.model ?? '研发交付（含实现与审查）', provider: task.provider ?? '', startedAt,
          durationMs: task.elapsedMs ?? (terminal && startedAt && endedAt ? endedAt - startedAt : null),
          status: task.state, verdict: ['accepted', 'passed'].includes(task.state) ? 'passed' : ['failed', 'invalidated'].includes(task.state) ? 'failed' : 'unverified',
          output: redact(JSON.stringify({ objective: task.contract?.objective ?? task.objective, acceptance: task.acceptance, quality: task.quality, evidence: task.evidence, reportPath: task.reportPath }, null, 2)),
          error: redact(task.error ?? task.reason), source: file, scope: task.scope });
      }
    } catch (e) { errors.push(`${file}: ${redact(e.message, 500)}`); }
    finally { db?.close(); }
  }
  return { records: result, errors };
}
export function apply(ctx, config = {}) {
  const root = config.stateDir ?? join(homedir(), '.dsh-delivery');
  const recorder = new Recorder(root);
  const presets = new Map();
  ctx.on('session/event', (session, event) => {
    if (event.type === 'agent-preset/selected') presets.set(session.id, event.data.agentPreset);
  }, { global: true });
  const selectedPreset = session => {
    // A host plugin can be mounted after a persisted session has already
    // switched presets. Reconstruct the durable selection instead of relying
    // only on live events or the immutable creation-time header.
    const selected = session.snapshotEvents?.().findLast(event => event.type === 'agent-preset/selected')?.data?.agentPreset;
    return selected ?? presets.get(session.id) ?? session.header.agentPreset;
  };
  const identify = options => {
    let session = ctx.sessions.get(options.sessionId), rootSessionId = options.sessionId, matched = false;
    const visited = new Set();
    while (session && !visited.has(session.id)) {
      visited.add(session.id); rootSessionId = session.id;
      const preset = selectedPreset(session);
      if (typeof preset === 'string' && /(?:^|[/:])pin-hao-mo$/.test(preset)) matched = true;
      session = session.header.parentSession ? ctx.sessions.get(session.header.parentSession) : undefined;
    }
    return matched ? { sessionId: options.sessionId, rootSessionId } : null;
  };
  ctx.on('llm/stream', streamRecorder(recorder, identify, e => ctx.logger.warn(`模型日志写入失败: ${e.message}`)), { global: true });
  const service = { list(sessionId) { if (typeof sessionId !== 'string' || !sessionId.length || sessionId.length > 512) throw new TypeError('Invalid sessionId'); const tasks = readTasks(root, sessionId); return JSON.stringify({ records: [...recorder.list(sessionId), ...tasks.records].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0)), errors: tasks.errors, generatedAt: Date.now() }); } };
  Object.defineProperty(service, 'typertRemote', { value: { service, serviceKey: 'modelLogs', namespace: 'modelLogs' } });
  ctx.provide('modelLogs', service);
  if (!ctx.typert.getPackage('dsh-model-logs', 'host')) ctx.typert.register(TYPERT);
  ctx.on('dispose', () => recorder.close());
}

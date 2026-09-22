import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function redact(value, limit = 16000) {
  return String(value ?? '').replace(/\b(?:Bearer\s+)[\w.\-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|sess)-[\w-]{8,}/g, '[REDACTED]')
    .replace(/((?:api[_-]?key|authorization|access[_-]?token|secret)\s*["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[REDACTED]').slice(0, limit);
}
export class Recorder {
  constructor(root, limit = 10000) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(root, 'model-logs.sqlite'));
    this.limit = limit;
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS calls(id TEXT PRIMARY KEY, started INTEGER NOT NULL, data TEXT NOT NULL);`);
    // A previous process could not have completed these calls. Never mark them successful.
    for (const row of this.db.prepare('SELECT data FROM calls').all()) {
      const r = JSON.parse(row.data);
      if (r.status === 'running') this.save({ ...r, status: 'interrupted', error: '宿主退出或插件重载，未收到完成事件', durationMs: null });
    }
  }
  save(record) {
    this.db.prepare('INSERT INTO calls VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(record.id, record.startedAt, JSON.stringify(record));
  }
  begin(meta) {
    const r = { ...meta, id: randomUUID(), kind: 'call', startedAt: Date.now(), status: 'running', verdict: 'unverified', output: '', error: '', durationMs: null };
    this.save(r);
    this.db.prepare('DELETE FROM calls WHERE id IN (SELECT id FROM calls ORDER BY started DESC LIMIT -1 OFFSET ?)').run(this.limit);
    return r;
  }
  list(sessionId) {
    const records = sessionId
      ? this.db.prepare("SELECT data FROM calls WHERE json_extract(data, '$.sessionId')=? OR json_extract(data, '$.rootSessionId')=? ORDER BY started DESC LIMIT 2000").all(sessionId, sessionId).map(r => JSON.parse(r.data))
      : this.db.prepare('SELECT data FROM calls ORDER BY started DESC LIMIT 2000').all().map(r => JSON.parse(r.data));
    return annotateContinuations(records);
  }
  close() { this.db.close(); }
}

// An agent loop sends tool results back to the same model in a new provider
// request. Preserve that causal edge without storing prompt or tool contents.
export function annotateContinuations(records) {
  const previousBySession = new Map(), annotated = new Map();
  for (const record of [...records].sort((a, b) => a.startedAt - b.startedAt)) {
    const previous = previousBySession.get(record.sessionId);
    const followsTools = previous?.status === 'success' && previous.finishReason === 'tool-calls'
      && Number.isFinite(previous.endedAt) && record.startedAt >= previous.endedAt
      && record.startedAt - previous.endedAt <= 10 * 60 * 1000;
    annotated.set(record.id, followsTools ? { ...record, inputKind: 'tool-results', continuedFrom: previous.id,
      inputTools: Array.isArray(previous.tools) ? previous.tools : [] } : record);
    previousBySession.set(record.sessionId, record);
  }
  return records.map(record => annotated.get(record.id));
}

export function streamRecorder(recorder, identify, warn = () => {}) {
  // Observer errors must not consume, replace or retry a real model request.
  const safe = fn => { try { return fn(); } catch (e) { warn(e); } };
  return (options, next) => {
    const meta = identify(options);
    if (!meta) return next();
    return (async function* () {
      const row = safe(() => recorder.begin({ ...meta, provider: options.provider, model: options.model }));
      const start = performance.now();
      let reason, complete = false, output = '', totalChars = 0, usage, tools = new Set();
      try {
        for await (const chunk of next()) {
          if (chunk.type === 'text-delta') { totalChars += (chunk.text ?? '').length; output = (output + (chunk.text ?? '')).slice(0, 16000); }
          if (chunk.type === 'tool-call-delta' && chunk.name) tools.add(chunk.name);
          if (chunk.type === 'usage') usage = chunk.usage;
          if (chunk.type === 'finish') reason = chunk.reason;
          yield chunk;
        }
        complete = true;
      } catch (e) {
        reason = { kind: options.signal?.aborted ? 'aborted' : 'error', failure: { message: e.message ?? String(e), code: e.code } };
        throw e;
      } finally {
        if (row) {
          const finish = reason?.kind;
          const status = options.signal?.aborted || finish === 'aborted' ? 'cancelled'
            : ['error', 'max-tokens', 'content-filter', 'refusal'].includes(finish) ? 'failed'
            : !complete ? 'interrupted' : ['stop', 'tool-calls'].includes(finish) ? 'success' : 'incomplete';
          safe(() => recorder.save({ ...row, endedAt: Date.now(), durationMs: Math.round(performance.now() - start), status,
            finishReason: finish ?? 'missing-finish', output: redact(output), truncated: totalChars > 16000,
            tools: [...tools], usage, error: redact(reason?.failure?.message ?? (status === 'failed' ? finish : '')), errorCode: redact(reason?.failure?.code, 200) }));
        }
      }
    })();
  };
}

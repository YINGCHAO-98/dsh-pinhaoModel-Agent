import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Recorder, streamRecorder, annotateContinuations } from '../recorder.mjs';
import { readTasks, apply } from '../index.mjs';
import { DatabaseSync } from 'node:sqlite';
const collect = async stream => { const chunks = []; for await (const c of stream) chunks.push(c); return chunks; };
function fixture(t) { const dir = mkdtempSync(join(tmpdir(), 'model-logs-')); const recorder = new Recorder(dir); t.after(() => { recorder.close(); rmSync(dir, { recursive: true, force: true }); }); return { dir, recorder, hook: streamRecorder(recorder, () => ({ sessionId: 'child', rootSessionId: 'root' })) }; }
test('records successful output, duration, usage and redacts credentials without altering chunks', async t => {
  const { recorder, hook } = fixture(t);
  const chunks = [{ type: 'text-delta', text: 'Bearer abc12345 sk-12345678901234567890' }, { type: 'usage', usage: { outputTokens: 8 } }, { type: 'finish', reason: { kind: 'stop' } }];
  assert.deepEqual(await collect(hook({ model: 'kimi', provider: 'test' }, async function* () { yield* chunks; })), chunks);
  const r = recorder.list()[0]; assert.equal(r.status, 'success'); assert.equal(r.verdict, 'unverified'); assert.ok(r.durationMs >= 0); assert.ok(!r.output.includes('12345')); assert.equal(r.usage.outputTokens, 8);
});
test('error, max tokens, missing finish and cancellation never become successful', async t => {
  const { recorder, hook } = fixture(t);
  for (const kind of ['error', 'max-tokens', 'aborted', undefined]) {
    await collect(hook({}, async function* () { if (kind) yield { type: 'finish', reason: { kind, failure: { message: 'bad output' } } }; }));
  }
  assert.ok(recorder.list().every(r => r.status !== 'success'));
  assert.deepEqual(new Set(recorder.list().map(r => r.status)), new Set(['failed', 'cancelled', 'incomplete']));
});
test('sync dispatch throw, async throw, early return and parallel streams retain separate records', async t => {
  const { recorder, hook } = fixture(t);
  await assert.rejects(collect(hook({}, () => { throw new Error('dispatch failed'); })), /dispatch failed/);
  await assert.rejects(collect(hook({}, async function* () { throw new Error('stream failed'); })), /stream failed/);
  let closed = false;
  for await (const c of hook({}, async function* () { try { yield { type: 'text-delta', text: 'partial' }; } finally { closed = true; } })) break;
  assert.ok(closed);
  await Promise.all(['A', 'B'].map(model => collect(hook({ model }, async function* () { yield { type: 'text-delta', text: model }; yield { type: 'finish', reason: { kind: 'stop' } }; }))));
  assert.equal(recorder.list().length, 5); assert.equal(recorder.list().filter(r => r.status === 'failed').length, 2); assert.ok(recorder.list().some(r => r.status === 'interrupted'));
});
test('unrelated preset does not get recorded and failure to persist does not break response', async t => {
  const { recorder } = fixture(t);
  await collect(streamRecorder(recorder, () => null)({}, async function* () { yield { type: 'finish', reason: { kind: 'stop' } }; }));
  assert.equal(recorder.list().length, 0);
  assert.equal((await collect(streamRecorder({ begin() { throw Error('disk full'); } }, () => ({}))({}, async function* () { yield 1; }))).length, 1);
});
test('restart marks orphaned running calls interrupted and preserves completed calls', t => {
  const dir = mkdtempSync(join(tmpdir(), 'model-log-restart-')); let recorder = new Recorder(dir);
  recorder.begin({ model: 'orphan' }); recorder.close(); recorder = new Recorder(dir);
  assert.equal(recorder.list()[0].status, 'interrupted'); recorder.close(); rmSync(dir, { recursive: true, force: true });
});
test('tool-result follow-up is linked to its causal model round without storing tool contents', () => {
  const records = [
    { id: 'next', sessionId: 'child', startedAt: 1021, status: 'running' },
    { id: 'tool', sessionId: 'child', startedAt: 1000, endedAt: 1020, status: 'success', finishReason: 'tool-calls', tools: ['skill'] },
    { id: 'other', sessionId: 'root', startedAt: 1010, endedAt: 1015, status: 'success', finishReason: 'stop', tools: [] },
  ];
  const linked = annotateContinuations(records);
  assert.deepEqual(linked[0].inputTools, ['skill']);
  assert.equal(linked[0].inputKind, 'tool-results');
  assert.equal(linked[0].continuedFrom, 'tool');
  assert.equal(linked[2].inputKind, undefined);
});
test('historical task acceptance is read-only and distinct from call status', t => {
  const { dir } = fixture(t); const db = new DatabaseSync(join(dir, 'capabilities.sqlite'));
  db.exec('CREATE TABLE tasks(data TEXT)'); db.prepare('INSERT INTO tasks VALUES(?)').run(JSON.stringify({ id: 'verified', owner: 'root', model: 'kimi', state: 'accepted', elapsedMs: 123, acceptance: { semantic: 'model-assessed' } })); db.close();
  const snapshot = readTasks(dir); assert.equal(snapshot.errors.length, 0); assert.equal(snapshot.records[0].verdict, 'passed'); assert.equal(snapshot.records[0].durationMs, 123);
});
test('host follows child ancestry and excludes other presets', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'model-log-host-')); const hooks = new Map();
  const sessions = new Map([
    ['root', { id: 'root', header: { agentPreset: 'pin-hao-mo' }, snapshotEvents: () => [] }],
    ['child', { id: 'child', header: { parentSession: 'root' }, snapshotEvents: () => [] }],
    ['other', { id: 'other', header: {}, snapshotEvents: () => [] }],
    // Creation-time preset is stale after a durable switch. This must bypass
    // the recorder even if the plugin missed the original live event.
    ['standard', { id: 'standard', header: { agentPreset: 'pin-hao-mo' }, snapshotEvents: () => [
      { type: 'agent-preset/selected', data: { agentPreset: 'standard' } },
    ] }],
  ]);
  const services = {};
  apply({ sessions: { get: id => sessions.get(id) }, typert: { getPackage: () => false, register: manifest => assert.equal(manifest.invocations.length, 1) }, on: (key, cb) => hooks.set(key, cb), provide: (key, value) => services[key] = value, logger: { warn() {} } }, { stateDir: dir });
  t.after(() => { hooks.get('dispose')(); rmSync(dir, { recursive: true, force: true }); });
  for (const sessionId of ['root', 'child', 'other', 'standard']) await collect(hooks.get('llm/stream')({ sessionId, model: 'fixture' }, async function* () { yield { type: 'finish', reason: { kind: 'stop' } }; }));
  const records = JSON.parse(services.modelLogs.list('root')).records; assert.equal(records.length, 2); assert.throws(() => services.modelLogs.list(''), /Invalid/); assert.equal(JSON.parse(services.modelLogs.list('other')).records.length, 0); assert.ok(records.every(r => r.rootSessionId === 'root'));
  assert.equal(JSON.parse(services.modelLogs.list('standard')).records.length, 0);
});

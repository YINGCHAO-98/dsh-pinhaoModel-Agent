import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../store.mjs';
import { DeliveryController } from '../controller.mjs';
import { applyProposal, validateContract, safePath } from '../files.mjs';

export const contract = {
  version: 1, editablePaths: ['src/'], protectedPaths: ['tests/'], requiredPaths: ['tests/'],
  checks: [{ id: 'tests', argv: ['node', '--test'], timeoutMs: 1000 }], maxRepairs: 2,
};
const proposal = content => ({ summary: 'Implementation complete; skip verification', status: 'passed',
  changes: [{ path: 'src/value.txt', operation: 'write', content }] });
export const fakeRunner = {
  async preflight() {},
  async check({ files, snapshot, check }) {
    const passed = Buffer.from(files['src/value.txt'], 'base64').toString() === 'good';
    return { id: check.id, snapshot, kind: passed ? 'passed' : 'failed', exitCode: passed ? 0 : 1, stdout: 'test evidence', stderr: '' };
  },
};
async function fixture(t, worker, runner = fakeRunner) {
  const base = await mkdtemp(resolve(tmpdir(), 'delivery-unit-'));
  const workspace = resolve(base, 'project');
  await mkdir(resolve(workspace, 'src'), { recursive: true });
  await mkdir(resolve(workspace, 'tests'));
  await writeFile(resolve(workspace, 'src/value.txt'), 'bad');
  await writeFile(resolve(workspace, 'tests/test.cjs'), '// trusted test');
  let store = new Store(resolve(base, 'state'));
  t.after(async () => { try { store.close(); } catch {} await rm(base, { recursive: true, force: true }); });
  const controller = new DeliveryController({ store, worker, runner });
  const run = await controller.create({ owner: 'session', workspace, objective: 'Fix value', contract });
  return { base, store, controller, run, reopen() { store.close(); store = new Store(resolve(base, 'state')); return store; } };
}

test('self-reported success cannot skip verification; failure automatically invokes repair', async t => {
  const phases = [];
  const f = await fixture(t, async ({ phase }) => { phases.push(phase); return proposal(phase === 'repair' ? 'good' : 'bad'); });
  const result = await f.controller.drive(f.run.id, 'session');
  assert.equal(result.state, 'passed');
  assert.deepEqual(phases, ['implement', 'repair']);
  assert.equal(result.verifyCalls, 2);
  assert.equal(result.repairCount, 1);
  assert.equal(await readFile(resolve(result.artifact, 'src/value.txt'), 'utf8'), 'good');
  assert.equal(await readFile(resolve(f.run.workspace, 'src/value.txt'), 'utf8'), 'bad');
  assert.ok(f.store.history(result.id).some(e => e.kind === 'check.finished'));
});

test('two repairs exhaust the budget; resume cannot reset a terminal run', async t => {
  const f = await fixture(t, async () => proposal('bad'));
  const result = await f.controller.drive(f.run.id, 'session');
  assert.equal(result.state, 'failed');
  assert.equal(result.repairCount, 2);
  assert.equal(result.workerCalls, 3);
  assert.equal(result.verifyCalls, 3);
  const resumed = await f.controller.drive(result.id, 'session');
  assert.equal(resumed.workerCalls, 3);
});

test('missing sandbox blocks before the first model call', async t => {
  const f = await fixture(t, async () => { throw new Error('must not call'); }, { preflight: async () => { throw new Error('sandbox unavailable'); } });
  const result = await f.controller.drive(f.run.id, 'session');
  assert.equal(result.state, 'blocked');
  assert.equal(result.workerCalls, 0);
});

test('protected tests, traversal and duplicate paths cannot be changed', () => {
  const files = { 'src/a.txt': Buffer.from('a').toString('base64'), 'tests/a.cjs': Buffer.from('test').toString('base64') };
  for (const path of ['../escape', '/tmp/file', 'src/../../escape', 'src/.config', 'tests/a.cjs', 'src\\escape']) {
    assert.throws(() => applyProposal(files, { summary: '', changes: [{ path, operation: 'write', content: 'x' }] }, contract));
  }
  assert.throws(() => safePath('src/./a'));
  assert.throws(() => applyProposal(files, { summary: '', changes: [
    { path: 'src/a.txt', operation: 'write', content: '' }, { path: 'src/a.txt', operation: 'delete', content: '' },
  ] }, contract));
});

test('snapshot identity, not worker text, determines pass; stale evidence is blocked', async t => {
  const runner = { preflight: async () => {}, check: async ({ check }) => ({ id: check.id, snapshot: 'old', kind: 'passed', exitCode: 0 }) };
  const f = await fixture(t, async () => proposal('good'), runner);
  assert.equal((await f.controller.drive(f.run.id, 'session')).state, 'blocked');
});

test('changed or missing exported artifact invalidates a passed result', async t => {
  const f = await fixture(t, async () => proposal('good'));
  const result = await f.controller.drive(f.run.id, 'session');
  await writeFile(resolve(result.artifact, 'src/value.txt'), 'changed');
  assert.equal((await f.controller.status(result.id, 'session')).state, 'invalidated');
});

test('adding an excluded environment file to an exported artifact also invalidates it', async t => {
  const f = await fixture(t, async () => proposal('good'));
  const result = await f.controller.drive(f.run.id, 'session');
  await writeFile(resolve(result.artifact, '.env'), 'CHANGED=true');
  assert.equal((await f.controller.status(result.id, 'session')).state, 'invalidated');
});

test('state changes cannot bypass verification, evidence count or repair limits', async t => {
  const f = await fixture(t, async () => proposal('good'));
  assert.throws(() => f.store.move(f.run, 'passed', { evidence: [] }));
  f.store.move(f.run, 'implementing');
  f.store.move(f.run, 'verify');
  f.store.move(f.run, 'verifying');
  assert.throws(() => f.store.move(f.run, 'passed', { evidence: [] }));
  assert.throws(() => f.store.move(f.run, 'repair', { repairCount: 3 }));
});

test('workspace lock prevents duplicate execution and same-workspace unfinished jobs', async t => {
  const f = await fixture(t, async () => proposal('good'));
  const release = f.store.lock(f.run.workspace);
  assert.throws(() => f.store.lock(f.run.workspace));
  await assert.rejects(f.controller.drive(f.run.id, 'session'));
  release();
  await assert.rejects(f.controller.create({ owner: 'other', workspace: f.run.workspace, objective: 'Reset budget', contract }));
  assert.throws(() => f.store.get(f.run.id, 'other'));
});

test('empty checks and missing required tests are rejected before model dispatch', async t => {
  assert.throws(() => validateContract({ ...contract, checks: [] }));
  const f = await fixture(t, async () => proposal('good'));
  f.controller.cancel(f.run.id, 'session');
  await rm(resolve(f.run.workspace, 'tests'), { recursive: true });
  await assert.rejects(f.controller.create({ owner: 'session', workspace: f.run.workspace, objective: 'Skip tests', contract }));
});

test('caller cancellation cannot produce passed', async t => {
  const abort = new AbortController();
  const f = await fixture(t, async () => { abort.abort(); return proposal('good'); });
  const result = await f.controller.drive(f.run.id, 'session', { signal: abort.signal });
  assert.equal(result.state, 'cancelled');
  assert.equal(result.verifyCalls, 0);
});

test('process death during repair is recoverable without resetting repair budget', async t => {
  const f = await fixture(t, async () => proposal('good'));
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('./crash-child.mjs', import.meta.url)),
    resolve(f.base, 'state'), f.run.id], { encoding: 'utf8' });
  assert.equal(child.status, 23, child.stderr);
  const recoveredStore = f.reopen();
  const interrupted = recoveredStore.get(f.run.id);
  assert.equal(interrupted.state, 'repairing');
  assert.equal(interrupted.repairCount, 1);
  const controller = new DeliveryController({ store: recoveredStore, worker: async () => proposal('good'), runner: fakeRunner });
  const result = await controller.drive(f.run.id, 'session');
  assert.equal(result.state, 'passed');
  assert.equal(result.repairCount, 1);
  assert.equal(result.workerCalls, 3);
  assert.ok(recoveredStore.history(result.id).some(e => e.kind === 'interrupted'));
});

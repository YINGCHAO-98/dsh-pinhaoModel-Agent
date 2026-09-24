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
async function fixture(t, worker, runner = fakeRunner, options = {}) {
  const base = await mkdtemp(resolve(tmpdir(), 'delivery-unit-'));
  const workspace = resolve(base, 'project');
  await mkdir(resolve(workspace, 'src'), { recursive: true });
  await mkdir(resolve(workspace, 'tests'));
  await writeFile(resolve(workspace, 'src/value.txt'), 'bad');
  await writeFile(resolve(workspace, 'tests/test.cjs'), '// trusted test');
  let store = new Store(resolve(base, 'state'));
  t.after(async () => { try { store.close(); } catch {} await rm(base, { recursive: true, force: true }); });
  const controller = new DeliveryController({ store, worker, runner, ...options });
  const run = await controller.create({ owner: 'session', workspace, objective: 'Fix value', contract: options.contract ?? contract,
    mode: options.mode ?? 'partial', assurance: options.assurance ?? 'verified' });
  return { base, store, controller, run, reopen() { store.close(); store = new Store(resolve(base, 'state')); return store; } };
}

test('self-reported success cannot skip verification; failure automatically invokes repair', async t => {
  const phases = [];
  const f = await fixture(t, async ({ phase }) => { phases.push(phase); return proposal(phase === 'repair' ? 'good' : 'bad'); });
  const result = await f.controller.drive(f.run.id, 'session');
  assert.equal(result.state, 'passed', result.reason);
  assert.deepEqual(phases, ['implement', 'repair']);
  assert.equal(result.verifyCalls, 2);
  assert.equal(result.repairCount, 1);
  assert.equal(await readFile(resolve(result.artifact, 'src/value.txt'), 'utf8'), 'good');
  assert.equal(await readFile(resolve(f.run.workspace, 'src/value.txt'), 'utf8'), 'bad');
  assert.ok(f.store.history(result.id).some(e => e.kind === 'check.finished'));
});

test('explicit unverified project delivery skips checks, review and repair but records an unverified sync receipt', async t => {
  let checks = 0, reviews = 0;
  const runner = { async preflight() {}, async check() { checks++; throw new Error('must not verify'); } };
  const f = await fixture(t, async ({ assurance, phase }) => {
    assert.equal(assurance, 'unverified');
    assert.equal(phase, 'implement');
    return proposal('unchecked');
  }, runner, { mode: 'project', assurance: 'unverified', contract: { ...contract, requiredOutputs: ['src/value.txt'] },
    qualityGate: { toolName: 'quality', provider: 'p', model: 'm' }, reviewer: async () => { reviews++; } });
  const result = await f.controller.drive(f.run.id, 'session');
  assert.equal(result.state, 'passed', result.reason);
  assert.equal(result.assurance, 'unverified');
  assert.equal(result.verifyCalls, 0);
  assert.equal(result.repairCount, 0);
  assert.equal(result.qualityGate, null);
  assert.equal(result.syncReceipt.verified, false);
  assert.equal(result.syncReceipt.assurance, 'unverified');
  assert.equal(checks, 0);
  assert.equal(reviews, 0);
  assert.equal(await readFile(resolve(f.run.workspace, 'src/value.txt'), 'utf8'), 'unchecked');
});

test('controller hands accepted reports to worker and blocks when required capability output becomes unavailable', async t => {
  let calls = 0;
  const f = await fixture(t, async input => {
    assert.equal(input.deliveryId, f.run.id);
    assert.equal(input.upstreamReports[0].id, 'accepted-report');
    return proposal('good');
  }, fakeRunner, { deliveryInputs: async () => {
    if (++calls > 1) throw new Error('Required capability task failed or is incomplete');
    return [{ id: 'accepted-report', summary: 'authoritative source output' }];
  } });
  const result = await f.controller.drive(f.run.id, 'session');
  assert.equal(result.state, 'blocked');
  assert.equal(result.verifyCalls, 0);
  assert.match(result.reason, /Required capability/);
  assert.ok(f.store.history(result.id).some(e => e.kind === 'reports.handed_off'));
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

test('output token exhaustion is terminal and resume cannot repeat the generation', async t => {
  const f = await fixture(t, async () => { throw Object.assign(new Error('Worker output token budget exhausted'), { code: 'WORKER_MAX_TOKENS' }); });
  const result = await f.controller.drive(f.run.id, 'session');
  assert.equal(result.state, 'failed');
  assert.equal(result.workerCalls, 1);
  assert.equal((await f.controller.drive(result.id, 'session')).workerCalls, 1);
});

test('zero-tool output exhaustion retries once with recovery then completes', async t => {
  let calls = 0;
  const f = await fixture(t, async input => {
    calls++;
    if (calls === 1) throw Object.assign(new Error('Output budget exhausted'), { code: 'WORKER_MAX_TOKENS', executionCount: 0 });
    assert.equal(input.recovery?.reason, 'output_limit_without_tool_calls');
    return proposal('good');
  });
  const result = await f.controller.drive(f.run.id, 'session');
  assert.equal(result.state, 'passed', result.reason);
  assert.equal(calls, 2);
  assert.equal(result.outputRetries, 1);
  assert.ok(f.store.history(result.id).some(event => event.kind === 'worker.output_retry_started'));
});

test('zero-tool output exhaustion stops after one recovery attempt', async t => {
  let calls = 0;
  const f = await fixture(t, async () => {
    calls++;
    throw Object.assign(new Error('Output budget exhausted'), { code: 'WORKER_MAX_TOKENS', executionCount: 0 });
  });
  const result = await f.controller.drive(f.run.id, 'session');
  assert.equal(result.state, 'failed');
  assert.equal(result.reasonCode, 'WORKER_MAX_TOKENS');
  assert.equal(calls, 2);
  assert.equal((await f.controller.drive(result.id, 'session')).workerCalls, 2);
});

test('repeated zero-tool failures dispatch one controlled recovery route with the same contract', async t => {
  const routes = [];
  const f = await fixture(t, async input => {
    routes.push(input.recovery?.route ?? 'primary');
    if (routes.length <= 2) throw Object.assign(new Error('No tool call before deadline'), {
      code: 'WORKER_EXECUTION_TIMEOUT', upstreamCode: 'WORKER_NO_ARTIFACT_DEADLINE', executionCount: 2, safeToRetry: true,
    });
    assert.equal(input.contract.editablePaths[0], 'src/');
    return proposal('good');
  }, fakeRunner, { recoveryWorkerAvailable: true });
  const result = await f.controller.drive(f.run.id, 'session');
  assert.equal(result.state, 'passed', result.reason);
  assert.deepEqual(routes, ['primary', 'primary', 'recovery-worker']);
  assert.equal(result.recoveryAttempts, 1);
  assert.equal(result.verifyCalls, 1);
});

test('recovery route is not retried after its own zero-tool failure', async t => {
  const routes = [];
  const f = await fixture(t, async input => {
    routes.push(input.recovery?.route ?? 'primary');
    throw Object.assign(new Error('No tool call before deadline'), {
      code: 'WORKER_EXECUTION_TIMEOUT', upstreamCode: 'WORKER_NO_TOOL_DEADLINE', executionCount: 0,
    });
  }, fakeRunner, { recoveryWorkerAvailable: true });
  const result = await f.controller.drive(f.run.id, 'session');
  assert.equal(result.state, 'failed');
  assert.deepEqual(routes, ['primary', 'primary', 'recovery-worker']);
  assert.equal(result.reasonCode, 'WORKER_TIMEOUT_RETRIES_EXHAUSTED');
});

test('zero-tool timeout retries once then terminates without poisoning the provider route', async t => {
  const f = await fixture(t, async () => { throw Object.assign(new Error('Worker model produced no tool call before its local execution deadline'), {
    code: 'WORKER_EXECUTION_TIMEOUT', upstreamCode: 'WORKER_NO_TOOL_DEADLINE', executionCount: 0,
  }); });
  const result = await f.controller.drive(f.run.id, 'session');
  assert.equal(result.state, 'failed');
  assert.equal(result.workerCalls, 2);
  assert.equal((await f.controller.drive(result.id, 'session')).workerCalls, 2);
  assert.equal(result.reasonCode, 'WORKER_TIMEOUT_RETRIES_EXHAUSTED');
  assert.equal(result.executionRetries, 1);
  assert.equal(result.lastWorkerToolCalls, 0);
  assert.equal(f.store.upstreamBackoff('worker'), null);
});

test('external resume and new planning are rejected during a real provider cooldown', async t => {
  const f = await fixture(t, async () => proposal('good'), fakeRunner, { mode: 'project' });
  const retryNotBefore = Date.now() + 60000;
  f.store.move(f.run, 'blocked', { reason: 'provider cooling down', reasonCode: 'WORKER_UPSTREAM', retryNotBefore, resumeState: 'implement' });
  assert.throws(() => f.controller.assertResumeReady(f.store.get(f.run.id)), /DELIVERY_RETRY_NOT_READY/);
  f.store.deferUpstream('worker', retryNotBefore, 'provider cooling down');
  assert.throws(() => f.controller.assertWorkerAvailable(), /WORKER_COOLDOWN/);
});

test('legacy max-tokens blocked tasks stop on resume without another model call', async t => {
  const f = await fixture(t, async () => { throw new Error('must not execute'); });
  f.store.move(f.run, 'blocked', { reason: 'Worker did not complete: max-tokens', resumeState: 'implement' });
  const result = await f.controller.drive(f.run.id, 'session');
  assert.equal(result.state, 'failed');
  assert.equal(result.workerCalls, 0);
});

test('replacement automatically retires only same-owner legacy output failures', async t => {
  const f = await fixture(t, async () => proposal('good'), fakeRunner, { mode: 'project' });
  f.store.move(f.run, 'blocked', { reason: 'Worker did not complete: max-tokens', resumeState: 'implement' });
  const create = owner => f.controller.create({ owner, workspace: f.run.workspace, objective: 'Smaller replacement', contract });
  await assert.rejects(create('foreign'), /unfinished delivery/);
  assert.equal(f.store.get(f.run.id).state, 'blocked');
  const replacement = await create('session');
  assert.equal(f.store.get(f.run.id).state, 'failed');
  assert.equal(f.store.get(f.run.id).workerCalls, 0);
  assert.equal(replacement.state, 'implement');
  f.store.move(replacement, 'blocked', { reason: 'Sandbox unavailable', resumeState: 'implement' });
  await assert.rejects(create('session'), /unfinished delivery/);
  assert.equal(f.controller.cancel(replacement.id, 'session').state, 'cancelled');
  assert.equal(f.controller.cancel(replacement.id, 'session').state, 'cancelled');
  assert.equal((await create('session')).state, 'implement');
  assert.equal(await readFile(resolve(f.run.workspace, 'src/value.txt'), 'utf8'), 'bad');
});

test('expired pre-dispatch project reservation from another session is retired before replacement', async t => {
  const f = await fixture(t, async () => proposal('good'), fakeRunner, { mode: 'project' });
  f.store.move(f.run, 'blocked', { reason: 'Worker execution deadline exceeded', resumeState: 'implement', retryNotBefore: Date.now() - 1 }, 'upstream.cooldown');
  const replacement = await f.controller.create({ owner: 'new-session', workspace: f.run.workspace, objective: 'Retry safely', contract, mode: 'project' });
  const expired = f.store.get(f.run.id);
  assert.equal(expired.state, 'failed');
  assert.match(expired.reason, /Expired pre-dispatch reservation/);
  assert.equal(replacement.state, 'implement');
  assert.ok(f.store.history(f.run.id).some(event => event.kind === 'reservation.expired'));
});

test('active or post-implementation blockers remain protected and identify the blocking delivery', async t => {
  const f = await fixture(t, async () => proposal('good'), fakeRunner, { mode: 'project' });
  f.store.move(f.run, 'blocked', { reason: 'Worker execution deadline exceeded', resumeState: 'implement', retryNotBefore: Date.now() + 60000 }, 'upstream.cooldown');
  await assert.rejects(f.controller.create({ owner: 'new-session', workspace: f.run.workspace, objective: 'Too early', contract, mode: 'project' }),
    error => error.message.includes(f.run.id) && /owned by another session/.test(error.message));
  const blocked = f.store.get(f.run.id);
  f.store.move(blocked, 'implement', { retryNotBefore: 0 });
  f.store.move(blocked, 'implementing', { workerCalls: 1 });
  f.store.move(blocked, 'verify', { snapshot: blocked.snapshot });
  f.store.move(blocked, 'blocked', { reason: 'Review unavailable', resumeState: 'verify' });
  await assert.rejects(f.controller.create({ owner: 'new-session', workspace: f.run.workspace, objective: 'Must not bypass', contract, mode: 'project' }),
    error => error.message.includes(f.run.id));
  assert.equal(f.store.get(f.run.id).state, 'blocked');
});

test('a missing owning session cannot leave a permanent workspace reservation', async t => {
  const f = await fixture(t, async () => proposal('good'), fakeRunner, { mode: 'project', ownerAlive: owner => owner !== 'deleted-session' });
  f.store.move(f.run, 'blocked', { reason: 'Worker execution deadline exceeded', resumeState: 'verify' });
  const stale = f.store.get(f.run.id);
  f.store.db.prepare('UPDATE runs SET owner=?,data=? WHERE id=?').run('deleted-session', JSON.stringify({ ...stale, owner: 'deleted-session' }), stale.id);
  const replacement = await f.controller.create({ owner: 'new-session', workspace: f.run.workspace, objective: 'Replace deleted task', contract, mode: 'project' });
  assert.equal(f.store.get(stale.id).state, 'cancelled');
  assert.match(f.store.get(stale.id).reason, /no longer exists/);
  assert.equal(replacement.state, 'implement');
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
  const release = f.store.lock(f.run.id);
  assert.throws(() => f.store.lock(f.run.id));
  await assert.rejects(f.controller.drive(f.run.id, 'session'));
  release();
  const project = await f.controller.create({ owner: 'other', workspace: f.run.workspace, objective: 'Integrate project', contract });
  await assert.rejects(f.controller.create({ owner: 'other', workspace: f.run.workspace, objective: 'Reset budget', contract }));
  f.controller.cancel(project.id, 'other');
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

test('startup recovery converts orphaned active execution into an explicit resumable block', async t => {
  const f = await fixture(t);
  f.store.move(f.run, 'implementing', { workerCalls: 1 });
  const recovered = f.store.recoverInterrupted();
  assert.deepEqual(recovered, [f.run.id]);
  const run = f.store.get(f.run.id);
  assert.equal(run.state, 'blocked');
  assert.equal(run.resumeState, 'implement');
  assert.match(run.reason, /restarted during active execution/);
  assert.equal(f.store.history(run.id).at(-1).kind, 'interrupted.recovered');
});

const qualityGate = { toolName: 'task_kimi_quality', provider: 'doubao', model: 'kimi-k2-8-preview' };
const qualityReport = (snapshot, status = 'passed') => ({ ...qualityGate, snapshot, status,
  summary: 'independent review', evidence: ['node --test: reviewed'], limitations: [] });

test('independent quality failure triggers repair even when contract tests pass', async t => {
  let reviews = 0;
  const inputs = [];
  const f = await fixture(t, async input => { inputs.push(input); return proposal('good'); }, fakeRunner, {
    qualityGate, reviewer: async ({ snapshot }) => ({ ...qualityReport(snapshot, ++reviews === 1 ? 'failed' : 'passed'), execution: [{ args: 'large private test payload' }] }),
  });
  const result = await f.controller.drive(f.run.id, 'session');
  assert.equal(result.state, 'passed');
  assert.equal(result.repairCount, 1);
  assert.equal(reviews, 2);
  assert.ok(inputs[1].evidence.some(e => e.id === 'independent-quality' && e.status === 'failed'));
  assert.equal(inputs[1].evidence.find(e => e.id === 'independent-quality').execution, undefined);
  assert.equal(result.quality.model, 'kimi-k2-8-preview');
  assert.equal(result.quality.snapshot, result.snapshot);
});

test('blocked reviewer cannot pass delivery or consume a repair; saved route survives config changes', async t => {
  const f = await fixture(t, async () => proposal('good'), fakeRunner, {
    qualityGate, reviewer: async ({ route, snapshot }) => { assert.deepEqual(route, qualityGate); return qualityReport(snapshot, 'blocked'); },
  });
  f.controller.qualityGate = { ...qualityGate, model: 'other' };
  const result = await f.controller.drive(f.run.id, 'session');
  assert.equal(result.state, 'blocked');
  assert.equal(result.resumeState, 'verify');
  assert.equal(result.repairCount, 0);
  f.controller.reviewer = async ({ snapshot }) => qualityReport(snapshot);
  assert.equal((await f.controller.drive(f.run.id, 'session')).state, 'passed');
});

test('stale review or unavailable reviewer fails closed', async t => {
  for (const reviewer of [undefined, async () => qualityReport('stale')]) {
    const f = await fixture(t, async () => proposal('good'), fakeRunner, { qualityGate, reviewer });
    assert.equal((await f.controller.drive(f.run.id, 'session')).state, 'blocked');
  }
});

test('store rejects model-declared pass without matching independent evidence', async t => {
  const f = await fixture(t, async () => proposal('good'), fakeRunner, { qualityGate });
  f.store.move(f.run, 'implementing'); f.store.move(f.run, 'verify'); f.store.move(f.run, 'verifying');
  const evidence = [{ id: 'tests', kind: 'passed', exitCode: 0, snapshot: f.run.snapshot }];
  assert.throws(() => f.store.move(f.run, 'passed', { evidence }), /quality/);
  assert.throws(() => f.store.move(f.run, 'passed', { evidence, quality: qualityReport('old') }), /quality/);
});

test('project mode automatically syncs after acceptance and checks actual project again', async t => {
  let checks = 0;
  const f = await fixture(t, async () => proposal('good'), { ...fakeRunner, async check(input) { checks++; return fakeRunner.check(input); } }, { mode: 'project' });
  const result = await f.controller.drive(f.run.id, 'session');
  assert.equal(result.state, 'passed', result.reason);
  assert.equal(await readFile(resolve(f.run.workspace, 'src/value.txt'), 'utf8'), 'good');
  assert.equal(result.syncReceipt.verified, true);
  assert.equal(checks, 2);
  assert.equal((await f.controller.status(result.id, 'session')).projectMatchesReceipt, true);
  await writeFile(resolve(f.run.workspace, 'src/new.txt'), 'later');
  assert.equal((await f.controller.status(result.id, 'session')).projectMatchesReceipt, false);
});

test('project integration preserves unrelated concurrent edits and verifies their merged snapshot', async t => {
  const f = await fixture(t, async () => {
    await writeFile(resolve(f.run.workspace, 'src/other.txt'), 'another agent');
    return proposal('good');
  }, fakeRunner, { mode: 'project' });
  const result = await f.controller.drive(f.run.id, 'session');
  assert.equal(result.state, 'passed', result.reason);
  assert.equal(await readFile(resolve(f.run.workspace, 'src/other.txt'), 'utf8'), 'another agent');
  assert.ok(f.store.files(result.snapshot)['src/other.txt']);
});

test('overlapping edits stop without overwrite; stale decisions reject; explicit decision re-verifies', async t => {
  const f = await fixture(t, async () => {
    await writeFile(resolve(f.run.workspace, 'src/value.txt'), 'concurrent');
    return proposal('good');
  }, fakeRunner, { mode: 'project' });
  const result = await f.controller.drive(f.run.id, 'session');
  assert.equal(result.state, 'blocked');
  assert.equal(result.conflicts[0].path, 'src/value.txt');
  assert.equal(await readFile(resolve(f.run.workspace, 'src/value.txt'), 'utf8'), 'concurrent');
  const resolution = { ...result.conflicts[0], take: 'delivery' };
  await assert.rejects(f.controller.resolveConflicts(result.id, 'session', [resolution]), /forbidden/);
  assert.equal((await f.controller.drive(result.id, 'session')).state, 'blocked');
  f.controller.askUser = async ({ questions }) => ({ answers: questions.map(q => ({ id: q.id, selected: ['采用交付版本'] })) });
  await f.controller.resolveConflicts(result.id, 'session');
  const completed = await f.controller.drive(result.id, 'session');
  assert.equal(completed.state, 'passed', completed.reason);
  assert.equal(await readFile(resolve(f.run.workspace, 'src/value.txt'), 'utf8'), 'good');
  assert.equal(completed.workerCalls, 1);
});

test('root imports accepted partial artifacts; integration test failure is repaired before sync', async t => {
  const f = await fixture(t, async () => proposal('good'));
  const child = await f.controller.drive(f.run.id, 'session');
  assert.equal(child.state, 'passed');
  let calls = 0;
  f.controller.worker = async input => {
    assert.equal(input.sourceDeliveries[0].id, child.id);
    assert.equal(Buffer.from(input.files['src/value.txt'], 'base64').toString(), calls ? 'bad' : 'good');
    return proposal(++calls === 1 ? 'bad' : 'good');
  };
  const root = await f.controller.create({ owner: 'session', workspace: f.run.workspace, objective: 'Integrate all work', contract, sourceDeliveryIds: [child.id] });
  const result = await f.controller.drive(root.id, 'session');
  assert.equal(result.state, 'passed', result.reason);
  assert.equal(result.repairCount, 1);
  assert.equal(await readFile(resolve(f.run.workspace, 'src/value.txt'), 'utf8'), 'good');
});

test('independent partial deliveries coexist; foreign, unfinished and tampered sources reject', async t => {
  const f = await fixture(t, async () => proposal('good'));
  const other = await f.controller.create({ owner: 'session', workspace: f.run.workspace, objective: 'Other step', contract, mode: 'partial' });
  await assert.rejects(f.controller.create({ owner: 'session', workspace: f.run.workspace, objective: 'Integrate', contract, sourceDeliveryIds: [other.id] }));
  const child = await f.controller.drive(f.run.id, 'session');
  await assert.rejects(f.controller.create({ owner: 'foreign', workspace: f.run.workspace, objective: 'Integrate', contract, sourceDeliveryIds: [child.id] }));
  await writeFile(resolve(child.artifact, 'src/value.txt'), 'tampered');
  await assert.rejects(f.controller.create({ owner: 'session', workspace: f.run.workspace, objective: 'Integrate', contract, sourceDeliveryIds: [child.id] }));
});

test('project pass cannot be written before synchronization receipt exists', async t => {
  const f = await fixture(t, async () => proposal('good'), fakeRunner, { mode: 'project' });
  f.store.move(f.run, 'implementing'); f.store.move(f.run, 'verify'); f.store.move(f.run, 'verifying');
  assert.throws(() => f.store.move(f.run, 'passed', { evidence: [{ id: 'tests', kind: 'passed', exitCode: 0, snapshot: f.run.snapshot }] }), /synchronization receipt/);
});

test('interrupted post-sync check resumes without repeating implementation or overwriting new values', async t => {
  let checks = 0;
  const f = await fixture(t, async () => proposal('good'), { ...fakeRunner, async check(input) {
    if (++checks === 2) throw new Error('verification interrupted');
    return fakeRunner.check(input);
  } }, { mode: 'project' });
  const interrupted = await f.controller.drive(f.run.id, 'session');
  assert.equal(interrupted.state, 'blocked');
  assert.equal(interrupted.resumeState, 'syncing');
  assert.equal(await readFile(resolve(f.run.workspace, 'src/value.txt'), 'utf8'), 'good');
  const completed = await f.controller.drive(f.run.id, 'session');
  assert.equal(completed.state, 'passed', completed.reason);
  assert.equal(completed.workerCalls, 1);
  assert.equal(f.store.history(f.run.id).filter(e => e.kind === 'sync.file_applied').length, 1);
});

test('modification during acceptance is merged and rechecked before publication', async t => {
  let checks = 0;
  const f = await fixture(t, async () => proposal('good'), { ...fakeRunner, async check(input) {
    if (++checks === 1) await writeFile(resolve(f.run.workspace, 'src/concurrent.txt'), 'concurrent');
    if (checks > 1) assert.ok(input.files['src/concurrent.txt']);
    return fakeRunner.check(input);
  } }, { mode: 'project' });
  const result = await f.controller.drive(f.run.id, 'session');
  assert.equal(result.state, 'passed', result.reason);
  assert.equal(checks, 3);
  assert.equal(await readFile(resolve(f.run.workspace, 'src/concurrent.txt'), 'utf8'), 'concurrent');
});

test('upstream cooldown blocks immediate resume, persists across store reopen and applies to replacement runs', async t => {
  let calls=0;
  const f = await fixture(t, async () => { calls++; throw Object.assign(new Error('Request burst protection; Request id: fixture'), {code:'WORKER_UPSTREAM',upstreamCode:'PI_AI_ERROR',cooldownMs:300000}); });
  const result=await f.controller.drive(f.run.id,'session');
  assert.equal(result.state,'blocked');assert.match(result.reason,/Request id: fixture/);assert.equal(result.upstreamFailures,1);
  await f.controller.drive(f.run.id,'session');assert.equal(calls,1);
  const reopened=f.reopen();f.controller.store=reopened;
  assert.ok(reopened.upstreamBackoff('worker'));
  await f.controller.drive(f.run.id,'session');assert.equal(calls,1);
  f.controller.cancel(f.run.id,'session');
  const replacement=await f.controller.create({owner:'session',workspace:f.run.workspace,objective:'retry',contract,mode:'partial'});
  const blocked=await f.controller.drive(replacement.id,'session');
  assert.equal(blocked.state,'blocked');assert.equal(blocked.workerCalls,0);assert.equal(calls,1);
});

test('a second upstream failure after cooldown ends the delivery without an infinite recovery loop', async t => {
  const f = await fixture(t, async () => { throw Object.assign(new Error('TIMEOUT'), {code:'WORKER_UPSTREAM',upstreamCode:'TIMEOUT',cooldownMs:120000}); });
  await f.controller.drive(f.run.id,'session');
  const blocked=f.store.get(f.run.id);
  f.store.move(blocked,'implement',{retryNotBefore:0});
  f.store.db.prepare('UPDATE upstream_backoff SET until_ms=0').run();
  const result=await f.controller.drive(f.run.id,'session');
  assert.equal(result.state,'failed');assert.equal(result.upstreamFailures,2);
  assert.equal((await f.controller.drive(f.run.id,'session')).workerCalls,2);
});

test('timeout recovery succeeds in the same delivery and retains validation and repair budgets', async t => {
  let calls = 0;
  const f = await fixture(t, async input => {
    if (++calls === 1) throw Object.assign(new Error('idle timeout'), { code: 'WORKER_UPSTREAM', upstreamCode: 'TIMEOUT', executionCount: 0 });
    assert.equal(input.recovery.attempt, 1);
    assert.match(input.recovery.instruction, /complete implementation/);
    return proposal('good');
  }, fakeRunner, { mode: 'project' });
  const result = await f.controller.drive(f.run.id, 'session');
  assert.equal(result.id, f.run.id); assert.equal(result.state, 'passed', result.reason);
  assert.equal(calls, 2); assert.equal(result.executionRetries, 1); assert.equal(result.repairCount, 0);
  assert.ok(result.verifyCalls > 0); assert.equal(result.syncReceipt.verified, true);
  assert.equal(await readFile(resolve(result.workspace, 'src/value.txt'), 'utf8'), 'good');
  assert.equal(f.store.history(result.id).filter(e => e.kind === 'worker.retry_scheduled').length, 1);
});

test('timeout after a tool operation is not automatically replayed', async t => {
  const f = await fixture(t, async () => { throw Object.assign(new Error('timeout after tool'), {
    code: 'WORKER_EXECUTION_TIMEOUT', upstreamCode: 'WORKER_TOOL_DEADLINE', executionCount: 1 }); });
  const result = await f.controller.drive(f.run.id, 'session');
  assert.equal(result.workerCalls, 1); assert.equal(result.state, 'failed');
  assert.equal(result.executionRetries ?? 0, 0);
});

test('caller cancellation cannot enter automatic timeout recovery', async t => {
  const abort = new AbortController();
  const f = await fixture(t, async () => {
    abort.abort(new Error('user stopped'));
    throw Object.assign(new Error('timeout'), { code: 'WORKER_EXECUTION_TIMEOUT', executionCount: 0 });
  });
  const result = await f.controller.drive(f.run.id, 'session', { signal: abort.signal });
  assert.equal(result.state, 'cancelled'); assert.equal(result.workerCalls, 1);
  assert.equal(result.executionRetries ?? 0, 0);
});

test('review timeout retries the same snapshot without regenerating implementation', async t => {
  let reviews = 0;
  const gate = { toolName: 'quality', provider: 'p', model: 'm' };
  const f = await fixture(t, async () => proposal('good'), fakeRunner, { mode: 'project', qualityGate: gate,
    reviewer: async ({ snapshot }) => {
      if (++reviews === 1) throw Object.assign(new Error('review timeout'), { code: 'WORKER_EXECUTION_TIMEOUT' });
      return { status: 'passed', provider: 'p', model: 'm', snapshot, evidence: ['inspected output'] };
    } });
  const result = await f.controller.drive(f.run.id, 'session');
  assert.equal(result.state, 'passed', result.reason); assert.equal(result.workerCalls, 1);
  assert.equal(result.qualityRetries, 1); assert.equal(result.syncReceipt.verified, true);
});

test('exhausted automatic review recovery terminates without regenerating or synchronizing', async t => {
  let reviews = 0;
  const f = await fixture(t, async () => proposal('good'), fakeRunner, { mode: 'project', qualityGate: { provider: 'p', model: 'm' },
    reviewer: async () => { reviews++; throw Object.assign(new Error('review timeout'), { code: 'WORKER_EXECUTION_TIMEOUT' }); } });
  const result = await f.controller.drive(f.run.id, 'session');
  assert.equal(result.state, 'failed'); assert.equal(result.reasonCode, 'QUALITY_TIMEOUT_RETRIES_EXHAUSTED');
  assert.equal(result.workerCalls, 1); assert.equal(reviews, 2); assert.equal(result.syncReceipt, undefined);
  assert.equal((await f.controller.drive(f.run.id, 'session')).workerCalls, 1);
  assert.equal(await readFile(resolve(result.workspace, 'src/value.txt'), 'utf8'), 'bad');
});

test('on-request review never delays file delivery; timeout preserves receipt and file', async t => {
  let reviews = 0;
  const f = await fixture(t, async () => proposal('good'), fakeRunner, { mode: 'project', reviewPolicy: 'on_request',
    qualityGate: { ...qualityGate, timeoutMs: 15 }, reviewer: async ({ signal, context }) => {
      reviews++;
      assert.deepEqual(JSON.parse(context).changedPaths, ['src/value.txt']);
      assert.equal(await readFile(resolve(f.run.workspace, 'src/value.txt'), 'utf8'), 'good');
      // A nonresponsive upstream must not defeat the controller deadline.
      return new Promise(() => {});
    } });
  const delivered = await f.controller.drive(f.run.id, 'session');
  assert.equal(delivered.state, 'passed');
  assert.equal(reviews, 0);
  assert.equal(delivered.qualityGate, null);
  const receipt = delivered.syncReceipt;
  const reviewed = await f.controller.review(f.run.id, 'session');
  assert.equal(reviews, 1);
  assert.equal(reviewed.state, 'passed');
  assert.equal(reviewed.review.status, 'incomplete');
  assert.equal(reviewed.review.reasonCode, 'REVIEW_TIMEOUT');
  assert.deepEqual(reviewed.syncReceipt, receipt);
  assert.equal(reviewed.workerCalls, 1);
  assert.equal(await readFile(resolve(f.run.workspace, 'src/value.txt'), 'utf8'), 'good');
  const reopened = f.reopen();
  const restored = new DeliveryController({ store: reopened });
  assert.equal((await restored.status(f.run.id, 'session')).review.reasonCode, 'REVIEW_TIMEOUT');
});

test('on-request review failure and stale evidence cannot change delivery state or trigger repairs', async t => {
  const f = await fixture(t, async () => proposal('good'), fakeRunner, { mode: 'project', reviewPolicy: 'on_request',
    qualityGate, reviewer: async ({ snapshot }) => qualityReport(snapshot, 'failed') });
  await assert.rejects(f.controller.review(f.run.id, 'session'), /already completed/);
  await f.controller.drive(f.run.id, 'session');
  await assert.rejects(f.controller.review(f.run.id, 'foreign'), /not found/);
  let result = await f.controller.review(f.run.id, 'session');
  assert.equal(result.review.status, 'failed');
  assert.equal(result.state, 'passed');
  assert.equal(result.repairCount, 0);
  f.controller.reviewer = async () => qualityReport('stale');
  result = await f.controller.review(f.run.id, 'session');
  assert.equal(result.review.status, 'incomplete');
  assert.equal(result.state, 'passed');
  assert.equal(result.workerCalls, 1);
  const abort = new AbortController(); abort.abort(new Error('Stop review'));
  result = await f.controller.review(f.run.id, 'session', { signal: abort.signal });
  assert.equal(result.review.reasonCode, 'REVIEW_CANCELLED');
  assert.equal(result.state, 'passed');
});

test('optional model review still requires local tests and immutable delivery policy', async t => {
  const f = await fixture(t, async () => proposal('bad'), fakeRunner, { mode: 'project', reviewPolicy: 'on_request', qualityGate });
  assert.throws(() => f.store.move(f.run, 'implementing', { reviewPolicy: 'required' }), /Immutable/);
  const result = await f.controller.drive(f.run.id, 'session');
  assert.equal(result.state, 'failed');
  assert.equal(result.repairCount, 2);
  assert.equal(result.syncReceipt, undefined);
  assert.equal(await readFile(resolve(f.run.workspace, 'src/value.txt'), 'utf8'), 'bad');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Store } from '../store.mjs';
import { DeliveryController } from '../controller.mjs';
import { validateTasks } from '../task-contracts.mjs';
const b64 = s => Buffer.from(s).toString('base64');
const contract = { version: 1, editablePaths: ['src/'], protectedPaths: ['tests/'], requiredPaths: ['tests/'], maxRepairs: 1,
  checks: [{ id: 'unit', argv: ['node', '--test'], timeoutMs: 1000 }, { id: 'integration', argv: ['node', '--test'], timeoutMs: 1000 }] };
const task = (id, dependsOn = []) => ({ id, objective: 'Implement '+id, context: 'Only this task context '+id,
  interfaces: ['export '+id], acceptanceCriteria: ['correct '+id], editablePaths: ['src/'+id], dependsOn, checkIds: ['unit'] });
const proposal = (path, content) => ({ summary: 'actual implementation', changes: [{ path, operation: 'write', content }] });
const runner = { async preflight() {}, async check({ check, snapshot }) { return { id: check.id, snapshot, kind: 'passed', exitCode: 0 }; } };
async function fixture(t, worker, options = {}) {
  const base = await mkdtemp(resolve(tmpdir(), 'coordination-'));
  const workspace = resolve(base, 'project'); await mkdir(resolve(workspace, 'src'), { recursive: true }); await mkdir(resolve(workspace, 'tests'));
  await writeFile(resolve(workspace, 'src/a'), 'base'); await writeFile(resolve(workspace, 'tests/test.cjs'), 'trusted');
  const store = new Store(resolve(base, 'state'));
  const controller = new DeliveryController({ store, worker, runner, ...options });
  t.after(async () => { store.close(); await rm(base, { recursive: true, force: true }); });
  const create = input => controller.create({ owner: 'root', workspace, objective: 'Whole project', contract, ...input });
  return { store, controller, workspace, create };
}
test('registered tasks run in dependency order with scoped context and mandatory root integration', async t => {
  const calls = [];
  const f = await fixture(t, async input => {
    const key = input.taskContext?.id;
    calls.push(key ?? 'root');
    if (key) {
      assert.equal(input.contract.checks.length, 1);
      assert.equal(input.taskContext.context, 'Only this task context '+key);
      assert.deepEqual(input.contract.editablePaths, ['src/'+key]);
      if (key === 'b') { assert.equal(input.files['src/a'], b64('a')); assert.equal(input.sourceDeliveries.length, 1); }
      return proposal('src/'+key, key);
    }
    assert.equal(input.sourceDeliveries.length, 2);
    assert.equal(input.files['src/a'], b64('a')); assert.equal(input.files['src/b'], b64('b'));
    return proposal('src/integrated', 'root reviewed');
  });
  const run = await f.create({ tasks: [task('a'), task('b', ['a'])] });
  assert.equal(run.state, 'collecting');
  await assert.rejects(f.controller.drive(run.tasks[0].runId, 'root'), /owning controller/);
  const result = await f.controller.drive(run.id, 'root');
  assert.equal(result.state, 'passed', result.reason);
  assert.deepEqual(calls, ['a', 'b', 'root']);
  assert.equal(await readFile(resolve(f.workspace, 'src/integrated'), 'utf8'), 'root reviewed');
  for (const spec of result.tasks) { const child = f.store.get(spec.runId); assert.equal(child.parentId, run.id); assert.equal(child.mode, 'partial'); }
});
test('manifest and identity cannot be rewritten; omitted or failed required tasks block root and synchronization', async t => {
  let rootCalls = 0;
  const f = await fixture(t, async input => {
    if (!input.taskContext) rootCalls++;
    return proposal('tests/test.cjs', 'try to bypass');
  });
  const run = await f.create({ tasks: [task('a'), task('b')] });
  assert.throws(() => f.store.move(run, 'implement', { tasks: [] }), /Immutable/);
  assert.throws(() => f.store.move(run, 'implement', { sourceDeliveries: [] }), /Required task/);
  const child = f.store.get(run.tasks[0].runId);
  assert.throws(() => f.store.move(child, 'implement', { parentId: 'different' }), /Immutable/);
  const result = await f.controller.drive(run.id, 'root');
  assert.equal(result.state, 'blocked'); assert.equal(rootCalls, 0);
  assert.equal(await readFile(resolve(f.workspace, 'src/a'), 'utf8'), 'base');
  await assert.rejects(f.create({ objective: 'Skip unfinished parent' }), /unfinished/);
  assert.throws(() => f.controller.cancel(child.id, 'root'), /owning delivery/);
});
test('task schema rejects missing context, cycle, scope escalation and invented check commands', () => {
  for (const tasks of [[{ ...task('a'), context: '' }], [task('a', ['b']), task('b', ['a'])],
    [{ ...task('a'), editablePaths: ['tests/'] }], [{ ...task('a'), checkIds: ['skip-tests'] }],
    [{ ...task('a'), checks: [{ argv: ['true'] }] }]]) assert.throws(() => validateTasks(tasks, contract));
});
async function conflict(t, askUser) {
  let f;
  f = await fixture(t, async () => { await writeFile(resolve(f.workspace, 'src/a'), 'other writer'); return proposal('src/a', 'delivery'); }, { askUser });
  const run = await f.create({});
  const result = await f.controller.drive(run.id, 'root');
  assert.equal(result.state, 'blocked'); assert.ok(result.conflicts.length);
  return { ...f, run: result };
}
test('forged decisions, direct state transitions, missing provider and incomplete answers cannot unblock', async t => {
  const f = await conflict(t);
  await assert.rejects(f.controller.resolveConflicts(f.run.id, 'root', { resolutions: [{ take: 'delivery' }] }), /forbidden/);
  assert.throws(() => f.store.move(f.run, 'verify', { conflicts: null, decisionId: 'forged' }), /Trusted user/);
  await assert.rejects(f.controller.resolveConflicts(f.run.id, 'root'), /unavailable/);
  for (const answer of [{ answers: [] }, { answers: [{ id: 'wrong', selected: ['采用交付版本'] }] }]) {
    f.controller.askUser = async () => answer;
    await assert.rejects(f.controller.resolveConflicts(f.run.id, 'root'), /decision/);
  }
  assert.equal((await f.controller.drive(f.run.id, 'root')).state, 'blocked');
  assert.equal(await readFile(resolve(f.workspace, 'src/a'), 'utf8'), 'other writer');
});
test('host answer binds to run/version, rejects changes while waiting, and is consumed once', async t => {
  const f = await conflict(t);
  f.controller.askUser = async ({ questions }) => {
    await writeFile(resolve(f.workspace, 'src/a'), 'third version');
    return { answers: questions.map(q => ({ id: q.id, selected: ['采用交付版本'] })) };
  };
  await assert.rejects(f.controller.resolveConflicts(f.run.id, 'root'), /changed while awaiting/);
  assert.equal(await readFile(resolve(f.workspace, 'src/a'), 'utf8'), 'third version');
  f.controller.askUser = async ({ questions }) => ({ answers: questions.map(q => ({ id: q.id, selected: ['采用交付版本'] })) });
  await f.controller.resolveConflicts(f.run.id, 'root');
  const decision = f.store.db.prepare("SELECT * FROM decisions WHERE state='consumed'").get();
  assert.ok(decision); assert.equal(decision.owner, 'root'); assert.equal(decision.run, f.run.id);
  await assert.rejects(f.controller.resolveConflicts(f.run.id, 'root'), /No resolvable/);
  const completed = await f.controller.drive(f.run.id, 'root');
  assert.equal(completed.state, 'passed', completed.reason);
  assert.equal(await readFile(resolve(f.workspace, 'src/a'), 'utf8'), 'delivery');
});
test('cancelled and custom user answers never become authorization', async t => {
  const f = await conflict(t);
  const abort = new AbortController();
  f.controller.askUser = async ({ questions }) => { abort.abort(); return { answers: questions.map(q => ({ id: q.id, selected: ['采用交付版本'] })) }; };
  await assert.rejects(f.controller.resolveConflicts(f.run.id, 'root', { signal: abort.signal }));
  f.controller.askUser = async ({ questions }) => ({ answers: questions.map(q => ({ id: q.id, selected: ['采用交付版本'], custom: 'actually do something else' })) });
  await assert.rejects(f.controller.resolveConflicts(f.run.id, 'root'), /explicit option/);
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM decisions WHERE state='consumed'").get().n, 0);
});

test('independent registered tasks execute strictly one at a time in manifest order', async t => {
  let active = 0, maximum = 0, release;
  const calls = [];
  const f = await fixture(t, async input => {
    if (!input.taskContext) return { summary: 'integrated', changes: [] };
    const id = input.taskContext.id;
    calls.push(id);
    maximum = Math.max(maximum, ++active);
    await Promise.resolve();
    active--;
    return proposal('src/'+id, id);
  });
  const run = await f.create({ tasks: ['a','b','c','d'].map(id => task(id)) });
  const result = await f.controller.drive(run.id, 'root');
  assert.equal(result.state, 'passed', result.reason); assert.equal(maximum, 1);
  assert.deepEqual(calls, ['a', 'b', 'c', 'd']);
});
test('conflicts while combining partial artifacts persist and require a host decision', async t => {
  let value = 'first';
  const f = await fixture(t, async input => input.sourceDeliveries.length ? { summary: 'integrated', changes: [] } : proposal('src/a', value), {
    askUser: async ({ questions }) => ({ answers: questions.map(q => ({ id: q.id, selected: ['采用交付版本'] })) }),
  });
  const first = await f.create({ mode: 'partial' }); await f.controller.drive(first.id, 'root');
  value = 'second'; const second = await f.create({ mode: 'partial' }); await f.controller.drive(second.id, 'root');
  const root = await f.create({ sourceDeliveryIds: [first.id, second.id] });
  const blocked = await f.controller.drive(root.id, 'root');
  assert.equal(blocked.state, 'blocked'); assert.equal(blocked.resumeState, 'collecting');
  assert.equal(blocked.conflictInput.sourceId, second.id);
  await f.controller.resolveConflicts(root.id, 'root');
  const result = await f.controller.drive(root.id, 'root');
  assert.equal(result.state, 'passed', result.reason);
  assert.equal(await readFile(resolve(f.workspace, 'src/a'), 'utf8'), 'second');
});
test('tampering with a passed required task blocks dependent work and root completion', async t => {
  let f, rootCalls = 0;
  f = await fixture(t, async input => {
    if (!input.taskContext) { rootCalls++; return { summary: 'root', changes: [] }; }
    if (input.taskContext.id === 'b') {
      const source = f.store.get(input.sourceDeliveries[0].id);
      await writeFile(resolve(source.artifact, 'src/a'), 'tampered');
    }
    return proposal('src/'+input.taskContext.id, 'correct');
  });
  const root = await f.create({ tasks: [task('a'), task('b', ['a'])] });
  const result = await f.controller.drive(root.id, 'root');
  assert.equal(result.state, 'blocked'); assert.equal(rootCalls, 0);
  assert.equal(await readFile(resolve(f.workspace, 'src/a'), 'utf8'), 'base');
  await assert.rejects(f.create({ mode: 'partial', sourceDeliveryIds: [root.tasks[0].runId] }), /Source must/);
});

test('caller cancellation cascades to queued children and releases the project reservation', async t => {
  const abort = new AbortController();
  const f = await fixture(t, async ({ signal }) => { abort.abort(new Error('user stopped')); signal.throwIfAborted(); });
  const root = await f.create({ tasks: [task('a'), task('b')] });
  const result = await f.controller.drive(root.id, 'root', { signal: abort.signal });
  assert.equal(result.state, 'cancelled');
  for (const spec of result.tasks) assert.equal(f.store.get(spec.runId).state, 'cancelled');
  const replacement = await f.create({});
  assert.equal(replacement.state, 'implement');
});

test('cancelling a conflicted delivery rejects its outstanding host decisions', async t => {
  const f = await conflict(t);
  f.store.openDecision('decision-to-cancel', f.run, { current: { a: 'current' }, proposed: { a: 'proposed' } }, [{ id: 'q', options: [] }]);
  const result = f.controller.cancel(f.run.id, 'root');
  assert.equal(result.state, 'cancelled');
  assert.equal(f.store.db.prepare('SELECT state FROM decisions WHERE id=?').get('decision-to-cancel').state, 'rejected');
});

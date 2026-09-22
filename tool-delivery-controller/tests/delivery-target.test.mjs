import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { resolveDeliveryTarget } from '../delivery-target.mjs';
import { Store } from '../store.mjs';
import { DeliveryController } from '../controller.mjs';
import { applyProposal } from '../files.mjs';
import { resolveToolPath } from '../workspace.mjs';
import { deliverySummary } from '../index.mjs';
const contract = { version: 1, editablePaths: ['src/'], protectedPaths: ['tests/', 'package.json'], requiredPaths: ['tests/'], checks: [{ id: 'node-tests', argv: ['node', '--test'], timeoutMs: 1000 }], maxRepairs: 2 };
const task = paths => ({ id: 'fix', objective: 'Fix', context: 'Rules', interfaces: [], acceptanceCriteria: ['Pass'], editablePaths: paths, dependsOn: [] });
async function fixture(t) {
  const base = await realpath(await mkdtemp(resolve(tmpdir(), 'delivery-target-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const cwd = resolve(base, 'session'); await mkdir(cwd);
  async function project(name) {
    const root = resolve(cwd, name); await mkdir(resolve(root, 'src'), { recursive: true }); await mkdir(resolve(root, 'tests'));
    await writeFile(resolve(root, 'src/value.cjs'), 'old'); await writeFile(resolve(root, 'tests/public.test.cjs'), 'protected'); return root;
  }
  return { base, cwd, project };
}
test('exported-session layout resolves nested project, both path spellings, and exact destination', async t => {
  const f = await fixture(t); const project = await f.project('demo1-candidate');
  for (const paths of [['demo1-candidate/src/value.cjs'], ['src/value.cjs']]) {
    const target = await resolveDeliveryTarget(f.cwd, contract, { projectRoot: 'demo1-candidate', tasks: [task(paths)] });
    assert.equal(target.workspace, project); assert.equal(target.deliveryDirectory, project);
    assert.deepEqual(target.tasks[0].editablePaths, ['src/value.cjs']); assert.deepEqual(target.checkIds, ['node-tests']);
  }
  const direct = await resolveDeliveryTarget(project, contract);
  assert.equal(direct.projectRoot, '.');
  await assert.rejects(resolveDeliveryTarget(f.cwd, contract, { tasks: [{ ...task(['src/value.cjs']), checkIds: ['node --test tests/public.test.cjs'] }] }), /node-tests/);
  await assert.rejects(resolveDeliveryTarget(f.cwd, contract, { tasks: [task(['demo1-candidate/tests/public.test.cjs'])] }), /scope exceeds/);
});
test('multiple projects keep session cwd; outside, traversal, symlink and missing explicit targets are rejected', async t => {
  const f = await fixture(t); await f.project('a'); await f.project('b');
  assert.equal((await resolveDeliveryTarget(f.cwd, contract)).workspace, f.cwd);
  assert.equal((await resolveDeliveryTarget(f.cwd, contract, { projectRoot: 'b' })).projectRoot, 'b');
  assert.equal((await resolveDeliveryTarget(f.cwd, { ...contract, editablePaths: ['**'] }, { tasks: [task(['a/src/value.cjs'])] })).projectRoot, '.');
  for (const projectRoot of ['../session/a', f.base, 'a/../b']) await assert.rejects(resolveDeliveryTarget(f.cwd, contract, { projectRoot }), /Unsafe relative/);
  await symlink(resolve(f.cwd, 'a'), resolve(f.cwd, 'link'));
  await assert.rejects(resolveDeliveryTarget(f.cwd, contract, { projectRoot: 'link' }), /PATH_REJECTED/);
  await assert.rejects(resolveDeliveryTarget(f.cwd, contract, { projectRoot: 'missing' }), { code: 'ENOENT' });
  assert.equal((await resolveDeliveryTarget(f.cwd, { ...contract, requiredPaths: [] }, { singleHtmlPath: 'out.html' })).workspace, f.cwd);
});
test('nested delivery implementation, review, status and sync share one destination; parent stays intact', async t => {
  const f = await fixture(t); const project = await f.project('demo1-candidate');
  await writeFile(resolve(f.cwd, 'untouched.txt'), 'parent');
  const target = await resolveDeliveryTarget(f.cwd, contract, { projectRoot: 'demo1-candidate' });
  const store = new Store(resolve(f.base, 'state')); t.after(() => store.close());
  let checks = 0, reviews = 0;
  const controller = new DeliveryController({ store, worker: async input => {
    assert.equal(input.deliveryDirectory, project);
    assert.ok(input.files['src/value.cjs']); assert.equal(input.files['untouched.txt'], undefined);
    const isolated = { root: '/isolated', scratch: '/scratch', projectRoots: [input.deliveryDirectory] };
    assert.equal(resolveToolPath(isolated, resolve(project, 'src/value.cjs')).target, '/isolated/src/value.cjs');
    assert.throws(() => resolveToolPath(isolated, resolve(f.cwd, 'untouched.txt')), /PATH_OUTSIDE/);
    assert.throws(() => applyProposal(input.files, { summary: 'bad', changes: [{ path: 'tests/public.test.cjs', operation: 'write', content: 'bad' }] }, contract), /outside|protected|scope|allowed/i);
    return { summary: 'fixed', changes: [{ path: 'src/value.cjs', operation: 'write', content: 'fixed' }] };
  }, runner: { async preflight() {}, async check({ snapshot, check, files }) { checks++; assert.ok(files['tests/public.test.cjs']); return { id: check.id, snapshot, kind: 'passed', exitCode: 0 }; } },
  qualityGate: { model: 'm', provider: 'p' }, reviewer: async input => { reviews++; assert.equal(input.deliveryDirectory, project); return { status: 'passed', model: 'm', provider: 'p', snapshot: input.snapshot, summary: 'ok', evidence: ['Inspected changed implementation'] }; } });
  const run = await controller.create({ owner: 's', workspace: target.workspace, objective: 'Fix value', contract, mode: 'project' });
  const result = await controller.drive(run.id, 's'); assert.equal(result.state, 'passed', result.reason);
  assert.ok(checks > 0); assert.ok(reviews > 0);
  assert.equal(deliverySummary(result).deliveryDirectory, project);
  assert.equal(await readFile(resolve(project, 'src/value.cjs'), 'utf8'), 'fixed');
  assert.equal(await readFile(resolve(project, 'tests/public.test.cjs'), 'utf8'), 'protected');
  assert.equal(await readFile(resolve(f.cwd, 'untouched.txt'), 'utf8'), 'parent');
  await assert.rejects(readFile(resolve(f.cwd, 'src/value.cjs')), { code: 'ENOENT' });
});

test('general deployment has no required layout or test command; arbitrary files sync without invented tests', async t => {
  const f = await fixture(t);
  const general = JSON.parse(await readFile(new URL('../../delivery-contract.json', import.meta.url), 'utf8'));
  assert.deepEqual(general.requiredPaths, []); assert.deepEqual(general.checks, []);
  const store = new Store(resolve(f.base, 'state')); t.after(() => store.close());
  const controller = new DeliveryController({ store, worker: async () => ({ summary: 'created', changes: [{ path: 'notes.txt', operation: 'write', content: 'hello' }] }),
    runner: { async preflight() {}, async check() { throw new Error('No configured checks should execute'); } },
    qualityGate: { model: 'm', provider: 'p' }, reviewer: async ({ snapshot }) => ({ status: 'passed', model: 'm', provider: 'p', snapshot, summary: 'reviewed text', evidence: ['Read notes.txt; no automated tests applicable'] }) });
  const target = await resolveDeliveryTarget(f.cwd, general);
  const run = await controller.create({ owner: 's', workspace: target.workspace, objective: 'Create notes', contract: general, mode: 'project' });
  const result = await controller.drive(run.id, 's'); assert.equal(result.state, 'passed', result.reason);
  assert.deepEqual(result.evidence, []);
  assert.equal(deliverySummary(result).verification.automatedChecks, 'not_configured');
  assert.equal(await readFile(resolve(f.cwd, 'notes.txt'), 'utf8'), 'hello');
  assert.throws(() => applyProposal({}, { summary: 'escape', changes: [{ path: '../outside', operation: 'write', content: 'bad' }] }, general), /Unsafe/);
});

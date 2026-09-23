import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { compileTask, validationSummary } from '../task-ir.mjs';
import { validateTasks } from '../task-contracts.mjs';
import { applyProposal } from '../files.mjs';
import { Store } from '../store.mjs';
import { DeliveryController } from '../controller.mjs';
import { resolveDeliveryTarget } from '../delivery-target.mjs';
import { deliverySummary } from '../index.mjs';

const deployment = { version: 1, layout: 'workspace', editablePaths: ['**'], protectedPaths: [], requiredPaths: [], checks: [], maxRepairs: 0 };
const task = { id: 'fix', objective: 'Fix refund', context: 'Preserve API', interfaces: ['refund'],
  acceptanceCriteria: ['Refund is idempotent'], editablePaths: ['src/'], dependsOn: [], checkIds: ['public-tests'] };
const compile = options => compileTask({ goal: 'Fix refunds', projectRoot: '/project', deployment, ...options });

test('IR is descriptive, accepts document constraints and cannot inject plans, resources or executable checks', () => {
  const input = { constraints: { runtime: 'Node 18+', module: 'CommonJS', externalDependencies: false },
    editablePaths: ['src/**'], protectedPaths: ['tests/**'], requiredInterfaces: ['quote', 'refund'], deliverables: ['src/refund.cjs'] };
  const result = compile({ context: input });
  assert.deepEqual(result.taskIR.constraints, input.constraints);
  assert.deepEqual(result.contract.editablePaths, ['src/']);
  assert.deepEqual(result.contract.protectedPaths, ['tests/']);
  assert.deepEqual(result.tasks, []);
  for (const key of ['steps', 'executor', 'availableChecks', 'availableModels', 'availableTools', 'checks', 'checkIds', 'capabilities'])
    assert.throws(() => compile({ context: { [key]: [] } }), /Unsupported Task IR field/);
  assert.throws(() => compile({ context: { constraints: { runtime: { steps: [] } } } }), /constraints/);
});

test('unknown check references become visible text acceptance, never executable commands or passes', () => {
  const result = compile({ tasks: [task] });
  assert.deepEqual(result.contract.checkIds, []);
  assert.deepEqual(result.tasks[0].checkIds, []);
  assert.ok(result.taskIR.validation.some(v => v.requestedCheckId === 'public-tests' && v.kind === 'text'));
  assert.ok(validationSummary({ taskIR: result.taskIR, evidence: [], snapshot: 's' }).every(v => v.status === 'not_verified'));
  assert.throws(() => validateTasks([task], deployment), /deployment contract/);
  assert.throws(() => compile({ tasks: [{ ...task, checkIds: ['node --test'] }] }), /check id/);
  assert.throws(() => compile({ tasks: [{ ...task, checks: [{ argv: ['node', '-e', 'malicious()'] }] }] }), /task contract/);
});

test('compiler retains deployment checks, binds exact IDs and narrows paths with actual rejection', () => {
  const check = { id: 'public-tests', argv: ['node', '--test'], timeoutMs: 1000 };
  const result = compile({ deployment: { ...deployment, editablePaths: ['src/'], protectedPaths: ['src/private/'], checks: [check] },
    context: { protectedPaths: ['src/locked.cjs'], acceptanceCriteria: ['public-tests'] }, tasks: [{ ...task, editablePaths: ['src/refund.cjs'] }] });
  assert.deepEqual(result.contract.checkIds, ['public-tests']);
  assert.deepEqual(result.contract.checks, [check]);
  assert.deepEqual(result.tasks[0].checkIds, ['public-tests']);
  for (const path of ['tests/test.cjs', 'src/locked.cjs', 'src/private/secret.cjs'])
    assert.throws(() => applyProposal({}, { summary: 'bypass', changes: [{ path, operation: 'write', content: 'bad' }] }, result.contract), /Protected path/);
  assert.throws(() => compile({ deployment: { ...deployment, editablePaths: ['src/'] }, context: { editablePaths: ['**'] } }), /scope exceeds/);
  assert.throws(() => compile({ context: { protectedPaths: ['../tests'] } }), /Unsafe/);
  const run = { taskIR: result.taskIR, snapshot: 'new', evidence: [{ id: 'public-tests', snapshot: 'old', kind: 'passed', exitCode: 0 }] };
  assert.equal(validationSummary(run)[0].status, 'not_verified');
  run.evidence[0].snapshot = 'new';
  assert.equal(validationSummary(run)[0].status, 'passed');
  run.evidence[0].kind = 'blocked';
  assert.equal(validationSummary(run)[0].status, 'not_verified');
});

test('context preview and real execution compile the same IR, persist it, pass it to workers and expose pending acceptance', async t => {
  const base = await realpath(await mkdtemp(resolve(tmpdir(), 'task-ir-')));
  t.after(() => rm(base, { force: true, recursive: true }));
  const workspace = resolve(base, 'project');
  await mkdir(resolve(workspace, 'src'), { recursive: true });
  await mkdir(resolve(workspace, 'tests'));
  await writeFile(resolve(workspace, 'tests/public.cjs'), 'protected');
  const context = { protectedPaths: ['tests/**'], requiredInterfaces: ['refund'], acceptanceCriteria: ['public-tests'] };
  const resources = { models: [{ executor: 'worker', model: 'test-model' }], tools: ['read', 'write'] };
  const target = await resolveDeliveryTarget(workspace, deployment, { goal: 'Fix refunds', context, tasks: [task], resources });
  let store = new Store(resolve(base, 'state'));
  t.after(() => store.close());
  const controller = new DeliveryController({ store, reviewPolicy: 'on_request', worker: async input => {
    assert.equal(input.taskIR.goal, input.objective);
    assert.deepEqual(input.taskIR.protectedPaths, ['tests/']);
    assert.throws(() => applyProposal(input.files, { summary: 'bad', changes: [{ path: 'tests/public.cjs', operation: 'write', content: 'bad' }] }, input.contract), /Protected/);
    return { summary: 'fixed', changes: [{ path: 'src/refund.cjs', operation: 'write', content: 'exports.refund = () => 1;' }] };
  }, runner: { async preflight() {}, async check() { assert.fail('No invented check may execute'); } } });
  const run = await controller.create({ owner: 'root', workspace, objective: 'Fix refunds', contract: deployment, context, tasks: [task], resources });
  assert.deepEqual(run.taskIR, target.taskIR);
  assert.deepEqual(run.contract, target.deploymentContract);
  assert.throws(() => store.move(run, 'blocked', { taskIR: { goal: 'replace' } }), /Immutable/);
  const finished = await controller.drive(run.id, 'root');
  assert.equal(finished.state, 'passed', finished.reason);
  const summary = deliverySummary(finished);
  assert.equal(summary.acceptanceComplete, false);
  assert.equal(summary.nextAction, 'root_acceptance_required');
  assert.ok(summary.acceptance.some(v => v.requestedCheckId === 'public-tests' && v.status === 'not_verified'));
  assert.equal(await readFile(resolve(workspace, 'tests/public.cjs'), 'utf8'), 'protected');
  assert.ok(store.history(run.id).some(e => e.kind === 'contract.compiled'));
  store.close(); store = new Store(resolve(base, 'state'));
  assert.deepEqual(store.get(run.id, 'root').taskIR, run.taskIR);
});

test('empty child check selection cannot bypass parent deployment verification or publish failing output', async t => {
  const base = await realpath(await mkdtemp(resolve(tmpdir(), 'task-ir-gate-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const workspace = resolve(base, 'project'); await mkdir(workspace);
  const store = new Store(resolve(base, 'state')); t.after(() => store.close());
  let checks = 0;
  const controller = new DeliveryController({ store, reviewPolicy: 'on_request',
    worker: async () => ({ summary: 'claim passed', changes: [{ path: 'src/refund.cjs', operation: 'write', content: 'broken' }] }),
    runner: { async preflight() {}, async check({ check, snapshot }) { checks++; return { id: check.id, snapshot, kind: 'failed', exitCode: 1 }; } } });
  const run = await controller.create({ owner: 'root', workspace, objective: 'Fix refunds',
    contract: { ...deployment, checks: [{ id: 'public-tests', argv: ['node', '--test'], timeoutMs: 1000 }] },
    context: { acceptanceCriteria: ['public-tests'] }, tasks: [{ ...task, checkIds: [] }] });
  const result = await controller.drive(run.id, 'root');
  assert.equal(result.state, 'failed', result.reason);
  assert.equal(checks, 1);
  assert.equal(deliverySummary(result).acceptance[0].status, 'failed');
  await assert.rejects(readFile(resolve(workspace, 'src/refund.cjs')), { code: 'ENOENT' });
});

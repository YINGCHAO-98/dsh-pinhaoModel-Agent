import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Store } from '../store.mjs';
import { DeliveryController } from '../controller.mjs';
import { validateProductDesign, normalizeProductDesignReport, designReceipt } from '../product-design.mjs';
import { deliveryTodos } from '../progress.mjs';

const designGate = { toolName: 'task_minimax_design', provider: 'doubao', model: 'minimax-m3', readOnly: true };
const qualityGate = { toolName: 'task_kimi_quality', provider: 'doubao', model: 'kimi-k2-8-preview', readOnly: true };
const plan = { goal: 'Fix the user-facing value', users: ['Existing user'], scope: ['value.txt only'],
  userFlows: ['Read the corrected value'], implementation: ['Change the value without changing its public format'],
  acceptanceCriteria: ['value.txt contains good'], risks: ['Small local change'], assumptions: ['Preserve public format'], riskLevel: 'low' };
const reportFor = (run, risk = 'low') => ({ ...designGate, capability: 'product_design', status: 'passed',
  snapshot: run.baseSnapshot, artifactRef: 'report:11111111-1111-4111-8111-111111111111', designPlan: { ...plan, riskLevel: risk } });
const contract = { version: 1, layout: 'workspace', editablePaths: ['**'], protectedPaths: [], requiredPaths: [], maxRepairs: 1, checks: [] };
const proposal = (content = 'good') => ({ summary: 'Implemented', changes: [{ path: 'value.txt', operation: 'write', content }] });

async function fixture(t, options = {}, create = {}) {
  const base = await mkdtemp(resolve(tmpdir(), 'product-design-'));
  const workspace = resolve(base, 'project'); await mkdir(workspace);
  await writeFile(resolve(workspace, 'value.txt'), 'old');
  const store = new Store(resolve(base, 'state'));
  t.after(async () => { store.close(); await rm(base, { recursive: true, force: true }); });
  const calls = [];
  let report;
  const controller = new DeliveryController({ store, designGate, qualityGate, reviewPolicy: 'risk_based',
    runner: { async preflight() {}, async check({ check, snapshot, files }) {
      const passed = Buffer.from(files['value.txt'], 'base64').toString() === 'good';
      return { id: check.id, snapshot, kind: passed ? 'passed' : 'failed', exitCode: passed ? 0 : 1 };
    } },
    designer: async ({ run }) => { calls.push('design'); return report = reportFor(run); },
    readDesign: async () => report,
    worker: async input => { calls.push(input.phase); assert.ok(input.productDesign.plan.acceptanceCriteria.length); return proposal(); },
    reviewer: async ({ snapshot }) => { calls.push('review'); return { ...qualityGate, snapshot, status: 'passed', evidence: ['Actual fixture check'] }; },
    ...options,
  });
  const run = await controller.create({ owner: 'root', workspace, objective: 'Fix the value', contract, ...create });
  return { controller, store, run, calls, workspace };
}

test('product design precedes implementation, is persisted and appears in progress', async t => {
  const f = await fixture(t);
  assert.equal(f.run.state, 'design');
  assert.ok(deliveryTodos(f.run).some(item => item.content.includes('产品设计方案') && item.status === 'in_progress'));
  const result = await f.controller.drive(f.run.id, 'root');
  assert.equal(result.state, 'passed', result.reason);
  assert.deepEqual(f.calls, ['design', 'implement']);
  assert.equal(result.productDesign.plan.goal, plan.goal);
  assert.deepEqual(f.store.get(result.id).productDesign, result.productDesign);
  assert.equal(await readFile(resolve(f.workspace, 'value.txt'), 'utf8'), 'good');
  assert.ok(f.store.history(result.id).some(event => event.kind === 'design.accepted'));
});

test('design failures cannot dispatch or synchronize; explicit resume is bounded to two attempts', async t => {
  let calls = 0;
  const f = await fixture(t, { designer: async () => { calls++; throw new Error('Designer unavailable'); } });
  assert.equal((await f.controller.drive(f.run.id, 'root')).state, 'blocked');
  assert.equal(await readFile(resolve(f.workspace, 'value.txt'), 'utf8'), 'old');
  const result = await f.controller.drive(f.run.id, 'root');
  assert.equal(result.state, 'failed');
  await f.controller.drive(f.run.id, 'root');
  assert.equal(calls, 2); assert.deepEqual(f.calls, []);
});

test('accepted design clears an earlier timeout reason after resume', async t => {
  let attempts = 0;
  let report;
  const f = await fixture(t, { designer: async ({ run }) => {
    if (++attempts === 1) throw new Error('Designer timed out');
    return report = reportFor(run);
  }, readDesign: async () => report });
  const blocked = await f.controller.drive(f.run.id, 'root');
  assert.equal(blocked.reasonCode, 'PRODUCT_DESIGN_FAILED');
  const completed = await f.controller.drive(f.run.id, 'root');
  assert.equal(completed.state, 'passed', completed.reason);
  assert.equal(completed.reasonCode, null);
  assert.equal(completed.reason, null);
});

test('unsupported design schema fails once without retrying or dispatching implementation', async t => {
  let calls = 0;
  const f = await fixture(t, { designer: async () => {
    calls++;
    throw Object.assign(new Error('unsupported JSON schema'), { code: 'UNSUPPORTED_SCHEMA' });
  } });
  const result = await f.controller.drive(f.run.id, 'root');
  assert.equal(result.state, 'failed');
  assert.equal(result.reasonCode, 'PRODUCT_DESIGN_SCHEMA_UNSUPPORTED');
  await f.controller.drive(f.run.id, 'root');
  assert.equal(calls, 1);
  assert.deepEqual(f.calls, []);
  assert.equal(await readFile(resolve(f.workspace, 'value.txt'), 'utf8'), 'old');
});

test('blocked, malformed and wrong-model plans cannot authorize implementation', async t => {
  for (const variant of ['blocked', 'schema', 'model', 'snapshot']) {
    const f = await fixture(t, { designer: async ({ run }) => {
      const report = reportFor(run);
      if (variant === 'blocked') report.status = 'blocked';
      if (variant === 'schema') report.designPlan = { goal: 'unsupported skeleton' };
      if (variant === 'model') report.model = 'deepseek-v4-1-flash';
      if (variant === 'snapshot') report.snapshot = 'foreign';
      return report;
    } });
    assert.equal((await f.controller.drive(f.run.id, 'root')).state, 'blocked');
    assert.deepEqual(f.calls, []);
  }
});

test('high-risk product design requires independent Kimi review before project synchronization', async t => {
  let report;
  const f = await fixture(t, { designer: async ({ run }) => report = reportFor(run, 'high'), readDesign: async () => report });
  const result = await f.controller.drive(f.run.id, 'root');
  assert.equal(result.state, 'passed', result.reason);
  assert.equal(result.qualityGate.model, 'kimi-k2-8-preview');
  assert.ok(f.calls.indexOf('review') > f.calls.indexOf('implement'));
  assert.equal(result.quality.status, 'passed');
});

test('high-risk failed review cannot publish the implementation', async t => {
  let report;
  const f = await fixture(t, { designer: async ({ run }) => report = reportFor(run, 'high'), readDesign: async () => report,
    reviewer: async ({ snapshot }) => ({ ...qualityGate, snapshot, status: 'failed', evidence: ['Regression found'] }) });
  const result = await f.controller.drive(f.run.id, 'root');
  assert.equal(result.state, 'failed', result.reason);
  assert.equal(await readFile(resolve(f.workspace, 'value.txt'), 'utf8'), 'old');
});

test('repair reuses the original product design without a second planning call', async t => {
  const receipts = [];
  const f = await fixture(t, { worker: async ({ phase, productDesign }) => { receipts.push(productDesign.hash); return proposal(phase === 'repair' ? 'good' : 'bad'); } },
    { contract: { ...contract, checks: [{ id: 'value', argv: ['node', 'check.cjs'], timeoutMs: 1000 }] } });
  const result = await f.controller.drive(f.run.id, 'root');
  assert.equal(result.state, 'passed', result.reason);
  assert.equal(result.designAttempts, 1); assert.equal(receipts.length, 2); assert.equal(new Set(receipts).size, 1);
});

test('registered children inherit the parent product design and do not re-plan', async t => {
  const f = await fixture(t, {}, { tasks: [{ id: 'fix', objective: 'Fix value', context: 'Parent product requirements',
    interfaces: [], acceptanceCriteria: ['value is good'], editablePaths: ['value.txt'], dependsOn: [], checkIds: [] }] });
  const result = await f.controller.drive(f.run.id, 'root');
  assert.equal(result.state, 'passed', result.reason);
  assert.deepEqual(f.calls, ['design', 'implement', 'implement']);
});

test('state transitions cannot skip design, replace a receipt or change task identity', async t => {
  const f = await fixture(t);
  assert.throws(() => f.store.move(f.run, 'implement'), /Invalid transition/);
  f.store.move(f.run, 'designing');
  assert.throws(() => f.store.move(f.run, 'implement'), /PRODUCT_DESIGN_REQUIRED/);
  const productDesign = designReceipt(reportFor(f.run), f.run);
  f.store.move(f.run, 'implement', { productDesign, qualityGate: null });
  assert.throws(() => f.store.move(f.run, 'implementing', { productDesign }), /immutable/);
  assert.throws(() => f.store.move(f.run, 'implementing', { objective: 'New goal' }), /Immutable/);
});

test('changed or removed accepted report blocks implementation even with a persisted receipt', async t => {
  const f = await fixture(t, { readDesign: async () => { throw new Error('Upstream artifact integrity failure'); } });
  const result = await f.controller.drive(f.run.id, 'root');
  assert.equal(result.state, 'blocked'); assert.deepEqual(f.calls, ['design']);
  assert.equal(await readFile(resolve(f.workspace, 'value.txt'), 'utf8'), 'old');
});

test('controller restart during planning resumes design with its attempt budget', async t => {
  const f = await fixture(t);
  f.store.move(f.run, 'designing', { designAttempts: 1 });
  assert.deepEqual(f.store.recoverInterrupted(), [f.run.id]);
  assert.equal(f.store.get(f.run.id).resumeState, 'design');
  const result = await f.controller.drive(f.run.id, 'root');
  assert.equal(result.state, 'passed', result.reason); assert.equal(result.designAttempts, 2);
});

test('cancellation during design cannot dispatch implementation', async t => {
  const abort = new AbortController();
  const f = await fixture(t, { designer: async ({ run }) => { abort.abort(); return reportFor(run); } });
  const result = await f.controller.drive(f.run.id, 'root', { signal: abort.signal });
  assert.equal(result.state, 'cancelled'); assert.deepEqual(f.calls, []);
});

test('design schema rejects invented commands, empty criteria and unbounded payloads', () => {
  for (const variant of [{ ...plan, commands: ['rm -rf /'] }, { ...plan, acceptanceCriteria: [] }, { ...plan, risks: ['x'.repeat(4001)] }])
    assert.throws(() => validateProductDesign(variant), /Invalid/);
});

test('flat MiniMax report is normalized to bounded plan sections before acceptance', () => {
  const raw = { status: 'passed', summary: 'Design ready', evidence: 'Read the task contract', limitations: '',
    designPlan: { ...Object.fromEntries(Object.entries(plan).map(([key, value]) =>
      [key, Array.isArray(value) ? value.join('\n') : value])), scope: '- One HTML file\n- No external resources' } };
  const normalized = normalizeProductDesignReport(raw);
  assert.deepEqual(normalized.evidence, ['Read the task contract']);
  assert.deepEqual(normalized.limitations, []);
  assert.deepEqual(normalized.designPlan.scope, ['One HTML file', 'No external resources']);
  assert.throws(() => normalizeProductDesignReport({ ...raw, designPlan: { ...raw.designPlan, users: [['nested']] } }), /Invalid product design users/);
  assert.throws(() => normalizeProductDesignReport({ ...raw, designPlan: { ...raw.designPlan, acceptanceCriteria: '' } }), /Invalid product design acceptanceCriteria/);
  assert.throws(() => normalizeProductDesignReport({ ...raw, evidence: [['nested']] }), /report shape/);
});

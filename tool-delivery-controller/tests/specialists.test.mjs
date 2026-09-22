import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Specialists, validateReport } from '../specialists.mjs';
import { capabilities, CapabilityControl } from '../capabilities.mjs';
import { materialize } from '../files.mjs';
import { SnapshotExplorer } from '../explore.mjs';
const routes = ['kimi-k2-8-preview', 'kimi-k2.7-code', 'glm-5-3-flash', 'minimax-m3', 'doubao-seed-2-0-lite-260215', 'doubao-seed-2-0-lite-260215']
  .map((model, i) => ({ toolName: ['task_kimi_research', 'task_kimi_quality', 'task_glm_vision', 'task_minimax_creative', 'task_doubao_media', 'task_doubao_animation'][i], provider: 'doubao', model, persona: 'test', description: 'test' }));
const report = { status: 'passed', summary: 'complete content', evidence: ['checked input'], limitations: [] };

test('report evidence is role-aware: plans may be unverified while quality passes require evidence', () => {
  assert.deepEqual(validateReport({ ...report, evidence: [] }).evidence, []);
  assert.throws(() => validateReport({ ...report, evidence: [] }, { requireEvidence: true }), /Invalid specialist report\/evidence/);
});

test('specialist route budgets reject invalid configuration', () => {
  const make = route => new Specialists({}, { specialists: [route] }, {}, {}, {});
  for (const timeoutMs of [9999, 300001, 12000.5])
    assert.throws(() => make({ ...routes[0], timeoutMs }), /timeoutMs/);
  for (const maxToolCalls of [0, 129, 2.5])
    assert.throws(() => make({ ...routes[0], maxToolCalls }), /maxToolCalls/);
});
const exec = () => ({ agent: { session: { id: 'root', header: {} } }, signal: new AbortController().signal });
function request(route, objective = 'Deliver real work') {
  return { capability: Object.keys(capabilities).find(k => capabilities[k].tool === route.toolName), objective,
    reason: 'Task requires a distinct output', singleModelGap: 'Fixture exercises the configured specialist',
    inputRefs: [route.toolName === 'task_glm_vision' ? 'file:logo.png' : 'file:input.txt'],
    expectedOutput: 'Complete report', acceptanceCriteria: ['Produce the requested report'] };
}
async function fixture(t, response = async () => report, recordTools = true) {
  const stateDir = await mkdtemp(resolve(tmpdir(), 'specialists-test-'));
  const cwd = resolve(stateDir, 'project'); await mkdir(cwd);
  await writeFile(resolve(cwd, 'input.txt'), 'source'); await writeFile(resolve(cwd, 'logo.png'), 'fixture image');
  const definitions = new Map(), requests = [], sessions = new Set();
  let disposed = 0;
  const ctx = { tools: { register: definition => definitions.set(definition.name, definition) },
    subagents: { async start(provider, request) {
      assert.equal(provider, 'spawn'); requests.push(request);
      const workspace = [...sessions].find(s => s.root === JSON.parse(request.prompt[0].text).workspace);
      if (recordTools) workspace.execution.push({ tool: 'read', ok: true }, { tool: 'read_image', path: 'logo.png', ok: true },
        { tool: 'bash', ok: true, commands: [{ command: 'node --test', exitCode: 0 }] });
      return { id: `child-${requests.length}`, result: response(request).then(structured => ({ stopReason: 'completed', structured })),
        async dispose() { disposed++; } };
    } } };
  const workspaces = { bind(session, id) { session.child = id; }, async open(files) { const session = { root: await mkdtemp(resolve(stateDir, 'copy-')) }; await materialize(files, session.root); sessions.add(session); return session; }, async close(session) { sessions.delete(session); } };
  const explorer = new SnapshotExplorer();
  const specialists = new Specialists(ctx, { stateDir, specialists: routes, maxConcurrentSpecialists: 3 }, explorer, workspaces, { async preflight() {} });
  specialists.register();
  t.after(async () => { await specialists.dispose(); await rm(stateDir, { recursive: true, force: true }); });
  return { cwd, ctx, workspaces, specialists, definitions, requests, sessions, explorer, disposed: () => disposed };
}

test('all configured tools dispatch their models and persist complete reports; children can read/write but cannot delegate', async t => {
  const f = await fixture(t);
  for (const route of routes) {
    const result = JSON.parse(await f.definitions.get(route.toolName).execute(Object.fromEntries(Object.entries(request(route)).filter(([k]) => k !== 'capability')), { ...exec(), agent: { session: { id: 'root', header: { cwd: f.cwd } } } }));
    assert.equal(result.model, route.model);
    assert.equal(result.reportPath, undefined);
    assert.equal((await f.specialists.control.artifact(result.artifactRef, 'root')).summary, report.summary);
  }
  assert.deepEqual(f.requests.map(r => r.agentOptions.model), routes.map(r => r.model));
  assert.ok(f.requests.every(r => r.toolFilter.allow.includes('write') && r.toolFilter.allow.includes('edit') && !r.toolFilter.allow.some(n => n.startsWith('task_'))));
  assert.equal(f.disposed(), routes.length); assert.equal(f.sessions.size, 0); assert.equal(f.explorer.sessions.size, 0);
});

test('read-only animation planner cannot receive mutation tools', async t => {
  const f = await fixture(t);
  const route = { ...routes[5], readOnly: true, tools: ['read', 'glob', 'grep', 'snapshot_explore', 'skill'] };
  const args = { ...request(route), inputRefs: [] };
  await f.specialists.run(route, { parent: exec().agent, signal: exec().signal, objective: args.objective, files: {}, request: args });
  assert.deepEqual(f.requests[0].toolFilter.allow, route.tools);
  const workspace = [...f.sessions][0];
  assert.equal(workspace, undefined);
});

test('per-route timeout and tool-call budget are passed to the isolated specialist workspace', async t => {
  const f = await fixture(t);
  const route = { ...routes[1], readOnly: true, tools: ['read', 'bash'], timeoutMs: 120000, maxToolCalls: 12 };
  await f.specialists.execute(route, { parent: exec().agent, signal: exec().signal, objective: 'Review', files: {} });
  const input = JSON.parse(f.requests[0].prompt[0].text);
  assert.equal(input.environment.timeoutMs, 120000);
  assert.equal(input.environment.toolCallLimit, 12);
  assert.deepEqual(f.requests[0].toolFilter.allow, ['read', 'bash']);
});

test('DAG overlaps independent nodes, obeys dependency completion and passes reports downstream', async t => {
  let active = 0, maximum = 0;
  const f = await fixture(t, async request => {
    maximum = Math.max(maximum, ++active);
    await new Promise(resolve => setTimeout(resolve, 10));
    active--;
    return { ...report, summary: JSON.parse(request.prompt[0].text).objective };
  });
  const nodes = routes.map((route, i) => ({ id: `node-${i}`, tool: route.toolName, ...request(route, `output-${i}`), dependsOn: [] }));
  nodes.push({ id: 'final', tool: routes[0].toolName, ...request(routes[0], 'integrate'), dependsOn: ['node-0', 'node-1'] });
  const result = await f.specialists.dag(nodes, { ...exec(), agent: { session: { id: 'root', header: { cwd: f.cwd } } } });
  assert.equal(maximum, 3); assert.equal(result.length, routes.length + 1);
  const final = f.requests.find(r => JSON.parse(r.prompt[0].text).objective === 'integrate');
  assert.match(JSON.parse(final.prompt[0].text).context, /output-0/);
  assert.match(JSON.parse(final.prompt[0].text).context, /output-1/);
});

test('failed nodes block only their descendants; invalid DAG never dispatches', async t => {
  const f = await fixture(t, async request => ({ ...report, status: JSON.parse(request.prompt[0].text).objective === 'fail' ? 'failed' : 'passed' }));
  const node = (id, objective, dependsOn = []) => ({ id, tool: routes[0].toolName, ...request(routes[0], objective), dependsOn });
  const results = await f.specialists.dag([node('a', 'fail'), node('b', 'dependent', ['a']), node('c', 'independent')], { ...exec(), agent: { session: { id: 'root', header: { cwd: f.cwd } } } });
  assert.deepEqual(results.map(r => r.status), ['failed', 'blocked', 'passed']);
  assert.equal(f.requests.length, 2);
  for (const nodes of [[node('a', 'x', ['a'])], [node('a', 'x', ['unknown'])], [node('a', 'x'), node('a', 'x')], Array.from({ length: 11 }, (_, i) => node(`n-${i}`, 'x'))]) {
    await assert.rejects(f.specialists.dag(nodes, { ...exec(), agent: { session: { id: 'root', header: { cwd: f.cwd } } } }));
  }
  assert.equal(f.requests.length, 2);
});

test('malformed specialist report revokes child capabilities and releases concurrency slot', async t => {
  const f = await fixture(t, async () => ({ status: 'passed', summary: 'no proof' }));
  await assert.rejects(f.specialists.run(routes[0], { parent: exec().agent, signal: exec().signal, objective: 'x', files: { 'input.txt': Buffer.from('source').toString('base64') }, request: request(routes[0], 'x') }), /Invalid/);
  assert.equal(f.specialists.active, 0); assert.equal(f.sessions.size, 0); assert.equal(f.explorer.sessions.size, 0); assert.equal(f.disposed(), 1);
});

test('queued cancelled tasks do not dispatch or leak concurrency', async t => {
  const f = await fixture(t);
  const signal = new AbortController();
  await Promise.all([f.specialists.slot(signal.signal), f.specialists.slot(signal.signal), f.specialists.slot(signal.signal)]);
  const waiting = f.specialists.slot(signal.signal); signal.abort(new Error('cancel'));
  await assert.rejects(waiting, /cancel/);
  f.specialists.release(); f.specialists.release(); f.specialists.release();
  assert.equal(f.specialists.active, 0); assert.equal(f.specialists.pending.length, 0);
});

test('owner lifecycle cancellation terminates active and orphaned capability state', async t => {
  const f = await fixture(t);
  const active = new AbortController();
  f.specialists.control.running.set('active-task', { owner: 'root', abort: active });
  const orphan = { id: 'orphan-task', owner: 'root', scope: 'session:root', signature: 'orphan', state: 'running', startedAt: new Date().toISOString() };
  f.specialists.control.db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?)').run(orphan.id, orphan.owner, orphan.scope, orphan.signature, JSON.stringify(orphan));
  f.specialists.control.cancelOwner('root', 'Session deleted');
  assert.equal(active.signal.aborted, true);
  assert.equal(f.specialists.control.get(orphan.id, 'root').state, 'cancelled');
  assert.equal(f.specialists.control.running.has('active-task'), true);
  f.specialists.control.running.delete('active-task');
});

test('read_image forwards snapshot bytes to attachment service and rejects paths outside the snapshot', async t => {
  const f = await fixture(t);
  f.workspaces.find = () => ({ root: '/fixture', files: { 'logo.png': Buffer.from('image bytes').toString('base64') } });
  let saved;
  f.ctx.get = name => name === 'attachments' ? { async saveImage(input) { saved = input; return { attachmentId: 'test', mediaType: input.mediaType, bytes: input.data.length, width: 1, height: 1 }; } } : undefined;
  const tool = f.definitions.get('read_image');
  const value = await tool.execute({ file_path: '/fixture/logo.png' }, exec());
  assert.equal(saved.data.toString(), 'image bytes');
  assert.equal(tool.output.render({}, value)[1].type, 'image');
  await assert.rejects(tool.execute({ file_path: '../secret.png' }, exec()), /Unsafe/);
  await assert.rejects(tool.execute({ file_path: 'missing.png' }, exec()), /snapshot/);
});

test('visual role allowlist removes shell without changing other roles', async t => {
  const f = await fixture(t);
  const route = { ...routes[2], tools: ['read', 'read_image', 'skill'] };
  await f.specialists.run(route, { parent: exec().agent, signal: exec().signal, objective: 'Inspect reference', files: { 'logo.png': Buffer.from('image').toString('base64') }, request: request(route, 'Inspect reference') });
  assert.deepEqual(f.requests[0].toolFilter.allow, ['read', 'read_image', 'skill', 'write', 'edit']);
  await f.specialists.run(routes[1], { parent: exec().agent, signal: exec().signal, objective: 'Review', files: {} });
  assert.ok(f.requests[1].toolFilter.allow.includes('bash'));
});

test('missing gap, unavailable capability and traversal are rejected before any model dispatch', async t => {
  const f = await fixture(t);
  const caller = { ...exec(), agent: { session: { id: 'root', header: { cwd: f.cwd } } } };
  const invoke = args => f.definitions.get('request_capability').execute(args, caller);
  await assert.rejects(invoke({ ...request(routes[3]), singleModelGap: '' }), /singleModelGap/);
  await assert.rejects(invoke({ ...request(routes[3]), capability: 'image_generation' }), /unavailable/);
  await assert.rejects(invoke({ ...request(routes[0]), inputRefs: ['file:../secret'] }), /Unsafe/);
  await assert.rejects(invoke({ ...request(routes[0]), owner: 'other' }), /Unknown/);
  assert.equal(f.requests.length, 0);
});

test('model-declared passed cannot bypass real image delivery, source reading or review execution', async t => {
  const f = await fixture(t, async () => report, false);
  for (const route of [routes[0], routes[1], routes[2]]) {
    const args = request(route);
    const result = await f.specialists.run(route, { parent: exec().agent, signal: exec().signal, objective: args.objective,
      files: { 'logo.png': Buffer.from('image').toString('base64'), 'input.txt': Buffer.from('source').toString('base64') }, request: args });
    assert.equal(result.status, 'blocked');
    assert.equal(result.acceptance.structural, false);
    const [task] = f.specialists.control.status('root', result.id);
    assert.equal(task.modelStatus, 'passed');
    assert.deepEqual(task.events.map(e => e.kind), ['requested', 'submitted', 'validating', 'blocked']);
    await assert.rejects(f.specialists.control.artifact(result.artifactRef, 'root'), /not accepted/);
  }
});

test('accepted report handoff enforces ownership and integrity; records survive controller restart', async t => {
  const f = await fixture(t);
  const args = request(routes[3]);
  const result = await f.specialists.run(routes[3], { parent: exec().agent, signal: exec().signal, objective: args.objective,
    files: { 'input.txt': Buffer.from('source').toString('base64') }, request: args, scope: 'delivery-1' });
  const reopened = new CapabilityControl(f.specialists.config, f.specialists, f.workspaces);
  assert.equal(reopened.status('root', result.id)[0].state, 'accepted'); reopened.close();
  const reports = await f.specialists.control.deliveryInputs('delivery-1', 'root');
  assert.equal(reports[0].id, result.id);
  await assert.rejects(f.specialists.control.artifact(result.artifactRef, 'another-session'), /not found/);
  await writeFile(result.reportPath, 'tampered');
  await assert.rejects(f.specialists.control.artifact(result.artifactRef, 'root'), /integrity/);
  await assert.rejects(f.specialists.control.deliveryInputs('delivery-1', 'root'), /failed or is incomplete/);
  assert.equal(f.specialists.control.status('root', result.id)[0].state, 'invalidated');
});

test('aliases and DAG share persisted dispatch budget; duplicate requests cannot spend twice', async t => {
  const f = await fixture(t);
  f.specialists.control.limit = 1;
  const caller = { ...exec(), agent: { session: { id: 'root', header: { cwd: f.cwd } } } };
  const args = request(routes[3]);
  await f.definitions.get('request_capability').execute(args, caller);
  await assert.rejects(f.definitions.get('request_capability').execute(args, caller), /Duplicate/);
  const aliasArgs = Object.fromEntries(Object.entries({ ...args, objective: 'new task' }).filter(([k]) => k !== 'capability'));
  await assert.rejects(f.definitions.get(routes[3].toolName).execute(aliasArgs, caller), /budget/);
  const results = await f.specialists.dag([{ id: 'next', tool: routes[3].toolName, ...aliasArgs, dependsOn: [] }], caller);
  assert.equal(results[0].status, 'blocked');
  assert.equal(f.requests.length, 1);
});

test('only active implementation worker can request help, with automatic root ownership and handoff', async t => {
  const f = await fixture(t);
  const root = { session: { id: 'root', header: { cwd: f.cwd } } };
  const workspace = { root: f.cwd, rootAgent: root, deliveryId: 'delivery-42', signal: exec().signal, tail: Promise.resolve() };
  f.workspaces.find = () => workspace;
  const caller = { ...exec(), agent: { session: { id: 'worker', header: { parentSession: 'root' } } } };
  const result = JSON.parse(await f.definitions.get('request_capability').execute(request(routes[3]), caller));
  const task = f.specialists.control.status('root', result.id)[0];
  assert.equal(task.reportPath, undefined);
  assert.equal(task.reportHash, undefined);
  assert.equal(task.artifactRef, result.artifactRef);
  assert.equal(task.scope, 'delivery-42');
  assert.equal(task.events.at(-1).kind, 'handed_off');
  assert.equal(f.requests[0].parent, root); // Sibling dispatch: helper never gains recursive delegation.
  await assert.rejects(f.definitions.get('request_capability').execute(request(routes[1]), caller), /quality gate/);
  workspace.readOnly = true;
  await assert.rejects(f.definitions.get('request_capability').execute(request(routes[3]), caller), /cannot delegate/);
  await assert.rejects(f.specialists.dag([], caller), /Only root/);
});

test('automatic quality gate reuses only intact accepted evidence for the identical snapshot', async t => {
  const f = await fixture(t);
  const input = { parent: exec().agent, signal: exec().signal, scope: 'delivery', objective: 'Review integrated project', files: { 'src/a': Buffer.from('a').toString('base64') } };
  const first = await f.specialists.run(routes[1], input);
  const second = await f.specialists.run(routes[1], input);
  assert.equal(second.id, first.id);
  assert.equal(f.requests.length, 1);
  await writeFile(first.reportPath, '{}');
  await assert.rejects(f.specialists.run(routes[1], input), /integrity/);
  assert.equal(f.requests.length, 1);
});

 test('quality rejects a passed report after reviewer mutates input', async t => {
  const f = await fixture(t, async request => {
    await writeFile(resolve(JSON.parse(request.prompt[0].text).workspace, 'input.txt'), 'tampered');
    return report;
  });
  await assert.rejects(f.specialists.execute(routes[1], { parent: exec().agent, signal: exec().signal,
    objective: 'Review', files: { 'input.txt': Buffer.from('source').toString('base64') } }), /QUALITY_INPUT_MODIFIED/);
});

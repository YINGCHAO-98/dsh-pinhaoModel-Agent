import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolPolicy } from '../tool-policy.mjs';
import { WorkerWorkspaces } from '../workspace.mjs';

test('role policy distinguishes root, authorized worker, specialist, cancelled and released sessions', () => {
  const workspaces = new WorkerWorkspaces({});
  const abort = new AbortController();
  const session = { parent: 'root', child: 'worker', signal: abort.signal, allowedTools: ['read', 'bash'] };
  workspaces.sessions.add(session);
  const policy = toolPolicy(workspaces, ['task_glm_vision']);
  const call = (name, id = 'worker', parentSession = 'root') => policy({ name, agent: { session: { id, header: { parentSession } } } });
  assert.match(call('bash', 'root', null), /ROOT_TOOL_NOT_ALLOWED/);
  assert.match(call('html_chunk', 'root', null), /ROOT_TOOL_NOT_ALLOWED/);
  for (const name of ['read', 'glob', 'grep']) assert.equal(call(name, 'root', null), undefined);
  for (const name of ['write', 'edit']) assert.match(call(name, 'root', null), /ROOT_IMPLEMENTATION_NOT_ALLOWED/);
  assert.equal(call('delivery_start', 'root', null), undefined);
  assert.equal(call('delivery_resume', 'root', null), undefined);
  assert.equal(call('delivery_cancel', 'root', null), undefined);
  assert.equal(call('delivery_review', 'root', null), undefined);
  assert.match(call('delivery_review'), /CHILD_ORCHESTRATION_DENIED/);
  assert.match(call('delivery_cancel'), /CHILD_ORCHESTRATION_DENIED/);
  assert.match(call('delivery_resume'), /CHILD_ORCHESTRATION_DENIED/);
  assert.equal(call('task_glm_vision', 'root', null), undefined);
  assert.equal(call('bash'), undefined);
  assert.match(call('edit'), /WORKER_TOOL_NOT_ALLOWED/);
  assert.match(call('html_chunk'), /WORKER_TOOL_NOT_ALLOWED/);
  session.allowedTools.push('html_chunk');
  assert.equal(call('html_chunk'), undefined);
  assert.match(call('delivery_start'), /CHILD_ORCHESTRATION_DENIED/);
  session.allowedTools = ['read']; session.readOnly = true;
  assert.equal(call('read'), undefined);
  assert.match(call('bash'), /WORKER_TOOL_NOT_ALLOWED/);
  abort.abort();
  assert.match(call('read'), /WORKER_EXPIRED/);
  workspaces.sessions.delete(session);
  assert.match(call('read'), /WORKER_NOT_BOUND/);
});

test('root can ask for missing input and start another bounded delivery in the same turn', () => {
  const workspaces = new WorkerWorkspaces({});
  const policy = toolPolicy(workspaces, []);
  const call = name => policy({ name, agent: { session: { id: 'root', header: {} } } });
  assert.equal(call('ask_user_question'), undefined);
  assert.equal(call('delivery_start'), undefined);
});

test('terminal output exhaustion hides same-turn mutation and restart tools until the next user turn', () => {
  const workspaces = new WorkerWorkspaces({});
  const policy = toolPolicy(workspaces, []);
  const agent = { session: { id: 'root', header: {} } };
  workspaces.blockTerminalDeliveryTurn('root', { id: 'delivery-1', state: 'failed', reasonCode: 'WORKER_MAX_TOKENS' });
  for (const name of ['write', 'edit']) assert.match(policy({ name, agent }), /ROOT_IMPLEMENTATION_NOT_ALLOWED/);
  assert.match(policy({ name: 'delivery_start', agent }), /TERMINAL_DELIVERY/);
  for (const name of ['read', 'glob', 'grep', 'delivery_status']) assert.equal(policy({ name, agent }), undefined);
  workspaces.beginRootTurn('root', '继续处理，但请缩小范围');
  for (const name of ['write', 'edit']) assert.match(policy({ name, agent }), /ROOT_IMPLEMENTATION_NOT_ALLOWED/);
  assert.equal(policy({ name: 'delivery_start', agent }), undefined);
});

test('exhausted no-tool recovery also blocks a new delivery in the same turn', () => {
  const workspaces = new WorkerWorkspaces({});
  const policy = toolPolicy(workspaces, []);
  const agent = { session: { id: 'root', header: {} } };
  workspaces.blockTerminalDeliveryTurn('root', { id: 'delivery-2', state: 'failed', reasonCode: 'WORKER_TIMEOUT_RETRIES_EXHAUSTED' });
  assert.match(policy({ name: 'delivery_start', agent }), /TERMINAL_DELIVERY_RESTART_DENIED/);
  workspaces.beginRootTurn('root', '继续处理');
  assert.equal(policy({ name: 'delivery_start', agent }), undefined);
});

test('all root file changes are forced through the configured implementation worker', () => {
  const workspaces = new WorkerWorkspaces({});
  workspaces.beginRootTurn('direct', '制作一个 SVG 动画');
  const policy = toolPolicy(workspaces, []);
  const call = name => policy({ name, agent: { session: { id: 'direct', header: {} } } });
  assert.match(call('write'), /ROOT_IMPLEMENTATION_NOT_ALLOWED/);
  assert.match(call('edit'), /ROOT_IMPLEMENTATION_NOT_ALLOWED/);
  assert.equal(call('delivery_start'), undefined);
});

test('user skill prohibition applies to root and child sessions without disabling other tools', () => {
  const workspaces = new WorkerWorkspaces({});
  workspaces.beginRootTurn('root', '不要使用任何 skill，但要验证结果');
  const policy = toolPolicy(workspaces, []);
  assert.match(policy({ name: 'skill', agent: { session: { id: 'root', header: {} } } }), /SKILL_DISABLED_BY_USER/);
  assert.match(policy({ name: 'skill', agent: { session: { id: 'child', header: { parentSession: 'root' } } } }), /SKILL_DISABLED_BY_USER/);
  assert.equal(policy({ name: 'delivery_start', agent: { session: { id: 'root', header: {} } } }), undefined);
});

test('owner lifecycle reset clears every root-turn policy flag', () => {
  const workspaces = new WorkerWorkspaces({});
  workspaces.beginRootTurn('root', '不使用 Skill，创建 SVG 动画');
  assert.throws(() => workspaces.assertSkillAllowed('root'), /SKILL_DISABLED/);
  workspaces.resetRootState('root');
  assert.doesNotThrow(() => workspaces.assertSkillAllowed('root'));
});

test('specialist tool-call budget is enforced before another tool executes', async () => {
  const workspaces = new WorkerWorkspaces({});
  const signal = new AbortController().signal;
  const session = { signal, tail: Promise.resolve(), execution: [{ tool: 'read', ok: true }], maxToolCalls: 1 };
  await assert.rejects(workspaces.invokeSession(session, 'read', { file_path: 'input.txt' }, { signal, callId: 'next' }), /budget exhausted \(1\)/);
  assert.equal(session.execution.length, 2);
  assert.equal(session.execution[1].ok, false);
});

test('isolated shell rejects host tmp paths before spawning and points to owned scratch', async () => {
  const workspaces = new WorkerWorkspaces({});
  const signal = new AbortController().signal;
  const session = { signal, tail: Promise.resolve(), execution: [], maxToolCalls: 2 };
  await assert.rejects(workspaces.invokeSession(session, 'bash', { command: 'python3 /tmp/check.py' }, { signal, callId: 'tmp' }),
    /WORKER_TEMP_PATH_REQUIRED.*\$TMPDIR/);
  assert.equal(session.execution.at(-1).ok, false);
});

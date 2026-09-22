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
  for (const name of ['read', 'write', 'edit', 'glob', 'grep']) assert.equal(call(name, 'root', null), undefined);
  assert.equal(call('delivery_start', 'root', null), undefined);
  assert.equal(call('delivery_resume', 'root', null), undefined);
  assert.equal(call('delivery_cancel', 'root', null), undefined);
  assert.match(call('delivery_cancel'), /CHILD_ORCHESTRATION_DENIED/);
  assert.match(call('delivery_resume'), /CHILD_ORCHESTRATION_DENIED/);
  assert.equal(call('task_glm_vision', 'root', null), undefined);
  assert.equal(call('bash'), undefined);
  assert.match(call('edit'), /WORKER_TOOL_NOT_ALLOWED/);
  assert.match(call('delivery_start'), /CHILD_ORCHESTRATION_DENIED/);
  session.allowedTools = ['read']; session.readOnly = true;
  assert.equal(call('read'), undefined);
  assert.match(call('bash'), /WORKER_TOOL_NOT_ALLOWED/);
  abort.abort();
  assert.match(call('read'), /WORKER_EXPIRED/);
  workspaces.sessions.delete(session);
  assert.match(call('read'), /WORKER_NOT_BOUND/);
});

test('terminal worker failure removes user-question and same-turn restart escape hatches', () => {
  const workspaces = new WorkerWorkspaces({});
  const policy = toolPolicy(workspaces, []);
  const call = name => policy({ name, agent: { session: { id: 'root', header: {} } } });
  workspaces.beginRootTurn('root', '制作 SVG 动画');
  workspaces.protectRoot('root', 'scene.html');
  assert.match(call('ask_user_question'), /CONTROLLED_DELIVERY_QUESTION_DENIED/);
  workspaces.blockTerminalDeliveryTurn('root', { id: 'delivery-1', reasonCode: 'WORKER_NO_TOOL_DEADLINE' });
  assert.match(call('ask_user_question'), /TERMINAL_DELIVERY_DECISION_DENIED/);
  assert.match(call('delivery_start'), /TERMINAL_DELIVERY_RESTART_DENIED/);
  workspaces.beginRootTurn('root', '请缩小范围后重新实现');
  assert.equal(call('ask_user_question'), undefined);
  assert.equal(call('delivery_start'), undefined);
});

test('controlled animation output rejects root mutation until a new user turn clears it', () => {
  const workspaces = new WorkerWorkspaces({});
  workspaces.beginRootTurn('direct', '制作一个 SVG 动画');
  assert.equal(workspaces.animationContext('direct'), '制作一个 SVG 动画');
  assert.throws(() => workspaces.assertRootMutationAllowed('direct', '/project', 'write', { file_path: 'direct.html' }), /ANIMATION_ROUTE_REQUIRED/);
  assert.doesNotThrow(() => workspaces.assertRootMutationAllowed('direct', '/project', 'write', { file_path: 'notes.txt' }));
  workspaces.beginRootTurn('direct', '不使用任何 skill，不进行任何验证');
  assert.equal(workspaces.animationContext('direct'), '制作一个 SVG 动画');
  assert.throws(() => workspaces.assertRootMutationAllowed('direct', '/project', 'write', { file_path: 'direct.html' }), /ANIMATION_ROUTE_REQUIRED/);
  assert.throws(() => workspaces.assertSkillAllowed('direct'), /SKILL_DISABLED_BY_USER/);
  workspaces.beginRootTurn('direct', '修改普通网页标题');
  assert.equal(workspaces.animationContext('direct'), null);
  assert.doesNotThrow(() => workspaces.assertRootMutationAllowed('direct', '/project', 'write', { file_path: 'direct.html' }));
  assert.doesNotThrow(() => workspaces.assertSkillAllowed('direct'));
  workspaces.protectRoot('root', 'scene.html');
  workspaces.beginRootTurn('root', '制作 scene.html SVG 动画');
  assert.throws(() => workspaces.assertRootMutationAllowed('root', '/project', 'write', { file_path: 'scene.html' }), /CONTROLLED_ANIMATION_PATH|ANIMATION_ROUTE_REQUIRED/);
  assert.throws(() => workspaces.assertRootMutationAllowed('root', '/project', 'edit', { file_path: '/project/scene.html' }), /CONTROLLED_ANIMATION_PATH|ANIMATION_ROUTE_REQUIRED/);
  assert.doesNotThrow(() => workspaces.assertRootMutationAllowed('root', '/project', 'read', { file_path: 'scene.html' }));
  assert.throws(() => workspaces.assertRootMutationAllowed('root', '/project', 'write', { file_path: 'other.html' }), /ANIMATION_ROUTE_REQUIRED/);
  workspaces.clearRootProtection('root');
  assert.throws(() => workspaces.assertRootMutationAllowed('root', '/project', 'write', { file_path: 'scene.html' }), /ANIMATION_ROUTE_REQUIRED/);
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
  workspaces.protectRoot('root', 'scene.html');
  assert.throws(() => workspaces.assertSkillAllowed('root'), /SKILL_DISABLED/);
  assert.throws(() => workspaces.assertRootMutationAllowed('root', '/project', 'write', { file_path: 'scene.html' }), /ANIMATION_ROUTE_REQUIRED/);
  workspaces.resetRootState('root');
  assert.doesNotThrow(() => workspaces.assertSkillAllowed('root'));
  assert.doesNotThrow(() => workspaces.assertRootMutationAllowed('root', '/project', 'write', { file_path: 'scene.html' }));
  assert.equal(workspaces.animationContext('root'), null);
  assert.equal(workspaces.terminalDeliveryBlock('root'), null);
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

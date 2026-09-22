import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeliveryProgress, deliveryTodos } from '../progress.mjs';

const run = { id: 'delivery-one', owner: 'root', state: 'implementing', tasks: [], repairCount: 0,
  contract: { maxRepairs: 2 }, qualityGate: { model: 'kimi' }, mode: 'project' };

test('real states distinguish implementation, checks, review, sync and bounded repair', () => {
  const labels = (state, history = []) => deliveryTodos({ ...run, state }, [], history, 30);
  assert.match(labels('implementing').find(t => t.status === 'in_progress').content, /实现中.*30 秒/);
  assert.equal(labels('implementing').filter(t => t.status === 'in_progress').length, 1);
  const reviewing = labels('verifying', [{ kind: 'quality.started' }]);
  assert.match(reviewing.find(t => t.status === 'in_progress').content, /独立审查（kimi）/);
  assert.equal(reviewing.find(t => t.content === '执行合同检查').status, 'completed');
  assert.equal(reviewing.find(t => t.content.startsWith('独立质量审查')).status, 'in_progress');
  assert.equal(labels('syncing').at(-1).status, 'in_progress');
  assert.ok(labels('passed').every(t => t.status === 'completed'));
  const repair = deliveryTodos({ ...run, state: 'repairing', repairCount: 1 });
  assert.match(repair.find(t => t.status === 'in_progress').content, /修复 1\/2/);
  assert.equal(repair.find(t => t.content === '独立质量审查').status, 'pending');
});

test('failure, cancellation, blocking and invalidation never claim completed delivery', () => {
  for (const state of ['failed', 'blocked', 'cancelled', 'invalidated']) {
    const todos = deliveryTodos({ ...run, state, reason: 'actual failure' });
    assert.match(todos[0].content, /actual failure/);
    assert.ok(todos.every(t => t.status !== 'in_progress'));
    assert.equal(todos.at(-1).status, 'pending');
  }
});

test('registered task objectives and parallel states appear without inventing semantic tasks', () => {
  const children = ['queued', 'implementing', 'passed', 'blocked'].map((state, i) => ({ ...run, id: String(i), taskKey: `task-${i}`, state, objective: `实现功能${i}` }));
  const todos = deliveryTodos({ ...run, state: 'collecting' }, children).filter(t => t.content.startsWith('子任务'));
  assert.deepEqual(todos.map(t => t.status), ['pending', 'in_progress', 'completed', 'pending']);
  assert.match(todos[1].content, /实现功能1/);
  assert.equal(deliveryTodos({ ...run, state: 'collecting' }, children).filter(t => t.status === 'in_progress').length, 1);
});

test('native todo events stream before completion; unchanged ticks deduplicate; close removes timer', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const events = []; let current = structuredClone(run), time = 0;
  const session = { id: 'root', append(type, data) { events.push({ type, data }); } };
  const progress = new DeliveryProgress(session, { get: () => current, history: () => [] }, { now: () => time });
  progress.bind(run.id);
  const before = events.length;
  t.mock.timers.tick(1000);
  assert.equal(events.length, before);
  time = 15000; t.mock.timers.tick(1000);
  assert.match(events.at(-1).data.todos.find(t => t.status === 'in_progress').content, /15 秒/);
  current.state = 'syncing'; t.mock.timers.tick(1000);
  assert.equal(events.at(-1).data.todos.at(-1).status, 'in_progress');
  current.state = 'passed'; progress.close();
  assert.ok(events.at(-1).data.todos.every(t => t.status === 'completed'));
  const final = events.length; t.mock.timers.tick(60000);
  assert.equal(events.length, final);
  assert.ok(events.every(e => e.type === 'todo/write'));
});

test('startup failure stays visible and parallel deliveries do not overwrite each other', () => {
  const events = [], session = { id: 'root', append(_type, data) { events.push(data); } };
  const store = { get: id => ({ ...run, id }), history: () => [] };
  const a = new DeliveryProgress(session, store), b = new DeliveryProgress(session, store);
  try {
    a.bind('delivery-a'); b.bind('delivery-b');
    assert.equal(events.at(-1).todos.filter(t => t.content.includes('[delivery')).length, 2);
    a.close(new Error('Snapshot budget exceeded'));
    assert.ok(events.at(-1).todos.some(t => t.content.includes('Snapshot budget exceeded') && t.status === 'pending'));
  } finally { a.close(); b.close(); }
});

test('manual cancellation clears only its own todo projection and republishes global state', () => {
  const events = [], session = { id: 'root', append(_type, data) { events.push(data); } };
  const store = { get: id => ({ ...run, id }), history: () => [] };
  const cancelled = new DeliveryProgress(session, store), remaining = new DeliveryProgress(session, store);
  cancelled.bind('cancelled-delivery'); remaining.bind('remaining-delivery');
  cancelled.close(undefined, { clear: true });
  assert.equal(events.at(-1).todos.some(t => t.content.includes('[cancelle')), false);
  assert.equal(events.at(-1).todos.some(t => t.content.includes('[remainin')), true);
  remaining.close(undefined, { clear: true });
  assert.deepEqual(events.at(-1).todos, []);
});

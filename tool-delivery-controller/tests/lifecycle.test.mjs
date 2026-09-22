import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanupOwnerState, registerSessionDisposal } from '../lifecycle.mjs';

test('session deletion cleanup is registered as a global DSH observer', () => {
  let registration;
  const listener = () => {};
  registerSessionDisposal({ on(...args) { registration = args; return 'dispose'; } }, listener);
  assert.equal(registration[0], 'session/disposed');
  assert.equal(registration[1], listener);
  assert.deepEqual(registration[2], { global: true });
});

test('session disposal aborts owner activity and clears every persisted and in-memory reservation', async () => {
  const aborted = [], cancelled = [], reset = [], capability = [];
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  const active = new Map([
    ['owned', { owner: 'root', abort: { abort(error) { aborted.push(error.message); release(); } }, promise }],
    ['foreign', { owner: 'other', abort: { abort() { throw new Error('must not abort'); } }, promise: Promise.resolve() }],
  ]);
  const startingWorkspaces = new Map([['/owned', 'root'], ['/foreign', 'other']]);
  const store = { list: owner => owner === 'root' ? [
    { id: 'active-root', owner, state: 'implementing' },
    { id: 'child', owner, parentId: 'active-root', state: 'queued' },
    { id: 'done', owner, state: 'passed' },
  ] : [] };
  await cleanupOwnerState({ owner: 'root', reason: 'Session deleted', active, startingWorkspaces, store,
    controller: { cancel(id, owner, reason) { cancelled.push({ id, owner, reason }); } },
    specialists: { control: { cancelOwner(owner, reason) { capability.push({ owner, reason }); } } },
    workspaces: { resetRootState(owner) { reset.push(owner); } } });
  assert.deepEqual(aborted, ['Session deleted']);
  assert.deepEqual(cancelled, [{ id: 'active-root', owner: 'root', reason: 'Session deleted' }]);
  assert.deepEqual(reset, ['root']);
  assert.deepEqual(capability, [{ owner: 'root', reason: 'Session deleted' }]);
  assert.equal(startingWorkspaces.has('/owned'), false);
  assert.equal(startingWorkspaces.has('/foreign'), true);
});

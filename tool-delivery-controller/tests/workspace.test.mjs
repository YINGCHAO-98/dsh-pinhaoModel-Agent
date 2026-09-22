import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workspaceProposal, WorkerWorkspaces, resolveToolPath } from '../workspace.mjs';
const enc = text => Buffer.from(text).toString('base64');
const contract = { editablePaths: ['src/'], protectedPaths: ['tests/'], requiredPaths: ['tests/'] };
const before = { 'src/a.js': enc('old'), 'tests/a.js': enc('test') };
test('actual workspace diff captures edits, creations and deletions', () => {
  const p = workspaceProposal(before, { 'src/b.js': enc('new'), 'tests/a.js': enc('test') }, 'done', contract);
  assert.deepEqual(p.changes, [{ path: 'src/a.js', operation: 'delete', content: '' }, { path: 'src/b.js', operation: 'write', content: 'new' }]);
});
test('protected, hidden and binary workspace changes fail closed', () => {
  for (const extra of [{ 'tests/a.js': enc('fake pass') }, { '.env': enc('secret') }, { 'src/b.bin': enc('\0') }])
    assert.throws(() => workspaceProposal(before, { ...before, ...extra }, 'done', contract));
});
test('workspace access requires active child ownership; root, siblings and expired sessions denied', () => {
  const manager = new WorkerWorkspaces({});
  const signal = new AbortController().signal;
  const session = { parent: 'root', child: null, signal };
  manager.sessions.add(session);
  const exec = (id, parentSession) => ({ agent: { session: { id, header: { parentSession } } } });
  assert.throws(() => manager.find(exec('root')));
  assert.throws(() => manager.find(exec('child', 'root')));
  session.child = 'child';
  assert.equal(manager.find(exec('child', 'root')), session);
  assert.throws(() => manager.find(exec('sibling', 'root')));
  session.closed = true;
  assert.throws(() => manager.find(exec('child', 'root')));
});

test('binding barrier waits for exact child; concurrent children never exchange workspaces', async () => {
  const manager = new WorkerWorkspaces({});
  const signal = new AbortController().signal;
  const first = { parent: 'root', child: null, signal, binding: Promise.withResolvers() };
  const second = { parent: 'root', child: null, signal, binding: Promise.withResolvers() };
  manager.sessions.add(first); manager.sessions.add(second);
  const child = id => ({ session: { id, header: { parentSession: 'root' } } });
  let ready = false;
  const waiting = manager.waitForBinding(child('a')).then(() => { ready = true; });
  await Promise.resolve(); assert.equal(ready, false);
  manager.bind(first, 'a'); manager.bind(second, 'b');
  await waiting;
  assert.equal(manager.find({ agent: child('a') }), first);
  assert.equal(manager.find({ agent: child('b') }), second);
  assert.throws(() => manager.bind(first, 'b'), /WORKER_BINDING_FAILED/);
  assert.throws(() => manager.find({ agent: child('unknown') }), /WORKER_NOT_BOUND/);
});

test('handed-off HTML draft revokes even directly invoked file operations', async () => {
  const workspaces=new WorkerWorkspaces({});
  const signal=new AbortController().signal;
  const session={signal,tail:Promise.resolve(),execution:[],handoffPending:true};
  await assert.rejects(workspaces.invokeSession(session,'write',{file_path:'p.html',content:'bypass'},{signal}),/HTML_DRAFT_HANDED_OFF/);
});

test('tool paths map project absolutes and virtual roots into owned workspace boundaries', () => {
  const session = { root: '/private/task/workspace', scratch: '/private/task/scratch', projectRoot: '/Users/example/project' };
  assert.deepEqual(resolveToolPath(session, 'src/page.html'), { target: '/private/task/workspace/src/page.html', boundary: '/private/task/workspace' });
  assert.deepEqual(resolveToolPath(session, '/Users/example/project/src/page.html'), { target: '/private/task/workspace/src/page.html', boundary: '/private/task/workspace' });
  assert.deepEqual(resolveToolPath(session, '/workspace/page.html'), { target: '/private/task/workspace/page.html', boundary: '/private/task/workspace' });
  assert.deepEqual(resolveToolPath(session, '$TMPDIR/check.mjs'), { target: '/private/task/scratch/check.mjs', boundary: '/private/task/scratch' });
  assert.deepEqual(resolveToolPath(session, '/scratch/check.mjs'), { target: '/private/task/scratch/check.mjs', boundary: '/private/task/scratch' });
  for (const path of ['/Users/example/other/file', '/workspace/../escape', '$TMPDIR/../escape', '/reports/report.md'])
    assert.throws(() => resolveToolPath(session, path), /WORKER_PATH_OUTSIDE/);
});

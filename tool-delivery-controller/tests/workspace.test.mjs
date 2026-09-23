import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workspaceProposal, WorkerWorkspaces, resolveToolPath, recoverReadPath } from '../workspace.mjs';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
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

test('single HTML chunks append sequentially in an isolated draft and require explicit finish', async t => {
  const manager = new WorkerWorkspaces({});
  const base = await mkdtemp(resolve(tmpdir(), 'html-chunks-'));
  t.after(async () => { await manager.close(session); await rm(base, { recursive: true, force: true }); });
  const signal = new AbortController().signal;
  const session = { base, root: base, parent: 'root', child: 'kimi', signal, closed: false,
    tail: Promise.resolve(), execution: [], draftReady: Promise.withResolvers(),
    expectedOutput: resolve(base, 'page.html'), allowedTools: ['read', 'html_chunk'] };
  manager.sessions.add(session);
  const exec = callId => ({ agent: { session: { id: 'kimi', header: { parentSession: 'root' } } }, signal, callId });
  await writeFile(session.expectedOutput, 'old draft to replace');
  await assert.rejects(manager.htmlChunk({ action: 'append', index: 1, content: 'wrong' }, exec('bad')), /SEQUENCE/);
  await assert.rejects(manager.htmlChunk({ action: 'append', index: 0, content: 'x'.repeat(8193) }, exec('large')), /LIMIT/);
  const head = '<!doctype html><html><head></head><body>';
  const tail = '<svg></svg></body></html>';
  assert.deepEqual(await manager.htmlChunk({ action: 'append', index: 0, content: head }, exec('first')),
    { accepted: true, nextIndex: 1, bytes: Buffer.byteLength(head) });
  assert.equal(await readFile(session.expectedOutput, 'utf8'), head);
  await assert.rejects(manager.htmlChunk({ action: 'append', index: 0, content: tail }, exec('duplicate')), /SEQUENCE/);
  const second = await manager.htmlChunk({ action: 'append', index: 1, content: tail }, exec('second'));
  assert.equal(second.nextIndex, 2);
  assert.equal(await readFile(session.expectedOutput, 'utf8'), head + tail);
  const finish = await manager.htmlChunk({ action: 'finish', index: 2 }, exec('finish'));
  assert.equal(finish.finalized, true);
  assert.equal(finish.chunks, 2);
  await assert.rejects(manager.htmlChunk({ action: 'append', index: 2, content: 'late' }, exec('late')), /HANDED_OFF/);
  await assert.rejects(manager.invokeSession(session, 'write', { file_path: 'page.html', content: 'late' }, exec('late-write')), /HANDED_OFF/);
  assert.equal(await readFile(session.expectedOutput, 'utf8'), head + tail);
  await assert.rejects(manager.htmlChunk({ action: 'append', index: 2, content: 'other' },
    { agent: { session: { id: 'other', header: { parentSession: 'root' } } }, signal }), /WORKER_NOT_BOUND/);
});

test('tool paths map project absolutes and virtual roots into owned workspace boundaries', () => {
  const session = { root: '/private/task/workspace', scratch: '/private/task/scratch', projectRoot: '/Users/example/project' };
  assert.deepEqual(resolveToolPath(session, 'src/page.html'), { target: '/private/task/workspace/src/page.html', boundary: '/private/task/workspace' });
  assert.deepEqual(resolveToolPath(session, '/Users/example/project/src/page.html'), { target: '/private/task/workspace/src/page.html', boundary: '/private/task/workspace' });
  assert.deepEqual(resolveToolPath(session, '/workspace/page.html'), { target: '/private/task/workspace/page.html', boundary: '/private/task/workspace' });
  assert.deepEqual(resolveToolPath(session, '$TMPDIR/check.mjs'), { target: '/private/task/scratch/check.mjs', boundary: '/private/task/scratch' });
  assert.deepEqual(resolveToolPath(session, '/scratch/check.mjs'), { target: '/private/task/scratch/check.mjs', boundary: '/private/task/scratch' });
  assert.deepEqual(resolveToolPath(session, 'docs/BUSINESS\\_RULES.md'), { target: '/private/task/workspace/docs/BUSINESS_RULES.md', boundary: '/private/task/workspace' });
  for (const path of ['/Users/example/other/file', '/workspace/../escape', '$TMPDIR/../escape', '/reports/report.md'])
    assert.throws(() => resolveToolPath(session, path), /WORKER_PATH_OUTSIDE/);
});

test('missing read path recovers a unique nested project suffix but never guesses between projects', async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'read-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(resolve(root, 'demo1-candidate/docs'), { recursive: true });
  await writeFile(resolve(root, 'demo1-candidate/docs/BUSINESS_RULES.md'), 'rules');
  const unique = await recoverReadPath(root, resolve(root, 'docs/BUSINESS_RULES.md'));
  assert.equal(unique.recovered, true);
  assert.equal(unique.target, resolve(root, 'demo1-candidate/docs/BUSINESS_RULES.md'));
  await mkdir(resolve(root, 'other/docs'), { recursive: true });
  await writeFile(resolve(root, 'other/docs/BUSINESS_RULES.md'), 'other rules');
  const ambiguous = await recoverReadPath(root, resolve(root, 'docs/BUSINESS_RULES.md'));
  assert.equal(ambiguous.recovered, false);
  assert.deepEqual(ambiguous.candidates.sort(), ['demo1-candidate/docs/BUSINESS_RULES.md', 'other/docs/BUSINESS_RULES.md']);
});

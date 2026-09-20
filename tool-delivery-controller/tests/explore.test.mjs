import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SnapshotExplorer } from '../explore.mjs';
import { dshWorker } from '../index.mjs';

function fixture(files) {
  const explorer = new SnapshotExplorer();
  const abort = new AbortController();
  const snapshot = explorer.open(Object.fromEntries(Object.entries(files).map(([path, text]) => [path, Buffer.from(text).toString('base64')])), { session: { id: 'parent' } }, abort.signal);
  const exec = { agent: { session: { id: 'child', header: { parentSession: 'parent' } } }, signal: abort.signal };
  const call = args => explorer.execute({ token: snapshot.token, ...args }, exec);
  return { explorer, abort, snapshot, exec, call };
}

test('large snapshots are paged; search finds later references and read reconstructs long Unicode files', () => {
  const content = '汉字🙂'.repeat(70000) + '\nfunction target() {}';
  const f = fixture({ 'src/large.js': content, 'image.bin': Buffer.from([0, 255]) });
  const first = f.call({ action: 'list', limit: 1 });
  assert.equal(first.entries.length, 1);
  assert.equal(first.nextOffset, 1);
  assert.equal(f.call({ action: 'list', offset: 1 }).nextOffset, null);
  const search = f.call({ action: 'search', query: 'target' });
  assert.equal(search.hits[0].line, 2);
  let text = '', offset = 0;
  do {
    const page = f.call({ action: 'read', path: 'src/large.js', offset, limit: 3999 });
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 32768);
    text += page.content; offset = page.nextOffset;
  } while (offset !== null);
  assert.equal(text, content);
  assert.throws(() => f.call({ action: 'read', path: 'image.bin' }), /Binary/);
  assert.throws(() => f.call({ action: 'read', path: '../secret' }), /Unsafe/);
  assert.throws(() => f.call({ action: 'read', path: 'missing' }), /not in snapshot/);
});

test('search pagination is bounded and literal', () => {
  const f = fixture({ 'a.js': Array.from({ length: 43 }, (_, i) => `literal .* ${i}`).join('\n') });
  const lines = [];
  let offset = 0;
  do {
    const page = f.call({ action: 'search', query: '.*', offset });
    lines.push(...page.hits.map(hit => hit.line)); offset = page.nextOffset;
  } while (offset !== null);
  assert.deepEqual(lines, Array.from({ length: 43 }, (_, i) => i + 1));
  assert.throws(() => f.call({ action: 'read', path: 'a.js', limit: 5000 }));
  assert.throws(() => f.call({ action: 'search', query: '' }));
});

test('capabilities reject parents, other workers, cancellation and expired rounds', () => {
  const f = fixture({ 'a': 'old snapshot' });
  const args = { token: f.snapshot.token, action: 'read', path: 'a' };
  assert.throws(() => f.explorer.execute(args, { agent: { session: { id: 'parent', header: {} } } }), /denied/);
  assert.equal(f.call(args).content, 'old snapshot');
  assert.throws(() => f.explorer.execute(args, { agent: { session: { id: 'sibling', header: { parentSession: 'parent' } } } }), /another worker/);
  f.abort.abort();
  assert.throws(() => f.call(args), /expired/);
  f.explorer.close(f.snapshot.token);
  assert.equal(f.explorer.sessions.size, 0);
  assert.throws(() => f.call(args), /expired/);
});

test('failed child startup revokes snapshot access', async () => {
  const explorer = new SnapshotExplorer();
  const worker = dshWorker({ subagents: { async start() { throw new Error('startup failed'); } } }, {}, explorer);
  await assert.rejects(worker({ parent: { session: { id: 'parent' } }, signal: new AbortController().signal, files: {} }), /startup failed/);
  assert.equal(explorer.sessions.size, 0);
});

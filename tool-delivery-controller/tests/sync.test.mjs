import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, statSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mergeSnapshots, syncPlan, applySync } from '../sync.mjs';
const b64 = value => Buffer.from(value).toString('base64');
test('three-way merge automatically combines non-overlapping edits in the same file', () => {
  const base = { 'src/a': b64('one\ntwo\nthree\nfour\nfive\nsix\nseven\n') };
  const proposed = { 'src/a': b64('ONE\ntwo\nthree\nfour\nfive\nsix\nseven\n') };
  const current = { 'src/a': b64('one\ntwo\nthree\nfour\nfive\nsix\nSEVEN\n'), 'src/b': b64('other') };
  const merged = mergeSnapshots(base, proposed, current);
  assert.equal(Buffer.from(merged['src/a'], 'base64').toString(), 'ONE\ntwo\nthree\nfour\nfive\nsix\nSEVEN\n');
  assert.equal(merged['src/b'], current['src/b']);
});
test('add/delete and file/directory conflicts refuse implicit overwrite', () => {
  assert.throws(() => mergeSnapshots({ a: b64('a') }, {}, { a: b64('changed') }), /conflict/);
  assert.throws(() => mergeSnapshots({}, { a: b64('file') }, { 'a/b': b64('child') }), /conflict/);
});
test('journal replay resumes partial writes, preserves modes, and detects a third version', t => {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), 'sync-test-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const before = { a: b64('old'), b: b64('old') }, after = { a: b64('new'), b: b64('new') };
  writeFileSync(resolve(root, 'a'), 'old', { mode: 0o755 }); writeFileSync(resolve(root, 'b'), 'old');
  const plan = syncPlan(before, after);
  assert.throws(() => applySync(root, plan, () => { throw new Error('crash'); }), /crash/);
  assert.equal(readFileSync(resolve(root, 'a'), 'utf8'), 'new');
  assert.equal(readFileSync(resolve(root, 'b'), 'utf8'), 'old');
  applySync(root, plan);
  assert.equal(readFileSync(resolve(root, 'b'), 'utf8'), 'new');
  assert.equal(statSync(resolve(root, 'a')).mode & 0o777, 0o755);
  writeFileSync(resolve(root, 'b'), 'third');
  assert.throws(() => applySync(root, plan), /conflict/);
  assert.equal(readFileSync(resolve(root, 'b'), 'utf8'), 'third');
});
test('sync rejects symlink parents and checks every target before any write', t => {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), 'sync-link-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(resolve(root, 'outside')); symlinkSync(resolve(root, 'outside'), resolve(root, 'link'));
  writeFileSync(resolve(root, 'a'), 'old');
  assert.throws(() => applySync(root, [{ path: 'a', before: b64('old'), after: b64('new') }, { path: 'link/b', before: null, after: b64('bad') }]), /conflict/);
  assert.equal(readFileSync(resolve(root, 'a'), 'utf8'), 'old');
});

test('journal recovery removes only its intact interrupted staging file', t => {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), 'sync-staging-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(resolve(root, 'a'), 'old');
  const plan = syncPlan({ a: b64('old') }, { a: b64('new') });
  writeFileSync(resolve(root, plan[0].temporaryName), 'new');
  applySync(root, plan);
  assert.equal(readFileSync(resolve(root, 'a'), 'utf8'), 'new');
  assert.throws(() => readFileSync(resolve(root, plan[0].temporaryName)), /ENOENT/);
  writeFileSync(resolve(root, plan[0].temporaryName), 'unrelated');
  assert.throws(() => applySync(root, plan), /conflict/);
  assert.equal(readFileSync(resolve(root, plan[0].temporaryName), 'utf8'), 'unrelated');
});

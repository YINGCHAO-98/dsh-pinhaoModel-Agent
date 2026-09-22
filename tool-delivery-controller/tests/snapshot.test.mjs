import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { capture, capabilityPaths } from '../files.mjs';
async function fixture(t) {
  const root = await mkdtemp(resolve(tmpdir(), 'snapshot-budget-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
test('project snapshot accepts more than old 4 MiB and 1000-file limits', async t => {
  const root = await fixture(t);
  await writeFile(resolve(root, 'reference.png'), Buffer.alloc(5 * 1024 * 1024));
  await Promise.all(Array.from({ length: 1001 }, (_, i) => writeFile(resolve(root, `file-${i}`), 'x')));
  assert.equal(Object.keys(await capture(root)).length, 1002);
});
test('metadata budget failure identifies path and both limits; exact boundary succeeds', async t => {
  const root = await fixture(t);
  await writeFile(resolve(root, 'a'), '1234');
  assert.equal(Object.keys(await capture(root, 4, { maxFiles: 1 })).length, 1);
  await assert.rejects(capture(root, 3), /SNAPSHOT_BUDGET_EXCEEDED: path="a", fileBytes=4, totalBytes=4\/3/);
  await writeFile(resolve(root, 'b'), 'x');
  await assert.rejects(capture(root, 10, { maxFiles: 1 }), /files=2\/1/);
  for (const limit of [0, -1, Infinity]) await assert.rejects(capture(root, limit), /Invalid snapshot budget/);
});
test('specialist references skip unrelated large files; caches excluded only from source capture', async t => {
  const root = await fixture(t);
  await mkdir(resolve(root, '.npm-cache'));
  await writeFile(resolve(root, '.npm-cache/cache'), Buffer.alloc(100));
  await writeFile(resolve(root, 'large'), Buffer.alloc(100));
  await writeFile(resolve(root, 'logo.png'), 'image');
  const files = await capture(root, 5, { paths: ['logo.png'] });
  assert.deepEqual(Object.keys(files), ['logo.png']);
  assert.deepEqual(Object.keys(await capture(root, 105)).sort(), ['large', 'logo.png']);
  await assert.rejects(capture(root, 105, { includeExcluded: true }), /SNAPSHOT_BUDGET_EXCEEDED/);
  assert.deepEqual(Object.keys(await capture(root, 1, { paths: [] })), []);
  assert.equal(capabilityPaths({ capability: 'quality_review', inputRefs: [] }), undefined);
});
test('explicit references cannot bypass path, secret or symlink checks', async t => {
  const root = await fixture(t);
  await writeFile(resolve(root, '.env'), 'private');
  await symlink(tmpdir(), resolve(root, 'link'));
  for (const path of ['../outside', '.env', 'link/file'])
    await assert.rejects(capture(root, undefined, { paths: [path] }), /Unsafe|Excluded|symlink/);
});

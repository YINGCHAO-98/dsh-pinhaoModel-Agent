import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { singleHtmlContract } from '../html-contract.mjs';
import { applyProposal, validateContract } from '../files.mjs';
import { DeliveryController } from '../controller.mjs';
import { Store } from '../store.mjs';

const baseContract = JSON.parse(await readFile(new URL('../../delivery-contract.json', import.meta.url), 'utf8'));
const path = 'pelican-bicycle.html';
const contract = singleHtmlContract(path, baseContract);
const html = '<!doctype html><html><head><title>Pelican</title></head><body><svg></svg><script>const frame = 0;</script></body></html>';
const proposal = (content = html, file = path) => ({ summary: 'Created HTML', changes: [{ path: file, operation: 'write', content }] });

test('single HTML contract cannot widen writes or omit its required output', () => {
  for (const file of ['../escape.html', '/tmp/page.html', 'src/page.html', '.hidden.html', 'page.js', '*', '', null])
    assert.throws(() => singleHtmlContract(file, baseContract));
  for (const file of ['other.html', 'src/app.js', 'package.json', 'tests/test.cjs'])
    assert.throws(() => applyProposal({}, proposal(html, file), contract), /Protected path/);
  assert.throws(() => singleHtmlContract(path, { ...baseContract, protectedPaths: [path] }), /Protected path/);
  assert.throws(() => applyProposal({}, { summary: 'done', changes: [] }, contract), /Required verification input missing/);
  assert.throws(() => applyProposal({ [path]: Buffer.from(html).toString('base64') },
    { summary: 'deleted', changes: [{ path, operation: 'delete' }] }, contract), /Required verification input missing/);
  assert.throws(() => validateContract({ ...contract, requiredPaths: [], requiredOutputs: undefined }), /Incomplete/);
  assert.ok(applyProposal({}, proposal(), contract)[path]);
});

test('trusted HTML check rejects placeholder documents and broken script syntax', async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'html-check-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const check = () => {
    const result = spawnSync(process.execPath, contract.checks[0].argv.slice(1), { cwd: root, encoding: 'utf8' });
    return result;
  };
  for (const content of ['placeholder', html.replace('const frame = 0;', 'const = ;'), html.replace('<script>', '<script src="external.js">')]) {
    await writeFile(resolve(root, path), content);
    assert.notEqual(check().status, 0);
  }
  await writeFile(resolve(root, path), html.replace('const frame = 0;', 'throw new Error("must not execute page code")'));
  assert.equal(check().status, 0);
});

test('new HTML in a project without tests is checked, reviewed and synchronized; quality failure cannot publish', async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'html-delivery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const reviewStatus of ['passed', 'failed']) {
    const workspace = resolve(root, reviewStatus);
    await mkdir(workspace);
    await writeFile(resolve(workspace, 'keep.txt'), 'untouched');
    const store = new Store(resolve(root, `state-${reviewStatus}`));
    t.after(() => store.close());
    let reviews = 0, checks = 0;
    const route = { model: 'fixture-quality', provider: 'fixture' };
    const controller = new DeliveryController({ store, qualityGate: route,
      worker: async () => proposal(),
      // Fixture runner, no live model or sandbox claims. Real sandbox is tested separately.
      runner: { async preflight() {}, async check({ check, snapshot, files }) {
        checks++;
        assert.ok(files[path]);
        assert.equal(check.id, 'single-html');
        return { id: check.id, snapshot, kind: 'passed', exitCode: 0 };
      } },
      reviewer: async ({ snapshot }) => { reviews++; return { ...route, snapshot, status: reviewStatus, evidence: ['Fixture independent review'] }; },
    });
    const run = await controller.create({ owner: 'session', workspace, objective: 'Create a single HTML animation', contract });
    const result = await controller.drive(run.id, 'session');
    assert.equal(result.state, reviewStatus, result.reason);
    assert.ok(reviews > 0);
    assert.ok(checks > 0);
    assert.equal(await readFile(resolve(workspace, 'keep.txt'), 'utf8'), 'untouched');
    if (reviewStatus === 'passed') {
      assert.equal(await readFile(resolve(workspace, path), 'utf8'), html);
      assert.deepEqual((await readdir(workspace)).sort(), ['keep.txt', path]);
      assert.equal(result.syncReceipt.verified, true);
    } else {
      assert.deepEqual(await readdir(workspace), ['keep.txt']);
    }
  }
});

test('SVG positioning cannot be overwritten by CSS transform animation', async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'svg-conflict-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const page = body => '<!doctype html><html><head><style>@keyframes spin {from{transform:rotate(0deg)}to{transform:rotate(360deg)}} #rear, #front {animation: spin 1s linear infinite}</style></head><body><svg>' + body + '</svg></body></html>';
  const run = async body => { await writeFile(resolve(root, path), page(body)); return spawnSync(process.execPath, contract.checks[0].argv.slice(1), { cwd: root, encoding: 'utf8' }); };
  const bad = await run('<g id="rear" transform="translate(110,250)"><circle r="20"/></g>');
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /SVG_TRANSFORM_ANIMATION_CONFLICT/);
  assert.equal((await run('<g transform="translate(110,250)"><g id="rear"><circle r="20"/></g></g>')).status, 0);
});

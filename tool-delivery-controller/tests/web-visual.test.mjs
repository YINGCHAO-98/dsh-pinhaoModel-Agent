import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsWebReview, webEntries, snapshotResponse, enforceVisualReport } from '../web-visual.mjs';
import { DeliveryController } from '../controller.mjs';
import { Store } from '../store.mjs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
const files = { 'index.html': Buffer.from('<html><body>hello</body></html>').toString('base64') };
test('web detection covers HTML and framework sources; browser serves only immutable resources', () => {
  assert.equal(needsWebReview(files), true);
  assert.equal(needsWebReview({ 'src/App.tsx': '' }), true);
  assert.equal(needsWebReview({ 'server.js': '' }), false);
  assert.deepEqual(webEntries({ ...files, 'tests/fixture.html': '' }), ['index.html']);
  assert.equal(snapshotResponse('https://snapshot.invalid/index.html', files).body, files['index.html']);
  for (const url of ['https://example.com/', 'http://127.0.0.1/', 'file:///etc/passwd', 'https://snapshot.invalid/secret', 'https://snapshot.invalid/%2e%2e/etc/passwd'])
    assert.throws(() => snapshotResponse(url, files), /BLOCKED|MISSING/);
});
test('missing screenshots and browser failures cannot receive a visual pass', () => {
  const report = { status: 'passed', evidence: [] };
  assert.equal(enforceVisualReport(report, { screenshots: [] }).status, 'blocked');
  assert.equal(enforceVisualReport(report, { screenshots: [{}], failures: ['script exception'] }).status, 'failed');
});
for (const status of ['missing', 'stale', 'empty', 'failed', 'passed']) test(`controller enforces web visual gate: ${status}`, async () => {
  const base = await mkdtemp(resolve(tmpdir(), 'web-gate-'));
  const workspace = resolve(base, 'project'); await mkdir(workspace);
  const store = new Store(resolve(base, 'state'));
  try {
    const controller = new DeliveryController({ store, reviewPolicy: 'on_request',
      worker: async () => ({ summary: 'HTML', changes: [{ path: 'index.html', operation: 'write', content: '<!doctype html><html><head><title>hello</title></head><body>hello</body></html>' }] }),
      runner: { async preflight() {}, async check({ check, snapshot }) { return { id: check.id, snapshot, kind: 'passed', exitCode: 0 }; } },
      webReviewer: status === 'missing' ? null : async ({ snapshot }) => ({ snapshot: status === 'stale' ? 'wrong' : snapshot,
        status: status === 'failed' ? 'failed' : 'passed', screenshots: status === 'empty' ? [] : [{ sha256: 'fixture' }] }),
    });
    const run = await controller.create({ owner: 'root', workspace, objective: 'Create a web page',
      contract: { version: 1, layout: 'workspace', editablePaths: ['**'], protectedPaths: [], requiredPaths: [], checks: [], maxRepairs: 0 } });
    const result = await controller.drive(run.id, 'root');
    assert.equal(result.state, status === 'passed' ? 'passed' : status === 'failed' ? 'failed' : 'blocked', result.reason);
    assert.equal(result.evidence.find(e => e.id === 'web-visual').snapshot, result.snapshot);
  } finally { store.close(); await rm(base, { recursive: true, force: true }); }
});

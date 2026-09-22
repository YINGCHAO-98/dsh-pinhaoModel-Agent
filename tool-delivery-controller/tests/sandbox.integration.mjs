import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { SandboxRunner } from '../runner.mjs';
import { digest } from '../files.mjs';
import { singleHtmlContract } from '../html-contract.mjs';

test('single HTML trusted check runs inside the real sandbox without tests directory', async () => {
  const runner = new SandboxRunner({ nodeExecutable: process.execPath });
  await runner.preflight();
  const contract = singleHtmlContract('page.html', { protectedPaths: [], maxRepairs: 2 });
  for (const [content, kind] of [
    ['<!doctype html><html><head></head><body><svg></svg><script>throw new Error("not executed")</script></body></html>', 'passed'],
    ['<!doctype html><html><head></head><body><script>const = ;</script></body></html>', 'failed'],
  ]) {
    const files = { 'page.html': Buffer.from(content).toString('base64') };
    const result = await runner.check({ files, snapshot: digest(files), check: contract.checks[0] });
    assert.equal(result.kind, kind, JSON.stringify(result));
  }
});

test('real sandbox permits checks but blocks snapshot/host writes and host secret reads', async t => {
  const base = await mkdtemp(resolve(tmpdir(), 'delivery-secret-'));
  const secret = resolve(base, 'secret');
  await writeFile(secret, 'untouched');
  t.after(() => rm(base, { recursive: true, force: true }));
  const runner = new SandboxRunner({ nodeExecutable: process.execPath });
  await runner.preflight();
  const content = `const fs=require('node:fs'); const assert=require('node:assert/strict');
    assert.throws(()=>fs.writeFileSync('source.txt','changed'));
    assert.throws(()=>fs.writeFileSync(${JSON.stringify(secret)},'changed'));
    assert.throws(()=>fs.readFileSync(${JSON.stringify(secret)}));
    fs.writeFileSync(require('node:path').join(require('node:os').tmpdir(),'allowed'),'ok');
    console.log('isolation enforced');`;
  const files = { 'source.txt': Buffer.from('original').toString('base64'), 'check.cjs': Buffer.from(content).toString('base64') };
  const result = await runner.check({ files, snapshot: digest(files), check: { id: 'isolation', argv: ['node', 'check.cjs'], timeoutMs: 10000 } });
  assert.equal(result.kind, 'passed', JSON.stringify(result));
  assert.match(result.stdout, /isolation enforced/u);
  assert.equal(await readFile(secret, 'utf8'), 'untouched');
});

test('real verification timeout blocks and terminates its process group', async () => {
  const runner = new SandboxRunner({ nodeExecutable: process.execPath });
  await runner.preflight();
  const files = { 'hang.cjs': Buffer.from('setInterval(()=>{}, 1000)').toString('base64') };
  const result = await runner.check({ files, snapshot: digest(files), check: { id: 'timeout', argv: ['node', 'hang.cjs'], timeoutMs: 300 } });
  assert.equal(result.kind, 'blocked');
  assert.equal(result.timedOut, true);
});

test('exit code zero without the contracted test report is not a pass', async () => {
  const runner = new SandboxRunner({ nodeExecutable: process.execPath });
  await runner.preflight();
  const files = { 'empty.cjs': Buffer.from('process.exit(0)').toString('base64') };
  const result = await runner.check({ files, snapshot: digest(files),
    check: { id: 'empty', argv: ['node', 'empty.cjs'], timeoutMs: 10000, minTests: 1 } });
  assert.equal(result.exitCode, 0);
  assert.equal(result.kind, 'failed');
});

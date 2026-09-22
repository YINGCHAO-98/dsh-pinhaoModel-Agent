import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { TYPERT } from '../typert.mjs';
const require = createRequire('/Applications/DSH Desktop.app/Contents/Resources/app/package.json');
const { Context } = await import(require.resolve('@deepseek-ai/cordis'));
const { default: Typert } = await import(require.resolve('@deepseek-ai/dsh-typert-registry'));
test('actual DSH registry accepts strict codec and read-only service descriptor', async () => {
  const ctx = new Context(); await ctx.plugin(Typert);
  ctx.typert.register(TYPERT);
  assert.ok(ctx.typert.getPackage('dsh-model-logs', 'host'));
  assert.equal(TYPERT.invocations[0].result.schema.parse('{}'), '{}');
  assert.throws(() => TYPERT.invocations[0].result.schema.parse({}), /Expected/);
});

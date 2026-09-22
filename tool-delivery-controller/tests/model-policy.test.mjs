import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configuredAgentOptions, configuredWorkerAgentOptions, resolveAgentOptions, validateConfiguredModels } from '../model-policy.mjs';

test('model policy rejects malformed and adapter-incompatible delivery parameters before dispatch', async () => {
  for (const value of [{}, { provider: 'doubao' }, { model: 'kimi' }, { provider: 'doubao', model: 'kimi', maxTokens: 0 },
    { provider: 'doubao', model: 'kimi', reasoningEffort: '' }]) assert.throws(() => configuredAgentOptions(value));
  const llm = { async resolveCallConfig(options) {
    if (options.model === 'kimi' && options.reasoningEffort !== undefined)
      throw new Error(`provider "doubao" model "kimi" does not support reasoning effort "${options.reasoningEffort}"`);
    if (options.model === 'missing') throw new Error('model not found');
    return { ...options };
  } };
  await assert.rejects(resolveAgentOptions(llm, { provider: 'doubao', model: 'kimi', reasoningEffort: 'off' }), /does not support/);
  await assert.rejects(validateConfiguredModels(llm, { modelProvider: 'doubao', model: 'kimi', specialists: [
    { provider: 'doubao', model: 'missing' },
  ] }), /model not found/);
  assert.deepEqual(await resolveAgentOptions(llm, { provider: 'doubao', model: 'kimi', maxTokens: 32768 }),
    { provider: 'doubao', model: 'kimi', maxTokens: 32768 });
  assert.deepEqual(configuredWorkerAgentOptions({ provider: 'spawn', modelProvider: 'doubao', model: 'kimi', maxTokens: 32768 }),
    { provider: 'doubao', model: 'kimi', maxTokens: 32768 });
});

test('model policy rejects a validator that changes identity or returns unknown controls', async () => {
  await assert.rejects(resolveAgentOptions({ resolveCallConfig: async options => ({ ...options, model: 'other' }) },
    { provider: 'doubao', model: 'kimi' }), /invalid or changed/);
  await assert.rejects(resolveAgentOptions({ resolveCallConfig: async options => ({ ...options, temperature: 1 }) },
    { provider: 'doubao', model: 'kimi' }), /invalid or changed/);
  await assert.rejects(resolveAgentOptions({}, { provider: 'doubao', model: 'kimi' }), /required/);
});

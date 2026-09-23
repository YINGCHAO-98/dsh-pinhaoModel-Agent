import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configuredAgentOptions, configuredWorkerAgentOptions, configuredRecoveryWorkerAgentOptions, resolveAgentOptions, validateConfiguredModels, validateRoleRoutes, installOrchestratorRoute } from '../model-policy.mjs';

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
  await assert.rejects(validateConfiguredModels(llm, { modelProvider: 'doubao', model: 'kimi-k2-8-preview', specialists: [
    { provider: 'doubao', model: 'missing' },
  ] }), /model not found/);
  assert.deepEqual(await resolveAgentOptions(llm, { provider: 'doubao', model: 'kimi', maxTokens: 32768 }),
    { provider: 'doubao', model: 'kimi', maxTokens: 32768 });
  assert.deepEqual(configuredWorkerAgentOptions({ provider: 'spawn', modelProvider: 'doubao', model: 'kimi-k2-8-preview', maxTokens: 32768 }),
    { provider: 'doubao', model: 'kimi-k2-8-preview', maxTokens: 32768 });
});

test('model role policy rejects swapped experts, writable specialists and shell access for planners', () => {
  const config = { enforceRoleModels: true, orchestrator: { model: 'deepseek-v4-1-flash' },
    designTool: 'task_minimax_design', qualityTool: 'task_kimi_quality', specialists: [
      { toolName: 'task_minimax_design', model: 'minimax-m3', readOnly: true, tools: ['read'] },
      { toolName: 'task_kimi_quality', model: 'kimi-k2.7-code', readOnly: true, tools: ['read', 'bash'] },
      { toolName: 'task_glm_vision', model: 'glm-5-3-flash', readOnly: true, tools: ['read_image'] },
      { toolName: 'task_doubao_media', model: 'doubao-seed-2-0-lite-260215', readOnly: true, tools: ['read'] },
    ] };
  assert.doesNotThrow(() => validateRoleRoutes(config));
  for (const patch of [{ model: 'kimi-k2-8-preview' }, { readOnly: false }, { tools: ['read', 'write'] }, { tools: ['bash'] }]) {
    const changed = structuredClone(config); Object.assign(changed.specialists[0], patch);
    assert.throws(() => validateRoleRoutes(changed), /Invalid specialist/);
  }
  const changed = structuredClone(config); changed.specialists[1].model = 'kimi-k2-8-preview';
  assert.throws(() => validateRoleRoutes(changed), /Invalid specialist/);
});

test('root request is routed to DeepSeek while Kimi implementation and review requests stay unchanged', async () => {
  let hook;
  const route = { provider: 'doubao', model: 'deepseek-v4-1-flash', reasoningEffort: 'low', maxTokens: 32768 };
  installOrchestratorRoute({ on: (name, handler) => { assert.equal(name, 'agent/request'); hook = handler; } }, { orchestrator: route });
  const proposal = { provider: 'doubao', model: 'kimi-k2.7-code', reasoningEffort: 'high', maxTokens: 10, messages: ['kept'] };
  assert.deepEqual(await hook({ agent: { session: { header: {} } } }, async () => proposal), { ...proposal, ...route });
  assert.equal(await hook({ agent: { session: { header: { parentSession: 'root' } } } }, async () => proposal), proposal);
});

test('model policy rejects a validator that changes identity or returns unknown controls', async () => {
  await assert.rejects(resolveAgentOptions({ resolveCallConfig: async options => ({ ...options, model: 'other' }) },
    { provider: 'doubao', model: 'kimi' }), /invalid or changed/);
  await assert.rejects(resolveAgentOptions({ resolveCallConfig: async options => ({ ...options, temperature: 1 }) },
    { provider: 'doubao', model: 'kimi' }), /invalid or changed/);
  await assert.rejects(resolveAgentOptions({}, { provider: 'doubao', model: 'kimi' }), /required/);
});

test('implementation prefers Kimi and accepts only a validated bounded recovery route', () => {
  const config = { modelProvider: 'doubao', model: 'kimi-k2-8-preview', maxTokens: 16384 };
  assert.deepEqual(configuredWorkerAgentOptions(config), { provider: 'doubao', model: 'kimi-k2-8-preview', maxTokens: 16384 });
  assert.throws(() => configuredWorkerAgentOptions({ model: 'kimi-k2.7-code' }), /must be Kimi K2.8/);
  for (const legacy of [
    { singleHtmlWorker: { provider: 'doubao', model: 'deepseek-v4-1-flash' } },
    { workerFallback: { provider: 'doubao', model: 'deepseek-v4-1-flash' } },
    { singleHtmlReasoningEffort: 'off' },
  ]) assert.throws(() => configuredWorkerAgentOptions({ ...config, ...legacy }), /Legacy implementation routes are forbidden/);
  assert.throws(() => configuredWorkerAgentOptions({ modelProvider: 'doubao', model: 'deepseek-v4-1-flash' }), /must be Kimi/);
  assert.deepEqual(configuredRecoveryWorkerAgentOptions({ ...config, enforceRoleModels: true,
    recoveryWorker: { provider: 'doubao', model: 'deepseek-v4-1-flash', reasoningEffort: 'off' } }),
  { provider: 'doubao', model: 'deepseek-v4-1-flash', reasoningEffort: 'off' });
  assert.throws(() => configuredRecoveryWorkerAgentOptions({ ...config, recoveryWorker: { provider: 'doubao' } }), /requires non-empty/);
  assert.throws(() => configuredRecoveryWorkerAgentOptions({ ...config, enforceRoleModels: true,
    recoveryWorker: { provider: 'doubao', model: 'kimi-k2.7-code' } }), /must use DeepSeek/);
});

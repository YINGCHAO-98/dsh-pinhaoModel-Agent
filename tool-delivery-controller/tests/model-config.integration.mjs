import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const require = createRequire('/Applications/DSH Desktop.app/Contents/Resources/app/package.json');
const { parse } = require('yaml');
const { apply } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm-pi-ai')));
const { streamSimple } = await import(pathToFileURL('/Applications/DSH Desktop.app/Contents/Resources/app/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js'));

test('installed adapter maps configured DeepSeek effort and output budget into the wire request', async () => {
  const settings = parse(await readFile(new URL('../../host/settings.yaml', import.meta.url), 'utf8'));
  let adapter;
  apply({ get() {}, inject() {}, llm: {
    registerConfigurableProviders() { return {}; }, registerModelDiscovery() {},
    registerAdapter(_routes, value) { adapter = value; return {}; },
  } }, settings['llm-pi-ai']);
  const info = await adapter.resolveModel('doubao', 'deepseek-v4-1-flash');
  assert.deepEqual(info.reasoning.efforts.map(e => e.id), ['off', 'low', 'high', 'max']);
  assert.equal(info.defaultMaxTokens, 32768);
  const model = adapter.modelOf(adapter.current(), 'doubao', 'deepseek-v4-1-flash');
  for (const reasoning of ['low', 'off']) {
    let payload;
    const stream = streamSimple(model, { messages: [{ role: 'user', content: 'fixture', timestamp: 0 }] }, {
      apiKey: 'fixture-not-a-real-key', reasoning, maxTokens: info.defaultMaxTokens,
      onPayload(value) { payload = value; throw new Error('Captured before network'); },
    });
    for await (const _event of stream) {}
    assert.ok(payload, 'must reach installed wire serializer');
    assert.equal(payload.max_tokens ?? payload.max_completion_tokens, 32768);
    assert.deepEqual(payload.thinking, { type: reasoning === 'off' ? 'disabled' : 'enabled' });
    assert.equal(payload.reasoning_effort, reasoning === 'off' ? undefined : 'low');
  }
  // Other models must retain their existing capability metadata.
  assert.equal((await adapter.resolveModel('doubao', 'kimi-k2.7-code')).reasoning, undefined);
  assert.equal(settings['agent-default-model'].model, 'kimi-k2.7-code');
  assert.equal(settings['agent-default-model'].reasoningEffort, undefined);
});

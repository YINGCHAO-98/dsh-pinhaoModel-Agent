import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const require = createRequire('/Applications/DSH Desktop.app/Contents/Resources/app/package.json');
const { parse } = require('yaml');
const { apply } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm-pi-ai')));
const settings = parse(await readFile(new URL('../../host/settings.yaml', import.meta.url), 'utf8'));
function adapterFor(config) {
  let adapter;
  apply({ get() {}, inject() {}, llm: {
    registerConfigurableProviders() { return {}; }, registerModelDiscovery() {},
    registerAdapter(_routes, value) { adapter = value; return {}; },
  } }, config);
  return adapter;
}
test('production route bounds retries and never retries idle timeouts', () => {
  const adapter = adapterFor(settings['llm-pi-ai']);
  const profile = adapter.current().profiles.get('doubao');
  assert.equal(profile.streamIdleTimeoutMs, 120000);
  const policy = adapter.providerRetryPolicy('doubao');
  assert.equal(policy.mode, 'normal');
  assert.equal(policy.maxRetries, 1);
  assert.equal(policy.retryableCodes.includes('TIMEOUT'), false);
  assert.equal(policy.retryableCodes.includes('RATE_LIMIT'), true);
});
test('installed stream watchdog aborts a stalled provider with TIMEOUT', async () => {
  const config = structuredClone(settings['llm-pi-ai']);
  config.providers.doubao.streamIdleTimeoutMs = 30;
  const adapter = adapterFor(config);
  adapter.config.resolveApiKey = async () => 'fixture';
  const snapshot = adapter.current();
  let cancelled = false;
  // Exercise the real adapter watchdog without an external request or real key.
  snapshot.models.streamSimple = (_model, _context, options) => ({
    [Symbol.asyncIterator]() { return this; },
    next() { return new Promise(resolve => options.signal.addEventListener('abort', () => {
      cancelled = true; resolve({ done: true });
    }, { once: true })); },
    return() { return Promise.resolve({ done: true }); },
  });
  const keepAlive = setTimeout(() => {}, 2000);
  try {
    await assert.rejects(async () => {
      for await (const _chunk of adapter.stream({ provider: 'doubao', model: 'deepseek-v4-1-flash',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'fixture' }] }] })) {}
    }, error => error.code === 'TIMEOUT' && /30ms/.test(error.message));
    assert.equal(cancelled, true);
  } finally { clearTimeout(keepAlive); }
});

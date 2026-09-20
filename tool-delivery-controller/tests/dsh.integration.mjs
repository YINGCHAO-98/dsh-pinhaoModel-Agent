import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { apply, dshWorker } from '../index.mjs';
import { SnapshotExplorer } from '../explore.mjs';

const root = process.env.DSH_SOURCE;
if (!root) throw new Error('Set DSH_SOURCE to a built deepseek-harness checkout');
const require = createRequire(resolve(root, 'packages/core/tools/package.json'));
const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')));
const { createScope } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-scope')));
const { default: SystemPrompt } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-system-prompt')));
const { default: Tools } = await import(pathToFileURL(resolve(root, 'packages/core/tools/lib/index.js')));

test('real DSH tool registry denies global, scoped and newly registered bypass tools', async t => {
  const base = await mkdtemp(resolve(tmpdir(), 'delivery-dsh-'));
  const ctx = new Context();
  let scope;
  t.after(async () => { await scope?.dispose(); await rm(base, { recursive: true, force: true }); });
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(Tools);
  const agent = { id: 'test-session', session: { id: 'test-session', header: { cwd: base } } };
  await ctx.plugin(Object.assign(inner => { scope = createScope(inner, agent); }, { inject: ['tools', 'systemPrompt'] }));
  let called = 0;
  const tool = name => ({ name, description: name, parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_, value) => [{ type: 'text', text: value }] },
    async execute() { called++; return 'bypass'; } });
  ctx.tools.register(tool('global_shell'));
  scope.ctx.tools.register(tool('scoped_shell'));
  const commands = new Map();
  const pluginContext = {
    tools: scope.ctx.tools, on: scope.ctx.on.bind(scope.ctx),
    commands: { register(def) { commands.set(def.name, def); } },
    subagents: { start() { throw new Error('No model calls expected'); } },
  };
  apply(pluginContext, { stateDir: resolve(base, 'state'), contractPath: resolve(base, 'contract.json') });
  scope.ctx.tools.register(tool('later_mcp_shell'));
  for (const name of ['global_shell', 'scoped_shell', 'later_mcp_shell', 'run_code']) {
    const result = await ctx.tools.execute({ agent, name, arguments: {}, callId: `call-${name}`, signal: new AbortController().signal });
    assert.equal(result.isError, true, name);
  }
  assert.equal(called, 0);
  const status = await ctx.tools.execute({ agent, name: 'delivery_status', arguments: {}, callId: 'status', signal: new AbortController().signal });
  assert.notEqual(status.isError, true, JSON.stringify(status));
  assert.equal(status.content[0].text, '[]');
  for (const objective of ['', '   ', 42, 'x'.repeat(16001)]) {
    const result = await ctx.tools.execute({ agent, name: 'delivery_start', arguments: { objective }, callId: 'invalid-start', signal: new AbortController().signal });
    assert.equal(result.isError, true);
  }
  const missingContract = await ctx.tools.execute({ agent, name: 'delivery_start', arguments: { objective: 'Fix code' }, callId: 'missing-contract', signal: new AbortController().signal });
  assert.equal(missingContract.isError, true);
  assert.ok(commands.has('deliver'));
  const commandStatus = await commands.get('deliver').handler({ agent, rawInput: 'status', signal: new AbortController().signal });
  assert.equal(commandStatus.kind, 'success');
  await scope.dispose();
});

test('worker adapter enforces schema, exploration allowlist and child disposal', async () => {
  let disposed = false;
  let request;
  const explorer = new SnapshotExplorer();
  const worker = dshWorker({ subagents: { async start(provider, input) {
    assert.equal(provider, 'spawn'); request = input;
    return { result: Promise.resolve({ stopReason: 'completed', structured: { summary: 'done', changes: [] } }),
      async dispose() { disposed = true; } };
  } } }, {}, explorer);
  const value = await worker({ parent: { session: { id: 'parent' } }, files: {}, signal: new AbortController().signal, phase: 'implement' });
  assert.deepEqual(value.changes, []);
  assert.equal(disposed, true);
  assert.deepEqual(request.toolFilter, { allow: ['snapshot_explore'] });
  assert.equal(explorer.sessions.size, 0);
  assert.equal(request.outputSchema.additionalProperties, false);
  assert.equal(request.maxDepth, 1);
});

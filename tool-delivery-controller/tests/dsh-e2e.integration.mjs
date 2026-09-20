import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { mkdtemp, mkdir, readFile, writeFile, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const root = process.env.DSH_SOURCE;
if (!root) throw new Error('Set DSH_SOURCE to a built deepseek-harness checkout');
const require = createRequire(resolve(root, 'apps/cli/package.json'));
const load = path => import(pathToFileURL(resolve(root, path)));
const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')));
const { default: Loader } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis-plugin-loader')));
const { default: Include } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis-plugin-include')));
const { mountAgentLoopTestDependencies } = await load('packages/test-support/agent-loop-testkit/lib/index.js');
const { default: AgentLoop } = await load('packages/core/agent-loop/lib/index.js');
const { default: Presets } = await load('packages/preset/agent-presets/lib/index.js');
const { default: Commands } = await load('packages/interaction/commands/lib/index.js');
const { default: Subagents } = await load('packages/subagent/subagent/lib/index.js');
const Spawn = await load('packages/subagent/subagent-spawn-in-process/lib/index.js');
const { LlmAdapter } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')));

for (const entry of ['command', 'tool']) test(`real preset loader, ${entry} entry, spawn worker and sandbox complete failure → repair → pass`, { timeout: 30000 }, async t => {
  const base = await mkdtemp(resolve(tmpdir(), 'delivery-e2e-'));
  const preset = resolve(base, 'presets/controlled');
  await mkdir(preset, { recursive: true });
  const template = await readFile(new URL('../../agent.cordis.yml', import.meta.url), 'utf8');
  await writeFile(resolve(preset, 'agent.cordis.yml'), template
    .replace('name: ./tool-delivery-controller/index.mjs', `name: ${JSON.stringify(fileURLToPath(new URL('../index.mjs', import.meta.url)))}`)
    .replace(/^    stateDir:.*$/mu, `    stateDir: ${JSON.stringify(resolve(base, 'state'))}`)
    .replace('modelProvider: doubao', 'modelProvider: fixture'));
  await writeFile(resolve(preset, 'preset.yml'), 'name: Controlled fixture\ndescription: Test\n');
  await writeFile(resolve(preset, 'delivery-contract.json'), await readFile(new URL('../../delivery-contract.json', import.meta.url)));
  const workspace = resolve(base, 'project');
  await cp(fileURLToPath(new URL('../examples/tiny-app/', import.meta.url)), workspace, { recursive: true });
  await writeFile(resolve(workspace, 'large.txt'), 'unused text\n'.repeat(30000));
  const ctx = new Context();
  t.after(async () => { await ctx.fiber.dispose(); await rm(base, { recursive: true, force: true }); });
  ctx.baseUrl = pathToFileURL(resolve(root, 'apps/cli')).href + '/';
  await ctx.plugin(Loader);
  ctx.loader.builtins.include = Include;
  await mountAgentLoopTestDependencies(ctx);
  await ctx.plugin(AgentLoop, { agents: [] });
  await ctx.plugin(Commands);
  await ctx.plugin(Subagents);
  await ctx.plugin(Spawn, { providerName: 'spawn' });
  await ctx.plugin(Presets, { default: 'controlled', roots: [{ path: resolve(base, 'presets'), trust: 'system' }],
    includeShippedRoot: false, includeUserRoot: false });
  const requests = [];
  class FixtureAdapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model }; }
    async *stream(options) {
      requests.push(options);
      const step = (requests.length - 1) % 4;
      function snapshotOf(value) {
        if (typeof value === 'string') { try { return snapshotOf(JSON.parse(value)); } catch { return; } }
        if (!value || typeof value !== 'object') return;
        if (value.snapshot?.token) return value.snapshot;
        for (const item of Object.values(value)) { const found = snapshotOf(item); if (found) return found; }
      }
      const snapshot = snapshotOf(options);
      assert.ok(snapshot?.token);
      const changes = requests.length <= 4 ? [] : [{ path: 'src/sum.cjs', operation: 'write', content: 'module.exports = (a,b) => a+b;\n' }];
      const name = step === 3 ? 'structured_output' : 'snapshot_explore';
      const args = JSON.stringify(step === 3 ? { summary: 'Fixture proposal', changes } : { token: snapshot.token, ...[
        { action: 'list' }, { action: 'search', query: 'module.exports', path: 'src/' },
        { action: 'read', path: 'src/sum.cjs' },
      ][step] });
      if (step === 3) assert.ok(JSON.stringify(options).includes('module.exports'), 'read result reaches model');
      const id = `fixture-${requests.length}`;
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args };
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } };
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 10 } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    }
  }
  ctx.llm.registerAdapter(['fixture'], new FixtureAdapter());
  const handle = await ctx.agents.create({ sessionId: 'delivery-e2e',
    meta: { cwd: workspace },
    agentOptions: { provider: 'fixture', model: 'fixture' },
    setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, 'controlled'); },
  });
  assert.deepEqual(ctx.tools.schemas(handle.agent).map(x => x.name).sort(), ['delivery_start', 'delivery_status', 'snapshot_explore'].sort());
  let outcome;
  if (entry === 'command') {
    const result = await ctx.commands.execute(handle.agent, '/deliver start 修复加法函数', [], new AbortController().signal);
    assert.equal(result.result.kind, 'success', JSON.stringify(result));
    outcome = JSON.parse(result.result.text);
  } else {
    const result = await ctx.tools.execute({ agent: handle.agent, name: 'delivery_start', arguments: { objective: '修复加法函数' }, callId: 'start', signal: new AbortController().signal });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    outcome = JSON.parse(result.content[0].text);
  }
  assert.equal(outcome.objective, '修复加法函数');
  assert.equal(outcome.state, 'passed', JSON.stringify(outcome));
  assert.equal(outcome.repairCount, 1);
  assert.equal(outcome.verifyCalls, 2);
  assert.equal(requests.length, 8);
  for (const request of requests) assert.ok(request.tools.every(tool => ['structured_output', 'snapshot_explore'].includes(tool.name)));
  await handle.dispose();
});

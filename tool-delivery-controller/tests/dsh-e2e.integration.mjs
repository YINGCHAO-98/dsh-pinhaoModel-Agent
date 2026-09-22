import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { mkdtemp, mkdir, readFile, writeFile, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { specialistTools } from '../specialists.mjs';
import { workerTools } from '../workspace.mjs';

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

for (const entry of ['command', 'tool', 'assistance', 'conflict', 'group']) test(`real preset loader, ${entry} entry, spawn worker and sandbox complete failure → repair → pass`, { timeout: 30000 }, async t => {
  const base = await mkdtemp(resolve(tmpdir(), 'delivery-e2e-'));
  const preset = resolve(base, 'presets/controlled');
  await mkdir(preset, { recursive: true });
  const template = await readFile(new URL('../../agent.cordis.yml', import.meta.url), 'utf8');
  await writeFile(resolve(preset, 'agent.cordis.yml'), template
    .replace('name: ./tool-delivery-controller/index.mjs', `name: ${JSON.stringify(fileURLToPath(new URL('../index.mjs', import.meta.url)))}`)
    .replace(/^    stateDir:.*$/mu, `    stateDir: ${JSON.stringify(resolve(base, 'state'))}`)
    .replace('modelProvider: doubao', 'modelProvider: fixture').replaceAll('provider: doubao', 'provider: fixture'));
  await cp(fileURLToPath(new URL('../../skills/', import.meta.url)), resolve(preset, 'skills'), { recursive: true });
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
  await ctx.plugin((await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-skill')))).default);
  await ctx.plugin((await load('packages/interaction/user-questions/lib/index.js')).default);
  await ctx.plugin(AgentLoop, { agents: [] });
  await ctx.plugin(Commands);
  await ctx.plugin(Subagents);
  await ctx.plugin(Spawn, { providerName: 'spawn' });
  await ctx.plugin(Presets, { default: 'controlled', roots: [{ path: resolve(base, 'presets'), trust: 'system' }],
    includeShippedRoot: false, includeUserRoot: false });
  const asked = [];
  ctx.on('user-questions/request', async request => { asked.push(request); return { answers: request.questions.map(q => ({ id: q.id, selected: ['采用交付版本'] })) }; });
  const requests = [];
  let implementationRequests = 0;
  const specialistRequests = [];
  const resolvedModels = new Set();
  const specialistSteps = new Map();
  const workerSteps = new Map();
  class FixtureAdapter extends LlmAdapter {
    async resolveModel(provider, model) { resolvedModels.add(model); return { provider, id: model, name: model }; }
    async *stream(options) {
      requests.push(options);

      function findPayload(value, predicate) {
        if (typeof value === 'string') { try { return findPayload(JSON.parse(value), predicate); } catch { return; } }
        if (!value || typeof value !== 'object') return;
        if (predicate(value)) return value;
        for (const item of Object.values(value)) { const found = findPayload(item, predicate); if (found) return found; }
      }
      const payload = findPayload(options, value => value.snapshot?.token);
      const snapshot = payload?.snapshot;
      const specialist = !payload.phase;
      if (specialist) specialistRequests.push(options); else implementationRequests++;
      const step = workerSteps.get(snapshot.token) ?? 0;
      if (!specialist) workerSteps.set(snapshot.token, step + 1);
      assert.ok(snapshot?.token);
      let calls = [
        ['snapshot_explore', { token: snapshot.token, action: 'list' }],
        ['glob', { pattern: '**/*.cjs' }],
        ['grep', { pattern: 'module.exports', path: 'src/' }],
        ['read', { file_path: 'src/sum.cjs' }],
        ['edit', { file_path: 'src/sum.cjs', old_string: 'a - b', new_string: payload.phase === 'implement' ? 'a - b' : 'a + b' }],
        ['bash', { command: 'node --test --test-reporter=tap', description: 'Run development tests' }],
        ['structured_output', { summary: 'Fixture implementation' }],
      ];
      if (!specialist && entry === 'group' && !payload.taskContext) calls = [
        ['read', { file_path: 'src/sum.cjs' }],
        ['bash', { command: 'node --test --test-reporter=tap', description: 'Verify integrated project' }],
        ['structured_output', { summary: 'Fixture root integration' }],
      ];
      if (!specialist && entry === 'assistance' && payload.phase === 'implement') calls.unshift(['request_capability', {
        capability: 'creative_writing', objective: 'Produce the requested release note', reason: 'Caller explicitly requires specialist release copy',
        singleModelGap: 'Dedicated copy output is part of this fixture task', inputRefs: [], expectedOutput: 'Release note text', acceptanceCriteria: ['Complete note']
      }]);
      if (!specialist && entry === 'assistance' && payload.phase === 'repair') assert.equal(payload.upstreamReports.length, 1);
      const specialistStep = specialistSteps.get(snapshot.token) ?? 0;
      if (specialist) specialistSteps.set(snapshot.token, specialistStep + 1);
      const [name, value] = specialist ? (specialistStep === 0 ? ['bash', { command: 'node --test --test-reporter=tap', description: 'Independently run tests' }] : ['structured_output', { status: 'passed', summary: 'Fixture independent review', evidence: ['Inspected fixture inputs and deterministic test results'], limitations: ['Mock model response'] }]) : calls[step];
      if (entry === 'conflict' && !specialist && payload.phase === 'repair' && name === 'structured_output') await writeFile(resolve(workspace, 'src/sum.cjs'), 'module.exports = (a, b) => a * b;\n');
      const args = JSON.stringify(value);
      if (!specialist && step === 0) assert.ok(!JSON.stringify(options).includes('unused text'), 'file contents are not preloaded');
      if (!specialist && calls[step][0] === 'edit') assert.ok(JSON.stringify(options).includes('module.exports = (a, b) => a - b'), 'read result reaches model');
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
  assert.deepEqual(ctx.tools.schemas(handle.agent).map(x => x.name).sort(), ['request_capability', 'capability_status', 'delivery_resume', 'delivery_start', 'delivery_status', 'snapshot_explore', 'read_image', 'skill', 'todo_write', 'ask_user_question', 'multimodel_run', 'task_kimi_research', 'task_kimi_quality', 'task_glm_vision', 'task_minimax_creative', 'task_doubao_media', ...workerTools].sort());
  const rootAssembly = await ctx.systemPrompt.assemble({ scope: handle.agent });
  assert.ok(rootAssembly.tools.some(tool => tool.name === 'delivery_start'));
  for (const name of [...workerTools, 'snapshot_explore', 'read_image'])
    assert.ok(!rootAssembly.tools.some(tool => tool.name === name), `root model must not see ${name}`);
  const skillResult = await ctx.tools.execute({ agent: handle.agent, name: 'skill', arguments: { name: 'multimodel-orchestration' }, callId: 'load-skill', signal: new AbortController().signal });
  assert.notEqual(skillResult.isError, true, JSON.stringify(skillResult));
  assert.match(JSON.stringify(skillResult), /multimodel_run/);
  const forged = await ctx.tools.execute({ agent: handle.agent, name: 'delivery_resume', arguments: { id: 'fake', conflictResolutions: [{ take: 'delivery' }] }, callId: 'forged-decision', signal: new AbortController().signal });
  assert.equal(forged.isError, true);
  let outcome;
  if (entry === 'command') {
    const result = await ctx.commands.execute(handle.agent, '/deliver start 修复加法函数', [], new AbortController().signal);
    assert.equal(result.result.kind, 'success', JSON.stringify(result));
    outcome = JSON.parse(result.result.text);
  } else {
    const result = await ctx.tools.execute({ agent: handle.agent, name: 'delivery_start', arguments: { objective: '修复加法函数', ...(entry === 'group' ? { tasks: [{ id: 'sum', objective: '修复加法函数', context: 'sum.cjs should add both inputs', interfaces: ['module.exports(a,b)'], acceptanceCriteria: ['positive and negative sums pass'], editablePaths: ['src/sum.cjs'], dependsOn: [] }] } : {}) }, callId: 'start', signal: new AbortController().signal });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    outcome = JSON.parse(result.content[0].text);
  }
  assert.equal(asked.length, entry === 'conflict' ? 1 : 0);
  if (entry === 'conflict') { assert.match(asked[0].questions[0].detail, /a \* b/); assert.match(asked[0].questions[0].detail, /a \+ b/); }
  assert.equal(outcome.objective, '修复加法函数');
  assert.equal(outcome.state, 'passed', JSON.stringify(outcome));
  assert.equal(outcome.repairCount, entry === 'group' ? 0 : 1);
  assert.equal(outcome.verifyCalls, entry === 'group' ? 1 : 2);
  if (entry === 'group') { assert.equal(outcome.taskStates.length, 1); assert.equal(outcome.taskStates[0].state, 'passed'); assert.equal(outcome.sourceDeliveries.length, 1); }
  assert.equal(implementationRequests, entry === 'assistance' ? 15 : entry === 'group' ? 17 : 14);
  assert.equal(specialistRequests.length, ['assistance', 'group'].includes(entry) ? 4 : 2);
  assert.equal(outcome.capabilityTasks.filter(t => t.capability !== 'quality_review').length, entry === 'assistance' ? 1 : 0);
  assert.equal(outcome.quality.model, 'kimi-k2.7-code');
  assert.equal(outcome.quality.status, 'passed');
  assert.equal(outcome.quality.snapshot, outcome.snapshot);
  for (const tool of ['task_minimax_creative']) {
    const result = await ctx.tools.execute({ agent: handle.agent, name: tool, arguments: { objective: 'Return a fixture report', reason: 'Need specialist copy', singleModelGap: 'Creative output is separate from code repair', inputRefs: [], expectedOutput: 'Complete copy', acceptanceCriteria: ['Complete copy is present'] }, callId: tool, signal: new AbortController().signal });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    const report = JSON.parse(result.content[0].text);
    assert.equal(report.tool, tool);
    assert.equal(report.status, 'passed');
  }
  assert.equal(specialistRequests.length, ['assistance', 'group'].includes(entry) ? 6 : 4);
  for (const model of ['deepseek-v4-1-flash', 'kimi-k2.7-code', 'minimax-m3']) assert.ok(resolvedModels.has(model), model);
  for (const request of requests) assert.ok(request.tools.every(tool => ['request_capability', 'structured_output', ...specialistTools, ...workerTools].includes(tool.name)));
  assert.match(await readFile(resolve(workspace, 'src/sum.cjs'), 'utf8'), /a \+ b/);
  assert.equal(outcome.syncReceipt.verified, true);
  assert.equal(outcome.projectMatchesReceipt, true);
  assert.match(await readFile(resolve(outcome.artifact, 'src/sum.cjs'), 'utf8'), /a \+ b/);
  await handle.dispose();
});

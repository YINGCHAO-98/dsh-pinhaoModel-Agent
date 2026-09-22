// Explicitly opt in: this runs the installed DSH adapter against real paid models.
// Credentials stay in DSH's credential service and are never copied to fixtures.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { mkdtemp, mkdir, readFile, writeFile, cp } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import * as multimodel from './live-multimodel-fixture.mjs';
import { tmpdir } from 'node:os';

if (process.env.DSH_LIVE !== '1') throw new Error('Set DSH_LIVE=1 to authorize real model calls');
const scenario = process.env.DSH_LIVE_SCENARIO ?? 'delivery';
assert.ok(['delivery', 'multimodel', 'assistance'].includes(scenario), 'Unknown live scenario');
const runtime = process.env.DSH_RUNTIME ?? '/Applications/DSH Desktop.app/Contents/Resources/app/package.json';
const home = process.env.DSH_LIVE_HOME ?? '/Users/chowchow/Library/Application Support/dsh-desktop/harness';
const require = createRequire(runtime);
const load = name => import(pathToFileURL(require.resolve(`@deepseek-ai/${name}`)));
const { parse } = require('yaml');
const settings = parse(await readFile(resolve(home, 'settings.yaml'), 'utf8'));
const providerConfig = settings['llm-pi-ai'];
assert.ok(providerConfig?.providers?.doubao, 'DSH doubao provider configuration missing');
const { Context } = await load('cordis');
const { createUserMessage } = await load('dsh-llm');
const { default: Loader } = await load('cordis-plugin-loader');
const { default: Include } = await load('cordis-plugin-include');
const base = await mkdtemp(resolve(tmpdir(), 'pinhaomo-live-'));
const preset = resolve(base, 'presets/pinhaomo-live');
const state = resolve(base, 'state');
const workspace = resolve(base, 'project');
await mkdir(preset, { recursive: true });
const template = await readFile(new URL('../../agent.cordis.yml', import.meta.url), 'utf8');
await writeFile(resolve(preset, 'agent.cordis.yml'), template
  .replace('name: ./tool-delivery-controller/index.mjs', `name: ${JSON.stringify(fileURLToPath(new URL('../index.mjs', import.meta.url)))}`)
  .replace(/^    stateDir:.*$/mu, `    stateDir: ${JSON.stringify(state)}`));
await cp(fileURLToPath(new URL('../../skills/', import.meta.url)), resolve(preset, 'skills'), { recursive: true });
if (scenario === 'multimodel') await multimodel.prepare(workspace, require);
else await cp(fileURLToPath(new URL('../examples/tiny-app/', import.meta.url)), workspace, { recursive: true });
await cp(fileURLToPath(new URL('../../delivery-contract.json', import.meta.url)), resolve(preset, 'delivery-contract.json'));
await writeFile(resolve(preset, 'preset.yml'), 'name: Pinhaomo live E2E\ndescription: Real model delivery validation\n');
const startedAt = new Date().toISOString();
const ctx = new Context();
const trace = [];
const agents = new Map();
let handle, outcome, failure, verification, credentialValue = '';
const checkpoint = setInterval(() => { writeFileSync(resolve(base, 'trace.json'), safe(JSON.stringify(trace)), { mode: 0o600 }); }, 5000);
const safe = text => credentialValue ? String(text).replaceAll(credentialValue, '[REDACTED]') : String(text);
process.on('SIGTERM', () => { handle?.agent.cancel({ kind: 'user' }); });
process.on('SIGINT', () => { handle?.agent.cancel({ kind: 'user' }); });
console.log(JSON.stringify({ event: 'live.start', startedAt, output: base, scenario, models: scenario === 'multimodel' ? multimodel.models : scenario === 'assistance' ? ['deepseek-v4-1-flash', 'minimax-m3', 'kimi-k2.7-code'] : ['deepseek-v4-1-flash', 'kimi-k2.7-code'] }));
try {
  ctx.baseUrl = pathToFileURL(resolve(runtime, '..')).href + '/';
  await ctx.plugin(Loader); ctx.loader.builtins.include = Include;
  for (const name of ['dsh-llm', 'dsh-session', 'dsh-session-projection', 'dsh-system-prompt', 'dsh-tools', 'dsh-agent', 'dsh-skill', 'dsh-user-questions']) {
    await ctx.plugin((await load(name)).default);
  }
  await ctx.plugin((await load('dsh-attachment-local')).default, { dshHome: resolve(base, 'media-store') });
  await ctx.plugin((await load('dsh-credentials-local')).default, { path: resolve(home, '.credentials.yaml'), watch: false });
  credentialValue = (await ctx.credentials.resolve(providerConfig.providers.doubao.apiKeyEnv))?.value ?? '';
  assert.ok(credentialValue, 'Configured credential is unavailable');
  await ctx.plugin(await load('dsh-llm-pi-ai'), providerConfig);
  await ctx.plugin((await load('dsh-agent-loop')).default, { agents: [] });
  await ctx.plugin((await load('dsh-commands')).default);
  await ctx.plugin((await load('dsh-subagent')).default);
  await ctx.plugin(await load('dsh-subagent-spawn-in-process'), { providerName: 'spawn' });
  await ctx.plugin((await load('dsh-agent-presets')).default, { default: 'pinhaomo-live',
    roots: [{ path: resolve(base, 'presets'), trust: 'system' }], includeShippedRoot: false, includeUserRoot: false });
  ctx.on('agent/created', ({ agent }) => {
    const info = { createdAt: new Date().toISOString(), id: agent.session.id, parent: agent.session.header.parentSession ?? null,
      provider: agent.options.provider, model: agent.options.model };
    agents.set(info.id, info); console.log(JSON.stringify({ event: 'agent.created', ...info }));
  });
  ctx.on('agent/disposed', ({ agent }) => { const info = agents.get(agent.session.id); if (info) info.disposedAt = new Date().toISOString(); });
  ctx.on('session/event', (session, event) => {
    trace.push({ session: session.id, ...event });
    if (event.type === 'tool/call') console.log(JSON.stringify({ event: 'tool.call', session: session.id, name: event.data.name }));
    if (event.type === 'assistant/message') console.log(JSON.stringify({ event: 'model.response', session: session.id,
      model: agents.get(session.id)?.model }));
  });
  ctx.on('agent/error', ({ agent, error }) => console.log(JSON.stringify({ event: 'agent.error', session: agent.session.id, error: safe(error?.message ?? error) })));
  handle = await ctx.agents.create({ sessionId: `live-${Date.now()}`, meta: { cwd: workspace },
    agentOptions: { provider: 'doubao', model: 'deepseek-v4-1-flash' },
    setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, 'pinhaomo-live'); },
  });
  let objective = scenario === 'multimodel' ? multimodel.objective : '请修复这个项目 src/sum.cjs 中的加法函数：对两个数字返回数学上的和，正确处理正数、负数和零。保留 CommonJS 导出形式，不修改 tests 或项目配置。请直接完成代码修改、运行已有测试，并独立验收后交付；不要只给建议。';
  if (scenario === 'assistance') objective += '\n这是专业协助与自动交接的验收用例：额外交付一段面向用户的简短发布说明。请实际使用 request_capability 的 creative_writing 能力生成说明，提交 schema 要求的理由、能力缺口和验收条件，inputRefs 使用 file:src/sum.cjs。然后把返回的 artifactRef 通过 delivery_start.reportRefs 传入研发，不要手工转述替代引用。';
  const timeout = setTimeout(() => handle.agent.cancel({ kind: 'user' }), 20 * 60 * 1000);
  try {
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: objective }], source: { kind: 'user' } }));
    await handle.agent.whenIdle();
  } finally { clearTimeout(timeout); }
  const result = await ctx.tools.execute({ agent: handle.agent, name: 'delivery_status', arguments: {}, callId: 'live-status', signal: new AbortController().signal });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  const runs = JSON.parse(result.content[0].text);
  outcome = runs[0];
  assert.ok(outcome, 'Real root agent did not start delivery');
  assert.equal(outcome.state, 'passed', safe(JSON.stringify(outcome)));
  assert.equal(outcome.quality?.model, 'kimi-k2.7-code');
  assert.equal(outcome.quality?.status, 'passed');
  assert.equal(outcome.quality?.snapshot, outcome.snapshot);
  if (scenario === 'multimodel') verification = await multimodel.verify({ workspace, outcome, trace, agents });
  else {
  const actual = require(resolve(outcome.artifact, 'src/sum.cjs'));
  for (const [a, b] of [[3, 4], [-3, 4], [0, 0], [-2, -4]]) assert.equal(actual(a, b), a + b);
  assert.equal(outcome.mode, 'project');
  assert.equal(outcome.syncReceipt?.verified, true);
  assert.equal(await readFile(resolve(workspace, 'src/sum.cjs'), 'utf8'), await readFile(resolve(outcome.artifact, 'src/sum.cjs'), 'utf8'));
  }
  if (scenario === 'assistance') {
    assert.ok(outcome.reportRefs.length, 'Accepted report was not handed to delivery');
    const status = await ctx.tools.execute({ agent: handle.agent, name: 'capability_status', arguments: {}, callId: 'capability-status', signal: new AbortController().signal });
    const tasks = JSON.parse(status.content[0].text);
    assert.ok(tasks.some(t => t.capability === 'creative_writing' && t.state === 'accepted'), 'Real creative capability was not accepted');
    verification = { reportHandoff: outcome.reportRefs, capabilityTasks: tasks };
  } else if (scenario === 'delivery') {
    assert.equal(outcome.capabilityTasks.filter(t => t.capability !== 'quality_review').length, 0, 'Simple bug unnecessarily delegated');
    assert.ok(!trace.some(e => e.type === 'tool/call' && ['request_capability', 'multimodel_run'].includes(e.data.name)), 'Simple bug added orchestration');
  }
  assert.ok(trace.some(e => e.type === 'tool/call' && e.data.name === 'delivery_start'), 'Natural-language dispatch missing');
  assert.ok([...agents.values()].some(a => a.parent && a.model === 'kimi-k2.7-code'), 'Real Kimi child missing');
} catch (error) {
  failure = safe(error?.message ?? error);
  process.exitCode = 1;
} finally {
  clearInterval(checkpoint);
  const modelCalls = trace.filter(e => e.type === 'assistant/message').map(e => ({ session: e.session, model: e.data.message.source.model, responseId: e.data.message.source.replayState?.response?.responseId, usage: e.data.usage }));
  const report = { startedAt, finishedAt: new Date().toISOString(), status: failure ? 'failed' : 'passed',
    output: base, scenario, workspace, agents: [...agents.values()], modelCalls, outcome, verification, failure };
  await writeFile(resolve(base, 'report.json'), safe(JSON.stringify(report, null, 2)), { mode: 0o600 });
  await writeFile(resolve(base, 'trace.json'), safe(JSON.stringify(trace, null, 2)), { mode: 0o600 });
  console.log(safe(JSON.stringify({ event: 'live.finished', status: report.status, output: base, failure, outcome: outcome?.state, modelRequests: modelCalls.length }))); 
  await handle?.dispose();
  await ctx.fiber.dispose();
}

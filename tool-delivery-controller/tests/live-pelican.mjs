// Explicitly opt in: this runs the installed DSH adapter against real paid models.
// Credentials stay in DSH's credential service and are never copied to fixtures.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { mkdtemp, mkdir, readFile, writeFile, cp } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';

import { tmpdir } from 'node:os';

if (process.env.DSH_LIVE !== '1') throw new Error('Set DSH_LIVE=1 to authorize real model calls');
const fullDelivery = process.env.DSH_PELICAN_FULL === '1';
const scenario = fullDelivery ? 'pelican-delivery' : 'pelican-direct';
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
await mkdir(workspace, { recursive: true });
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
console.log(JSON.stringify({ event: 'live.start', startedAt, output: base, scenario, models: ['deepseek-v4-1-flash'] }));
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
    if (['step/start', 'step/end', 'llm/retry', 'turn/end'].includes(event.type)) console.log(JSON.stringify({event:event.type, time:event.time, data:event.data}));
    if (event.type === 'tool/call') console.log(JSON.stringify({ event: 'tool.call', session: session.id, name: event.data.name }));
    if (event.type === 'assistant/message') console.log(JSON.stringify({ event: 'model.response', session: session.id,
      model: agents.get(session.id)?.model }));
  });
  ctx.on('llm/stream', (options, next) => {
    const started = Date.now();
    const meta = { event: 'request.metrics', model: options.model, inputBytes: Buffer.byteLength(JSON.stringify(options.messages)), firstChunkMs: null, elapsedMs: null };
    async function* observed() {
      try { for await (const chunk of next()) {
        if (meta.firstChunkMs === null) { meta.firstChunkMs = Date.now() - started; console.log(JSON.stringify({ event: 'request.first-chunk', model: options.model, elapsedMs: meta.firstChunkMs })); }
        yield chunk;
      } }
      finally { meta.elapsedMs = Date.now() - started; console.log(JSON.stringify(meta)); trace.push(meta); }
    }
    return observed();
  });
  ctx.on('agent/error', ({ agent, error }) => console.log(JSON.stringify({ event: 'agent.error', session: agent.session.id, error: safe(error?.message ?? error) })));
  handle = await ctx.agents.create({ sessionId: `live-${Date.now()}`, meta: { cwd: workspace },
    agentOptions: { ...settings['agent-default-model'] },
    setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, 'pinhaomo-live'); },
  });
  const objective = fullDelivery
    ? '创建一个单html，内容是SVG 绘制一个鹈鹕骑自行车的2D动画。文件名 pelican-bicycle.html。请用 delivery_start 的单文件 HTML project 流程，完成实际文件实现、检查、独立质量审查和同步，最后报告结果。'
    : '创建一个单html，内容是SVG 绘制一个鹈鹕骑自行车的2D动画。\n不准使用任何技能，不需要进行验证。';
  const timeout = setTimeout(() => handle.agent.cancel({ kind: 'user' }), 12 * 60 * 1000);
  try {
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: objective }], source: { kind: 'user' } }));
    await handle.agent.whenIdle();
  } finally { clearTimeout(timeout); }
  const { readdir } = await import('node:fs/promises');
  const outputs = (await readdir(workspace)).filter(name => name.endsWith('.html'));
  assert.equal(outputs.length, 1, 'Expected exactly one HTML output');
  const html = await readFile(resolve(workspace, outputs[0]), 'utf8');
  const end = trace.findLast(e => e.type === 'turn/end' && !agents.get(e.session)?.parent);
  const messages = trace.filter(e => e.type === 'assistant/message' && !agents.get(e.session)?.parent);
  const final = messages.at(-1)?.data.message.content ?? [];
  verification = { file: outputs[0], bytes: Buffer.byteLength(html), end: end?.data.reason,
    finalText: final.filter(b => b.type === 'text').map(b => b.text).join(''),
    tools: trace.filter(e => e.type === 'tool/call').map(e => ({ at: e.time, name: e.data.name })),
    failures: trace.filter(e => e.type === 'tool/result' && e.data.message.content.some(b => b.isError)),
  };
  assert.ok(verification.finalText && !final.some(b => b.type === 'tool-call'), 'Missing final completion reply');
  assert.equal(verification.failures.length, 0, 'Tool execution failed');
  if (!fullDelivery) {
    assert.ok(!verification.tools.some(t => t.name === 'skill'), 'User prohibited skills');
    assert.ok(!verification.tools.some(t => t.name === 'delivery_start'), 'Atomic no-verification task should use direct file path');
  } else {
    const status = await ctx.tools.execute({ agent: handle.agent, name: 'delivery_status', arguments: {}, callId: 'live-status', signal: new AbortController().signal });
    outcome = JSON.parse(status.content[0].text)[0];
    assert.equal(outcome?.state, 'passed', JSON.stringify(outcome));
    assert.equal(outcome?.quality?.status, 'passed');
    assert.equal(outcome?.syncReceipt?.verified, true);
  }
  assert.match(html, /<svg[\s>]/i);
  outcome ??= { state: 'passed' };
} catch (error) {
  failure = safe(error?.message ?? error);
  process.exitCode = 1;
} finally {
  clearInterval(checkpoint);
  if (fullDelivery && !outcome && handle) {
    try {
      const status = await ctx.tools.execute({ agent: handle.agent, name: 'delivery_status', arguments: {}, callId: 'final-status', signal: new AbortController().signal });
      outcome = JSON.parse(status.content[0].text)[0];
    } catch { /* Preserve the original failure if teardown already revoked tools. */ }
  }
  const modelCalls = trace.filter(e => e.type === 'assistant/message').map(e => ({ session: e.session, model: e.data.message.source.model, responseId: e.data.message.source.replayState?.response?.responseId, usage: e.data.usage }));
  const report = { startedAt, finishedAt: new Date().toISOString(), status: failure ? 'failed' : 'passed',
    output: base, scenario, workspace, agents: [...agents.values()], modelCalls, outcome, verification, failure };
  await writeFile(resolve(base, 'report.json'), safe(JSON.stringify(report, null, 2)), { mode: 0o600 });
  await writeFile(resolve(base, 'trace.json'), safe(JSON.stringify(trace, null, 2)), { mode: 0o600 });
  console.log(safe(JSON.stringify({ event: 'live.finished', status: report.status, output: base, failure, outcome: outcome?.state, modelRequests: modelCalls.length }))); 
  await handle?.dispose();
  await ctx.fiber.dispose();
}

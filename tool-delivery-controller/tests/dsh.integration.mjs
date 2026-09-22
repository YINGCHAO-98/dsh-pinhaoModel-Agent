import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { apply, dshWorker } from '../index.mjs';
import { workerTools, rootFileTools } from '../workspace.mjs';
import { SnapshotExplorer } from '../explore.mjs';
import { Store } from '../store.mjs';

const root = process.env.DSH_SOURCE;
if (!root) throw new Error('Set DSH_SOURCE to a built deepseek-harness checkout');
const require = createRequire(resolve(root, 'packages/core/tools/package.json'));
const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')));
const { createScope } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-scope')));
const { default: SystemPrompt } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-system-prompt')));
const { default: Tools } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-tools')));
const validatingLlm = { async resolveCallConfig(options) {
  if (options.model === 'kimi-k2.7-code' && options.reasoningEffort !== undefined)
    throw new Error(`provider "${options.provider}" model "${options.model}" does not support reasoning effort "${options.reasoningEffort}"`);
  return { ...options };
} };

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
    llm: validatingLlm,
    tools: scope.ctx.tools, on: scope.ctx.on.bind(scope.ctx),
    commands: { register(def) { commands.set(def.name, def); } },
    subagents: { start() { throw new Error('No model calls expected'); } },
  };
  await apply(pluginContext, { runtimePackageJson: "/Applications/DSH Desktop.app/Contents/Resources/app/package.json", stateDir: resolve(base, 'state'), contractPath: resolve(base, 'contract.json') });
  scope.ctx.tools.register(tool('later_mcp_shell'));
  for (const name of ['global_shell', 'scoped_shell', 'later_mcp_shell', 'run_code', ...workerTools]) {
    const result = await ctx.tools.execute({ agent, name, arguments: {}, callId: `call-${name}`, signal: new AbortController().signal });
    assert.equal(result.isError, true, name);
  }
  assert.equal(called, 0);
  const assembly = await ctx.systemPrompt.assemble({ scope: agent });
  for (const name of ['bash', 'snapshot_explore', 'read_image'])
    assert.ok(!assembly.tools.some(tool => tool.name === name), `${name} must not be sent to root model`);
  for (const name of rootFileTools) assert.ok(assembly.tools.some(tool => tool.name === name));
  assert.ok(assembly.tools.some(tool => tool.name === 'delivery_start'));
  assert.ok(assembly.tools.some(tool => tool.name === 'delivery_cancel'));

  const testStore = new Store(resolve(base, 'state'));
  try {
    const contract = { version: 1, editablePaths: ['src/'], protectedPaths: [], requiredPaths: ['src/'],
      checks: [{ id: 'test', argv: ['node', '--test'], timeoutMs: 1000 }], maxRepairs: 2 };
    const own = testStore.create({ owner: agent.session.id, workspace: base, objective: 'fixture', contract, files: {}, mode: 'project' });
    const cancel = arguments_ => ctx.tools.execute({ agent, name: 'delivery_cancel', arguments: arguments_, callId: 'cancel', signal: new AbortController().signal });
    for (const args of [{ id: own.id, owner: 'forged' }, { id: '../ bad' }]) assert.equal((await cancel(args)).isError, true);
    const foreign = testStore.create({ owner: 'foreign', workspace: base + '-foreign', objective: 'fixture', contract, files: {} });
    assert.equal((await cancel({ id: foreign.id })).isError, true);
    const value = await cancel({ id: own.id });
    assert.notEqual(value.isError, true, JSON.stringify(value));
    assert.equal(JSON.parse(value.content[0].text).state, 'cancelled');
    assert.notEqual((await cancel({ id: own.id })).isError, true);
    assert.equal(testStore.get(foreign.id).state, 'implement');
  } finally { testStore.close(); }

  const status = await ctx.tools.execute({ agent, name: 'delivery_status', arguments: {}, callId: 'status', signal: new AbortController().signal });
  assert.notEqual(status.isError, true, JSON.stringify(status));
  assert.equal(JSON.parse(status.content[0].text)[0].state, 'cancelled');
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
    return { id: 'fixture-child', result: Promise.resolve({ stopReason: 'completed', structured: { summary: 'done', changes: [] } }),
      async dispose() { disposed = true; } };
  } } }, { reasoningEffort: 'low', maxTokens: 32768 }, explorer, { bind() {}, open: async () => ({ root: "/fixture" }), close: async () => {}, proposal: async () => ({ summary: "done", changes: [] }) });
  const value = await worker({ parent: { session: { id: 'parent' } }, files: {}, signal: new AbortController().signal, phase: 'implement' });
  assert.deepEqual(value.changes, []);
  assert.equal(disposed, true);
  assert.deepEqual(request.toolFilter, { allow: [...workerTools, 'snapshot_explore'] });
  assert.equal(explorer.sessions.size, 0);
  assert.equal(request.outputSchema.additionalProperties, false);
  assert.equal(request.maxDepth, 1);
  assert.equal(request.agentOptions.reasoningEffort, 'low');
  assert.equal(request.agentOptions.maxTokens, 32768);
});

test('invalid worker model budgets are rejected before dispatch', () => {
  for (const maxTokens of [0, -1, 1.5, '32768', Infinity])
    assert.throws(() => dshWorker({}, { maxTokens }), /maxTokens/);
  for (const reasoningEffort of ['', 42]) assert.throws(() => dshWorker({}, { reasoningEffort }), /reasoningEffort/);
});

test('worker output exhaustion is classified and disposes child and workspace', async () => {
  let disposed = 0, closed = 0;
  const explorer = new SnapshotExplorer();
  const worker = dshWorker({ subagents: { async start() {
    return { id: 'limited-worker', result: Promise.resolve({ stopReason: 'max-tokens' }), async dispose() { disposed++; } };
  } } }, {}, explorer, { open: async () => ({ root: '/fixture' }), bind() {}, close: async () => { closed++; } });
  await assert.rejects(worker({ parent: { session: { id: 'root' } }, files: {}, signal: new AbortController().signal, phase: 'implement' }), { code: 'WORKER_MAX_TOKENS' });
  assert.equal(disposed, 1);
  assert.equal(closed, 1);
  assert.equal(explorer.sessions.size, 0);
});

test('real tool entry selects single HTML contract and synchronizes a fixture worker output', async t => {
  const base = await mkdtemp(resolve(tmpdir(), 'delivery-html-dsh-'));
  const workspace = resolve(base, 'project');
  await mkdir(workspace);
  const contractPath = resolve(base, 'contract.json');
  await writeFile(contractPath, await readFile(new URL('../../delivery-contract.json', import.meta.url)));
  const ctx = new Context();
  let scope;
  t.after(async () => { await scope?.dispose(); await rm(base, { recursive: true, force: true }); });
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(Tools);
  const progressEvents = [];
  const agent = { session: { id: 'html-session', header: { cwd: workspace }, append(type, data) { progressEvents.push({ type, data }); } } };
  await ctx.plugin(Object.assign(inner => { scope = createScope(inner, agent); }, { inject: ['tools', 'systemPrompt'] }));
  const html = '<!doctype html><html><head></head><body><svg></svg></body></html>';
  let workers = 0;
  await apply({ tools: scope.ctx.tools, llm: validatingLlm, on: scope.ctx.on.bind(scope.ctx), commands: { register() {} },
    subagents: { async start(_provider, input) {
      workers++;
      await new Promise(resolve => setTimeout(resolve, 1100));
      assert.ok(progressEvents.some(e => e.type === 'todo/write' && e.data.todos.some(t => t.content.includes('实现中'))), 'progress must reach root while worker is still running');
      const payload = JSON.parse(input.prompt[0].text);
      assert.deepEqual(payload.contract.editablePaths, ['pelican-bicycle.html']);
      await writeFile(resolve(payload.workspace, 'pelican-bicycle.html'), html);
      return { id: 'html-worker', result: Promise.resolve({ stopReason: 'completed', structured: { summary: 'Fixture HTML' } }), async dispose() {} };
    } },
  }, { stateDir: resolve(base, 'state'), contractPath,
    runtimePackageJson: '/Applications/DSH Desktop.app/Contents/Resources/app/package.json' });
  const call = args => ctx.tools.execute({ agent, name: 'delivery_start', arguments: args,
    callId: 'html-start', signal: new AbortController().signal });
  for (const extra of [{ singleHtmlPath: '../escape.html' }, { singleHtmlPath: 'page.html', sourceDeliveryIds: ['other'] }, { skipVerification: true }]) {
    const result = await call({ objective: 'Create one HTML', ...extra });
    assert.equal(result.isError, true);
  }
  assert.equal(workers, 0);
  const result = await call({ objective: 'Create one HTML', singleHtmlPath: 'pelican-bicycle.html' });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  const run = JSON.parse(result.content[0].text);
  assert.equal(run.state, 'passed', run.reason);
  assert.equal(workers, 1);
  assert.equal(run.syncReceipt.verified, true);
  assert.ok(progressEvents.at(-1).data.todos.every(t => t.status === 'completed'));
  assert.equal(await readFile(resolve(workspace, 'pelican-bicycle.html'), 'utf8'), html);
});

test('single HTML worker hands off on a successful write without another model completion', async () => {
  const workspace={root:'/fixture',execution:[],tokenUsage:[]};let disposed=false,closed=false;
  const worker=dshWorker({subagents:{async start(_provider,input){
    assert.deepEqual(input.toolFilter.allow,['read','write']);
    assert.equal(input.agentOptions.reasoningEffort,undefined);
    queueMicrotask(()=>workspace.draftReady.resolve({draft:true}));
    return {id:'child',result:new Promise(()=>{}),async dispose(){disposed=true;}};
  }}},{reasoningEffort:'low'}, {open:()=>({token:'fixture'}),close(){}}, {
    open:async()=>workspace,bind(){},close:async()=>{closed=true;},proposal:async(_w,_f,summary)=>({summary,changes:[{path:'p.html',operation:'write',content:'draft'}]}),
  });
  const result=await worker({parent:{session:{id:'parent'}},signal:new AbortController().signal,files:{},contract:{editablePaths:['p.html'],requiredOutputs:['p.html'],checks:[{id:'single-html'}]}});
  assert.ok(disposed && closed);assert.match(result.summary,/verification and independent review are still required/);
  assert.equal(result.changes.length,1);
});

test('animation HTML enforces Doubao plan before Kimi implementation and hands the accepted plan to code', async t => {
  const base = await mkdtemp(resolve(tmpdir(), 'delivery-animation-dsh-'));
  const workspace = resolve(base, 'project'); await mkdir(workspace);
  const contractPath = resolve(base, 'contract.json');
  await writeFile(contractPath, await readFile(new URL('../../delivery-contract.json', import.meta.url)));
  const ctx = new Context(); let scope;
  t.after(async () => { await scope?.dispose(); await rm(base, { recursive: true, force: true }); });
  await ctx.plugin(SystemPrompt); await ctx.plugin(Tools);
  const calls = [];
  const agent = { session: { id: 'animation-session', header: { cwd: workspace }, append() {} } };
  await ctx.plugin(Object.assign(inner => { scope = createScope(inner, agent); }, { inject: ['tools', 'systemPrompt'] }));
  await apply({ tools: scope.ctx.tools, llm: validatingLlm, on: scope.ctx.on.bind(scope.ctx), commands: { register() {} },
    subagents: { async start(_provider, input) {
      calls.push(input.label);
      if (input.label === 'task_doubao_animation') {
        assert.deepEqual(input.toolFilter.allow, ['read', 'glob', 'grep', 'snapshot_explore', 'skill']);
        return { id: 'doubao-plan', result: Promise.resolve({ stopReason: 'completed', structured: {
          status: 'passed', summary: '0-2 秒建立画面，2-5 秒主体动作，5-6 秒回到首帧循环；实现器使用 SVG 分层与 ease-in-out。',
          evidence: ['方案包含画面、动作、时间轴、分镜、循环和实现参数'], limitations: ['不生成视频'] } }), async dispose() {} };
      }
      assert.equal(input.label, 'Delivery implement');
      assert.equal(input.agentOptions.model, 'kimi-k2.7-code');
      assert.equal(Object.hasOwn(input.agentOptions, 'reasoningEffort'), false);
      const payload = JSON.parse(input.prompt[0].text);
      assert.equal(payload.upstreamReports.length, 1);
      assert.equal(payload.upstreamReports[0].capability, 'animation_planning');
      await writeFile(resolve(payload.workspace, payload.contract.requiredOutputs[0]), '<!doctype html><html><head></head><body><svg><circle cx="20" cy="20" r="10"/></svg></body></html>');
      return { id: 'kimi-implementation', result: Promise.resolve({ stopReason: 'completed', structured: { summary: 'Implemented the accepted storyboard.' } }), async dispose() {} };
    } },
  }, { stateDir: resolve(base, 'state'), contractPath, runtimePackageJson: '/Applications/DSH Desktop.app/Contents/Resources/app/package.json',
    modelProvider: 'doubao', model: 'kimi-k2.7-code', animationPlanTool: 'task_doubao_animation',
    specialists: [{ toolName: 'task_doubao_animation', provider: 'doubao', model: 'doubao-seed-2-0-lite-260215', readOnly: true,
      tools: ['read', 'glob', 'grep', 'snapshot_explore', 'skill'], persona: 'Create an animation plan only.' }],
    sandbox: { nodeExecutable: '/Applications/DSH Desktop.app/Contents/Resources/app/node_modules/node/bin/node', backend: 'seatbelt' } });
  const result = await ctx.tools.execute({ agent, name: 'delivery_start', arguments: {
    objective: '制作一个循环 SVG 动画，明确动作节奏和分镜', singleHtmlPath: 'scene.html' }, callId: 'animation-start', signal: new AbortController().signal });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  const run = JSON.parse(result.content[0].text);
  assert.equal(run.state, 'passed', run.reason);
  assert.deepEqual(calls, ['task_doubao_animation', 'Delivery implement']);
  assert.equal(run.capabilityTasks[0].capability, 'animation_planning');
  assert.equal(run.capabilityTasks[0].state, 'accepted');
  assert.match(await readFile(resolve(workspace, 'scene.html'), 'utf8'), /<svg>/);

  const unverifiedResult = await ctx.tools.execute({ agent, name: 'delivery_start', arguments: {
    objective: '再制作一个 SVG 动画，不使用任何 skill，不进行任何验证', singleHtmlPath: 'unverified-scene.html' }, callId: 'animation-unverified', signal: new AbortController().signal });
  assert.notEqual(unverifiedResult.isError, true, JSON.stringify(unverifiedResult));
  const unverified = JSON.parse(unverifiedResult.content[0].text);
  assert.equal(unverified.state, 'passed', unverified.reason);
  assert.equal(unverified.assurance, 'unverified');
  assert.equal(unverified.verifyCalls, 0);
  assert.deepEqual(unverified.checks, []);
  assert.equal(unverified.qualityGate, null);
  assert.equal(unverified.syncReceipt.verified, false);
  assert.equal(unverified.syncReceipt.assurance, 'unverified');
  assert.deepEqual(calls, ['task_doubao_animation', 'Delivery implement', 'task_doubao_animation', 'Delivery implement']);
  assert.match(await readFile(resolve(workspace, 'unverified-scene.html'), 'utf8'), /<svg>/);

  // A blocked project must be rejected before another paid animation plan is dispatched.
  const blockerStore = new Store(resolve(base, 'state'));
  blockerStore.create({ owner: agent.session.id, workspace: await realpath(workspace), objective: 'blocked fixture', contract: {}, files: {}, mode: 'project' });
  blockerStore.close();
  const callCount = calls.length;
  const duplicate = await ctx.tools.execute({ agent, name: 'delivery_start', arguments: {
    objective: '再次制作循环 SVG 动画', singleHtmlPath: 'another-scene.html' }, callId: 'duplicate-animation-start', signal: new AbortController().signal });
  assert.equal(duplicate.isError, true, JSON.stringify(duplicate));
  assert.match(JSON.stringify(duplicate), /unfinished delivery/);
  assert.equal(calls.length, callCount);

  const bypass = await ctx.tools.execute({ agent, name: 'write', arguments: { file_path: 'scene.html', content: 'bypass' }, callId: 'bypass', signal: new AbortController().signal });
  assert.equal(bypass.isError, true);
  assert.match(JSON.stringify(bypass), /CONTROLLED_ANIMATION_PATH|ANIMATION_ROUTE_REQUIRED/);
});

test('general native tool entry keeps session paths and binds explicit subdirectory delivery', async t => {
  const base = await realpath(await mkdtemp(resolve(tmpdir(), 'delivery-general-dsh-')));
  const workspace = resolve(base, 'project');
  await mkdir(resolve(workspace, 'candidate'), { recursive: true });
  const contractPath = resolve(base, 'contract.json');
  await writeFile(contractPath, await readFile(new URL('../../delivery-contract.json', import.meta.url)));
  const ctx = new Context(); let scope;
  t.after(async () => { await scope?.dispose(); await rm(base, { recursive: true, force: true }); });
  await ctx.plugin(SystemPrompt); await ctx.plugin(Tools);
  const agent = { session: { id: 'general-session', header: { cwd: workspace } } };
  await ctx.plugin(Object.assign(inner => { scope = createScope(inner, agent); }, { inject: ['tools', 'systemPrompt'] }));
  let calls = 0;
  await apply({ tools: scope.ctx.tools, llm: validatingLlm, on: scope.ctx.on.bind(scope.ctx), commands: { register() {} },
    subagents: { async start(_provider, input) {
      const payload = JSON.parse(input.prompt[0].text);
      const output = calls++ ? 'child.txt' : 'candidate/parent-relative.txt';
      assert.equal(payload.deliveryDirectory, calls === 1 ? workspace : resolve(workspace, 'candidate'));
      if (calls === 1) await mkdir(resolve(payload.workspace, 'candidate'), { recursive: true });
      await writeFile(resolve(payload.workspace, output), 'delivered');
      return { id: `general-worker-${calls}`, result: Promise.resolve({ stopReason: 'completed', structured: { summary: 'Created file; no automated tests' } }), async dispose() {} };
    } },
  }, { stateDir: resolve(base, 'state'), contractPath, runtimePackageJson: '/Applications/DSH Desktop.app/Contents/Resources/app/package.json' });
  const call = (name, args) => ctx.tools.execute({ agent, name, arguments: args, callId: `general-${calls}`, signal: new AbortController().signal });
  const context = await call('delivery_context', {});
  assert.notEqual(context.isError, true); assert.equal(JSON.parse(context.content[0].text).deliveryDirectory, workspace);
  for (const projectRoot of [undefined, 'candidate']) {
    const value = await call('delivery_start', { objective: 'Create a text file', ...(projectRoot ? { projectRoot } : {}) });
    assert.notEqual(value.isError, true, JSON.stringify(value));
    const run = JSON.parse(value.content[0].text); assert.equal(run.state, 'passed', run.reason);
    assert.equal(run.verification.automatedChecks, 'not_configured');
    assert.equal(run.deliveryDirectory, projectRoot ? resolve(workspace, projectRoot) : workspace);
  }
  assert.equal(await readFile(resolve(workspace, 'candidate/parent-relative.txt'), 'utf8'), 'delivered');
  assert.equal(await readFile(resolve(workspace, 'candidate/child.txt'), 'utf8'), 'delivered');
  await assert.rejects(readFile(resolve(workspace, 'child.txt')), { code: 'ENOENT' });
  assert.equal((await call('delivery_start', { objective: 'Bad path', projectRoot: '../outside' })).isError, true);
  assert.equal(calls, 2);
});

test('HTML adapter uses only caller deadline and disposes timed-out attempts before returning', async () => {
  const signal = AbortSignal.timeout(15);
  const explorer = new SnapshotExplorer(); let disposed = 0, closed = 0;
  const worker = dshWorker({ subagents: { async start(_provider, input) {
    assert.equal(input.signal, signal, 'no extra first-write deadline may replace the controller signal');
    return { id: 'timeout-child', result: new Promise((_, reject) => {
      input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true });
    }), async dispose() { disposed++; } };
  } } }, { singleHtmlFirstWriteTimeoutMs: 1 }, explorer, {
    async open() { return { root: '/fixture', execution: [] }; }, bind() {}, async close() { closed++; },
  });
  const keepAlive = setInterval(() => {}, 50);
  try {
    await assert.rejects(worker({ parent: { session: { id: 'root' } }, files: {}, signal, phase: 'implement',
      contract: { editablePaths: ['page.html'], requiredOutputs: ['page.html'], checks: [{ id: 'single-html' }] } }),
      error => error.code === 'WORKER_EXECUTION_TIMEOUT' && error.executionCount === 0);
    assert.equal(disposed, 1); assert.equal(closed, 1); assert.equal(explorer.sessions.size, 0);
  } finally { clearInterval(keepAlive); }
});

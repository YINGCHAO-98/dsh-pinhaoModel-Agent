import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { apply, dshWorker, compactTerminalDelivery, workerPromptInput } from '../index.mjs';
import { WorkerWorkspaces, workerTools, rootFileTools, registerHtmlChunkTool } from '../workspace.mjs';
import { installToolPolicy } from '../tool-policy.mjs';
import { completeHtmlDraft } from '../request-policy.mjs';
import { SnapshotExplorer } from '../explore.mjs';
import { Store } from '../store.mjs';
import { productDesignWireSchema, normalizeProductDesignReport, validateProductDesign } from '../product-design.mjs';
import { productDesignReportSchema } from '../specialists.mjs';

const root = process.env.DSH_SOURCE;
if (!root) throw new Error('Set DSH_SOURCE to a built deepseek-harness checkout');
const require = createRequire(resolve(root, 'packages/core/tools/package.json'));
const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')));
const { createScope, bindScopeParent } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-scope')));
const { default: SystemPrompt } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-system-prompt')));
const { default: Tools } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-tools')));
const { assertObjectJsonSchema, validateJsonSchemaValue } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-tools')));
const validatingLlm = { async resolveCallConfig(options) {
  if (options.model === 'kimi-k2.7-code' && options.reasoningEffort !== undefined)
    throw new Error(`provider "${options.provider}" model "${options.model}" does not support reasoning effort "${options.reasoningEffort}"`);
  return { ...options };
} };

test('real DSH accepts flat MiniMax output and local normalization rejects malformed sections', () => {
  const schema = productDesignReportSchema;
  assert.doesNotThrow(() => assertObjectJsonSchema(schema));
  const plan = { goal: 'Deliver a page', users: 'Visitor', scope: 'One HTML file', userFlows: 'Open page',
    implementation: 'Build with Kimi', acceptanceCriteria: 'Page opens', risks: 'Minor',
    assumptions: 'Modern browser', riskLevel: 'low' };
  const report = { status: 'passed', summary: 'Ready', evidence: '', limitations: '', designPlan: plan };
  assert.deepEqual(validateJsonSchemaValue(schema, report), []);
  const normalized = normalizeProductDesignReport(report);
  assert.doesNotThrow(() => validateProductDesign(normalized.designPlan));
  for (const bad of [{ ...plan, goal: '' }, { ...plan, users: '' }, { ...plan, users: 'x'.repeat(4001) }]) {
    assert.throws(() => normalizeProductDesignReport({ ...report, designPlan: bad }), /Invalid product design/);
  }
  assert.notDeepEqual(validateJsonSchemaValue(schema, { ...report, designPlan: { ...plan, users: [['nested']] } }), []);
  assert.throws(() => assertObjectJsonSchema({ ...schema, properties: {
    ...schema.properties, designPlan: { ...productDesignWireSchema, minLength: 1 },
  } }), { code: 'UNSUPPORTED_SCHEMA' });
});

test('real DSH registry accepts sequential HTML chunks and refuses root or unfinished handoff', async t => {
  const base = await mkdtemp(resolve(tmpdir(), 'html-chunks-dsh-'));
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(Tools);
  let scope;
  const rootAgent = { session: { id: 'root', header: { cwd: base } } };
  await ctx.plugin(Object.assign(inner => { scope = createScope(inner, rootAgent); }, { inject: ['tools', 'systemPrompt'] }));
  const toolCtx = { tools: scope.ctx.tools, on: scope.ctx.on.bind(scope.ctx) };
  const manager = new WorkerWorkspaces({});
  const signal = new AbortController().signal;
  const workspace = { base, root: base, parent: 'root', child: 'kimi', signal, closed: false,
    tail: Promise.resolve(), execution: [], draftReady: Promise.withResolvers(),
    expectedOutput: resolve(base, 'page.html'), allowedTools: ['html_chunk'] };
  manager.sessions.add(workspace);
  t.after(async () => { await manager.close(workspace); await scope.dispose(); await rm(base, { recursive: true, force: true }); });
  installToolPolicy(toolCtx, manager, new Set());
  registerHtmlChunkTool(toolCtx, manager);
  const agent = { session: { id: 'kimi', header: { parentSession: 'root' } } };
  bindScopeParent(agent, rootAgent);
  const call = (callId, args, caller = agent) => scope.ctx.tools.execute({ agent: caller, name: 'html_chunk',
    arguments: args, callId, signal });
  const root = await call('root', { action: 'append', index: 0, content: 'bad' },
    { session: { id: 'root', header: {} } });
  assert.equal(root.isError, true);
  const first = await call('first', { action: 'append', index: 0, content: '<!doctype html><html>' });
  assert.notEqual(first.isError, true, JSON.stringify(first));
  assert.equal(completeHtmlDraft(workspace, { type: 'tool/result', data: { message: {
    source: { callId: 'first' }, content: first.content,
  } } }), false);
  const second = await call('second', { action: 'append', index: 1,
    content: '<head></head><body><svg></svg></body></html>' });
  assert.notEqual(second.isError, true, JSON.stringify(second));
  const finish = await call('finish', { action: 'finish', index: 2 });
  assert.notEqual(finish.isError, true, JSON.stringify(finish));
  assert.equal(completeHtmlDraft(workspace, { type: 'tool/result', data: { message: {
    source: { callId: 'finish' }, content: finish.content,
  } } }), true);
  assert.deepEqual(await workspace.draftReady.promise, { draft: true });
  assert.match(await readFile(workspace.expectedOutput, 'utf8'), /<svg><\/svg>/);
  assert.equal((await call('late', { action: 'append', index: 2, content: 'bad' })).isError, true);
});

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
  for (const name of rootFileTools.filter(name => !['write', 'edit'].includes(name))) assert.ok(assembly.tools.some(tool => tool.name === name));
  for (const name of ['write', 'edit']) assert.ok(!assembly.tools.some(tool => tool.name === name));
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
  assert.match(request.persona, /32768 token/);
  assert.match(request.persona, /尽早提交可执行的小块/);
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

test('no-progress recovery dispatches the configured model through the same worker boundary', async () => {
  const routes = [];
  const explorer = new SnapshotExplorer();
  const worker = dshWorker({ subagents: { async start(_provider, input) {
    routes.push(input.agentOptions.model);
    return { id: 'recovery-child', result: Promise.resolve({ stopReason: 'completed', structured: { summary: 'Recovered' } }), async dispose() {} };
  } } }, { modelProvider: 'doubao', model: 'kimi-k2-8-preview', recoveryWorker: {
    provider: 'doubao', model: 'deepseek-v4-1-flash', reasoningEffort: 'off', maxTokens: 32768,
  } }, explorer, { open: async () => ({ root: '/fixture', execution: [] }), bind() {}, close: async () => {},
    proposal: async () => ({ changes: [] }) });
  await worker({ parent: { session: { id: 'root' } }, files: {}, signal: new AbortController().signal,
    phase: 'implement', recovery: { route: 'recovery-worker' } });
  assert.deepEqual(routes, ['deepseek-v4-1-flash']);
});

test('terminal output exhaustion returns a compact root handoff without the repeated objective', () => {
  const summary = compactTerminalDelivery({ id: 'delivery-1', state: 'failed', deliveryDirectory: '/project',
    reason: 'Worker output token budget exhausted', reasonCode: 'WORKER_MAX_TOKENS', workerCalls: 1,
    objective: 'large objective '.repeat(10000), taskIR: { goal: 'duplicate large objective' } });
  assert.deepEqual(summary, { id: 'delivery-1', state: 'failed', deliveryDirectory: '/project',
    reason: 'Worker output token budget exhausted', reasonCode: 'WORKER_MAX_TOKENS', workerCalls: 1,
    nextAction: 'report_failure_and_wait_for_new_user_request' });
  assert.equal(compactTerminalDelivery({ ...summary, reasonCode: 'WORKER_TIMEOUT_RETRIES_EXHAUSTED' })?.nextAction,
    'report_failure_and_wait_for_new_user_request');
  assert.equal(compactTerminalDelivery({ state: 'passed' }), null);
});

test('single HTML prompt excludes executable checks and designer-invented acceptance criteria', () => {
  const prompt = workerPromptInput({ objective: 'Create SVG page',
    productDesign: { plan: { goal: 'SVG page', scope: ['One HTML'], userFlows: ['Open it'],
      implementation: ['Draw a scene'], risks: ['Small visual risk'], acceptanceCriteria: ['Invented fixed pivot'] } },
    taskIR: { constraints: ['Inline SVG'], acceptanceCriteria: ['It opens'], availableChecks: [{ argv: ['node', '-e', 'private checker source'] }] } },
  { requiredOutputs: ['page.html'], checks: [{ id: 'single-html', argv: ['node', '-e', 'private checker source'] }] }, '/workspace', true);
  assert.equal(prompt.target, 'page.html');
  assert.deepEqual(prompt.constraints, ['Inline SVG']);
  assert.doesNotMatch(JSON.stringify(prompt), /private checker source|Invented fixed pivot|availableChecks/);
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
      assert.equal(payload.target, 'pelican-bicycle.html');
      assert.doesNotMatch(JSON.stringify(payload), /"argv"/);
      await writeFile(resolve(payload.workspace, payload.target), html);
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
    assert.deepEqual(input.toolFilter.allow,['read','write','html_chunk']);
    assert.equal(input.agentOptions.reasoningEffort,'low');
    queueMicrotask(()=>workspace.draftReady.resolve({draft:true}));
    return {id:'child',result:new Promise(()=>{}),async dispose(){disposed=true;}};
  }}},{reasoningEffort:'low'}, {open:()=>({token:'fixture'}),close(){}}, {
    open:async()=>workspace,bind(){},close:async()=>{closed=true;},proposal:async(_w,_f,summary)=>({summary,changes:[{path:'p.html',operation:'write',content:'draft'}]}),
  });
  const result=await worker({parent:{session:{id:'parent'}},signal:new AbortController().signal,files:{},contract:{editablePaths:['p.html'],requiredOutputs:['p.html'],checks:[{id:'single-html'}]}});
  assert.ok(disposed && closed);assert.match(result.summary,/local verification and synchronization are still required/);
  assert.equal(result.changes.length,1);
});

test('real HTML entry enforces MiniMax design then Kimi K2.8 implementation and preserves optional review', async t => {
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
      if (input.label === 'task_kimi_quality') throw Object.assign(new Error('Fixture upstream timeout'), { code: 'WORKER_EXECUTION_TIMEOUT' });
      if (input.label === 'task_minimax_design') {
        assert.equal(input.agentOptions.model, 'minimax-m3');
        assert.ok(!input.toolFilter.allow.includes('write'));
        return { id: 'minimax-design', result: Promise.resolve({ stopReason: 'completed', structured: {
          status: 'passed', summary: 'Plan a self-contained SVG animation', evidence: '', limitations: '',
          designPlan: { goal: 'SVG animation', users: 'Viewer', scope: 'One HTML file', userFlows: 'Open page and view loop',
            implementation: 'Use inline SVG and CSS', acceptanceCriteria: 'Animation loops', risks: 'Local presentation only', assumptions: 'No dependencies', riskLevel: 'low' },
        } }), async dispose() {} };
      }
      assert.equal(input.label, 'Delivery implement');
      assert.equal(input.agentOptions.model, 'kimi-k2-8-preview');
      assert.equal(Object.hasOwn(input.agentOptions, 'reasoningEffort'), false);
      assert.match(input.persona, /每次模型调用的输出硬上限为 16384 token/);
      const payload = JSON.parse(input.prompt[0].text);
      assert.match(payload.objective, /制作一个.*SVG 动画/);
      assert.ok(['scene.html', 'unverified-scene.html'].includes(payload.target));
      assert.equal(payload.designGuidance.goal, 'SVG animation');
      assert.doesNotMatch(JSON.stringify(payload), /Animation loops|single-html/);
      await writeFile(resolve(payload.workspace, payload.target), '<!doctype html><html><head></head><body><svg><circle cx="20" cy="20" r="10"/></svg></body></html>');
      return { id: 'kimi-implementation', result: Promise.resolve({ stopReason: 'completed', structured: { summary: 'Implemented the accepted storyboard.' } }), async dispose() {} };
    } },
  }, { stateDir: resolve(base, 'state'), contractPath, runtimePackageJson: '/Applications/DSH Desktop.app/Contents/Resources/app/package.json',
    modelProvider: 'doubao', model: 'kimi-k2-8-preview', maxTokens: 16384,
    qualityTool: 'task_kimi_quality', designTool: 'task_minimax_design', reviewPolicy: 'risk_based',
    specialists: [{ toolName: 'task_kimi_quality', provider: 'doubao', model: 'kimi-k2.7-code', readOnly: true, tools: ['read'], persona: 'Read-only code review.' }, { toolName: 'task_minimax_design', provider: 'doubao', model: 'minimax-m3', readOnly: true,
      tools: ['read', 'glob', 'grep', 'snapshot_explore', 'skill'], persona: 'Create a product design.' }],
    sandbox: { nodeExecutable: '/Applications/DSH Desktop.app/Contents/Resources/app/node_modules/node/bin/node', backend: 'seatbelt' } });
  const result = await ctx.tools.execute({ agent, name: 'delivery_start', arguments: {
    objective: '制作一个循环 SVG 动画，明确动作节奏和分镜', singleHtmlPath: 'scene.html' }, callId: 'animation-start', signal: new AbortController().signal });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  const run = JSON.parse(result.content[0].text);
  assert.equal(run.state, 'passed', run.reason);
  assert.deepEqual(calls, ['task_minimax_design', 'Delivery implement']);
  assert.equal(run.capabilityTasks[0].capability, 'product_design');
  assert.equal(run.productDesign.plan.goal, 'SVG animation');
  assert.ok(run.acceptance.every(item => item.source !== 'product_design'));
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
  assert.deepEqual(calls, ['task_minimax_design', 'Delivery implement', 'task_minimax_design', 'Delivery implement']);
  assert.match(await readFile(resolve(workspace, 'unverified-scene.html'), 'utf8'), /<svg>/);

  assert.equal(run.verification.independentReview, 'not_requested');
  assert.equal(run.verification.reviewPolicy, 'risk_based');
  const reviewed = await ctx.tools.execute({ agent, name: 'delivery_review', arguments: { id: run.id },
    callId: 'review-timeout', signal: new AbortController().signal });
  assert.notEqual(reviewed.isError, true, JSON.stringify(reviewed));
  const reviewResult = JSON.parse(reviewed.content[0].text);
  assert.equal(reviewResult.state, 'passed');
  assert.equal(reviewResult.review.status, 'incomplete');
  assert.equal(reviewResult.review.reasonCode, 'REVIEW_TIMEOUT');
  assert.deepEqual(reviewResult.syncReceipt, run.syncReceipt);
  assert.match(await readFile(resolve(workspace, 'scene.html'), 'utf8'), /<svg>/);

  // A blocked project must be rejected before another implementation is dispatched.
  const blockerStore = new Store(resolve(base, 'state'));
  blockerStore.create({ owner: agent.session.id, workspace: await realpath(workspace), objective: 'blocked fixture', contract: {}, files: {}, mode: 'project' });
  blockerStore.close();
  const callCount = calls.length;
  const duplicate = await ctx.tools.execute({ agent, name: 'delivery_start', arguments: {
    objective: '再次制作循环 SVG 动画', singleHtmlPath: 'another-scene.html' }, callId: 'duplicate-animation-start', signal: new AbortController().signal });
  assert.equal(duplicate.isError, true, JSON.stringify(duplicate));
  assert.match(JSON.stringify(duplicate), /unfinished delivery/);
  assert.equal(calls.length, callCount);

  const direct = await ctx.tools.execute({ agent, name: 'write', arguments: { file_path: 'direct-animation.html', content: '<svg></svg>' }, callId: 'direct', signal: new AbortController().signal });
  assert.equal(direct.isError, true, JSON.stringify(direct));
  assert.match(JSON.stringify(direct), /ROOT_IMPLEMENTATION_NOT_ALLOWED/);
  await assert.rejects(readFile(resolve(workspace, 'direct-animation.html')), /ENOENT/);
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
  const taskContext = { constraints: { runtime: 'Node 18+', externalDependencies: false }, protectedPaths: ['tests/**'], acceptanceCriteria: ['public-tests'] };
  const requestedTasks = [{ id: 'write-child', objective: 'Create child file', context: 'Keep tests unchanged', interfaces: [], acceptanceCriteria: ['Create child.txt'], editablePaths: ['child.txt'], dependsOn: [], checkIds: ['public-tests'] }];
  const preview = await call('delivery_context', { projectRoot: 'candidate', objective: 'Create a text file', context: taskContext, tasks: requestedTasks });
  assert.notEqual(preview.isError, true, JSON.stringify(preview));
  assert.deepEqual(JSON.parse(preview.content[0].text).checkIds, []);
  assert.ok(JSON.parse(preview.content[0].text).taskIR.validation.some(v => v.requestedCheckId === 'public-tests'));
  for (const projectRoot of [undefined, 'candidate']) {
    const value = await call('delivery_start', { objective: 'Create a text file', ...(projectRoot ? { projectRoot, context: taskContext, tasks: requestedTasks } : {}) });
    assert.notEqual(value.isError, true, JSON.stringify(value));
    const run = JSON.parse(value.content[0].text); assert.equal(run.state, 'passed', run.reason);
    assert.equal(run.verification.automatedChecks, 'not_configured');
    if (projectRoot) {
      assert.deepEqual(run.taskIR, JSON.parse(preview.content[0].text).taskIR);
      assert.deepEqual(run.tasks[0].checkIds, []);
      assert.equal(run.acceptanceComplete, false);
      assert.equal(run.nextAction, 'root_acceptance_required');
    }
    assert.equal(run.deliveryDirectory, projectRoot ? resolve(workspace, projectRoot) : workspace);
  }
  assert.equal(await readFile(resolve(workspace, 'candidate/parent-relative.txt'), 'utf8'), 'delivered');
  assert.equal(await readFile(resolve(workspace, 'candidate/child.txt'), 'utf8'), 'delivered');
  await assert.rejects(readFile(resolve(workspace, 'child.txt')), { code: 'ENOENT' });
  assert.equal((await call('delivery_start', { objective: 'Bad path', projectRoot: '../outside' })).isError, true);
  assert.equal(calls, 3);
});

test('HTML adapter preserves caller cancellation with a separate first-tool deadline', async () => {
  const signal = AbortSignal.timeout(15);
  const explorer = new SnapshotExplorer(); let disposed = 0, closed = 0;
  const worker = dshWorker({ subagents: { async start(_provider, input) {
    assert.notEqual(input.signal, signal);
    assert.equal(input.signal.aborted, false);
    return { id: 'timeout-child', result: new Promise((_, reject) => {
      input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true });
    }), async dispose() { disposed++; } };
  } } }, { firstToolTimeoutMs: 30000 }, explorer, {
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

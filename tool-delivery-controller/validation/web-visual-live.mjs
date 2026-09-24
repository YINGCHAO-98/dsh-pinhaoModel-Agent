import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Specialists } from '../specialists.mjs';
import { WorkerWorkspaces } from '../workspace.mjs';
import { SandboxRunner } from '../runner.mjs';
import { SnapshotExplorer } from '../explore.mjs';
import { digest } from '../files.mjs';
import { resolveAgentOptions } from '../model-policy.mjs';
const runtime = '/Applications/DSH Desktop.app/Contents/Resources/app/package.json';
const require = createRequire(runtime);
const load = name => import(pathToFileURL(require.resolve('@deepseek-ai/' + name)));
const { parse } = require('yaml');
const home = homedir() + '/Library/Application Support/dsh-desktop/harness';
const settings = parse(await readFile(home + '/settings.yaml', 'utf8'));
const base = await mkdtemp(resolve(tmpdir(), 'web-visual-live-'));
const { Context } = await load('cordis');
const ctx = new Context();
let handle, specialists;
const reports = [];
try {
  for (const name of ['dsh-llm', 'dsh-session', 'dsh-session-projection', 'dsh-system-prompt', 'dsh-tools', 'dsh-agent', 'dsh-skill', 'dsh-user-questions'])
    await ctx.plugin((await load(name)).default);
  await ctx.plugin((await load('dsh-attachment-local')).default, { dshHome: base });
  await ctx.plugin((await load('dsh-credentials-local')).default, { path: home + '/.credentials.yaml', watch: false });
  await ctx.plugin(await load('dsh-llm-pi-ai'), settings['llm-pi-ai']);
  await ctx.plugin((await load('dsh-agent-loop')).default, { agents: [] });
  await ctx.plugin((await load('dsh-subagent')).default);
  await ctx.plugin(await load('dsh-subagent-spawn-in-process'), { providerName: 'spawn' });
  const config = { stateDir: resolve(base, 'state'), runtimePackageJson: runtime, provider: 'spawn',
    sandbox: { nodeExecutable: '/Applications/DSH Desktop.app/Contents/Resources/app/node_modules/node/bin/node' },
    webVisual: { provider: 'doubao', model: 'kimi-k2-8-preview', executable: homedir() + '/.cache/pinhaomo-web/chrome-headless-shell-mac-arm64/chrome-headless-shell' } };
  handle = await ctx.agents.create({ sessionId: 'web-visual-probe-' + Date.now(), meta: { cwd: base },
    agentOptions: { provider: 'doubao', model: 'deepseek-v4-1-flash' },
    setup: async agentCtx => {
      specialists = new Specialists({ subagents: ctx.subagents, get: name => ctx.get(name) }, config, new SnapshotExplorer(), new WorkerWorkspaces(config), new SandboxRunner(config.sandbox),
        (options, signal) => resolveAgentOptions(ctx.llm, options, signal));
    } });
  const samples = [
    { id: 'good', objective: '验收这个结账页面：桌面和手机视口都应完整看到 Checkout 标题、Total $29.00 以及可读的 Pay now 按钮，内容不能溢出或互相遮挡。',
      html: '<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:24px Arial;margin:24px;background:#f3f4f6}main{max-width:600px;background:white;padding:24px;border-radius:12px}button{font:24px Arial;background:#1455cc;color:white;padding:16px;border:0;border-radius:8px}</style><main><h1>Checkout</h1><p>Total $29.00</p><button>Pay now</button></main></html>' },
    { id: 'broken', objective: '验收这个结账页面：桌面和手机视口都应完整看到 Checkout 标题、Total $29.00 以及可读的 Pay now 按钮，内容不能溢出或互相遮挡。',
      html: '<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:24px Arial;margin:24px;background:#f3f4f6}main{width:1100px;background:white;padding:24px}button{position:absolute;left:960px;top:24px;font:24px Arial;color:white;background:white;border:0}</style><main><h1>Checkout</h1><p>Total $29.00</p><button>Pay now</button></main></html>' },
  ];
  for (const model of ['kimi-k2-8-preview', 'glm-5-3-flash']) for (const sample of samples) {
    config.webVisual.model = model;
    const files = { 'index.html': Buffer.from(sample.html).toString('base64') };
    const started = Date.now();
    try {
      const result = await specialists.reviewWeb({ files, snapshot: digest(files), parent: handle.agent, objective: sample.objective, signal: AbortSignal.timeout(210000) });
      reports.push({ sample: sample.id, elapsedMs: Date.now() - started, ...result });
    } catch (error) { reports.push({ sample: sample.id, model, elapsedMs: Date.now() - started, error: error.message }); }
    await writeFile(new URL('./web-visual-live.json', import.meta.url), JSON.stringify(reports, null, 2));
    console.log(JSON.stringify(reports.at(-1)));
  }
} finally { await specialists?.dispose(); await handle?.dispose(); await ctx.fiber.dispose(); await rm(base, { recursive: true, force: true }); }

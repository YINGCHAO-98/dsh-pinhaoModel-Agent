import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { resolve } from 'node:path';
const require = createRequire('/Applications/DSH Desktop.app/Contents/Resources/app/package.json');
const load = name => import(pathToFileURL(require.resolve('@deepseek-ai/' + name)));
const { parse } = require('yaml');
const root = homedir() + '/Library/Application Support/dsh-desktop/harness';
const settings = parse(await readFile(root + '/settings.yaml', 'utf8'));
// Probe only: explicitly permit serialization in memory; do not change runtime metadata.
for (const model of settings['llm-pi-ai'].providers.doubao.models) if (model.id === 'kimi-k2-8-preview') model.input = ['text', 'image'];
const { Context } = await load('cordis');
const llm = await load('dsh-llm');
const ctx = new Context();
const temp = await mkdtemp(resolve(tmpdir(), 'kimi-vision-'));
const report = { model: 'kimi-k2-8-preview', text: '', status: 'unverified' };
try {
  await ctx.plugin(llm.default);
  await ctx.plugin((await load('dsh-credentials-local')).default, { path: root + '/.credentials.yaml', watch: false });
  await ctx.plugin((await load('dsh-attachment-local')).default, { dshHome: temp });
  await ctx.plugin(await load('dsh-llm-pi-ai'), settings['llm-pi-ai']);
  const attachment = await ctx.attachments.saveImage({ data: await readFile(new URL('./pelican-single-html-20260923/preview.png', import.meta.url)), mediaType: 'image/png', name: 'visual-probe.png' });
  const messages = [llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Describe only what is visibly shown in this screenshot: the central subject, its action, and three visual details. Do not infer from filenames. Reply in Chinese.' }, { type: 'image', attachment }] })];
  for await (const chunk of ctx.llm.stream({ provider: 'doubao', model: report.model, maxTokens: 1024, messages, tools: [], signal: AbortSignal.timeout(120000) })) {
    if (chunk.type === 'finish') report.finish = chunk.reason;
    if (chunk.type === 'block-end' && chunk.block.type === 'text') report.text += chunk.block.text;
  }
  report.status = report.text ? 'response_received' : 'empty';
} catch (error) { report.status = 'error'; report.error = { code: error.code, message: error.message }; }
finally { await ctx.fiber.dispose(); await rm(temp, { recursive: true, force: true }); }
await writeFile(new URL('./kimi-vision-probe.json', import.meta.url), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));

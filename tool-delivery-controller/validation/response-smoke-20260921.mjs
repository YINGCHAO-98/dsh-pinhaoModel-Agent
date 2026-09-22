// One opt-in real request using synthetic post-write history; no user files sent.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
const require = createRequire('/Applications/DSH Desktop.app/Contents/Resources/app/package.json');
const load = name => import(pathToFileURL(require.resolve('@deepseek-ai/' + name)));
if (process.env.DSH_LIVE !== '1') throw new Error('Set DSH_LIVE=1');
const { parse } = require('yaml');
const root = homedir() + '/Library/Application Support/dsh-desktop/harness';
const settings = parse(await readFile(root + '/settings.yaml', 'utf8'));
const { Context } = await load('cordis');
const llm = await load('dsh-llm');
const ctx = new Context();
const start = Date.now();
const report = { scenario: 'synthetic post-write completion', firstChunkMs: null, elapsedMs: null, finish: null, text: '' };
try {
  await ctx.plugin(llm.default);
  await ctx.plugin((await load('dsh-credentials-local')).default, { path: root + '/.credentials.yaml', watch: false });
  await ctx.plugin(await load('dsh-llm-pi-ai'), settings['llm-pi-ai']);
  const messages = [
    llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Create a single HTML file fixture.html with the word hello. After the file is written, reply with one short sentence. Do not call any further tools.' }] }),
    llm.createAssistantMessage({ source: { provider: 'doubao', model: 'deepseek-v4-1-flash' }, content: [{ type: 'tool-call', id: 'fixture_write', name: 'write', arguments: JSON.stringify({ file_path: 'fixture.html', content: '<!doctype html><html><head><title>hello</title></head><body>hello</body></html>' }) }] }),
    llm.createToolResultMessage({ callId: 'fixture_write', content: [{ type: 'text', text: 'Created file fixture.html' }], isError: false }),
  ];
  for await (const chunk of ctx.llm.stream({ provider: 'doubao', model: 'deepseek-v4-1-flash', reasoningEffort: 'low', maxTokens: 1024,
    messages, tools: [{ name: 'write', description: 'Write a file', parameters: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path','content'] } }], signal: AbortSignal.timeout(135000) })) {
    report.firstChunkMs ??= Date.now() - start;
    if (chunk.type === 'finish') report.finish = chunk.reason;
    if (chunk.type === 'block-end' && chunk.block.type === 'text') report.text += chunk.block.text;
  }
} catch (e) { report.failure = e.code ?? e.name; }
finally { report.elapsedMs = Date.now() - start; await ctx.fiber.dispose(); }
await writeFile(new URL('./response-smoke-20260921.json', import.meta.url), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));

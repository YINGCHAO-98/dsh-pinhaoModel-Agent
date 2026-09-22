// Offline only: inspect request serialization; block every network attempt.
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const require = createRequire('/Applications/DSH Desktop.app/Contents/Resources/app/package.json');
const {parse} = require('yaml');
const {apply} = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm-pi-ai')));
const settings = parse(await readFile(new URL('../../host/settings.yaml', import.meta.url),'utf8'));
const trace = JSON.parse(await readFile(process.argv[2], 'utf8'));
const messages = trace.flatMap(e => e.type === 'system/message' ? [e.data.message] : e.type === 'user/message' ? [e.data] : e.type === 'assistant/message' ? [e.data.message] : e.type === 'tool/result' ? [e.data.message] : []);
let adapter, wire, networkCalls = 0;
globalThis.fetch = async () => { networkCalls++; throw new Error('OFFLINE_NETWORK_DENIED'); };
apply({get(){},inject(){},llm:{registerConfigurableProviders(){return{};},registerModelDiscovery(){},registerAdapter(_routes,a){adapter=a;return{};}}},settings['llm-pi-ai']);
adapter.config.resolveApiKey = async () => 'offline-fixture';
const models=adapter.current().models, original=models.streamSimple;
models.streamSimple = (model,context,options) => original.call(models,model,context,{...options,onPayload(payload){wire=payload;throw new Error('OFFLINE_CAPTURED');}});
try { for await (const _ of adapter.stream({provider:'doubao',model:'deepseek-v4-1-flash',reasoningEffort:'low',maxTokens:32768,messages,tools:trace.find(e=>e.type==='request/header').data.header.tools})){ if (_.type === 'finish') console.log(JSON.stringify(_.reason)); } } catch(e) { console.log(e.code, e.message); }
assert.ok(wire);assert.equal(networkCalls,0);
console.log(JSON.stringify({networkCalls,keys:Object.keys(wire),thinking:wire.thinking,reasoning_effort:wire.reasoning_effort,max_tokens:wire.max_tokens,tools:wire.tools?.length,messages:wire.messages.map(m=>({role:m.role,keys:Object.keys(m),contentType:typeof m.content,contentLength:typeof m.content==='string'?m.content.length:0,reasoningLength:m.reasoning_content?.length,calls:m.tool_calls?.map(c=>({name:c.function.name,argumentType:typeof JSON.parse(c.function.arguments),argumentKeys:Object.keys(JSON.parse(c.function.arguments))}))}))},null,2));

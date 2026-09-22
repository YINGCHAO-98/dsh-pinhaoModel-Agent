import { nativeTools } from './native-tools.mjs';

// One tool per fresh process. stdin is trusted controller RPC, never evaluated.
let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 512 * 1024) throw new Error('Tool input exceeds budget');
}
const { runtimePackageJson, workspace, name, args } = JSON.parse(input);
const runtime = await nativeTools(runtimePackageJson, workspace);
try {
  const tool = runtime.definitions.get(name);
  if (!tool) throw new Error('Unknown worker tool');
  const value = await tool.execute(args, { signal: new AbortController().signal, callId: 'isolated-tool',
    agent: { session: { id: 'isolated-worker', header: { cwd: workspace } } } });
  process.stdout.write(JSON.stringify({ ok: true, value, execution: runtime.execution }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(error.message ?? error) }));
} finally { await runtime.dispose(); }

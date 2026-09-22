import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { execute } from './runner.mjs';

// Reuse DSH tool schemas, editing and search implementations. The helper that
// invokes these definitions runs entirely inside the OS sandbox.
export async function nativeTools(runtimePackageJson, workspace) {
  const require = createRequire(runtimePackageJson);
  const load = name => import(pathToFileURL(require.resolve(`@deepseek-ai/${name}`)));
  const [{ Context }, { default: FileSystem }, fsTools, bashTools, searchTools] = await Promise.all([
    load('cordis'), load('dsh-fs-local'), load('dsh-tool-fs'), load('dsh-tool-bash'), load('dsh-tool-fs-search'),
  ]);
  const context = new Context();
  await context.plugin(FileSystem, { cwd: workspace, diffBasisMaxBytes: 65536 });
  const definitions = new Map();
  const execution = [];
  const facade = {
    fs: context.fs,
    tools: { register: tool => definitions.set(tool.name, tool) },
    systemPrompt: { section() {}, getSectionOrder() { return 0; } },
    get() {}, inject() {}, emit() {}, on() {},
    async waterfall(_event, _target, _exec, initial) { return initial(); },
    shellEnv: { collect() { return {}; } },
    shell: {
      resolve: request => ({ ...request, timeoutMs: Math.min(request.timeoutMs ?? 30000, 60000) }),
      async run(spec) {
        const result = await execute(['/bin/bash', '--noprofile', '--norc', '-c', spec.command], {
          processGroup: false, cwd: spec.workdir, signal: spec.signal, timeoutMs: spec.timeoutMs,
          env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, DSH_WORKSPACE: workspace },
        });
        if (result.spawnError) throw new Error(result.spawnError);
        execution.push({ command: spec.command, exitCode: result.exitCode, timedOut: result.timedOut,
          stdout: result.stdout.slice(0, 4000), stderr: result.stderr.slice(0, 4000),
          outputTruncated: result.truncated || result.stdout.length > 4000 || result.stderr.length > 4000 });
        return { ...result, signal: result.exitSignal, timeoutMs: spec.timeoutMs,
          stdout: { text: result.stdout, truncated: result.truncated },
          stderr: { text: result.stderr, truncated: result.truncated } };
      },
    },
    subprocess: {
      spawn(spec) {
        let result;
        const done = execute(spec.argv, { processGroup: false, cwd: spec.cwd, signal: spec.signal, timeoutMs: 30000 }).then(value => {
          result = value;
          if (value.spawnError) throw new Error(value.spawnError);
          return { exitCode: value.exitCode, signal: value.exitSignal };
        });
        const stream = key => ({ readFrom() { return { text: result[key], lossy: result.truncated }; } });
        return { done, collected: { stdout: stream('stdout'), stderr: stream('stderr') } };
      },
    },
  };
  try {
    fsTools.apply(facade, { readLimit: 300, readMaxLineLength: 3000, readMaxBytes: 16384, readStreamMinSize: 65536 });
    bashTools.apply(facade, { enableRunInBackground: false });
    await searchTools.apply(facade, { sampleOverCapGlobResults: false, globMaxResults: 100, grepMaxMatches: 100,
      grepMaxLineBytes: 3000, searchMetaMaxBytes: 16384, rawOutputMaxBytes: 65536, graceMs: 100,
      stderrMaxBytes: 8192, timeoutMs: 30000 });
    return { definitions, execution, dispose: () => context.fiber.dispose() };
  } catch (error) { await context.fiber.dispose(); throw error; }
}

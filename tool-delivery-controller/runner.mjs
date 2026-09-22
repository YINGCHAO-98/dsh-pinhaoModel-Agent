import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { materialize, hash } from './files.mjs';

// Never pass commands through a shell or inherit model/provider credentials.
export function execute(argv, { cwd, signal, timeoutMs, env = {}, input, processGroup = true }) {
  signal?.throwIfAborted();
  return new Promise(resolveResult => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd, detached: processGroup && process.platform !== 'win32', stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8', ...env },
    });
    if (child.stdin) { child.stdin.on('error', () => {}); child.stdin.end(input); }
    let stdout = '', stderr = '', timedOut = false, spawnError, truncated = false;
    const collect = which => chunk => {
      const value = chunk.toString();
      if (which === 'stdout') { truncated ||= stdout.length + value.length > 65536; stdout = (stdout + value).slice(0, 65536); }
      else { truncated ||= stderr.length + value.length > 65536; stderr = (stderr + value).slice(0, 65536); }
    };
    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));
    const stop = () => {
      if (!child.pid) return;
      try { process.kill(!processGroup || process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); } catch {}
    };
    const onAbort = () => stop();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) stop();
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    child.on('error', error => { spawnError = error.code ?? error.message; });
    child.on('close', (exitCode, exitSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      // A check may fork a daemon which has already detached its stdio.
      stop();
      resolveResult({ exitCode, exitSignal, stdout, stderr, timedOut, spawnError: spawnError ?? null,
        aborted: signal?.aborted ?? false, truncated });
    });
  });
}

const quote = value => JSON.stringify(value);
export function seatbeltProfile(snapshot, scratch, executable, { writable = false, extraReadRoots = [] } = {}) {
  const readRoots = ['/System', '/usr', '/bin', '/sbin', '/Library/Apple', '/private/var/db/dyld',
    '/private/etc', snapshot, scratch, dirname(dirname(executable)), ...extraReadRoots];
  return [
    '(version 1)', '(allow default)', '(deny network*)', '(deny file-read*)', '(deny file-write*)',
    '(allow file-read-metadata)', '(allow file-read-data (literal "/"))',
    `(allow file-read* ${readRoots.map(path => `(subpath ${quote(path)})`).join(' ')})`,
    '(allow file-read* (subpath "/dev"))',
    `(allow file-write* (subpath ${quote(scratch)}) (literal "/dev/null"))`,
    ...(writable ? [`(allow file-write* (subpath ${quote(snapshot)}))`] : []),
  ].join('\n');
}

export class SandboxRunner {
  constructor({ backend = process.platform === 'darwin' ? 'seatbelt' : 'docker', image = 'node:24-bookworm-slim', nodeExecutable = process.execPath, extraReadRoots = [] } = {}) {
    if (!['seatbelt', 'docker'].includes(backend)) throw new Error('Unknown sandbox backend');
    if (!isAbsolute(nodeExecutable)) throw new Error('nodeExecutable must be an absolute path');
    if (!Array.isArray(extraReadRoots) || extraReadRoots.some(path => typeof path !== 'string' || !isAbsolute(path)))
      throw new Error('extraReadRoots must contain absolute paths');
    this.extraReadRoots = [...extraReadRoots];
    this.nodeExecutable = nodeExecutable;
    this.backend = backend;
    this.image = image;
  }
  async preflight(signal) {
    if (this.backend === 'seatbelt') {
      if (process.platform !== 'darwin') throw new Error('Seatbelt requires macOS');
      const result = await execute(['/usr/bin/sandbox-exec', '-p', '(version 1)(allow default)(deny file-write*)(deny network*)', '/usr/bin/true'],
        { signal, timeoutMs: 5000 });
      if (result.exitCode !== 0) throw new Error(`Sandbox unavailable: ${result.stderr || result.spawnError}`);
    } else {
      const result = await execute(['docker', 'image', 'inspect', this.image], { signal, timeoutMs: 10000, env: { PATH: process.env.PATH } });
      if (result.exitCode !== 0) throw new Error(`Docker or preloaded image unavailable: ${this.image}`);
    }
  }
  async check({ files, snapshot, check, signal }) {
    const base = await realpath(await mkdtemp(resolve(tmpdir(), 'pinhaomo-check-')));
    const source = resolve(base, 'snapshot');
    const scratch = resolve(base, 'scratch');
    const startedAt = new Date().toISOString();
    const container = `pinhaomo-${randomUUID()}`;
    try {
      await materialize(files, source);
      await mkdir(scratch);
      let argv, env;
      if (this.backend === 'seatbelt') {
        const executable = await realpath(check.argv[0] === 'node' ? this.nodeExecutable : check.argv[0]);
        argv = ['/usr/bin/sandbox-exec', '-p', seatbeltProfile(source, scratch, executable, { extraReadRoots: this.extraReadRoots }), executable, ...check.argv.slice(1)];
        env = { HOME: scratch, TMPDIR: scratch, PATH: `${dirname(executable)}:/usr/bin:/bin` };
      } else {
        argv = ['docker', 'run', '--rm', '--name', container, '--network=none', '--read-only', '--cap-drop=ALL',
          '--security-opt=no-new-privileges', '--pids-limit=64', '--memory=512m', '--cpus=1',
          '--mount', `type=bind,src=${source},dst=/workspace,readonly`,
          '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m', '--workdir', '/workspace',
          '--env', 'HOME=/tmp', this.image, ...check.argv];
        env = { PATH: process.env.PATH };
      }
      const result = await execute(argv, { cwd: source, signal, timeoutMs: check.timeoutMs, env });
      let kind = result.aborted ? 'cancelled'
        : result.spawnError || result.timedOut || /sandbox_apply:|execvp\(\):/u.test(result.stderr)
          || (this.backend === 'docker' && [125, 126, 127].includes(result.exitCode)) ? 'blocked'
          : result.exitCode === 0 ? 'passed' : 'failed';
      // With a TAP contract, an empty test run or early process.exit(0) is not success.
      if (kind === 'passed' && check.minTests !== undefined) {
        const count = Number(/^# tests (\d+)\s*$/mu.exec(result.stdout)?.[1] ?? 0);
        const passed = Number(/^# pass (\d+)\s*$/mu.exec(result.stdout)?.[1] ?? 0);
        if (count < check.minTests || passed < check.minTests || !/^# fail 0\s*$/mu.test(result.stdout)
          || !/^# cancelled 0\s*$/mu.test(result.stdout) || result.truncated) kind = 'failed';
      }
      return { id: check.id, snapshot, kind, argv: check.argv, backend: this.backend,
        runtime: { platform: process.platform, hostNode: process.version, image: this.backend === 'docker' ? this.image : null },
        startedAt, finishedAt: new Date().toISOString(), ...result,
        logHash: hash(result.stdout + '\0' + result.stderr) };
    } finally {
      // Kill the named container even if its client was interrupted or timed out.
      if (this.backend === 'docker') await execute(['docker', 'rm', '-f', container],
        { timeoutMs: 10000, env: { PATH: process.env.PATH } });
      await rm(base, { recursive: true, force: true });
    }
  }
}

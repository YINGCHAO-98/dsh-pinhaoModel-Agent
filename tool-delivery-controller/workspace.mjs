import { mkdtemp, mkdir, rm, realpath, lstat, readdir, open, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { capture, materialize, isWithin, applyProposal } from './files.mjs';
import { execute, seatbeltProfile } from './runner.mjs';
import { nativeTools } from './native-tools.mjs';

export const rootFileTools = ['read', 'write', 'edit', 'glob', 'grep'];
export const workerTools = ['read', 'write', 'edit', 'glob', 'grep', 'bash'];
const HTML_CHUNK_BYTES = 8192;
const HTML_MAX_BYTES = 512 * 1024;
const HTML_MAX_CHUNKS = 128;
const helper = fileURLToPath(new URL('./worker-helper.mjs', import.meta.url));

export function resolveToolPath(session, input) {
  if (typeof input !== 'string' || !input) throw new Error('Tool path must be a non-empty string');
  // Models sometimes copy a Markdown-rendered path (`BUSINESS\_RULES.md`) back
  // into a tool argument. Backslashes are not valid project path separators in
  // this runtime, so decode only Markdown punctuation escapes before resolving.
  let value = input.replace(/\\([_*\[\]()#])/gu, '$1');
  // Stable virtual roots avoid coupling model calls to randomized temporary
  // directories. These are aliases, not host filesystem roots.
  value = value.replace(/^\/(workspace|scratch)(?=\/|$)/u,
    (_match, root) => session[root === 'workspace' ? 'root' : 'scratch']);
  value = value.replace(/^(?:\$TMPDIR|\$\{TMPDIR\})(?=\/|$)/u, session.scratch);
  let target = resolve(session.root, value);
  // An absolute path under the root agent's project means the corresponding
  // file in the isolated copy. Never grant the worker a direct host write.
  const sourceRoot = isAbsolute(value) && (session.projectRoots ?? [session.projectRoot].filter(Boolean))
    .find(root => isWithin(target, root));
  if (sourceRoot && !isWithin(target, session.root) && !isWithin(target, session.scratch))
    target = resolve(session.root, relative(sourceRoot, target));
  const boundary = isWithin(target, session.root) ? session.root : isWithin(target, session.scratch) ? session.scratch : null;
  if (!boundary) throw new Error(`WORKER_PATH_OUTSIDE: Path ${JSON.stringify(input)} is outside the task workspace. Use a workspace-relative path, /workspace/..., or $TMPDIR/... for temporary files.`);
  return { target, boundary };
}

const ignoredLookupDirectories = new Set(['.git', 'node_modules', '.delivery']);
export async function recoverReadPath(root, target, maxEntries = 5000) {
  try { await lstat(target); return { target, recovered: false, candidates: [] }; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const requested = relative(root, target);
  if (!requested || requested.startsWith('..')) return { target, recovered: false, candidates: [] };
  const candidates = [];
  let visited = 0;
  async function walk(directory, prefix = '') {
    if (visited >= maxEntries || candidates.length > 1) return;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++visited > maxEntries || candidates.length > 1) return;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!ignoredLookupDirectories.has(entry.name)) await walk(resolve(directory, entry.name), path);
      } else if (entry.isFile() && (path === requested || path.endsWith('/' + requested))) candidates.push(path);
    }
  }
  await walk(root);
  return { target: candidates.length === 1 ? resolve(root, candidates[0]) : target,
    recovered: candidates.length === 1, candidates };
}

export function workspaceProposal(before, after, summary, contract) {
  const changes = [];
  for (const path of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[path] === after[path]) continue;
    if (!Object.hasOwn(after, path)) { changes.push({ path, operation: 'delete', content: '' }); continue; }
    const buffer = Buffer.from(after[path], 'base64');
    const content = buffer.toString('utf8');
    if (!buffer.equals(Buffer.from(content)) || content.includes('\0')) throw new Error(`Binary change unsupported: ${path}`);
    changes.push({ path, operation: 'write', content });
  }
  const proposal = { summary, changes };
  applyProposal(before, proposal, contract); // Protected files remain authoritative.
  return proposal;
}

export class WorkerWorkspaces {
  sessions = new Set();
  noSkillTurns = new Set();
  terminalDeliveryTurns = new Map();
  constructor(config) { this.config = config; }
  beginRootTurn(owner, text) {
    this.noSkillTurns.delete(owner);
    this.terminalDeliveryTurns.delete(owner);
    if (typeof text !== 'string') return;
    if (/(?:不使用|不要使用|禁用|跳过|without|disable|skip|no)\s*(?:任何\s*)?(?:skill|技能)/iu.test(text))
      this.noSkillTurns.add(owner);
  }
  assertSkillAllowed(owner) {
    if (this.noSkillTurns.has(owner)) throw new Error('SKILL_DISABLED_BY_USER: the current user request explicitly disables skills');
  }
  blockTerminalDeliveryTurn(owner, delivery) {
    if (typeof owner !== 'string' || !owner || !delivery?.id || !delivery?.reasonCode)
      throw new Error('Invalid terminal delivery turn');
    this.terminalDeliveryTurns.set(owner, { id: delivery.id, state: delivery.state, reasonCode: delivery.reasonCode });
  }
  terminalDeliveryBlock(owner) { return this.terminalDeliveryTurns.get(owner) ?? null; }
  assertRootMutationAllowed(owner) {
    const terminal = this.terminalDeliveryBlock(owner);
    if (terminal) throw new Error(`TERMINAL_DELIVERY_MUTATION_DENIED: delivery ${terminal.id} ended with ${terminal.reasonCode}; report the terminal result and wait for a new user request`);
  }
  assertRootDeliveryStartAllowed(owner) {
    const terminal = this.terminalDeliveryBlock(owner);
    if (terminal) throw new Error(`TERMINAL_DELIVERY_RESTART_DENIED: delivery ${terminal.id} ended with ${terminal.reasonCode}; report the terminal result and wait for a new user request`);
  }
  resetRootState(owner) {
    this.noSkillTurns.delete(owner);
    this.terminalDeliveryTurns.delete(owner);
  }
  async open(files, parent, signal, deliveryDirectory) {
    if ((this.config.sandbox?.backend ?? (process.platform === 'darwin' ? 'seatbelt' : 'docker')) !== 'seatbelt' || process.platform !== 'darwin')
      throw new Error('Native worker tools currently require macOS Seatbelt; Docker worker runtime is not configured');
    const base = await realpath(await mkdtemp(resolve(tmpdir(), 'pinhaomo-worker-')));
    const projectPath = deliveryDirectory ?? (parent.session.header?.cwd ? resolve(parent.session.header.cwd) : null);
    const projectRoot = projectPath ? await realpath(projectPath) : null;
    const projectRoots = [...new Set([projectPath, projectRoot].filter(Boolean))];
    const session = { base, root: resolve(base, 'workspace'), scratch: resolve(base, 'scratch'), projectRoot, projectRoots,
      parent: parent.session.id, child: null, signal, tail: Promise.resolve(), closed: false, execution: [], tokenUsage: [] };
    session.binding = Promise.withResolvers();
    session.onAbort = () => session.binding.resolve();
    signal.addEventListener('abort', session.onAbort, { once: true });
    try {
      await materialize(files, session.root);
      await mkdir(session.scratch);
      this.sessions.add(session);
      return session;
    } catch (error) { signal.removeEventListener('abort', session.onAbort); session.binding.resolve(); await rm(base, { recursive: true, force: true }); throw error; }
  }
  bind(session, childId) {
    if (typeof childId !== 'string' || !childId || session.closed || session.signal.aborted)
      throw new Error('WORKER_BINDING_FAILED: child id missing or workspace inactive');
    if (session.child !== null && session.child !== childId) throw new Error('WORKER_BINDING_FAILED: cannot rebind workspace');
    session.child = childId;
    session.binding?.resolve();
  }
  async waitForBinding(agent) {
    const pending = [...this.sessions].filter(s => s.parent === agent.session.header.parentSession &&
      s.child === null && !s.closed && !s.signal.aborted);
    await Promise.all(pending.map(s => s.binding?.promise));
  }
  find(exec) {
    const agent = exec.agent;
    if (!agent?.session.header.parentSession)
      throw new Error('ROOT_TOOL_NOT_ALLOWED: execution tools belong to child agents; use delivery_start or a specialist tool');
    const owned = [...this.sessions].filter(s => agent.session.header.parentSession === s.parent && s.child === agent.session.id);
    if (owned.length !== 1)
      throw new Error('WORKER_NOT_BOUND: no matching active workspace (unregistered, released, or preset reloaded)');
    const session = owned[0];
    if (session.closed || session.signal.aborted) throw new Error('WORKER_EXPIRED: workspace closed or task cancelled');
    return session;
  }
  async close(session) {
    session.closed = true;
    session.binding?.resolve();
    session.signal.removeEventListener('abort', session.onAbort);
    this.sessions.delete(session);
    await session.tail;
    await rm(session.base, { recursive: true, force: true });
  }
  async invoke(name, args, exec) {
    if (!exec.agent?.session.header.parentSession) {
      if (['write', 'edit'].includes(name)) throw new Error('ROOT_IMPLEMENTATION_NOT_ALLOWED: use the Kimi implementation worker');
      if (!rootFileTools.includes(name)) throw new Error('ROOT_TOOL_NOT_ALLOWED: only file tools are enabled');
      const cwd = exec.agent?.session.header.cwd;
      if (!cwd) throw new Error('Session has no workspace');
      if (process.platform !== 'darwin' || (this.config.sandbox?.backend ?? 'seatbelt') !== 'seatbelt')
        throw new Error('Root file tools require macOS Seatbelt');
      exec.signal.throwIfAborted();
      const root = await realpath(cwd);
      if (['write', 'edit'].includes(name)) this.assertRootMutationAllowed(exec.agent.session.id);
      const scratch = await realpath(await mkdtemp(resolve(tmpdir(), 'pinhaomo-root-')));
      const session = { root, scratch, projectRoot: root, projectRoots: [resolve(cwd), root], signal: exec.signal, tail: Promise.resolve(), execution: [] };
      try { return await this.invokeSession(session, name, args, exec); }
      finally { await rm(scratch, { recursive: true, force: true }); }
    }
    return this.invokeSession(this.find(exec), name, args, exec);
  }
  async htmlChunk(args, exec) {
    const session = this.find(exec);
    if (!session.draftReady || !session.expectedOutput || !session.allowedTools?.includes('html_chunk'))
      throw new Error('HTML_CHUNK_NOT_ALLOWED: only the single-HTML Kimi Worker may submit chunks');
    const operation = session.tail.then(async () => {
      session.signal.throwIfAborted(); exec.signal.throwIfAborted();
      if (session.closed || session.handoffPending || session.htmlChunks?.finished)
        throw new Error('HTML_DRAFT_HANDED_OFF: draft is already finalized');
      if (!args || !['append', 'finish'].includes(args.action)
        || !Number.isSafeInteger(args.index) || args.index !== (session.htmlChunks?.nextIndex ?? 0))
        throw new Error('HTML_CHUNK_SEQUENCE: expected the next sequential chunk index');
      const state = session.htmlChunks ??= { nextIndex: 0, bytes: 0 };
      if (args.action === 'append') {
        const bytes = typeof args.content === 'string' ? Buffer.byteLength(args.content) : 0;
        if (!bytes || bytes > HTML_CHUNK_BYTES || state.nextIndex >= HTML_MAX_CHUNKS
          || state.bytes + bytes > HTML_MAX_BYTES)
          throw new Error('HTML_CHUNK_LIMIT: chunk must be 1..8192 bytes; total must stay within 512 KiB and 128 chunks');
        const file = await open(session.expectedOutput,
          constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW
            | (state.nextIndex === 0 ? constants.O_TRUNC : constants.O_APPEND), 0o600);
        try {
          const target = await file.stat();
          if (!target.isFile() || target.size !== state.bytes)
            throw new Error('HTML_CHUNK_TARGET_CHANGED: draft changed outside chunk submissions');
          await file.writeFile(args.content);
        } finally { await file.close(); }
        state.nextIndex++;
        state.bytes += bytes;
        session.execution.push({ tool: 'html_chunk', callId: exec.callId, action: 'append', index: args.index,
          bytes, ok: true, at: new Date().toISOString() });
        return { accepted: true, nextIndex: state.nextIndex, bytes: state.bytes };
      }
      if (args.content !== undefined || state.nextIndex === 0)
        throw new Error('HTML_CHUNK_FINISH: submit at least one chunk; finish has no content');
      const content = await readFile(session.expectedOutput);
      if (content.length !== state.bytes) throw new Error('HTML_CHUNK_TARGET_CHANGED: draft changed outside chunk submissions');
      const sha256 = createHash('sha256').update(content).digest('hex');
      state.finished = true;
      session.execution.push({ tool: 'html_chunk', callId: exec.callId, action: 'finish', index: args.index,
        bytes: state.bytes, sha256, ok: true, at: new Date().toISOString() });
      return { accepted: true, finalized: true, chunks: state.nextIndex, bytes: state.bytes, sha256 };
    });
    session.tail = operation.catch(error => { session.execution?.push({ tool: 'html_chunk', callId: exec.callId,
      action: args?.action, ok: false, error: String(error.message), at: new Date().toISOString() }); });
    return operation;
  }
  async invokeSession(session, name, args, exec) {
    const operation = session.tail.then(async () => {
      session.signal.throwIfAborted(); exec.signal.throwIfAborted();
      if (session.closed) throw new Error('Worker workspace expired');
      if (session.handoffPending || session.htmlChunks?.finished)
        throw new Error('HTML_DRAFT_HANDED_OFF: further implementation calls are revoked');
      if (session.execution.length >= (session.maxToolCalls ?? 128))
        throw new Error(`Specialist tool-call budget exhausted (${session.maxToolCalls ?? 128})`);
      if (session.readOnly && ['write', 'edit'].includes(name)) throw new Error('Specialist workspace is read-only');
      if (args.sandbox_permissions !== undefined || args.run_in_background) throw new Error('Escalation/background execution is disabled');
      const bounded = { ...args };
      if (name === 'bash' && typeof bounded.command === 'string' && /(?:^|\s|['"])\/(?:private\/)?tmp\//u.test(bounded.command))
        throw new Error('WORKER_TEMP_PATH_REQUIRED: /tmp is outside this isolated task. Use $TMPDIR/... or /scratch/... so the command runs in the owned scratch directory.');
      for (const key of ['file_path', 'path', 'workdir']) if (typeof bounded[key] === 'string') {
        let { target, boundary } = resolveToolPath(session, bounded[key]);
        if (name === 'read' && key === 'file_path' && boundary === session.root) {
          const lookup = await recoverReadPath(session.root, target);
          if (lookup.recovered) target = lookup.target;
          else if (lookup.candidates.length > 1) throw new Error(
            `WORKER_READ_AMBIGUOUS: ${JSON.stringify(bounded[key])} is missing and matches multiple workspace files: ${lookup.candidates.join(', ')}`);
        }
        // Reject symlink paths even when they resolve back inside the workspace.
        let current = boundary;
        for (const part of relative(boundary, target).split('/').filter(Boolean)) {
          current = resolve(current, part);
          try { if ((await lstat(current)).isSymbolicLink()) throw new Error('Symlink tool paths are not allowed'); }
          catch (error) { if (error.code === 'ENOENT') break; throw error; }
        }
        bounded[key] = target;
      }
      if (session.htmlChunks?.nextIndex && (name === 'edit'
        || name === 'write' && bounded.file_path !== session.expectedOutput))
        throw new Error('HTML_CHUNK_MODE: only a full write to the declared HTML target may replace a chunked draft');
      if (name === 'bash') bounded.timeoutMs = Math.min(bounded.timeoutMs ?? 30000, 60000);
      const node = await realpath(this.config.sandbox.nodeExecutable);
      const runtimePackageJson = await realpath(this.config.runtimePackageJson);
      const profile = seatbeltProfile(session.root, session.scratch, node, { writable: !session.readOnly,
        extraReadRoots: [dirname(helper), dirname(runtimePackageJson), ...(this.config.sandbox.extraReadRoots ?? [])] });
      const input = JSON.stringify({ runtimePackageJson, workspace: session.root, name, args: bounded });
      if (Buffer.byteLength(input) > 512 * 1024) throw new Error('Tool input exceeds budget');
      const result = await execute(['/usr/bin/sandbox-exec', '-p', profile, node, helper], {
        cwd: session.root, input, signal: AbortSignal.any([session.signal, exec.signal]),
        timeoutMs: name === 'bash' ? bounded.timeoutMs + 5000 : 35000,
        env: { HOME: session.scratch, TMPDIR: session.scratch, PATH: `${dirname(node)}:/usr/bin:/bin:/usr/sbin:/sbin` },
      });
      if (result.exitCode !== 0 || result.timedOut || result.aborted || result.truncated)
        throw new Error(`Isolated tool failed: ${result.spawnError ?? result.stderr ?? ''} (exit=${result.exitCode}, timeout=${result.timedOut}, truncated=${result.truncated})`);
      let response;
      try { response = JSON.parse(result.stdout); } catch { throw new Error('Invalid isolated tool response'); }
      if (!response.ok) throw new Error(response.error);
      if (name === 'write' && bounded.file_path === session.expectedOutput && session.htmlChunks?.nextIndex)
        session.htmlChunks = null;
      session.execution?.push({ tool: name, callId: exec.callId, args: bounded, ok: true, at: new Date().toISOString(),
        result: JSON.stringify(response.value).slice(0, 16000), commands: response.execution ?? [] });
      return response.value;
    });
    session.tail = operation.catch(error => { session.execution?.push({ tool: name, ok: false, error: String(error.message), at: new Date().toISOString() }); });
    return operation;
  }
  async proposal(session, files, summary, contract) {
    session.closed = true; // Revoke new calls before collecting the final snapshot.
    await session.tail;
    session.signal.throwIfAborted();
    return workspaceProposal(files, await capture(session.root, undefined, { includeExcluded: true }), summary, contract);
  }
}

export async function registerWorkerTools(ctx, workspaces, config) {
  const runtime = await nativeTools(config.runtimePackageJson, process.cwd());
  try {
    for (const name of workerTools) {
      const definition = runtime.definitions.get(name);
      if (!definition) throw new Error(`Missing native DSH tool: ${name}`);
      ctx.tools.register({ ...definition, description: definition.description + ' Relative paths use the task workspace.',
        execute: (args, exec) => workspaces.invoke(name, args, exec) });
    }
  } finally { await runtime.dispose(); }
}

export function registerHtmlChunkTool(ctx, workspaces) {
  ctx.tools.register({
    name: 'html_chunk',
    description: 'Submit a single-HTML draft in sequential pieces. Append 1..8192 UTF-8 bytes per call with index 0,1,...; call finish with the next index after the complete document. Each append is kept in the isolated draft; finish hands the document to controller checks.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      action: { type: 'string', enum: ['append', 'finish'] }, index: { type: 'integer' }, content: { type: 'string' },
    }, required: ['action', 'index'] },
    output: { schema: { type: 'string' }, render: (_, value) => [{ type: 'text', text: value }] },
    execute: async (args, exec) => JSON.stringify(await workspaces.htmlChunk(args, exec)),
  });
}

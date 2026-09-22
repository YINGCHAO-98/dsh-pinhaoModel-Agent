import { mkdtemp, mkdir, rm, realpath, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { capture, materialize, isWithin, applyProposal } from './files.mjs';
import { execute, seatbeltProfile } from './runner.mjs';
import { nativeTools } from './native-tools.mjs';

export const rootFileTools = ['read', 'write', 'edit', 'glob', 'grep'];
export const workerTools = ['read', 'write', 'edit', 'glob', 'grep', 'bash'];
const helper = fileURLToPath(new URL('./worker-helper.mjs', import.meta.url));

export function resolveToolPath(session, input) {
  if (typeof input !== 'string' || !input) throw new Error('Tool path must be a non-empty string');
  let value = input;
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
  rootProtections = new Map();
  animationTurns = new Map();
  noSkillTurns = new Set();
  terminalDeliveryTurns = new Map();
  constructor(config) { this.config = config; }
  beginRootTurn(owner, text) {
    this.clearRootProtection(owner);
    this.noSkillTurns.delete(owner);
    this.terminalDeliveryTurns.delete(owner);
    if (typeof text !== 'string') return;
    const animation = /(?:动画|动效|分镜|镜头|帧动画|animation|animated|animate|motion|storyboard)/iu.test(text);
    // A workflow-only follow-up still belongs to the preceding animation request.
    // Keep the route guard so splitting the request across messages cannot turn
    // an isolated delivery into an unrestricted root write.
    const workflowModifier = /(?:不|无需|不要|跳过|取消|禁用|without|skip|disable|no\s+)/iu.test(text)
      && /(?:skill|技能|验证|校验|检查|测试|审查|verification|validation|test|review)/iu.test(text);
    if (animation) this.animationTurns.set(owner, text);
    else if (!workflowModifier) this.animationTurns.delete(owner);
    if (/(?:不使用|不要使用|禁用|跳过|without|disable|skip|no)\s*(?:任何\s*)?(?:skill|技能)/iu.test(text))
      this.noSkillTurns.add(owner);
  }
  assertSkillAllowed(owner) {
    if (this.noSkillTurns.has(owner)) throw new Error('SKILL_DISABLED_BY_USER: the current user request explicitly disables skills');
  }
  animationContext(owner) { return this.animationTurns.get(owner) ?? null; }
  protectRoot(owner, path) {
    if (typeof owner !== 'string' || !owner || typeof path !== 'string' || !path) throw new Error('Invalid root protection');
    const paths = this.rootProtections.get(owner) ?? new Set();
    paths.add(path); this.rootProtections.set(owner, paths);
  }
  clearRootProtection(owner) { this.rootProtections.delete(owner); }
  blockTerminalDeliveryTurn(owner, delivery) {
    if (typeof owner !== 'string' || !owner || !delivery?.id || !delivery?.reasonCode)
      throw new Error('Invalid terminal delivery turn');
    this.terminalDeliveryTurns.set(owner, { id: delivery.id, reasonCode: delivery.reasonCode });
  }
  terminalDeliveryBlock(owner) { return this.terminalDeliveryTurns.get(owner) ?? null; }
  assertRootQuestionAllowed(owner) {
    const terminal = this.terminalDeliveryBlock(owner);
    if (terminal) throw new Error(`TERMINAL_DELIVERY_DECISION_DENIED: delivery ${terminal.id} ended with ${terminal.reasonCode}; report the failure directly and wait for a new user request`);
    if (this.rootProtections.get(owner)?.size)
      throw new Error('CONTROLLED_DELIVERY_QUESTION_DENIED: the controller owns this animation delivery and handles actionable conflicts itself');
  }
  assertRootDeliveryStartAllowed(owner) {
    const terminal = this.terminalDeliveryBlock(owner);
    if (terminal) throw new Error(`TERMINAL_DELIVERY_RESTART_DENIED: delivery ${terminal.id} ended with ${terminal.reasonCode}; do not retry or replace it in the same user turn`);
  }
  resetRootState(owner) {
    this.clearRootProtection(owner);
    this.animationTurns.delete(owner);
    this.noSkillTurns.delete(owner);
    this.terminalDeliveryTurns.delete(owner);
  }
  assertRootMutationAllowed(owner, cwd, name, args) {
    if (!['write', 'edit'].includes(name)) return;
    if (this.animationTurns.has(owner) && typeof args?.file_path === 'string' && /\.html?$/iu.test(args.file_path))
      throw new Error('ANIMATION_ROUTE_REQUIRED: SVG/HTML animation must use delivery_start so Doubao planning and controlled implementation cannot be skipped');
    const paths = this.rootProtections.get(owner);
    if (!paths?.size || typeof args?.file_path !== 'string') return;
    const target = resolve(cwd, args.file_path);
    if ([...paths].some(path => target === resolve(cwd, path)))
      throw new Error('CONTROLLED_ANIMATION_PATH: this animation output is reserved for the controlled planning -> implementation -> delivery route until the next user turn');
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
      if (!rootFileTools.includes(name)) throw new Error('ROOT_TOOL_NOT_ALLOWED: only file tools are enabled');
      const cwd = exec.agent?.session.header.cwd;
      if (!cwd) throw new Error('Session has no workspace');
      if (process.platform !== 'darwin' || (this.config.sandbox?.backend ?? 'seatbelt') !== 'seatbelt')
        throw new Error('Root file tools require macOS Seatbelt');
      exec.signal.throwIfAborted();
      const root = await realpath(cwd);
      this.assertRootMutationAllowed(exec.agent.session.id, root, name, args);
      const scratch = await realpath(await mkdtemp(resolve(tmpdir(), 'pinhaomo-root-')));
      const session = { root, scratch, projectRoot: root, projectRoots: [resolve(cwd), root], signal: exec.signal, tail: Promise.resolve(), execution: [] };
      try { return await this.invokeSession(session, name, args, exec); }
      finally { await rm(scratch, { recursive: true, force: true }); }
    }
    return this.invokeSession(this.find(exec), name, args, exec);
  }
  async invokeSession(session, name, args, exec) {
    const operation = session.tail.then(async () => {
      session.signal.throwIfAborted(); exec.signal.throwIfAborted();
      if (session.closed) throw new Error('Worker workspace expired');
      if (session.handoffPending) throw new Error('HTML_DRAFT_HANDED_OFF: further implementation calls are revoked');
      if (session.execution.length >= (session.maxToolCalls ?? 128))
        throw new Error(`Specialist tool-call budget exhausted (${session.maxToolCalls ?? 128})`);
      if (session.readOnly && ['write', 'edit'].includes(name)) throw new Error('Specialist workspace is read-only');
      if (args.sandbox_permissions !== undefined || args.run_in_background) throw new Error('Escalation/background execution is disabled');
      const bounded = { ...args };
      if (name === 'bash' && typeof bounded.command === 'string' && /(?:^|\s|['"])\/(?:private\/)?tmp\//u.test(bounded.command))
        throw new Error('WORKER_TEMP_PATH_REQUIRED: /tmp is outside this isolated task. Use $TMPDIR/... or /scratch/... so the command runs in the owned scratch directory.');
      for (const key of ['file_path', 'path', 'workdir']) if (typeof bounded[key] === 'string') {
        const { target, boundary } = resolveToolPath(session, bounded[key]);
        // Reject symlink paths even when they resolve back inside the workspace.
        let current = boundary;
        for (const part of relative(boundary, target).split('/').filter(Boolean)) {
          current = resolve(current, part);
          try { if ((await lstat(current)).isSymbolicLink()) throw new Error('Symlink tool paths are not allowed'); }
          catch (error) { if (error.code === 'ENOENT') break; throw error; }
        }
        bounded[key] = target;
      }
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

import { readFileSync, constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, readdir, open, mkdir, writeFile, realpath } from 'node:fs/promises';
import { resolve, dirname, isAbsolute, sep } from 'node:path';

export const hash = value => createHash('sha256').update(value).digest('hex');
export const snapshotPolicy = JSON.parse(readFileSync(new URL('./snapshot-policy.json', import.meta.url), 'utf8'));
if (!Number.isSafeInteger(snapshotPolicy.maxBytes) || snapshotPolicy.maxBytes < 1 || snapshotPolicy.maxBytes > 512 * 1024 * 1024
  || !Number.isSafeInteger(snapshotPolicy.maxFiles) || snapshotPolicy.maxFiles < 1 || snapshotPolicy.maxFiles > 50000
  || !Array.isArray(snapshotPolicy.excludedNames) || snapshotPolicy.excludedNames.some(n => typeof n !== 'string' || !n || /[\\/]/.test(n)))
  throw new Error('Invalid deployment snapshot-policy.json');
const excluded = new Set(['.git', 'node_modules', '.delivery', '.DS_Store', ...snapshotPolicy.excludedNames]);
const isExcluded = name => excluded.has(name) || name === '.env' || name.startsWith('.env.');
export function safePath(path) {
  if (typeof path !== 'string' || !path || isAbsolute(path) || /[\\\x00-\x1f:]/u.test(path)
    || path.split('/').some(p => !p || p === '.' || p === '..')) {
    throw new Error(`Unsafe relative path: ${JSON.stringify(path)}`);
  }
  return path;
}
export function matches(path, rule) {
  return rule === '**' ? true : rule.endsWith('/') ? path.startsWith(rule) : path === rule;
}
export function isWithin(child, parent) {
  return child === parent || child.startsWith(parent + sep);
}
export function digest(files) {
  return hash(JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))));
}

// No symlinks, executable metadata or special files enter the proposal boundary.
export async function capture(root, maxBytes = snapshotPolicy.maxBytes, { includeExcluded = false, maxFiles = snapshotPolicy.maxFiles, paths } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 512 * 1024 * 1024
    || !Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > 50000) throw new Error('Invalid snapshot budget');
  root = await realpath(root);
  const files = Object.create(null);
  const manifest = [];
  let size = 0;
  const budget = (path, fileBytes, count, total) => {
    if (total > maxBytes || count > maxFiles) throw new Error(
      `SNAPSHOT_BUDGET_EXCEEDED: path=${JSON.stringify(path)}, fileBytes=${fileBytes}, totalBytes=${total}/${maxBytes}, files=${count}/${maxFiles}. Narrow inputRefs for specialist tasks or adjust deployment snapshot-policy.json; no partial snapshot was accepted.`);
  };
  async function visit(path) {
    safePath(path);
    const full = resolve(root, path);
    const stat = await lstat(full);
    if (stat.isSymbolicLink()) throw new Error(`Snapshot rejects symlink: ${path}`);
    if (stat.isDirectory()) await walk(full, path + '/');
    else if (stat.isFile()) {
      size += stat.size;
      budget(path, stat.size, manifest.length + 1, size);
      manifest.push({ path, full, size: stat.size, ino: stat.ino, dev: stat.dev });
    } else throw new Error(`Snapshot rejects special file: ${path}`);
  }
  async function walk(dir, prefix = '') {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!includeExcluded && isExcluded(entry.name)) continue;
      await visit(prefix + entry.name);
    }
  }
  if (paths !== undefined) {
    if (!Array.isArray(paths)) throw new Error('Snapshot paths must be an array');
    for (const path of [...new Set(paths)].sort()) {
      safePath(path);
      let full = root;
      for (const part of path.split('/')) {
        if (!includeExcluded && isExcluded(part)) throw new Error(`Excluded snapshot input: ${path}`);
        full = resolve(full, part);
        if ((await lstat(full)).isSymbolicLink()) throw new Error(`Snapshot rejects symlink: ${path}`);
      }
      if (!(await lstat(full)).isFile()) throw new Error(`Snapshot input must name a file: ${path}`);
      await visit(path);
    }
  } else await walk(root);
  // Metadata preflight completes before reading content or allocating base64 snapshots.
  size = 0;
  for (const entry of manifest) {
    if (!isWithin(await realpath(entry.full), root)) throw new Error(`Snapshot path escaped workspace: ${entry.path}`);
    const handle = await open(entry.full, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.ino !== entry.ino || stat.dev !== entry.dev || stat.size !== entry.size)
        throw new Error(`Snapshot input changed during capture: ${entry.path}`);
      const buffer = Buffer.alloc(stat.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length !== stat.size) throw new Error(`Snapshot input changed during capture: ${entry.path}`);
      size += length;
      budget(entry.path, length, Object.keys(files).length + 1, size);
      files[entry.path] = buffer.subarray(0, length).toString('base64');
    } finally { await handle.close(); }
  }
  return files;
}

export function capabilityPaths(request) {
  if (request.capability === 'quality_review') return undefined; // Reviews retain the complete code snapshot.
  return request.inputRefs.filter(ref => ref.startsWith('file:')).map(ref => safePath(ref.slice(5)));
}

export async function materialize(files, root) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const [path, data] of Object.entries(files)) {
    safePath(path);
    const target = resolve(root, path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, Buffer.from(data, 'base64'), { flag: 'wx', mode: 0o600 });
  }
}

export function validateContract(value) {
  const c = structuredClone(value);
  if (c.version !== 1 || !Array.isArray(c.editablePaths) || !c.editablePaths.length
    || !Array.isArray(c.protectedPaths) || !Array.isArray(c.checks)
    || !Array.isArray(c.requiredPaths)
    || (c.layout !== undefined && c.layout !== 'workspace')
    || (c.layout !== 'workspace' && (!c.checks.length || (!c.requiredPaths.length && !c.requiredOutputs?.length)))) throw new Error('Incomplete verification contract');
  if (c.requiredOutputs !== undefined && (!Array.isArray(c.requiredOutputs) || !c.requiredOutputs.length))
    throw new Error('Invalid required outputs');
  if (!Number.isInteger(c.maxRepairs) || c.maxRepairs < 0 || c.maxRepairs > 2) throw new Error('maxRepairs must be 0..2');
  for (const path of [...c.editablePaths, ...c.protectedPaths, ...c.requiredPaths, ...(c.requiredOutputs ?? [])]) safePath(path.replace(/\/$/u, ''));
  const ids = new Set();
  for (const check of c.checks) {
    if (!/^[a-z][a-z0-9_-]*$/u.test(check.id) || ids.has(check.id)) throw new Error('Invalid/duplicate check id');
    ids.add(check.id);
    if (!Array.isArray(check.argv) || !check.argv.length || check.argv.some(v => typeof v !== 'string' || !v || v.includes('\0')))
      throw new Error('check.argv must be a nonempty argv array');
    if (check.argv[0] !== 'node' && !isAbsolute(check.argv[0])) throw new Error('Use node or an absolute executable path');
    if (!Number.isInteger(check.timeoutMs) || check.timeoutMs < 100 || check.timeoutMs > 300000) throw new Error('Invalid check timeout');
    if (check.minTests !== undefined && (!Number.isInteger(check.minTests) || check.minTests < 1)) throw new Error('Invalid minimum test count');
  }
  return c;
}

export function assertRequired(files, contract, { beforeImplementation = false } = {}) {
  for (const path of [...contract.requiredPaths, ...(beforeImplementation ? [] : contract.requiredOutputs ?? [])]) {
    if (!Object.keys(files).some(file => matches(file, path))) throw new Error(`Required verification input missing: ${path}`);
  }
}

export function applyProposal(files, proposal, contract) {
  if (!proposal || typeof proposal.summary !== 'string' || !Array.isArray(proposal.changes)
    || proposal.changes.length > 64) throw new Error('Invalid worker proposal');
  const next = Object.assign(Object.create(null), files);
  const seen = new Set();
  let bytes = 0;
  for (const change of proposal.changes) {
    const path = safePath(change.path);
    if (seen.has(path)) throw new Error(`Duplicate change: ${path}`);
    seen.add(path);
    if (path.split('/').some(p => p.startsWith('.'))
      || !contract.editablePaths.some(rule => matches(path, rule))
      || contract.protectedPaths.some(rule => matches(path, rule))) throw new Error(`Protected path: ${path}`);
    if (change.operation === 'delete') {
      if (!Object.hasOwn(next, path)) throw new Error(`Cannot delete missing file: ${path}`);
      delete next[path];
    } else if (change.operation === 'write' && typeof change.content === 'string') {
      bytes += Buffer.byteLength(change.content);
      if (bytes > 256 * 1024) throw new Error('Proposal exceeds byte budget');
      next[path] = Buffer.from(change.content).toString('base64');
    } else throw new Error('Invalid change operation/content');
  }
  // Reject file/directory collisions before touching the filesystem.
  for (const path of Object.keys(next)) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      if (Object.hasOwn(next, parts.slice(0, i).join('/'))) throw new Error(`Path collision: ${path}`);
    }
  }
  assertRequired(next, contract);
  return next;
}

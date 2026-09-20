import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, mkdir, writeFile, realpath } from 'node:fs/promises';
import { resolve, dirname, isAbsolute, sep } from 'node:path';

export const hash = value => createHash('sha256').update(value).digest('hex');
const excluded = new Set(['.git', 'node_modules', '.delivery', '.DS_Store']);
export function safePath(path) {
  if (typeof path !== 'string' || !path || isAbsolute(path) || /[\\\x00-\x1f:]/u.test(path)
    || path.split('/').some(p => !p || p === '.' || p === '..')) {
    throw new Error(`Unsafe relative path: ${JSON.stringify(path)}`);
  }
  return path;
}
export function matches(path, rule) {
  return rule.endsWith('/') ? path.startsWith(rule) : path === rule;
}
export function isWithin(child, parent) {
  return child === parent || child.startsWith(parent + sep);
}
export function digest(files) {
  return hash(JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))));
}

// No symlinks, executable metadata or special files enter the proposal boundary.
export async function capture(root, maxBytes = 4 * 1024 * 1024, { includeExcluded = false } = {}) {
  root = await realpath(root);
  const files = Object.create(null);
  let size = 0;
  async function walk(dir, prefix = '') {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!includeExcluded && (excluded.has(entry.name) || entry.name === '.env' || entry.name.startsWith('.env.'))) continue;
      const path = safePath(prefix + entry.name);
      const full = resolve(dir, entry.name);
      const stat = await lstat(full);
      if (stat.isSymbolicLink()) throw new Error(`Snapshot rejects symlink: ${path}`);
      if (stat.isDirectory()) await walk(full, path + '/');
      else if (stat.isFile()) {
        size += stat.size;
        if (size > maxBytes || Object.keys(files).length >= 1000) throw new Error('Snapshot exceeds file/byte budget');
        files[path] = (await readFile(full)).toString('base64');
      } else throw new Error(`Snapshot rejects special file: ${path}`);
    }
  }
  await walk(root);
  return files;
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
    || !Array.isArray(c.protectedPaths) || !Array.isArray(c.checks) || !c.checks.length
    || !Array.isArray(c.requiredPaths) || !c.requiredPaths.length) throw new Error('Incomplete verification contract');
  if (!Number.isInteger(c.maxRepairs) || c.maxRepairs < 0 || c.maxRepairs > 2) throw new Error('maxRepairs must be 0..2');
  for (const path of [...c.editablePaths, ...c.protectedPaths, ...c.requiredPaths]) safePath(path.replace(/\/$/u, ''));
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

export function assertRequired(files, contract) {
  for (const path of contract.requiredPaths) {
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


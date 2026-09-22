import { mkdtempSync, writeFileSync, readFileSync, rmSync, lstatSync, realpathSync, mkdirSync, renameSync, unlinkSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { safePath, hash } from './files.mjs';

export class SyncConflict extends Error {
  constructor(conflicts) { super('Integration conflict requires a decision: ' + conflicts.map(c => c.path).join(', ')); this.conflicts = conflicts; }
}
const text = data => {
  const bytes = Buffer.from(data, 'base64');
  const value = bytes.toString('utf8');
  return !bytes.includes(0) && Buffer.from(value).equals(bytes) ? value : null;
};
// Three-way merge: preserve current-only changes, merge non-overlapping text edits.
export function mergeSnapshots(base, proposed, current, resolutions = []) {
  if (!Array.isArray(resolutions) || resolutions.length > 64 || new Set(resolutions.map(r => r.path)).size !== resolutions.length)
    throw new Error('Invalid conflict resolutions');
  for (const r of resolutions) if (!r || !['current', 'delivery'].includes(r.take) || typeof r.currentHash !== 'string' || typeof r.deliveryHash !== 'string') throw new Error('Invalid conflict resolution');
  const result = Object.assign(Object.create(null), current);
  const conflicts = [];
  for (const path of new Set([...Object.keys(base), ...Object.keys(proposed)])) {
    const before = base[path], after = proposed[path], now = current[path];
    const choice = resolutions.find(r => r.path === path);
    if (choice) {
      if (choice.currentHash !== hash(now ?? '<missing>') || choice.deliveryHash !== hash(after ?? '<missing>'))
        throw new SyncConflict([{ path, reason: 'conflict changed since decision' }]);
      const selected = choice.take === 'current' ? now : after;
      if (selected === undefined) delete result[path]; else result[path] = selected;
      continue;
    }
    if (before === after || now === after) continue;
    if (now === before) { if (after === undefined) delete result[path]; else result[path] = after; continue; }
    if ([before, after, now].some(v => v === undefined || text(v) === null)) {
      conflicts.push({ path, reason: 'concurrent add/delete or binary change' }); continue;
    }
    const dir = mkdtempSync(resolve(tmpdir(), 'delivery-merge-'));
    try {
      const paths = ['current', 'base', 'proposed'].map(name => resolve(dir, name));
      [now, before, after].forEach((data, i) => writeFileSync(paths[i], Buffer.from(data, 'base64'), { mode: 0o600 }));
      const merged = spawnSync('git', ['merge-file', '-p', '--', ...paths], { encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
      if (merged.status !== 0) conflicts.push({ path, reason: merged.error ? 'merge unavailable' : 'overlapping text edits' });
      else result[path] = Buffer.from(merged.stdout).toString('base64');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  for (const path of Object.keys(result)) {
    safePath(path);
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) if (Object.hasOwn(result, parts.slice(0, i).join('/')))
      conflicts.push({ path, reason: 'file/directory collision' });
  }
  const unresolved = [];
  for (const conflict of conflicts) {
    const { path } = conflict;
    const detail = { ...conflict, currentHash: hash(current[path] ?? '<missing>'), deliveryHash: hash(proposed[path] ?? '<missing>') };
    const choice = resolutions.find(r => r.path === path);
    if (!choice || conflict.reason === 'file/directory collision') { unresolved.push(detail); continue; }
    if (choice.currentHash !== detail.currentHash || choice.deliveryHash !== detail.deliveryHash) {
      unresolved.push({ ...detail, reason: 'conflict changed since decision' }); continue;
    }
    const selected = choice.take === 'current' ? current[path] : proposed[path];
    if (selected === undefined) delete result[path]; else result[path] = selected;
  }
  for (const path of Object.keys(result)) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) if (Object.hasOwn(result, parts.slice(0, i).join('/')))
      unresolved.push({ path, reason: 'file/directory collision after resolution' });
  }
  if (unresolved.length) throw new SyncConflict(unresolved);
  return result;
}
export function syncPlan(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().filter(path => before[path] !== after[path])
    .map(path => ({ path, before: before[path] ?? null, after: after[path] ?? null, temporaryName: '.delivery-sync-' + randomUUID() }));
}
function inspect(root, path) {
  safePath(path);
  if (realpathSync(root) !== root) throw new SyncConflict([{ path, reason: 'workspace identity changed' }]);
  const parts = path.split('/');
  for (let i = 1; i <= parts.length; i++) {
    const full = resolve(root, ...parts.slice(0, i));
    let stat;
    try { stat = lstatSync(full); } catch (error) { if (error.code === 'ENOENT') return { value: null }; throw error; }
    if (stat.isSymbolicLink() || (i < parts.length ? !stat.isDirectory() : !stat.isFile()))
      throw new SyncConflict([{ path, reason: 'symlink or incompatible file type' }]);
    if (i === parts.length) return { value: readFileSync(full).toString('base64'), mode: stat.mode & 0o777 };
  }
}
// Journal is persisted by controller before this function. A retry accepts already-applied
// bytes, but never overwrites a third version. No asynchronous yield between check/write.
export function applySync(root, plan, onApplied = () => {}) {
  for (const change of plan) {
    const { value } = inspect(root, change.path);
    if (value !== change.before && value !== change.after)
      throw new SyncConflict([{ path: change.path, reason: 'changed after verification' }]);
  }
  for (const change of plan) {
    const target = resolve(root, change.path);
    const actual = inspect(root, change.path);
    const temporaryName = change.temporaryName ?? '.delivery-sync-' + randomUUID();
    if (!/^\.delivery-sync-[a-f0-9-]{36}$/.test(temporaryName)) throw new Error('Invalid sync temporary name');
    const temporary = resolve(dirname(target), temporaryName);
    try {
      const leftover = lstatSync(temporary);
      if (!leftover.isFile() || readFileSync(temporary).toString('base64') !== change.after)
        throw new SyncConflict([{ path: change.path, reason: 'unexpected synchronization staging file' }]);
      unlinkSync(temporary);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (actual.value === change.after) continue;
    if (actual.value !== change.before) throw new SyncConflict([{ path: change.path, reason: 'changed during synchronization' }]);
    if (change.after === null) unlinkSync(target);
    else {
      mkdirSync(dirname(target), { recursive: true });
      try {
        writeFileSync(temporary, Buffer.from(change.after, 'base64'), { flag: 'wx', mode: actual.mode ?? 0o644 });
        const fd = openSync(temporary, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
        if (inspect(root, change.path).value !== change.before) throw new SyncConflict([{ path: change.path, reason: 'changed during synchronization' }]);
        renameSync(temporary, target);
      } finally { rmSync(temporary, { force: true }); }
    }
    onApplied(change.path);
  }
}

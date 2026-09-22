import { lstat, realpath } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { safePath, isWithin } from './files.mjs';
import { validateTasks } from './task-contracts.mjs';

// Native harness semantics: all paths are relative to the session cwd unless
// an explicit project directory is supplied. Never guess from directory names.
export async function resolveDeliveryTarget(cwd, contract, { projectRoot = '.', tasks = [], singleHtmlPath } = {}) {
  const sessionRoot = await realpath(cwd);
  if (typeof projectRoot !== 'string' || !projectRoot) throw new Error('Invalid projectRoot');
  if (singleHtmlPath && projectRoot !== '.') throw new Error('Single HTML delivery uses the session root');
  if (projectRoot !== '.') safePath(projectRoot);
  let selected = sessionRoot;
  for (const part of projectRoot === '.' ? [] : projectRoot.split('/')) {
    selected = resolve(selected, part);
    const stat = await lstat(selected);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`DELIVERY_PROJECT_PATH_REJECTED: ${projectRoot}`);
  }
  selected = await realpath(selected);
  if (!isWithin(selected, sessionRoot)) throw new Error('DELIVERY_PROJECT_PATH_OUTSIDE');
  const prefix = relative(sessionRoot, selected);
  const normalized = structuredClone(tasks);
  for (const task of normalized) if (Array.isArray(task.editablePaths)) {
    task.editablePaths = task.editablePaths.map(path => prefix && typeof path === 'string' && path.startsWith(prefix + '/') ? path.slice(prefix.length + 1) : path);
  }
  try { validateTasks(normalized, contract); }
  catch (error) { throw new Error(`${error.message}: ${JSON.stringify({ projectRoot: selected, editablePaths: contract.editablePaths, protectedPaths: contract.protectedPaths, checkIds: contract.checks.map(check => check.id) })}`); }
  return { sessionRoot, projectRoot: prefix || '.', workspace: selected, tasks: normalized,
    deliveryDirectory: selected, editablePaths: contract.editablePaths, protectedPaths: contract.protectedPaths,
    checkIds: contract.checks.map(check => check.id) };
}

import { isAbsolute } from 'node:path';
import { validateContract, safePath, matches } from './files.mjs';
import { validateTasks } from './task-contracts.mjs';

const list = { type: 'array', maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 4000 } };
export const taskContextSchema = { type: 'object', additionalProperties: false, properties: {
  constraints: { anyOf: [list, { type: 'object', maxProperties: 100, additionalProperties: { type: ['string', 'boolean', 'number'] } }] }, editablePaths: list, protectedPaths: list, requiredInterfaces: list,
  acceptanceCriteria: list, deliverables: list,
} };

function strings(value, field) {
  if (!Array.isArray(value) || value.length > 100 || value.some(v => typeof v !== 'string' || !v.trim() || v.length > 4000))
    throw new Error(`Invalid Task IR ${field}`);
  return [...new Set(value)];
}
function pathRule(value) {
  if (typeof value !== 'string') throw new Error('Invalid Task IR path');
  const rule = value.endsWith('/**') ? value.slice(0, -2) : value;
  safePath(rule.replace(/\/$/u, ''));
  if (rule !== '**' && /[*?\[\]]/u.test(rule)) throw new Error('Unsupported Task IR path pattern');
  return rule;
}

// No decomposition, command synthesis, model selection or keyword routing.
// Only deployment-owned checks/resources can enter the executable contract.
export function compileTask({ goal, projectRoot, deployment, context = {}, tasks = [], resources = {} }) {
  if (typeof goal !== 'string' || !goal.trim() || goal.length > 16000 || !isAbsolute(projectRoot)) throw new Error('Invalid Task IR identity');
  if (!context || Array.isArray(context) || typeof context !== 'object'
    || Object.keys(context).some(k => !Object.hasOwn(taskContextSchema.properties, k))) throw new Error('Unsupported Task IR field');
  if (Buffer.byteLength(JSON.stringify(context)) > 128 * 1024) throw new Error('Task IR exceeds context budget');
  const input = Object.fromEntries(Object.entries(context).map(([key, value]) => {
    if (key === 'constraints' && value && !Array.isArray(value) && typeof value === 'object') {
      if (Object.keys(value).length > 100 || Object.entries(value).some(([k, v]) => !k.trim() || k.length > 100
        || !['string', 'boolean', 'number'].includes(typeof v) || (typeof v === 'number' && !Number.isFinite(v))
        || String(v).length > 4000)) throw new Error('Invalid Task IR constraints');
      return [key, structuredClone(value)];
    }
    return [key, strings(value, key)];
  }));
  const contract = validateContract(deployment);
  if (input.editablePaths) {
    const paths = input.editablePaths.map(pathRule);
    if (!paths.length || paths.some(path => !contract.editablePaths.some(rule => matches(path, rule))))
      throw new Error('Task IR modification scope exceeds deployment contract');
    contract.editablePaths = paths;
  }
  contract.protectedPaths = [...new Set([...contract.protectedPaths, ...(input.protectedPaths ?? []).map(pathRule)])];
  const checkIds = contract.checks.map(check => check.id);
  const validation = [];
  const criterion = (text, taskId = null, checkId = null) => {
    const executable = checkIds.includes(checkId ?? text);
    validation.push({ text, taskId, checkId: executable ? checkId ?? text : null,
      kind: executable ? 'check' : 'text', ...(!executable && checkId ? { requestedCheckId: checkId,
        reason: 'Check is not registered; temporary check creation is not enabled by this deployment' } : {}) });
  };
  for (const text of input.acceptanceCriteria ?? []) criterion(text);
  for (const text of Array.isArray(input.constraints) ? input.constraints : Object.entries(input.constraints ?? {}).map(([k, v]) => `${k}: ${v}`)) criterion(text);
  for (const text of input.requiredInterfaces ?? []) criterion(`Required interface: ${text}`);
  for (const text of input.deliverables ?? []) criterion(`Deliverable: ${text}`);
  if (!Array.isArray(tasks)) throw new Error('Invalid task manifest');
  const normalized = structuredClone(tasks);
  for (const task of normalized) {
    if (!task || typeof task !== 'object') throw new Error('Invalid task manifest');
    if (Array.isArray(task.editablePaths)) task.editablePaths = task.editablePaths.map(pathRule);
    for (const text of task.acceptanceCriteria ?? []) criterion(text, task.id);
    for (const text of task.interfaces ?? []) criterion(`Required interface: ${text}`, task.id);
    if (task.checkIds !== undefined) {
      const requested = strings(task.checkIds, 'checkIds');
      if (task.checkIds.length > 20) throw new Error('Invalid Task IR checkIds');
      if (requested.some(id => !/^[a-z][a-z0-9_-]*$/u.test(id))) throw new Error('Invalid requested check id');
      for (const id of requested) criterion(`Requested check: ${id}`, task.id, id);
      task.checkIds = requested.filter(id => checkIds.includes(id));
    }
  }
  validateTasks(normalized, contract);
  const taskIR = { version: 1, goal, constraints: input.constraints ?? [], projectRoot,
    editablePaths: contract.editablePaths, protectedPaths: contract.protectedPaths,
    requiredInterfaces: input.requiredInterfaces ?? [], availableTools: resources.tools ?? [],
    availableModels: resources.models ?? [], availableChecks: structuredClone(contract.checks),
    acceptanceCriteria: input.acceptanceCriteria ?? [], deliverables: input.deliverables ?? [], validation };
  return { taskIR, contract: { ...contract, projectRoot, checkIds, capabilities: resources.capabilities ?? [] }, tasks: normalized };
}

export function validationSummary(run) {
  // Design suggestions may be informed by arbitrary workspace files. They
  // cannot add mandatory acceptance criteria to the user's task contract.
  const criteria = [...(run.taskIR?.validation ?? [])];
  return criteria.map(item => {
    const evidence = item.checkId && run.evidence.find(e => e.id === item.checkId && e.snapshot === run.snapshot);
    return { ...item, status: evidence ? evidence.kind === 'passed' && evidence.exitCode === 0 ? 'passed'
      : evidence.kind === 'failed' ? 'failed' : 'not_verified' : 'not_verified' };
  });
}

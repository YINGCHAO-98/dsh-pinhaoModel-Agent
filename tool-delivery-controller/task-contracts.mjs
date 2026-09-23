import { safePath, matches } from './files.mjs';

export const taskSchema = { type: 'array', maxItems: 10, items: { type: 'object', properties: {
  id: { type: 'string' }, objective: { type: 'string', maxLength: 16000 }, context: { type: 'string', maxLength: 32000 },
  interfaces: { type: 'array', items: { type: 'string' }, maxItems: 20 },
  acceptanceCriteria: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20 },
  editablePaths: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20 },
  checkIds: { type: 'array', items: { type: 'string' }, maxItems: 20 },
  dependsOn: { type: 'array', items: { type: 'string' }, maxItems: 10 },
}, required: ['id', 'objective', 'context', 'interfaces', 'acceptanceCriteria', 'editablePaths', 'dependsOn'], additionalProperties: false } };
export function validateTasks(tasks, contract) {
  if (!Array.isArray(tasks) || tasks.length > 10) throw new Error('Invalid task manifest');
  if (Buffer.byteLength(JSON.stringify(tasks)) > 128 * 1024) throw new Error('Task manifest exceeds context budget');
  const result = structuredClone(tasks);
  const ids = new Set();
  const strings = (values, minimum = 0) => Array.isArray(values) && values.length >= minimum && values.length <= 20
    && values.every(v => typeof v === 'string' && v.trim() && v.length <= 4000);
  for (const task of result) {
    if (!task || Object.keys(task).some(k => !Object.hasOwn(taskSchema.items.properties, k))
      || typeof task.id !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(task.id) || ids.has(task.id)
      || typeof task.objective !== 'string' || !task.objective.trim() || task.objective.length > 16000
      || typeof task.context !== 'string' || !task.context.trim() || task.context.length > 32000
      || !strings(task.interfaces) || !strings(task.acceptanceCriteria, 1) || !strings(task.editablePaths, 1)
      || !strings(task.dependsOn) || new Set(task.dependsOn).size !== task.dependsOn.length) throw new Error('Incomplete or duplicate task contract');
    if (task.checkIds !== undefined && (!strings(task.checkIds) || task.checkIds.some(id => !contract.checks.some(c => c.id === id)))) throw new Error('Task checks must come from the deployment contract');
    ids.add(task.id);
    for (const path of task.editablePaths) {
      safePath(path.replace(/\/$/, ''));
      if (!contract.editablePaths.some(rule => matches(path, rule))
        || contract.protectedPaths.some(rule => matches(path, rule) || (path.endsWith('/') && rule.startsWith(path))))
        throw new Error('Task modification scope exceeds project contract');
    }
  }
  const visited = new Set(), visiting = new Set();
  function visit(id) {
    if (!ids.has(id)) throw new Error('Unknown task dependency');
    if (visiting.has(id)) throw new Error('Task dependency cycle');
    if (visited.has(id)) return;
    visiting.add(id); result.find(t => t.id === id).dependsOn.forEach(visit); visiting.delete(id); visited.add(id);
  }
  result.forEach(t => visit(t.id));
  return result;
}

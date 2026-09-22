import { randomUUID } from 'node:crypto';
import { hash } from './files.mjs';

function preview(data) {
  if (data === undefined) return '（文件不存在）';
  const bytes = Buffer.from(data, 'base64');
  if (bytes.includes(0) || !Buffer.from(bytes.toString('utf8')).equals(bytes)) return `（二进制文件，${bytes.length} 字节）`;
  const text = bytes.toString('utf8');
  return text.length <= 12000 ? text : text.slice(0, 12000) + '\n（预览已截断；请先查阅完整文件再选择）';
}
// Only the host's userQuestions service is allowed to provide answers. The model
// receives no API for submitting selected labels or minting a decision receipt.
export async function obtainDecision({ store, askUser, run, current, proposed, conflicts, parent, signal }) {
  if (typeof askUser !== 'function') throw new Error('Trusted user interaction service unavailable');
  if (!conflicts.length || conflicts.some(c => /directory|unavailable|staging|symlink|identity/.test(c.reason)))
    throw new Error('Conflict needs structural/environment repair before a content decision');
  const labels = { current: run.resumeState === 'collecting' ? '保留当前集成版本' : '保留当前项目版本', delivery: '采用交付版本' };
  const id = randomUUID();
  const questions = conflicts.map((c, i) => ({ id: `${id}:${i}`, header: '交付冲突',
    question: `${c.path} 存在冲突，保留哪个版本？`,
    detail: `原因：${c.reason}\n当前内容指纹：${hash(current[c.path] ?? '<missing>')}\n交付内容指纹：${hash(proposed[c.path] ?? '<missing>')}\n\n${run.resumeState === 'collecting' ? '当前集成结果' : '当前项目'}：\n${preview(current[c.path])}\n\n交付版本：\n${preview(proposed[c.path])}`,
    options: Object.values(labels).map(label => ({ label })), multiSelect: false }));
  store.openDecision(id, run, { current, proposed }, questions);
  try {
    const answer = await askUser({ agent: parent, signal, questions });
    signal.throwIfAborted();
    if (!answer || !Array.isArray(answer.answers) || answer.answers.length !== questions.length
      || new Set(answer.answers.map(a => a.id)).size !== questions.length) throw new Error('Incomplete user decision');
    const resolutions = questions.map((q, i) => {
      const a = answer.answers.find(a => a.id === q.id);
      if (!a || a.custom?.trim() || !Array.isArray(a.selected) || a.selected.length !== 1) throw new Error('User decision needs one explicit option per conflict');
      const take = Object.keys(labels).find(k => labels[k] === a.selected[0]);
      if (!take) throw new Error('Unrecognized user decision');
      const path = conflicts[i].path;
      return { path, take, currentHash: hash(current[path] ?? '<missing>'), deliveryHash: hash(proposed[path] ?? '<missing>') };
    });
    store.answerDecision(id, resolutions);
    return { id, resolutions };
  } catch (error) { store.rejectDecision(id, String(error.message ?? error)); throw error; }
}

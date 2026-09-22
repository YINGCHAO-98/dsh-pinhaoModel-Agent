// Publish controller-owned state through DSH's existing todo projection.
// UI-only: never inject heartbeat text into model messages or claim model thinking.
const terminal = new Set(['passed', 'failed', 'blocked', 'cancelled', 'invalidated']);
const sessions = new WeakMap();
const names = { queued: '等待依赖', collecting: '执行子任务并集成', implement: '准备实现', implementing: '实现中',
  repair: '准备修复', repairing: '修复中', verify: '准备验收', verifying: '执行检查', syncing: '同步并复核',
  passed: '已完成', failed: '失败', blocked: '阻塞', cancelled: '已取消', invalidated: '产物已失效' };

export function deliveryTodos(run, children = [], history = [], seconds = 0) {
  if (!run) return [
    { content: '准备输入与交付快照', status: 'in_progress' },
    { content: '实现任务', status: 'pending' },
    { content: '执行检查与独立审查', status: 'pending' },
    { content: '交付产物', status: 'pending' },
  ];
  const unverified = run.assurance === 'unverified';
  const ended = terminal.has(run.state);
  const label = names[run.state] ?? run.state;
  const latest = history.at(-1);
  const reviewing = run.state === 'verifying' && latest?.kind === 'quality.started';
  const phase = reviewing ? `独立审查（${run.qualityGate?.model ?? '审查模型'}）`
    : unverified && run.state === 'verify' ? '准备未验证同步'
    : unverified && run.state === 'syncing' ? '同步未验证产物' : label;
  const current = `[${run.id.slice(0, 8)}] ${phase}${ended ? '' : ` · 已运行 ${seconds} 秒`}`
    + (run.repairCount ? ` · 修复 ${run.repairCount}/${run.contract.maxRepairs}` : '')
    + (ended && run.reason ? `：${String(run.reason).slice(0, 240)}` : '');
  const afterImplementation = ['verify', 'verifying', 'syncing', 'passed'].includes(run.state);
  const checked = ['syncing', 'passed'].includes(run.state);
  const active = state => !ended && state ? 'in_progress' : 'pending';
  const decorate = (content, selected) => selected && !ended ? `${content}（${current}）` : content;
  const implementationActive = ['implement', 'implementing', 'repair', 'repairing'].includes(run.state);
  const checkingActive = ['verify', 'verifying'].includes(run.state) && !reviewing;
  const todos = [
    { content: '准备输入与交付快照', status: 'completed' },
    ...children.map(child => {
      const selected = !ended && !terminal.has(child.state) && child.state !== 'queued';
      return { content: decorate(`子任务 ${child.taskKey}：${child.objective.slice(0, 160)}（${names[child.state] ?? child.state}）`, selected),
        status: child.state === 'passed' ? 'completed' : selected ? 'in_progress' : 'pending' };
    }),
    { content: decorate(children.length ? '集成子任务产物' : '实现任务', implementationActive),
      status: afterImplementation ? 'completed' : active(implementationActive) },
  ];
  if (!unverified) todos.push({ content: decorate('执行合同检查', checkingActive), status: checked || reviewing ? 'completed' : active(checkingActive) });
  if (run.qualityGate) todos.push({ content: decorate('独立质量审查', reviewing), status: checked ? 'completed' : active(reviewing) });
  const syncing = run.state === 'syncing';
  todos.push({ content: decorate(run.mode === 'project' ? (unverified ? '同步项目（未验证）' : '同步项目并复核') : '导出交付产物', syncing),
    status: run.state === 'passed' ? 'completed' : active(syncing) });
  if (ended && run.state !== 'passed') todos.unshift({ content: current, status: 'pending' });
  return todos;
}

export class DeliveryProgress {
  constructor(session, store, { intervalMs = 1000, now = Date.now, onError = () => {} } = {}) {
    this.session = session; this.store = store; this.now = now; this.onError = onError;
    if (!sessions.has(session)) sessions.set(session, new Map());
    this.peers = sessions.get(session);
    this.started = now(); this.publish(deliveryTodos());
    this.timer = setInterval(() => this.refresh(), intervalMs);
    this.timer.unref?.();
  }
  bind(id) { this.id = id; this.refresh(); }
  publish(todos) {
    const signature = JSON.stringify(todos);
    if (signature === this.last) return;
    this.peers.set(this, todos);
    try { this.session.append('todo/write', { todos: [...this.peers.values()].flat() }); this.last = signature; }
    catch (error) { this.onError(error); }
  }
  refresh() {
    if (this.closed || !this.id) return;
    try {
      const run = this.store.get(this.id, this.session.id);
      const children = (run.tasks ?? []).map(task => this.store.get(task.runId, this.session.id));
      // Heartbeats at 15-second granularity; state changes are visible on next tick.
      this.publish(deliveryTodos(run, children, this.store.history(this.id), Math.floor((this.now() - this.started) / 15000) * 15));
    } catch (error) { this.onError(error); }
  }
  close(error, { clear = false } = {}) {
    if (this.closed) return;
    clearInterval(this.timer);
    if (clear) {
      this.closed = true;
      this.peers.delete(this);
      try { this.session.append('todo/write', { todos: [...this.peers.values()].flat() }); }
      catch (appendError) { this.onError(appendError); }
      return;
    }
    if (error) this.publish([{ content: `交付未完成：${String(error.message ?? error).slice(0, 240)}`, status: 'pending' }]);
    else this.refresh();
    this.closed = true;
    this.peers.delete(this);
  }
}

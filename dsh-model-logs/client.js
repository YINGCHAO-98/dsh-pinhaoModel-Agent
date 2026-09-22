window.__ModuleLoader__.load({ id: 'dsh-model-logs', factory: require => {
  const React = require('react');
  const h = React.createElement;
  const labels = { running: '运行中', success: '调用成功', failed: '失败', cancelled: '已取消', interrupted: '已中断', incomplete: '未完整返回', accepted: '验收通过', passed: '验收通过', blocked: '阻塞', invalidated: '验收失效', unverified: '未验证', submitted: '已提交', validating: '验收中' };
  const duration = ms => ms == null ? '—' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} 秒`;
  const resultText = r => {
    if (r.output) return r.output;
    if (r.status === 'running') return r.inputKind === 'tool-results'
      ? '模型正在读取上一轮工具结果并继续处理，当前轮次尚未产生文本。'
      : '模型仍在处理，当前轮次尚未产生文本。';
    if (r.error) return '本次调用失败，错误信息见上方。';
    if (r.finishReason === 'tool-calls' && r.tools?.length)
      return `本轮已成功发起工具调用：${r.tools.join(', ')}。工具调用轮次通常没有正文，结果会在工具返回后的后续轮次产生。`;
    if (r.status === 'success') return '调用已完成，但模型没有返回文本。';
    return '本轮没有返回文本，请结合状态、停止原因和错误信息判断。';
  };
  function Panel({ api, sessionId }) {
    const [data, setData] = React.useState(null), [error, setError] = React.useState('');
    const [query, setQuery] = React.useState(''), [model, setModel] = React.useState(''), [status, setStatus] = React.useState('');
    React.useEffect(() => {
      let live = true, busy = false;
      const refresh = async () => {
        if (busy) return; busy = true;
        try { const reply = await api.list(sessionId); if (!reply.ok) throw new Error(reply.error?.message ?? '读取失败'); const next = JSON.parse(reply.value); if (live) { setData(next); setError(''); } }
        catch (e) { if (live) setError(e.message); } finally { busy = false; }
      };
      refresh(); const timer = setInterval(refresh, 2000);
      return () => { live = false; clearInterval(timer); };
    }, [api, sessionId]);
    const records = data?.records ?? [];
    const rows = records.filter(r => (!model || r.model === model) && (!status || r.status === status)
      && (r.sessionId === sessionId || r.rootSessionId === sessionId)
      && (!query || [r.model, r.error, r.output, ...(r.tools ?? [])].join(' ').toLowerCase().includes(query.toLowerCase())));
    return h('section', { className: 'ml-content', 'aria-label': '模型日志' },
        h('header', null, h('div', null, h('h2', null, '模型日志'), h('p', null, '当前会话与子模型 · 实际调用与验收证据'))),
        h('p', { className: 'ml-note' }, '调用成功表示接口正常完成；输出正确性以独立验收为参考，未验收的调用显示“未验证”。历史验收可追溯；逐次调用从插件启用后记录。'),
        h('div', { className: 'ml-filters' },
          h('input', { value: query, onChange: e => setQuery(e.target.value), placeholder: '搜索模型输出或错误', 'aria-label': '搜索日志' }),
          h('select', { value: model, onChange: e => setModel(e.target.value), 'aria-label': '模型筛选' }, h('option', { value: '' }, '全部模型'), [...new Set(records.map(r => r.model))].sort().map(m => h('option', { key: m, value: m }, m))),
          h('select', { value: status, onChange: e => setStatus(e.target.value), 'aria-label': '状态筛选' }, h('option', { value: '' }, '全部状态'), [...new Set(records.map(r => r.status))].sort().map(s => h('option', { key: s, value: s }, labels[s] ?? s)))),
        h('div', { className: 'ml-summary' }, `${rows.length} 条匹配记录 · 失败 ${rows.filter(r => ['failed', 'blocked', 'incomplete', 'interrupted'].includes(r.status)).length} 条 · 每 2 秒更新`),
        error && h('p', { role: 'alert', className: 'ml-error' }, `读取失败：${error}`),
        data?.errors?.map(e => h('p', { key: e, role: 'alert', className: 'ml-error' }, e)),
        !data && !error && h('p', null, '正在读取日志…'),
        data && !rows.length && h('p', { className: 'ml-empty' }, '暂无匹配记录。开始一次拼好模任务后，模型调用会出现在这里。'),
        h('div', { className: 'ml-list' }, rows.slice(0, 300).map(r => h('details', { key: `${r.kind}:${r.id}`, className: 'ml-row' },
          h('summary', null, h('span', { className: 'ml-model' }, r.model, h('small', null, r.kind === 'call' ? `${r.provider} · 模型调用${r.inputKind === 'tool-results' ? ' · 工具结果续接' : ''}` : r.kind === 'specialist' ? '专业任务验收' : '工程交付验收')),
            h('span', { className: ['failed', 'blocked', 'incomplete', 'interrupted'].includes(r.status) ? 'ml-error' : '' }, labels[r.status] ?? r.status),
            h('span', null, duration(r.durationMs ?? (r.status === 'running' ? Date.now() - r.startedAt : null))),
            h('time', null, r.startedAt ? new Date(r.startedAt).toLocaleString() : '时间未知')),
          h('div', { className: 'ml-detail' }, h('p', null, `输出验收：${labels[r.verdict] ?? '未验证'}${r.verdict === 'passed' ? '（按现有验收条件，不保证全部语义正确）' : ''}`),
            h('p', null, `记录 ID：${r.id}`), h('p', null, `会话：${r.sessionId} · 总会话：${r.rootSessionId}`),
            r.kind === 'call' && r.inputKind === 'tool-results' && h('p', { className: 'ml-input' },
              `本轮输入：上一轮工具 ${r.inputTools?.length ? r.inputTools.join(', ') : '调用'} 的返回结果与既有上下文 · 续接记录：${r.continuedFrom}`),
            r.kind === 'call' && r.usage?.inputTokens != null && h('p', { className: 'ml-input' },
              `输入用量：${r.usage.inputTokens} token${r.usage.cacheReadTokens != null ? ` · 缓存读取：${r.usage.cacheReadTokens} token` : ''}`),
            r.finishReason && h('p', null, `停止原因：${r.finishReason}`),
            r.error && h('pre', { className: 'ml-error' }, `${r.errorCode ?? ''} ${r.error}`),
            h('h4', null, r.kind === 'call' ? '本轮结果' : '验收证据'),
            h('pre', null, resultText(r)),
            r.truncated && h('p', null, '输出超过 16,000 字符，日志仅保留开头。完整内容请查看原会话。'),
            r.tools?.length > 0 && h('p', null, `调用工具：${r.tools.join(', ')}`),
            r.usage && h('pre', null, JSON.stringify(r.usage, null, 2)))))),
        rows.length > 300 && h('p', null, '当前显示前 300 条，请使用筛选缩小范围。'),
        h('footer', null, '本地保存最近 10,000 次调用；查询最近 2,000 次调用及各 200 条专业/交付记录。'));
  }
  const css = `.ml-content{padding:24px;box-sizing:border-box;height:100%;overflow:auto;color:var(--dsw-alias-label-primary,#20242c)}.ml-content header{display:flex;justify-content:space-between;align-items:center}.ml-content h2{margin:0;font-size:23px}.ml-content p{line-height:1.6}.ml-content header p,.ml-note,.ml-content footer{font-size:12px;opacity:.7}.ml-filters{display:flex;flex-wrap:wrap;gap:8px;margin:18px 0}.ml-content input,.ml-content select,.ml-content button{font:inherit;color:inherit;background:transparent;border:1px solid #8885;border-radius:7px;padding:8px}.ml-content input{flex:1;min-width:220px}.ml-content select{max-width:280px}.ml-summary{font-size:12px;margin:12px 0}.ml-row{border:1px solid #8883;border-radius:9px;margin:8px 0}.ml-row summary{display:grid;grid-template-columns:minmax(200px,1fr) 95px 100px 175px;align-items:center;gap:12px;padding:14px;cursor:pointer;font-size:13px}.ml-model{font-weight:600;overflow-wrap:anywhere}.ml-model small{display:block;margin-top:5px;font-weight:400;opacity:.65}.ml-detail{padding:0 16px 16px;font-size:12px}.ml-detail pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:360px;overflow:auto;background:#8881;padding:12px;border-radius:6px}.ml-detail p{overflow-wrap:anywhere}.ml-input{border-left:3px solid #4c8bf5;padding-left:9px}.ml-error{color:#d35449}.ml-empty{padding:40px;text-align:center}.ml-content footer{margin-top:20px}@media(max-width:750px){.ml-row summary{grid-template-columns:1fr 80px}.ml-content{padding:16px}}`;
  return { inject: ['remote', 'slots', 'sessions'], async apply(ctx) {
    const schema = { parse(value) { if (typeof value !== 'string') throw new TypeError('Expected JSON string'); return value; }, '~standard': { version: 1, vendor: 'dsh-model-logs', validate: value => typeof value === 'string' ? { value } : { issues: [{ message: 'Expected JSON string' }] } } };
    const descriptor = { id: 'dsh-model-logs#modelLogs/list', service: 'modelLogs', namespace: 'modelLogs', method: 'list', invocation: { kind: 'direct' }, parameters: [{ name: 'sessionId', wire: 'sessionId', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-model-logs#SessionId', schema: { parse(value) { if (typeof value !== 'string' || !value.length || value.length > 512) throw new TypeError('Invalid sessionId'); return value; } } } }], result: { mode: 'strict', typeSymbol: 'dsh-model-logs#LogSnapshot', schema, create: () => schema } };
    const dispose = await ctx.remote.$mount({ package: 'dsh-model-logs', descriptors: [descriptor] });
    ctx.effect(() => dispose);
    const api = ctx.get('remote.modelLogs');
    const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style); ctx.effect(() => () => style.remove());
    ctx.slots.inject('conversation.view', () => {
      let disposeView;
      const refresh = () => {
        const state = ctx.sessions.list.getSnapshot();
        const sessionId = state.current;
        const preset = sessionId === undefined ? undefined : state.byId[sessionId]?.projectionValues?.agentPreset;
        const visible = typeof preset === 'string' && /(?:^|[/:])pin-hao-mo$/.test(preset);
        if (visible && disposeView === undefined) {
          disposeView = ctx.slots.register({ name: 'conversation.view', id: 'model-logs', label: '模型日志', order: 30 }, props => h(Panel, { ...props, api }));
        } else if (!visible && disposeView !== undefined) {
          disposeView(); disposeView = undefined;
        }
      };
      refresh();
      const unsubscribe = ctx.sessions.list.subscribe(refresh);
      return () => { unsubscribe(); disposeView?.(); };
    });
  } };
} });

// A narrow compute policy, never a tool/permission or verification bypass.
export function isSingleHtmlCreation(text) {
  return typeof text === 'string' && text.length <= 4000
    && /(?:创建|生成|制作|绘制|create|build|generate)/iu.test(text)
    && /(?:单\s*(?:个|一|文件)?\s*html|single[ -]?(?:file[ -]?)?html|一个\s*html)/iu.test(text)
    && /(?:svg|动画|animation)/iu.test(text)
    && !/(?:多文件|多模块|后端|数据库|登录|鉴权|支付|重构|backend|database|authentication|payment)/iu.test(text);
}
export function isSingleHtmlContract(contract) {
  return contract?.editablePaths?.length === 1 && contract?.requiredOutputs?.length === 1
    && contract.editablePaths[0] === contract.requiredOutputs[0]
    && /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.html$/u.test(contract.editablePaths[0])
    && contract.checks?.length === 1 && contract.checks[0].id === 'single-html';
}
export function findReusableAnimationPlan(reports) {
  if (!Array.isArray(reports)) return null;
  return reports.find(report => report?.capability === 'animation_planning' && report.status === 'passed'
    && typeof report.artifactRef === 'string' && report.artifactRef.startsWith('report:')) ?? null;
}
export function installRequestPolicy(ctx, config) {
  const applied = new Map();
  ctx.on('agent/request', async ({ agent }, next) => {
    const proposal = await next();
    if (!agent?.session || agent.session.header.parentSession) return proposal;
    if (['minimal', 'medium', 'high', 'xhigh', 'max'].includes(agent.options?.reasoningEffort)) { applied.delete(agent.session.id); return proposal; }
    if (proposal.provider !== (config.modelProvider ?? 'doubao') || proposal.model !== (config.model ?? 'deepseek-v4-1-flash')) return proposal;
    // The HTML effort optimization is specific to DeepSeek thinking models.
    // Models without that capability must receive their unchanged proposal.
    if (!/^deepseek(?:-|$)/iu.test(proposal.model)) return proposal;
    // prepareRequest runs before the first user/message is appended. Read the
    // already accepted user inbox event as well; never classify tool/plugin text.
    const events = agent.session.snapshotEvents();
    const event = events.findLast(e => (e.type === 'user/message' && e.data.source?.kind === 'user')
      || (e.type === 'agent/inbox/spliced' && e.data.inserted?.some(m => m.source?.kind === 'user')));
    const message = event?.type === 'user/message' ? event.data : event?.data.inserted?.findLast(m => m.source?.kind === 'user');
    const text = message?.content?.filter(b => b.type === 'text').map(b => b.text).join('\n');
    const saved = applied.get(agent.session.id);
    const effort = saved && saved.turnSeq === event?.seq ? saved.original : (agent.options?.reasoningEffort ?? proposal.reasoningEffort);
    if (isSingleHtmlCreation(text) && [undefined, 'low', 'off'].includes(effort)) {
      applied.set(agent.session.id, { turnSeq: event.seq, original: effort });
      return { ...proposal, reasoningEffort: config.singleHtmlReasoningEffort ?? 'off' };
    }
    if (saved) {
      applied.delete(agent.session.id);
      return { ...proposal, reasoningEffort: agent.options?.reasoningEffort ?? saved.original ?? 'low' };
    }
    return proposal;
  });
  ctx.on('agent/disposed', ({ agent }) => applied.delete(agent.session.id));
  ctx.on('dispose', () => applied.clear());
}

export function workerFailure(result, run, route, signal, execution = []) {
  const reason = run?.localAgent?.session?.snapshotEvents?.().findLast(e => e.type === 'turn/end')?.data.reason;
  const localDeadline = !reason?.error && signal?.aborted && signal.reason?.name === 'TimeoutError';
  const diagnostic = reason?.error ?? (localDeadline ? {
    code: execution.length ? 'WORKER_TOOL_DEADLINE' : 'WORKER_NO_TOOL_DEADLINE',
    message: execution.length
      ? `Worker exceeded its local execution deadline after ${execution.length} tool call(s)`
      : 'Worker reached its total execution deadline before completing a tool call; this does not establish whether generation was active',
  } : null) ?? (result.diagnostic ? { message: result.diagnostic } : null);
  const message = String(diagnostic?.message ?? `Worker did not complete: ${result.stopReason}`).slice(0, 2000);
  const error = new Error(message);
  error.executionCount = execution.length;
  if (route) error.upstreamRoute = route;
  if (diagnostic) error.upstreamCode = diagnostic.code ?? 'UNKNOWN';
  if (localDeadline) {
    error.code = 'WORKER_EXECUTION_TIMEOUT';
    error.executionCount = execution.length;
  } else if (diagnostic?.code === 'TIMEOUT' || /stream idle timeout|request burst|RequestBurstTooFast|rate.?limit|server.?overload/iu.test(message)) {
    error.code = 'WORKER_UPSTREAM';
    error.cooldownMs = /request burst|RequestBurstTooFast|rate.?limit|server.?overload/iu.test(message) ? 300000 : 120000;
  }
  return error;
}

export function completeHtmlDraft(workspace, event) {
  if (!workspace?.draftReady || event.type !== 'tool/result') return false;
  const callId = event.data.message.source?.callId;
  if (typeof callId !== 'string' || !callId) return false;
  const write = workspace.execution.findLast(e => e.callId === callId && e.tool === 'write' && e.ok && e.args.file_path === workspace.expectedOutput);
  if (!write || event.data.message.content.some(b => b.isError)) return false;
  workspace.allowedTools = [];
  workspace.handoffPending = true;
  workspace.draftReady.resolve({ draft: true });
  return true;
}

// Full execution evidence remains in the persisted quality report, not every
// root status response (which otherwise repeats code and tool traces).
export function compactQuality(report) {
  if (!report) return null;
  const { status, model, provider, snapshot, artifactRef } = report;
  return { status, model, provider, snapshot, artifactRef,
    summary: report.summary?.slice(0, 4000),
    evidence: report.evidence?.slice(0, 20).map(value => String(value).slice(0, 1000)),
    limitations: report.limitations?.slice(0, 20).map(value => String(value).slice(0, 1000)) };
}

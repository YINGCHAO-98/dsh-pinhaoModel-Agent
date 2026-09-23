export function isSingleHtmlContract(contract) {
  return contract?.editablePaths?.length === 1 && contract?.requiredOutputs?.length === 1
    && contract.editablePaths[0] === contract.requiredOutputs[0]
    && /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.html$/u.test(contract.editablePaths[0])
    && contract.checks?.length === 1 && contract.checks[0].id === 'single-html';
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
  error.safeToRetry = execution.every(entry => ['read', 'glob', 'grep', 'snapshot_explore', 'read_image', 'skill'].includes(entry.tool));
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
  const chunks = workspace.execution.findLast(e => e.callId === callId && e.tool === 'html_chunk' && e.action === 'finish' && e.ok);
  if ((!write && !chunks) || event.data.message.content.some(b => b.isError)) return false;
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

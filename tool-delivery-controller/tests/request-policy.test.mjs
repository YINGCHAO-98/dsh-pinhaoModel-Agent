import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSingleHtmlContract, workerFailure, completeHtmlDraft } from '../request-policy.mjs';
test('single HTML is identified only by its delivery contract and does not alter the model route', () => {
  assert.ok(isSingleHtmlContract({editablePaths:['p.html'],requiredOutputs:['p.html'],checks:[{id:'single-html'}]}));
  assert.equal(isSingleHtmlContract({editablePaths:['src/'],requiredOutputs:['p.html'],checks:[{id:'single-html'}]}), false);
});
test('worker failure preserves runtime diagnostic and classifies provider cooldowns', () => {
  const fail = error => workerFailure({stopReason:'error'},{localAgent:{session:{snapshotEvents:()=>[{type:'turn/end',data:{reason:{kind:'error',error}}}]}}});
  const timeout=fail({code:'TIMEOUT',message:'pi-ai stream idle timeout after 120000ms'});
  assert.equal(timeout.code,'WORKER_UPSTREAM');assert.equal(timeout.upstreamCode,'TIMEOUT');assert.equal(timeout.cooldownMs,120000);
  const burst=fail({code:'PI_AI_ERROR',message:'System protection triggered by request burst. Request id: fixture'});
  assert.match(burst.message,/Request id: fixture/);assert.equal(burst.cooldownMs,300000);
  assert.equal(fail({code:'OTHER',message:'other failure'}).code,undefined);
  const timeoutSignal = AbortSignal.timeout(1);
  return new Promise(resolve => setTimeout(resolve, 5)).then(() => {
    const stalled = workerFailure({stopReason:'aborted'}, {localAgent:{session:{snapshotEvents:()=>[]}}}, 'route', timeoutSignal, []);
    assert.equal(stalled.code, 'WORKER_EXECUTION_TIMEOUT');
    assert.equal(stalled.upstreamCode, 'WORKER_NO_TOOL_DEADLINE');
    assert.equal(stalled.executionCount, 0);
    assert.match(stalled.message, /before completing a tool call/);
  });
});


test('draft handoff requires a successful real write receipt for the contracted file', async () => {
  const workspace={draftReady:Promise.withResolvers(),expectedOutput:'/workspace/p.html',allowedTools:['read','write'],execution:[]};
  const result=(callId,isError=false)=>({type:'tool/result',data:{message:{source:{callId},content:[{isError}]}}});
  assert.equal(completeHtmlDraft(workspace,result('fake')),false);
  workspace.execution.push({callId:'wrong-path',tool:'write',ok:true,args:{file_path:'/workspace/other.html'}});
  assert.equal(completeHtmlDraft(workspace,result('wrong-path')),false);
  workspace.execution.push({callId:'valid',tool:'write',ok:true,args:{file_path:'/workspace/p.html'}});
  assert.equal(completeHtmlDraft(workspace,result('valid',true)),false);
  assert.equal(workspace.handoffPending,undefined);
  assert.equal(completeHtmlDraft(workspace,result('valid')),true);
  assert.deepEqual(await workspace.draftReady.promise,{draft:true});
  assert.equal(workspace.handoffPending,true);assert.deepEqual(workspace.allowedTools,[]);
});

test('HTML chunks hand off only after the successful finish tool result', async () => {
  const workspace = { draftReady: Promise.withResolvers(), expectedOutput: '/workspace/p.html',
    allowedTools: ['read', 'html_chunk'], execution: [] };
  const result = (callId, isError = false) => ({ type: 'tool/result', data: {
    message: { source: { callId }, content: [{ isError }] },
  } });
  workspace.execution.push({ callId: 'first', tool: 'html_chunk', action: 'append', ok: true });
  assert.equal(completeHtmlDraft(workspace, result('first')), false);
  workspace.execution.push({ callId: 'last', tool: 'html_chunk', action: 'finish', ok: true });
  assert.equal(completeHtmlDraft(workspace, result('last', true)), false);
  assert.equal(completeHtmlDraft(workspace, result('last')), true);
  assert.deepEqual(await workspace.draftReady.promise, { draft: true });
  assert.deepEqual(workspace.allowedTools, []);
});

test('quality response excludes repeated execution payload but preserves decision and report link', async () => {
  const { compactQuality } = await import('../request-policy.mjs');
  const source = { status: 'failed', summary: 'x'.repeat(9000), evidence: ['e'.repeat(5000)], limitations: ['not rendered'], model: 'kimi', snapshot: 'abc', reportPath: '/local/report.json', execution: [{ args: 'large code' }], tokenUsage: [1] };
  const value = compactQuality(source);
  assert.equal(value.status, 'failed');
  assert.equal(value.reportPath, undefined);
  assert.equal(value.snapshot, 'abc');
  assert.equal(value.summary.length, 4000);
  assert.equal(value.evidence[0].length, 1000);
  assert.equal(value.execution, undefined);
  assert.equal(source.execution.length, 1);
});

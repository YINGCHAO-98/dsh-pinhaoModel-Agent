import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSingleHtmlCreation, isSingleHtmlContract, installRequestPolicy, workerFailure, completeHtmlDraft, findReusableAnimationPlan } from '../request-policy.mjs';
test('HTML compute routing is narrow and does not alter explicit high reasoning or other models', async () => {
  assert.ok(isSingleHtmlCreation('创建一个单html，SVG 绘制鹈鹕骑车2D动画。不使用技能，不验证。'));
  assert.equal(isSingleHtmlCreation('创建一个单html动画，包含支付与后端数据库'), false);
  assert.equal(isSingleHtmlCreation('修复大型工程'), false);
  assert.ok(isSingleHtmlContract({editablePaths:['p.html'],requiredOutputs:['p.html'],checks:[{id:'single-html'}]}));
  assert.equal(isSingleHtmlContract({editablePaths:['src/'],requiredOutputs:['p.html'],checks:[{id:'single-html'}]}), false);
  const handlers = new Map();installRequestPolicy({on:(event,fn)=>handlers.set(event,fn)},{});
  let events = [{seq:1,type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text:'创建一个单html，SVG鹈鹕动画'}]}}];
  const agent={options:{reasoningEffort:'low'},session:{id:'root',header:{},snapshotEvents:()=>events}};
  const request = config=>handlers.get('agent/request')({agent},async()=>config);
  const base={provider:'doubao',model:'deepseek-v4-1-flash',reasoningEffort:'low'};
  const initial = events;events=[];assert.equal((await request(base)).reasoningEffort,'low');
  events=[{seq:0,type:'agent/inbox/spliced',data:{inserted:[initial[0].data]}}];
  assert.equal((await request(base)).reasoningEffort,'off');
  events=initial;
  assert.equal((await request(base)).reasoningEffort,'off');
  assert.equal((await request({...base,reasoningEffort:'off'})).reasoningEffort,'off');
  events=[{seq:2,type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text:'设计一个复杂数据库系统'}]}}];
  assert.equal((await request({...base,reasoningEffort:'off'})).reasoningEffort,'low');
  events[0].data.content[0].text='创建一个单html，SVG鹈鹕动画';
  agent.options.reasoningEffort='high';
  assert.equal((await request({...base,reasoningEffort:'high'})).reasoningEffort,'high');
  agent.options.reasoningEffort='low';
  assert.equal((await request({...base,model:'kimi-k2.7-code'})).reasoningEffort,'low');
  agent.session.header.parentSession='parent';
  assert.equal((await request(base)).reasoningEffort,'low');
});
test('only an accepted animation report can suppress duplicate planning', () => {
  const accepted = { capability: 'animation_planning', status: 'passed', artifactRef: 'report:accepted' };
  assert.equal(findReusableAnimationPlan([{ ...accepted, status: 'blocked' }, accepted]), accepted);
  assert.equal(findReusableAnimationPlan([{ capability: 'quality_review', status: 'passed', artifactRef: 'report:quality' }]), null);
  assert.equal(findReusableAnimationPlan([{ capability: 'animation_planning', status: 'passed', reportPath: '/private/report.json' }]), null);
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

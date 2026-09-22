import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestsUnverifiedDelivery, deliverySummary } from '../index.mjs';

test('validation preference is independent from the skill preference', () => {
  assert.equal(requestsUnverifiedDelivery('创建动画，不进行任何验证'), true);
  assert.equal(requestsUnverifiedDelivery('不要使用任何 skill，也不要审查'), true);
  assert.equal(requestsUnverifiedDelivery('不要使用任何 skill，但是要验证结果'), false);
  assert.equal(requestsUnverifiedDelivery('不使用 skill，正常执行测试和审查'), false);
  assert.equal(requestsUnverifiedDelivery('create it without validation'), true);
  assert.equal(requestsUnverifiedDelivery('do not use skills, but run tests'), false);
});

test('terminal worker failures expose no user decision or same-turn retry action', () => {
  const result = deliverySummary({ id: 'delivery-1', state: 'failed', objective: 'create animation', reasonCode: 'WORKER_NO_TOOL_DEADLINE',
    repairCount: 0, contract: { maxRepairs: 2 }, workerCalls: 1, verifyCalls: 0, evidence: [], reportRefs: [], tasks: [] });
  assert.equal(result.retryableNow, false);
  assert.equal(result.nextAction, 'report_failure_and_wait_for_new_user_request');
});

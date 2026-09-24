import { hash } from './files.mjs';

// DSH's structured output accepts a restricted JSON Schema. Keep size and
// nonempty checks in validateProductDesign, which runs before acceptance.
const text = { type: 'string' };
const list = { type: 'array', items: text };
export const productDesignSchema = { type: 'object', additionalProperties: false, properties: {
  goal: text, users: list, scope: list, userFlows: list, implementation: list,
  acceptanceCriteria: list, risks: list, assumptions: list,
  riskLevel: { type: 'string', enum: ['low', 'medium', 'high'] },
}, required: ['goal', 'users', 'scope', 'userFlows', 'implementation', 'acceptanceCriteria', 'risks', 'assumptions', 'riskLevel'] };

// MiniMax returns one short text field per design section. The controller
// converts those fields to the canonical list form and validates every bound.
// This avoids repeatedly asking the model to serialize nested string arrays.
export const productDesignWireSchema = { type: 'object', additionalProperties: false,
  properties: Object.fromEntries(productDesignSchema.required.map(key => [key,
    key === 'riskLevel' ? productDesignSchema.properties.riskLevel : { type: 'string' }])),
  required: productDesignSchema.required };

export function normalizeProductDesignReport(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)
    || typeof report.evidence !== 'string' || typeof report.limitations !== 'string')
    throw new Error('Invalid product design report shape');
  const normalized = { ...report, evidence: report.evidence.trim() ? [report.evidence.trim()] : [],
    limitations: report.limitations.trim() ? [report.limitations.trim()] : [] };
  if (report.status !== 'passed') return normalized;
  const raw = report.designPlan;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || Object.keys(raw).some(key => !productDesignSchema.required.includes(key)))
    throw new Error('Invalid product design fields');
  const plan = {};
  for (const key of productDesignSchema.required) {
    const value = raw[key];
    if (typeof value !== 'string') throw new Error(`Invalid product design ${key}`);
    plan[key] = key === 'goal' || key === 'riskLevel' ? value : value.split(/\r?\n/u)
      .map(item => item.replace(/^\s*(?:[-*•]|\d+[.)])\s*/u, '').trim()).filter(Boolean);
  }
  normalized.designPlan = validateProductDesign(plan);
  return normalized;
}

export function validateProductDesign(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)
    || Object.keys(plan).some(key => !productDesignSchema.required.includes(key))) throw new Error('Invalid product design fields');
  for (const key of productDesignSchema.required) {
    const value = plan[key];
    if (key === 'riskLevel') {
      if (!['low', 'medium', 'high'].includes(value)) throw new Error('Invalid product design riskLevel');
    } else if (key === 'goal') {
      if (typeof value !== 'string' || !value.trim() || value.length > 4000) throw new Error('Invalid product design goal');
    } else if (!Array.isArray(value) || !value.length || value.length > 30
      || value.some(item => typeof item !== 'string' || !item.trim() || item.length > 4000))
      throw new Error(`Invalid product design ${key}`);
  }
  if (Buffer.byteLength(JSON.stringify(plan)) > 64000) throw new Error('Product design exceeds context budget');
  return plan;
}

export function designReceipt(report, run) {
  if (report?.status !== 'passed') throw new Error(`PRODUCT_DESIGN_REQUIRED: ${report?.summary ?? 'designer did not return a successful plan'}`);
  validateProductDesign(report?.designPlan);
  if (report.status !== 'passed' || report.capability !== 'product_design'
    || report.model !== run.designGate.model || report.provider !== run.designGate.provider
    || report.snapshot !== run.baseSnapshot || !/^report:[a-f0-9-]{36}$/u.test(report.artifactRef ?? ''))
    throw new Error('PRODUCT_DESIGN_REQUIRED: missing accepted design for this route and snapshot');
  const value = { artifactRef: report.artifactRef, owner: run.owner, objective: run.objective,
    snapshot: run.baseSnapshot, model: report.model, provider: report.provider, plan: report.designPlan };
  return { ...value, hash: hash(JSON.stringify(value)) };
}

export function assertDesignReceipt(run, receipt = run.productDesign) {
  if (!run.designGate) return;
  if (!receipt) throw new Error('PRODUCT_DESIGN_REQUIRED: implementation cannot start without a product design');
  const { hash: signature, ...value } = receipt;
  validateProductDesign(value.plan);
  if (hash(JSON.stringify(value)) !== signature || value.owner !== run.owner || value.objective !== run.objective
    || value.snapshot !== run.baseSnapshot || value.model !== run.designGate.model || value.provider !== run.designGate.provider)
    throw new Error('PRODUCT_DESIGN_INTEGRITY: design changed or belongs to another task');
}

export function productDesignRequest(run) {
  return { capability: 'product_design', objective: run.objective,
    reason: 'Required product design before implementation',
    singleModelGap: 'MiniMax defines product behavior and a bounded implementation plan; GLM-5.3 implements it.',
    inputRefs: run.reportRefs ?? [], expectedOutput: 'Return designPlan with goal, users, scope, userFlows, implementation, acceptanceCriteria, risks, assumptions as plain text strings; use newline-separated points within each section, not arrays or nested objects. riskLevel is low, medium or high. Return evidence and limitations as plain text strings. Scale detail to the task; small fixes need only a concise plan. Preserve user constraints. Identify high-risk security, data-loss and compatibility changes.',
    acceptanceCriteria: ['Cover the original goal and constraints', 'Define observable behavior and acceptance criteria', 'Explain risk level and assumptions', 'Do not modify files or invent executable checks'] };
}

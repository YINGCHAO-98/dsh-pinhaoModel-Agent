import { realpath, mkdir, rename, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { capture, validateContract, assertRequired, applyProposal, materialize, digest, isWithin } from './files.mjs';

export class DeliveryController {
  constructor({ store, worker, runner, workerTimeoutMs = 180000 }) {
    this.store = store;
    this.worker = worker;
    this.runner = runner;
    this.workerTimeoutMs = workerTimeoutMs;
  }
  async create({ owner, workspace, objective, contract }) {
    if (typeof objective !== 'string' || !objective.trim() || objective.length > 16000) throw new Error('Invalid objective');
    workspace = await realpath(workspace);
    const stateRoot = await realpath(this.store.root);
    if (isWithin(stateRoot, workspace) || isWithin(workspace, stateRoot)) throw new Error('State directory must be outside the delivery workspace');
    contract = validateContract(contract);
    const unlock = this.store.lock(workspace);
    try {
      const files = await capture(workspace);
      assertRequired(files, contract);
      return this.store.create({ owner, workspace, objective, contract, files });
    } finally { unlock(); }
  }
  async status(id, owner) {
    const run = this.store.get(id, owner);
    if (run.state === 'passed') {
      const unlock = this.store.lock(run.workspace);
      try {
        let valid = false;
        try { valid = digest(await capture(run.artifact, undefined, { includeExcluded: true })) === run.snapshot; } catch {}
        if (!valid) this.store.move(run, 'invalidated', { reason: 'Verified artifact changed or is missing' });
      } finally { unlock(); }
    }
    return run;
  }
  async drive(id, owner, { signal = new AbortController().signal, parent } = {}) {
    const run = this.store.get(id, owner);
    const unlock = this.store.lock(run.workspace);
    let stage = run.state;
    try {
      if (['passed', 'failed', 'cancelled', 'invalidated'].includes(run.state)) return run;
      if (run.state === 'blocked') this.store.move(run, run.resumeState, { reason: null }, 'resumed');
      if (['implementing', 'repairing', 'verifying'].includes(run.state)) {
        const resumeState = { implementing: 'implement', repairing: 'repair', verifying: 'verify' }[run.state];
        this.store.move(run, 'blocked', { resumeState, reason: 'Interrupted execution recovered' }, 'interrupted');
        this.store.move(run, resumeState, { reason: null }, 'resumed');
      }
      stage = run.state;
      signal.throwIfAborted();
      await this.runner.preflight(signal); // No unsandboxed fallback, and no model spend before environment readiness.
      while (true) {
        signal.throwIfAborted();
        stage = run.state;
        if (run.state === 'implement' || run.state === 'repair') {
          if (run.workerCalls >= run.contract.maxRepairs + 3) throw new Error('Worker dispatch budget exhausted');
          const isRepair = run.state === 'repair';
          this.store.move(run, isRepair ? 'repairing' : 'implementing', { workerCalls: run.workerCalls + 1 });
          const files = this.store.files(run.snapshot);
          const timeout = AbortSignal.timeout(this.workerTimeoutMs);
          const workerSignal = AbortSignal.any([signal, timeout]);
          // The adapter must honor cancellation and dispose the child before settling.
          const proposal = await this.worker({ parent, signal: workerSignal, objective: run.objective,
            phase: isRepair ? 'repair' : 'implement', files,
            contract: run.contract, evidence: run.evidence, repairCount: run.repairCount });
          workerSignal.throwIfAborted();
          const next = applyProposal(files, proposal, run.contract);
          const snapshot = this.store.snapshot(next);
          this.store.move(run, 'verify', { snapshot, workerSummary: proposal.summary });
        } else if (run.state === 'verify') {
          if (run.verifyCalls >= 6) throw new Error('Verification dispatch budget exhausted');
          this.store.move(run, 'verifying', { verifyCalls: run.verifyCalls + 1 });
          const files = this.store.files(run.snapshot);
          const evidence = [];
          for (const check of run.contract.checks) {
            signal.throwIfAborted();
            const result = await this.runner.check({ files, snapshot: run.snapshot, check, signal });
            if (result.id !== check.id || result.snapshot !== run.snapshot) throw new Error('Verifier returned stale/mismatched evidence');
            this.store.event(run.id, 'check.finished', result);
            evidence.push(result);
          }
          signal.throwIfAborted();
          if (evidence.some(e => e.kind === 'blocked' || e.kind === 'cancelled')) {
            this.store.move(run, 'blocked', { evidence, resumeState: 'verify', reason: 'Verification environment unavailable, timed out or interrupted' });
            return run;
          }
          if (evidence.every(e => e.kind === 'passed' && e.exitCode === 0)) {
            const artifact = await this.publishSnapshot(run, files);
            signal.throwIfAborted();
            this.store.move(run, 'passed', { evidence, artifact });
            return run;
          }
          if (run.repairCount >= run.contract.maxRepairs) {
            this.store.move(run, 'failed', { evidence, reason: 'Repair budget exhausted' });
            return run;
          }
          this.store.move(run, 'repair', { evidence, repairCount: run.repairCount + 1 });
        } else throw new Error(`Unexpected active state: ${run.state}`);
      }
    } catch (error) {
      if (signal.aborted) this.store.move(run, 'cancelled', { reason: 'Cancelled by caller' });
      else this.store.move(run, 'blocked', { reason: String(error.message ?? error), resumeState: stage });
      return run;
    } finally { unlock(); }
  }
  async publishSnapshot(run, files) {
    const parent = resolve(this.store.root, 'artifacts', run.id);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const staging = resolve(parent, randomUUID());
    const target = resolve(parent, run.snapshot);
    await materialize(files, staging);
    // If a crash left an older export, reconstruct it from immutable DB data.
    await rm(target, { recursive: true, force: true });
    await rename(staging, target);
    return target;
  }
  cancel(id, owner) {
    const run = this.store.get(id, owner);
    const unlock = this.store.lock(run.workspace);
    try {
      if (['passed', 'failed', 'cancelled', 'invalidated'].includes(run.state)) throw new Error('Delivery already terminal');
      return this.store.move(run, 'cancelled', { reason: 'Cancelled by user command' });
    } finally { unlock(); }
  }
}

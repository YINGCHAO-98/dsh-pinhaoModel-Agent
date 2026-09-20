import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';
import { DeliveryController } from './controller.mjs';
import { SandboxRunner } from './runner.mjs';

const state = await mkdtemp(resolve(tmpdir(), 'pinhaomo-demo-'));
const store = new Store(state);
const controller = new DeliveryController({ store, runner: new SandboxRunner(),
  // Deterministic proposal fixture, NOT a real model call. Tests and sandbox are real.
  worker: async ({ phase }) => ({ summary: `Fixture ${phase}`, changes: phase === 'implement' ? [] : [
    { path: 'src/sum.cjs', operation: 'write', content: 'module.exports = (a, b) => a + b;\n' },
  ] }),
});
try {
  const run = await controller.create({ owner: 'demo', objective: '修复加法函数',
    workspace: fileURLToPath(new URL('./examples/tiny-app/', import.meta.url)),
    contract: JSON.parse(await readFile(new URL('../delivery-contract.json', import.meta.url), 'utf8')) });
  const result = await controller.drive(run.id, 'demo');
  console.log(JSON.stringify({ stateDirectory: state, result, events: store.history(run.id) }, null, 2));
  if (result.state !== 'passed' || result.repairCount !== 1) process.exitCode = 1;
} finally { store.close(); }

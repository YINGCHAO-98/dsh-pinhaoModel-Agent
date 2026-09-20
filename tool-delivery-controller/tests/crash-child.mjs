import { Store } from '../store.mjs';
import { DeliveryController } from '../controller.mjs';
const store = new Store(process.argv[2]);
const controller = new DeliveryController({ store,
  worker: async ({ phase }) => {
    if (phase === 'repair') process.exit(23);
    return { summary: 'done', changes: [] };
  },
  runner: { preflight: async () => {}, check: async ({ snapshot, check }) => ({ id: check.id, snapshot, kind: 'failed', exitCode: 1 }) },
});
await controller.drive(process.argv[3], 'session');
process.exit(99);

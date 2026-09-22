const terminal = new Set(['passed', 'failed', 'cancelled', 'invalidated']);

export function registerSessionDisposal(ctx, listener) {
  // Session events are dispatched through each session's carrier scope. A
  // preset-level listener must be global or it silently misses UI deletion.
  return ctx.on('session/disposed', listener, { global: true });
}

// One owner-scoped cleanup path is shared by UI cancellation and session
// disposal. Abort live executions first, wait for their finally blocks to
// release locks/workspaces, then cancel any persisted orphaned roots.
export async function cleanupOwnerState({ owner, reason, active, startingWorkspaces, controller, store, specialists, workspaces }) {
  workspaces.resetRootState(owner);
  specialists.control.cancelOwner(owner, reason);
  for (const [workspace, startingOwner] of startingWorkspaces) if (startingOwner === owner) startingWorkspaces.delete(workspace);
  const running = [...active.values()].filter(entry => entry.owner === owner);
  for (const entry of running) entry.abort.abort(new Error(reason));
  await Promise.allSettled(running.map(entry => entry.promise));
  for (const run of store.list(owner)) {
    if (run.parentId || terminal.has(run.state)) continue;
    controller.cancel(run.id, owner, reason);
  }
}

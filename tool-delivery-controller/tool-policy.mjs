import { workerTools, rootFileTools } from './workspace.mjs';

// One policy drives both model-visible schemas and the execution guard.
// Do not put a deny mask on an ancestor scope: children inherit that mask too.
export function toolPolicy(workspaces, routes) {
  const rootTools = new Set(['delivery_context', 'delivery_review', 'delivery_start', 'delivery_resume', 'delivery_cancel', 'delivery_status', 'capability_status',
    'todo_write', 'ask_user_question', 'multimodel_run', ...routes]);
  const executionTools = new Set([...workerTools, 'read_image', 'snapshot_explore', 'html_chunk']);
  return exec => {
    const agent = exec.agent;
    const child = Boolean(agent?.session.header.parentSession);
    if (!child && rootFileTools.includes(exec.name)) {
      if (['write', 'edit'].includes(exec.name))
        return 'ROOT_IMPLEMENTATION_NOT_ALLOWED: all file implementation belongs to the configured Kimi Worker; use delivery_start';
      return;
    }
    if (executionTools.has(exec.name)) {
      try {
        const workspace = workspaces.find(exec);
        if (workspace.allowedTools && !workspace.allowedTools.includes(exec.name))
          return `WORKER_TOOL_NOT_ALLOWED: ${exec.name} is not enabled for this role`;
        return;
      } catch (error) { return error.message; }
    }
    if (exec.name === 'request_capability') {
      if (!child) return;
      try {
        const workspace = workspaces.find(exec);
        if (!workspace.readOnly && workspace.deliveryId && workspace.rootAgent) return;
      } catch (error) { return error.message; }
      return 'CAPABILITY_REQUEST_NOT_ALLOWED: only implementation workers can request capabilities';
    }
    if (exec.name === 'structured_output') return child ? undefined : 'ROOT_TOOL_NOT_ALLOWED: structured_output belongs to child runtime';
    if (exec.name === 'skill') {
      try { workspaces.assertSkillAllowed(child ? agent.session.header.parentSession : agent.session.id); }
      catch (error) { return error.message; }
      return;
    }
    if (rootTools.has(exec.name)) {
      if (!child && exec.name === 'delivery_start') {
        try { workspaces.assertRootDeliveryStartAllowed(agent.session.id); }
        catch (error) { return error.message; }
      }
      return child ? 'CHILD_ORCHESTRATION_DENIED: only the root agent may orchestrate tasks' : undefined;
    }
    return `DELIVERY_TOOL_NOT_ALLOWED: ${exec.name}`;
  };
}

export function installToolPolicy(ctx, workspaces, routes) {
  const policy = toolPolicy(workspaces, routes);
  ctx.tools.guard(policy);
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next();
    if (context.scope?.session?.header.parentSession) await workspaces.waitForBinding(context.scope);
    return { ...assembly, tools: assembly.tools.filter(tool => policy({ agent: context.scope, name: tool.name }) === undefined) };
  });
}

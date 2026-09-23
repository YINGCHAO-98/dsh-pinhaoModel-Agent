const allowedKeys = new Set(['provider', 'model', 'reasoningEffort', 'maxTokens']);

export function configuredAgentOptions(value, defaults = {}) {
  const options = {
    provider: value.provider ?? defaults.provider,
    model: value.model ?? defaults.model,
    ...(value.reasoningEffort === undefined ? {} : { reasoningEffort: value.reasoningEffort }),
    ...(value.maxTokens === undefined ? {} : { maxTokens: value.maxTokens }),
  };
  if (typeof options.provider !== 'string' || !options.provider || typeof options.model !== 'string' || !options.model)
    throw new Error('Model route requires non-empty provider and model');
  if (options.reasoningEffort !== undefined && (typeof options.reasoningEffort !== 'string' || !options.reasoningEffort))
    throw new Error('Model reasoningEffort must be a non-empty string');
  if (options.maxTokens !== undefined && (!Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1))
    throw new Error('Model maxTokens must be a positive safe integer');
  return options;
}

export function configuredWorkerAgentOptions(config) {
  if (config.singleHtmlWorker || config.workerFallback || config.singleHtmlReasoningEffort)
    throw new Error('Legacy implementation routes are forbidden; use recoveryWorker for a bounded no-progress fallback');
  const options = configuredAgentOptions({
    provider: config.modelProvider ?? 'doubao',
    model: config.model ?? 'kimi-k2-8-preview',
    ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
    ...(config.maxTokens === undefined ? {} : { maxTokens: config.maxTokens }),
  });
  if (options.model !== 'kimi-k2-8-preview')
    throw new Error('Implementation model must be Kimi K2.8 Preview (kimi-k2-8-preview)');
  return options;
}

export function configuredRecoveryWorkerAgentOptions(config) {
  if (config.recoveryWorker === undefined) return null;
  if (!config.recoveryWorker || typeof config.recoveryWorker !== 'object'
    || Array.isArray(config.recoveryWorker)
    || Object.keys(config.recoveryWorker).some(key => !allowedKeys.has(key)))
    throw new Error('Invalid recoveryWorker route');
  const options = configuredAgentOptions(config.recoveryWorker);
  if (config.enforceRoleModels && options.model !== 'deepseek-v4-1-flash')
    throw new Error('Recovery worker must use DeepSeek V4.1 Flash');
  return options;
}

export async function resolveAgentOptions(llm, options, signal) {
  if (typeof llm?.resolveCallConfig !== 'function')
    throw new Error('DSH llm.resolveCallConfig() is required for hard model-parameter validation');
  options = configuredAgentOptions(options);
  const resolved = await llm.resolveCallConfig(options, signal);
  if (!resolved || Object.keys(resolved).some(key => !allowedKeys.has(key))
    || resolved.provider !== options.provider || resolved.model !== options.model)
    throw new Error('LLM model validation returned an invalid or changed route');
  return configuredAgentOptions(resolved);
}

export async function validateConfiguredModels(llm, config, signal) {
  const routes = [configuredWorkerAgentOptions(config),
    ...(configuredRecoveryWorkerAgentOptions(config) ? [configuredRecoveryWorkerAgentOptions(config)] : []),
    ...(config.orchestrator ? [configuredAgentOptions(config.orchestrator)] : []),
    ...(config.specialists ?? []).map(route => configuredAgentOptions(route))];
  const unique = [...new Map(routes.map(route => [JSON.stringify(route), route])).values()];
  await Promise.all(unique.map(route => resolveAgentOptions(llm, route, signal)));
}

export function validateRoleRoutes(config) {
  configuredRecoveryWorkerAgentOptions(config);
  if (!config.enforceRoleModels) return;
  const roles = { task_minimax_design: 'minimax-m3', task_kimi_quality: 'kimi-k2.7-code',
    task_glm_vision: 'glm-5-3-flash', task_doubao_media: 'doubao-seed-2-0-lite-260215' };
  if (config.orchestrator?.model !== 'deepseek-v4-1-flash' || config.designTool !== 'task_minimax_design'
    || config.qualityTool !== 'task_kimi_quality') throw new Error('Invalid orchestrator/design/review role assignment');
  for (const route of config.specialists ?? []) {
    if (roles[route.toolName] !== route.model || route.readOnly !== true
      || route.tools?.some(tool => ['write', 'edit'].includes(tool))
      || (route.toolName !== 'task_kimi_quality' && route.tools?.includes('bash')))
      throw new Error('Invalid specialist model or mutation permission: ' + route.toolName);
  }
  for (const name of Object.keys(roles)) if (!config.specialists?.some(route => route.toolName === name))
    throw new Error('Missing required role: ' + name);
}

export function installOrchestratorRoute(ctx, config) {
  if (!config.orchestrator) return;
  const options = configuredAgentOptions(config.orchestrator);
  ctx.on('agent/request', async ({ agent }, next) => {
    const proposal = await next();
    if (!agent?.session || agent.session.header.parentSession) return proposal;
    const { reasoningEffort: _effort, maxTokens: _tokens, ...base } = proposal;
    return { ...base, ...options };
  });
}

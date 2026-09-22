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

export function configuredWorkerAgentOptions(config, singleHtml = false) {
  const reasoningEffort = singleHtml ? config.singleHtmlReasoningEffort : config.reasoningEffort;
  return configuredAgentOptions({
    provider: config.modelProvider ?? 'doubao',
    model: config.model ?? 'deepseek-v4-1-flash',
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(config.maxTokens === undefined ? {} : { maxTokens: config.maxTokens }),
  });
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
  const routes = [configuredWorkerAgentOptions(config), configuredWorkerAgentOptions(config, true),
    ...(config.specialists ?? []).map(route => configuredAgentOptions(route))];
  const unique = [...new Map(routes.map(route => [JSON.stringify(route), route])).values()];
  await Promise.all(unique.map(route => resolveAgentOptions(llm, route, signal)));
}

import {
  LIVE_OPENROUTER_DEEPSEEK_BACKEND_KEYS,
  loadModelPolicyConfig,
  resolveFamilyModelPolicy,
  resolveModelByKey,
  resolveOpenRouterDeepSeekBackendKey,
  getAvailableModels,
  type ResolvedModelPolicy,
} from '../modelPolicy.js';
import { getProviderSpec, providerSupportsOperation } from '../runners/providerRegistry.js';

/** Exact existing Go routes allowed for explicit Chat selection; native budget gates still apply. */
export function isChatOpenCodeGoRoute(
  policy: Pick<ResolvedModelPolicy, 'provider' | 'providerModelId'> | undefined,
): boolean {
  return policy?.provider === 'opencode-go' &&
    (policy.providerModelId === 'deepseek-v4-flash' || policy.providerModelId === 'deepseek-v4.1-flash') &&
    getProviderSpec('opencode-go').authorityConformance === 'certified' &&
    providerSupportsOperation('opencode-go', 'native_tool_stream');
}

/** Inputs used to resolve ChatEngine's provider-backed model policy. */
export interface ChatModelPolicyOptions {
  model?: string;
  modelTier?: string;
  allowExpensive?: boolean;
  babelRoot?: string;
}

/** Return whether ChatEngine should use offline provider compatibility behavior. */
export function isOfflineChatMode(): boolean {
  return (
    process.env['BABEL_OFFLINE'] === '1' ||
    process.env['BABEL_OFFLINE'] === 'true' ||
    process.env['BABEL_DESKTOP_PROVIDER'] === 'ollama' ||
    process.argv.includes('--offline')
  );
}

/** Resolve ChatEngine's model policy while applying live-only routing rules.
 *  Explicit OpenRouter/GLM and OpenCode requests are resolved as their named
 *  provider routes; the default live DeepSeek lane uses OpenRouter. */
export function resolveChatModelPolicy(options: ChatModelPolicyOptions): {
  policy: ResolvedModelPolicy;
  offline: boolean;
} {
  const offline = isOfflineChatMode();
  const policyRootOptions = options.babelRoot ? { babelRoot: options.babelRoot } : {};
  const configuredModels = loadModelPolicyConfig(options.babelRoot).config.models ?? {};
  const desktopProvider = process.env['BABEL_DESKTOP_PROVIDER'];
  const desktopModel = process.env['BABEL_DESKTOP_MODEL_ROUTE'];
  const explicitModel = options.model ?? desktopModel;

  const selectedModel = !offline
    ? (desktopProvider === 'deepseek'
        ? (explicitModel ?? 'deepseek-v4-pro')
        : desktopProvider === 'deepinfra'
          ? (explicitModel ?? 'deepseek-v4-flash')
          : (resolveOpenRouterDeepSeekBackendKey(explicitModel ?? '') ??
             (explicitModel === undefined ? LIVE_OPENROUTER_DEEPSEEK_BACKEND_KEYS[0] : explicitModel)))
    : (explicitModel ?? (desktopProvider === 'ollama' ? 'deepseek-v4-flash' : undefined));

  const requestedBackendKey = selectedModel === undefined
    ? undefined
    : configuredModels[selectedModel]
      ? selectedModel
      : Object.entries(configuredModels).find(
          ([, entry]) => entry.model_id === selectedModel,
        )?.[0];
  const requestedBackendEntry = requestedBackendKey
    ? configuredModels[requestedBackendKey]
    : undefined;
  const assertSelectedProvider = (provider: string): void => {
    if (desktopProvider && provider !== desktopProvider) {
      throw new Error('The requested model does not belong to the selected provider. Choose its provider in Desktop Settings before running this profile.');
    }
  };
  if (requestedBackendEntry) assertSelectedProvider(requestedBackendEntry.provider);
  const requestedModelIsBackendKey = Boolean(requestedBackendEntry);
  // Explicit opencode requests skip the DeepSeek-only live assertion: naming
  // the backend key IS the opt-in (operator supplies OPENCODE_API_KEY).
  const explicitOpenCodeRequest = requestedBackendEntry?.provider === 'opencode';
  const explicitCommandCodeRequest = requestedBackendEntry?.provider === 'command-code' &&
    requestedBackendKey === 'command-code/deepseek-v4.1-flash' &&
    requestedBackendEntry.model_id === 'deepseek/deepseek-v4.1-flash' &&
    getProviderSpec('command-code').authorityConformance === 'certified' &&
    providerSupportsOperation('command-code', 'native_tool_stream');
  const explicitGoRequest = requestedBackendEntry !== undefined && isChatOpenCodeGoRoute({
    provider: requestedBackendEntry.provider,
    providerModelId: requestedBackendEntry.model_id,
  });
  // Desktop Settings pins provider + route key in policy. Catalog discovery stays
  // unverified; that admission is separate from the live DeepSeek/OpenRouter gate.
  const explicitDesktopRoute =
    Boolean(desktopProvider && desktopModel && requestedBackendKey) &&
    requestedBackendKey === desktopModel &&
    requestedBackendEntry?.provider === desktopProvider;
  const policy = requestedModelIsBackendKey
    ? resolveModelByKey({
        key: requestedBackendKey!,
        bindStagesToSelectedModel: true,
        ...(explicitOpenCodeRequest ||
        explicitCommandCodeRequest ||
        explicitGoRequest ||
        desktopProvider === 'deepseek' ||
        desktopProvider === 'deepinfra' ||
        explicitDesktopRoute
          ? {}
          : { liveOnly: !offline }),
        ...policyRootOptions,
      })
    : resolveFamilyModelPolicy({
      family: offline ? 'Ollama' : (selectedModel ?? 'DeepSeek'),
        ...(options.modelTier !== undefined ? { requestedTier: options.modelTier } : {}),
        ...(options.allowExpensive === true ? { allowExpensive: true } : {}),
        liveOnly: !offline && desktopProvider !== 'deepseek',
        ...policyRootOptions,
      });

  assertSelectedProvider(policy.provider);

  if (explicitGoRequest || explicitCommandCodeRequest) {
    const backend = policy.waterfall[0]!;
    policy.stagePolicies = policy.stagePolicies.map(stage => ({
      ...stage,
      primaryBackendKey: backend.backendKey,
      primaryProvider: backend.provider,
      primaryProviderModelId: backend.providerModelId,
      orderedBackends: [backend],
      selectionReason: `Explicit ${policy.provider} Chat route stays on the requested model.`,
    }));
  }
  return { policy, offline };
}

/** Resolve the cheapest enabled compatibility fallback model from policy. */
export function resolveFallbackModelId(): string {
  try {
    const available = getAvailableModels();
    const enabled = available.filter((model) => model.entry.enabled !== false);
    if (enabled.length > 0) {
      enabled.sort(
        (a, b) =>
          (a.entry.estimated_cost_per_1m_output ?? Infinity) -
          (b.entry.estimated_cost_per_1m_output ?? Infinity),
      );
      return enabled[0]!.entry.model_id;
    }
  } catch {
    // Policy unavailable: use the direct DeepSeek live default.
  }
  return isOfflineChatMode()
    ? 'deepseek-v4-flash'
    : 'deepseek/deepseek-v4-flash-0731';
}

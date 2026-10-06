import {
  LIVE_OPENROUTER_DEEPSEEK_BACKEND_KEYS,
  loadModelPolicyConfig,
  resolveFamilyModelPolicy,
  resolveModelByKey,
  resolveOpenRouterDeepSeekBackendKey,
  getAvailableModels,
  type ResolvedModelPolicy,
} from '../modelPolicy.js';
import { isProviderId } from '../runners/providerRegistry.js';
import {
  evaluateRouteAdmission,
  type ConfiguredRoute,
} from '../intelligence/route-selection.js';

/**
 * Explicit operator opt-in for naming a dormant/uncertified provider's backend
 * key directly in chat (the deliberate `opencode`/`ox-alpha-free` contract).
 * Naming the backend key IS the authorization, but it is encoded as data here
 * rather than silently skipping the shared admission gate. Providers absent
 * from this set keep the shared typed denial (`provider_uncertified`,
 * `provider_not_production`, `route_disabled`, ...).
 */
const EXPLICIT_BACKEND_KEY_OPT_IN_PROVIDERS: ReadonlySet<string> = new Set(['opencode']);

/**
 * Apply the shared route-admission gate to a chat backend key. This mirrors
 * {@link evaluateRouteAdmission} used by `ModelRouter` so chat and router agree
 * on the typed denial for dormant/benchmark/disabled routes, with one explicit,
 * data-encoded opt-in carve-out.
 */
function assertChatBackendAdmitted(entry: {
  backendKey: string;
  provider: string;
  providerModelId: string;
  enabled: boolean;
  explicitlyRequestedBackendKey: boolean;
}): void {
  if (!isProviderId(entry.provider)) {
    throw new Error(
      `[ModelRouter] provider_unknown: Model policy backend "${entry.backendKey}" declares unregistered provider "${entry.provider}".`,
    );
  }
  const route: ConfiguredRoute = {
    routeId: entry.backendKey,
    ref: { provider: entry.provider, modelId: entry.providerModelId },
    enabled: entry.enabled,
  };
  const decision = evaluateRouteAdmission(
    { mode: 'production_resilient', requested: entry.backendKey, routes: [route] },
    route,
  );
  if (decision.admitted) return;
  const explicitOptIn =
    decision.code === 'provider_uncertified' &&
    entry.explicitlyRequestedBackendKey &&
    EXPLICIT_BACKEND_KEY_OPT_IN_PROVIDERS.has(entry.provider);
  if (explicitOptIn) return;
  throw new Error(`[ModelRouter] ${decision.code}: ${decision.reason}`);
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
    process.argv.includes('--offline')
  );
}

/**
 * Match an explicit `provider:model_id` selector against configured routes by
 * exact provider and exact-case provider model ID. Returns every matching
 * backend key so an ambiguous declaration is surfaced rather than first-matched.
 */
function resolveProviderQualifiedBackendKeys(
  selector: string | undefined,
  models: Record<string, { provider: string; model_id: string }>,
): string[] {
  if (!selector) return [];
  const separator = selector.indexOf(':');
  if (separator <= 0) return [];
  const provider = selector.slice(0, separator);
  const modelId = separator === selector.length - 1 ? '' : selector.slice(separator + 1);
  if (!isProviderId(provider) || modelId.length === 0) return [];
  return Object.entries(models)
    .filter(([, entry]) => entry.provider === provider && entry.model_id === modelId)
    .map(([key]) => key);
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
  const selectedModel = !offline
    ? resolveOpenRouterDeepSeekBackendKey(options.model ?? '') ??
      (options.model === undefined ? LIVE_OPENROUTER_DEEPSEEK_BACKEND_KEYS[0] : options.model)
    : options.model;
  // An explicit provider-qualified selector (`provider:model_id`) is matched
  // against the exact provider and exact-case provider model ID; it never
  // case-folds an API ID or guesses across providers.
  const qualifiedBackendKeys = resolveProviderQualifiedBackendKeys(options.model, configuredModels);
  if (qualifiedBackendKeys.length > 1) {
    throw new Error(
      `[ModelRouter] Provider-qualified selector "${options.model}" matches ${qualifiedBackendKeys.length} configured routes; ` +
        'configure a single backend key or request the backend key directly.',
    );
  }
  const requestedBackendKey = qualifiedBackendKeys[0] ?? (selectedModel === undefined
    ? undefined
    : configuredModels[selectedModel]
      ? selectedModel
      : Object.entries(configuredModels).find(
          ([, entry]) => entry.model_id === selectedModel,
        )?.[0]);
  const requestedBackendEntry = requestedBackendKey
    ? configuredModels[requestedBackendKey]
    : undefined;
  const requestedModelIsBackendKey = Boolean(requestedBackendEntry);
  // Explicit opencode requests skip the DeepSeek-only live assertion: naming
  // the backend key IS the opt-in (operator supplies OPENCODE_API_KEY).
  const explicitOpenCodeRequest = requestedBackendEntry?.provider === 'opencode';
  // Route the explicitly requested backend key through the shared admission
  // gate before provider resolution, so a dormant/uncertified/benchmark-only
  // request yields the same typed denial as ModelRouter. The opencode opt-in
  // is the only explicit carve-out and remains data-driven.
  if (requestedModelIsBackendKey && requestedBackendEntry) {
    assertChatBackendAdmitted({
      backendKey: requestedBackendKey!,
      provider: requestedBackendEntry.provider,
      providerModelId: requestedBackendEntry.model_id,
      enabled: requestedBackendEntry.enabled !== false,
      explicitlyRequestedBackendKey: true,
    });
  }
  const policy = requestedModelIsBackendKey
    ? resolveModelByKey({
        key: requestedBackendKey!,
        ...(explicitOpenCodeRequest ? {} : { liveOnly: !offline }),
        ...policyRootOptions,
      })
    : resolveFamilyModelPolicy({
      family: offline ? 'Ollama' : (selectedModel ?? 'DeepSeek'),
        ...(options.modelTier !== undefined ? { requestedTier: options.modelTier } : {}),
        ...(options.allowExpensive === true ? { allowExpensive: true } : {}),
        liveOnly: !offline,
        ...policyRootOptions,
      });
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

import {
  loadModelPolicyConfig,
  resolveFamilyModelPolicy,
  resolveModelByKey,
  getAvailableModels,
  type ResolvedModelPolicy,
} from '../modelPolicy.js';

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

/** Resolve ChatEngine's model policy while applying live-only routing rules.
 *  Explicit backend-key requests for the opencode provider are honored as a
 *  direct operator opt-in to OpenCode Zen; every other live selection still
 *  goes through the DeepSeek-only lane. */
export function resolveChatModelPolicy(options: ChatModelPolicyOptions): {
  policy: ResolvedModelPolicy;
  offline: boolean;
} {
  const offline = isOfflineChatMode();
  const policyRootOptions = options.babelRoot ? { babelRoot: options.babelRoot } : {};
  const requestedBackendEntry =
    options.model !== undefined
      ? loadModelPolicyConfig(options.babelRoot).config.models?.[options.model]
      : undefined;
  const requestedModelIsBackendKey = Boolean(requestedBackendEntry);
  // Explicit opencode requests skip the DeepSeek-only live assertion: naming
  // the backend key IS the opt-in (operator supplies OPENCODE_API_KEY).
  const explicitOpenCodeRequest = requestedBackendEntry?.provider === 'opencode';
  const policy = requestedModelIsBackendKey
    ? resolveModelByKey({
        key: options.model!,
        ...(explicitOpenCodeRequest ? {} : { liveOnly: !offline }),
        ...policyRootOptions,
      })
    : resolveFamilyModelPolicy({
        family: offline ? 'Ollama' : (options.model ?? 'DeepSeek'),
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
  return 'deepseek-v4-flash';
}

import { BABEL_ROOT } from '../cli/constants.js';
import {
  loadModelPolicyConfig,
  resolveFamilyModelPolicy,
  resolveModelByKey,
  type ResolvedModelPolicy,
} from '../modelPolicy.js';

/** Resolve an explicit selector to a configured backend key. */
function configuredBackendKeyForSelector(model: string): string | null {
  const normalized = model.trim().toLowerCase();
  if (!normalized) return null;
  const configuredModels = loadModelPolicyConfig(BABEL_ROOT).config.models ?? {};
  if (configuredModels[normalized]) return normalized;
  return (
    Object.entries(configuredModels).find(
      ([, entry]) => entry.model_id.trim().toLowerCase() === normalized,
    )?.[0] ?? null
  );
}

/** Resolve an explicit workflow model while enforcing live-only policy when requested. */
export function preflightRequestedModelPolicy(
  model: string,
  options: { modelTier?: string; allowExpensive?: boolean; liveOnly?: boolean },
): ResolvedModelPolicy {
  const backendKey = configuredBackendKeyForSelector(model);
  if (backendKey) {
    return resolveModelByKey({
      key: backendKey,
      ...(options.allowExpensive !== undefined ? { allowExpensive: options.allowExpensive } : {}),
      liveOnly: options.liveOnly === true,
      babelRoot: BABEL_ROOT,
    });
  }
  return resolveFamilyModelPolicy({
    family: model,
    ...(options.modelTier !== undefined ? { requestedTier: options.modelTier } : {}),
    allowExpensive: options.allowExpensive === true,
    liveOnly: options.liveOnly === true,
    babelRoot: BABEL_ROOT,
  });
}

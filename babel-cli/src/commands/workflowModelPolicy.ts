import { BABEL_ROOT } from '../cli/constants.js';
import {
  resolveFamilyModelPolicy,
  resolveModelByKey,
  resolveModelPolicyBackendKey,
  type ResolvedModelPolicy,
} from '../modelPolicy.js';

/** Resolve an explicit workflow model while enforcing live-only policy when requested. */
export function preflightRequestedModelPolicy(
  model: string,
  options: { modelTier?: string; allowExpensive?: boolean; liveOnly?: boolean },
): ResolvedModelPolicy {
  const backendKey = resolveModelPolicyBackendKey(model, BABEL_ROOT);
  if (backendKey) {
    return resolveModelByKey({
      key: backendKey,
      allowExpensive: options.allowExpensive === true,
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

import { BABEL_ROOT } from '../cli/constants.js';
import { resolveChatModelPolicy } from '../agent/chatModelPolicy.js';
import {
  resolveFamilyModelPolicy,
  resolveModelByKey,
  resolveModelPolicyBackendKey,
  type ResolvedModelPolicy,
} from '../modelPolicy.js';

/** Resolve an explicit model using the policy owned by its actual controller. */
export function preflightRequestedModelPolicy(
  model: string,
  options: { modelTier?: string; allowExpensive?: boolean; liveOnly?: boolean; chatController?: boolean },
): ResolvedModelPolicy {
  if (options.chatController === true) {
    return resolveChatModelPolicy({
      model,
      ...(options.modelTier !== undefined ? { modelTier: options.modelTier } : {}),
      ...(options.allowExpensive === true ? { allowExpensive: true } : {}),
      babelRoot: BABEL_ROOT,
    }).policy;
  }
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

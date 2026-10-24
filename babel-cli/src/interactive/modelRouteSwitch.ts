/**
 * Campaign Task 6: between-turn model route switching for the interactive
 * session. A switch applies the durable route on the live engine (preserving
 * session identity, conversation, tool pairing and accounting) and only then
 * updates the REPL projection. Engine disposal is never used for a model
 * change — that remains the separate explicit `/clear` semantics.
 */
import type { ReplContext } from './context.js';
import type { ModelSwitchResult } from '../agent/chatEngine.js';
import { resolveModelByKey } from '../modelPolicy.js';
import { resolveChatRouteFromPolicy } from '../agent/chatModelPolicy.js';
import { isOfflineChatMode } from '../agent/chatModelPolicy.js';
import { REQUESTED_SELECTOR_KEYS } from '../intelligence/providerCatalog.js';
import { loadModelPolicyConfig } from '../modelPolicy.js';
import { resetModelSnapshotCache } from './commands/modelDetail.js';

/** The ten campaign selector keys, labeled with provider identity. */
export interface CampaignRouteChoice {
  selectorKey: string;
  provider: string;
  modelId: string;
  protocol: string;
  credentialEnvVar: string;
  credentialPresent: boolean;
  contextWindow: number | null;
  verifiedAt: string | null;
}

/** Resolve one campaign route from the pinned policy entry without a fetch. */
export function resolveCampaignRouteByKey(
  selectorKey: string,
  options?: { babelRoot?: string },
) {
  if (!(REQUESTED_SELECTOR_KEYS as readonly string[]).includes(selectorKey)) {
    throw new Error(
      `"${selectorKey}" is not one of the ten campaign selector keys.`,
    );
  }
  const policy = resolveModelByKey({
    key: selectorKey,
    bindStagesToSelectedModel: true,
    liveOnly: !isOfflineChatMode(),
    ...(options?.babelRoot ? { babelRoot: options.babelRoot } : {}),
  });
  return {
    policy,
    route: resolveChatRouteFromPolicy(
      policy,
      options?.babelRoot ? { babelRoot: options.babelRoot } : undefined,
    ),
  };
}

/** Label all ten campaign routes with provider identity and key presence. */
export function listCampaignRouteChoices(options?: { babelRoot?: string }): CampaignRouteChoice[] {
  const configured = loadModelPolicyConfig(options?.babelRoot).config.models ?? {};
  const choices: CampaignRouteChoice[] = [];
  for (const selectorKey of REQUESTED_SELECTOR_KEYS) {
    try {
      const { policy, route } = resolveCampaignRouteByKey(selectorKey, options);
      choices.push({
        selectorKey,
        provider: policy.provider,
        modelId: policy.providerModelId,
        protocol: route.protocol,
        credentialEnvVar: route.credentialEnvVar,
        credentialPresent: Boolean(process.env[route.credentialEnvVar]),
        contextWindow: policy.contextWindow ?? null,
        verifiedAt: configured[selectorKey]?.verified_at ?? null,
      });
    } catch {
      // An unresolvable pinned entry is listed as unavailable rather than
      // hidden: the ten choices are the campaign surface, not a suggestion.
    }
  }
  return choices;
}

/**
 * Apply a campaign route to the live session. The engine's durable selection
 * runs first; the interactive projection updates only after it succeeds.
 */
export function applySessionModelRoute(
  ctx: ReplContext,
  selectorKey: string,
): ModelSwitchResult {
  let route: ReturnType<typeof resolveChatRouteFromPolicy>;
  try {
    route = resolveCampaignRouteByKey(selectorKey).route;
  } catch (error) {
    return {
      status: 'rejected',
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  if (ctx.chatEngine) {
    const result = ctx.chatEngine.selectModelRoute(route);
    if (result.status !== 'applied') return result;
  } else {
    // No live engine yet: the next turn constructs one from session state.
    // The same policy resolution just ran, so the key is valid; a missing
    // credential surfaces at engine construction with the same message.
  }

  // Projection after durable success.
  ctx.state.model = route.selectorKey;
  ctx.state.resolvedModelId = route.modelId;
  ctx.saveSessionState();
  resetModelSnapshotCache();
  return { status: 'applied', routeHash: route.routeHash };
}

/**
 * Refresh both official catalogs at an idle boundary without changing the
 * current pinned selection. Returns a display summary.
 */
export async function refreshModelCatalogs(): Promise<{
  ok: boolean;
  summary: string;
}> {
  const { refreshProviderCatalogs } = await import(
    '../intelligence/providerCatalog.js'
  );
  try {
    const catalogs = await refreshProviderCatalogs({
      providers: ['openrouter', 'commandcode'],
    });
    const parts: string[] = [];
    if (catalogs.openrouter) {
      parts.push(
        `openrouter ${catalogs.openrouter.entries.length} models (${catalogs.openrouter.fetchedAt})`,
      );
    }
    if (catalogs.commandcode) {
      parts.push(
        `commandcode ${catalogs.commandcode.entries.length} models (${catalogs.commandcode.fetchedAt})`,
      );
    }
    return { ok: true, summary: parts.join('; ') || 'no catalogs refreshed' };
  } catch (error) {
    return {
      ok: false,
      summary: `catalog refresh failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

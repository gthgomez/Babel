import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  evaluateModelBackendPolicy,
  formatEnterprisePolicyDecision,
} from './config/enterprisePolicy.js';

export const MODEL_POLICY_TIERS = [
  'cheap',
  'standard',
  'triage',
  'fallback',
  'escalation',
] as const;
export type ModelPolicyTier = (typeof MODEL_POLICY_TIERS)[number];
export const MODEL_POLICY_STAGES = ['orchestrator', 'planning', 'qa', 'executor'] as const;
export type ModelPolicyStage = (typeof MODEL_POLICY_STAGES)[number];

export interface ModelPolicyModelEntry {
  provider: string;
  model_id: string;
  tier: ModelPolicyTier;
  context_window?: number;
  estimated_cost_per_1m_input?: number;
  estimated_cost_per_1m_output?: number;
  source_url?: string;
  verified_at?: string;
  expires_at?: string;
  expensive?: boolean;
  enabled?: boolean;
  experimental?: boolean;
  selection_reason?: string;
  notes?: string[];
  /** Model's native context window in tokens (e.g. 1000000 for DeepSeek v4). */
  context_limit?: number;
  /** Whether the model supports native function calling via tools/tool_choice API. */
  native_tool_use?: boolean;
  /** Capability tags for routing decisions (e.g. coding, reasoning, fast). */
  capabilities?: string[];
}

export interface ModelPolicyTierSelection {
  selection_reason?: string;
}

export interface ModelPolicyExperimentEntry {
  backend_key: string;
  status?: string;
  selection_reason?: string;
  gates?: string[];
}

export interface ModelPolicyVendorAliasEntry {
  maps_to: string;
  notes?: string;
}

export interface ModelPolicyStageRouteEntry {
  primary_backend_key: string;
  ordered_backend_keys: string[];
  selection_reason?: string;
  notes?: string[];
}

export interface ResolvedModelPolicyEntry {
  backendKey: string;
  provider: string;
  providerModelId: string;
  tier: ModelPolicyTier;
  contextWindow?: number;
  expensive: boolean;
  enabled: boolean;
  experimental: boolean;
  selectionReason?: string;
  notes?: string[];
  estimatedCostPer1MInput?: number;
  estimatedCostPer1MOutput?: number;
  sourceUrl?: string;
  verifiedAt?: string;
  expiresAt?: string;
  contextLimit?: number;
  nativeToolUse?: boolean;
  capabilities?: string[];
}

export interface ModelMetadataFreshnessResult {
  status: 'pass' | 'fail';
  checkedAt: string;
  issues: string[];
}

export interface ResolvedModelPolicyExperiment {
  name: string;
  backendKey: string;
  status?: string;
  selectionReason?: string;
  gates?: string[];
}

export interface ResolvedModelPolicyStageRoute {
  stage: ModelPolicyStage;
  primaryBackendKey: string;
  primaryProvider: string;
  primaryProviderModelId: string;
  orderedBackends: ResolvedModelPolicyEntry[];
  selectionReason?: string;
  notes?: string[];
}

export interface ResolvedModelPolicy {
  policyPath: string;
  family: string;
  selectedTier: ModelPolicyTier;
  requestedStage?: ModelPolicyStage;
  tierSelectionReason?: string;
  resolvedBackendKey: string;
  provider: string;
  providerModelId: string;
  expensive: boolean;
  enabled: boolean;
  experimental: boolean;
  selectionReason?: string;
  notes?: string[];
  blockedWithoutExplicitOptIn: boolean;
  estimatedCostPer1MInput?: number;
  estimatedCostPer1MOutput?: number;
  approximateCostPerRunUsd?: number;
  approximateInputTokens: number;
  approximateOutputTokens: number;
  warnings: string[];
  waterfall: ResolvedModelPolicyEntry[];
  stagePolicies: ResolvedModelPolicyStageRoute[];
  experimentRecommendation?: ResolvedModelPolicyExperiment | null;
  contextLimit?: number;
  nativeToolUse?: boolean;
  capabilities?: string[];
}

interface ModelPolicyConfig {
  version?: number;
  default_tier?: string;
  require_explicit_opt_in_for_expensive?: boolean;
  show_preflight_cost_estimate?: boolean;
  hard_fail_on_unknown_model?: boolean;
  cost_estimation?: {
    default_input_tokens?: number;
    default_output_tokens?: number;
  };
  selection_policy?: Partial<Record<ModelPolicyTier, ModelPolicyTierSelection>>;
  family_defaults?: Record<string, Partial<Record<ModelPolicyTier, string>>>;
  experiments?: Record<string, ModelPolicyExperimentEntry>;
  vendor_aliases?: Record<string, ModelPolicyVendorAliasEntry>;
  models?: Record<string, ModelPolicyModelEntry>;
  stages?: Partial<Record<ModelPolicyStage, ModelPolicyStageRouteEntry>>;
  policy?: {
    vendor_mode?: boolean;
    blocked_without_explicit_opt_in?: string[];
    allowed_default_tiers?: string[];
    max_estimated_cost_per_run_usd?: number;
    warn_if_estimated_cost_per_run_usd_at_least?: number;
  };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Walk up from startDir until config/model-policy.json is found.
 *  Handles the case where dist/ is one level deeper than src/ and
 *  the policy file lives at the repo root rather than in babel-cli/. */
function findBabelRoot(startDir: string): string {
  let dir = resolve(startDir);
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(dir, 'config', 'model-policy.json'))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(startDir); // fallback to original
}

const DEFAULT_BABEL_ROOT = process.env['BABEL_ROOT'] ?? findBabelRoot(resolve(__dirname, '../..'));

function isKnownTier(value: string): value is ModelPolicyTier {
  return (MODEL_POLICY_TIERS as readonly string[]).includes(value);
}

function isKnownStage(value: string): value is ModelPolicyStage {
  return (MODEL_POLICY_STAGES as readonly string[]).includes(value);
}

function normalizeTier(value: string | undefined, fallback: ModelPolicyTier): ModelPolicyTier {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (!isKnownTier(normalized)) {
    throw new Error(
      `Invalid model tier "${value}". Valid values: ${MODEL_POLICY_TIERS.join(', ')}`,
    );
  }
  return normalized;
}

function normalizeStage(value: string | undefined): ModelPolicyStage | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!isKnownStage(normalized)) {
    throw new Error(
      `Invalid model stage "${value}". Valid values: ${MODEL_POLICY_STAGES.join(', ')}`,
    );
  }
  return normalized;
}

function resolveFamilyDefaults(
  familyDefaults: ModelPolicyConfig['family_defaults'],
  family: string,
): Partial<Record<ModelPolicyTier, string>> | undefined {
  if (!familyDefaults) {
    return undefined;
  }

  const directMatch = familyDefaults[family];
  if (directMatch) {
    return directMatch;
  }

  const normalizedFamily = family.trim().toLowerCase();
  const lowerMatch = familyDefaults[normalizedFamily];
  if (lowerMatch) {
    return lowerMatch;
  }

  return Object.entries(familyDefaults).find(
    ([key]) => key.toLowerCase() === normalizedFamily,
  )?.[1];
}

function getVendorAlias(
  aliases: ModelPolicyConfig['vendor_aliases'],
  key: string,
): ModelPolicyVendorAliasEntry | undefined {
  if (!aliases) {
    return undefined;
  }
  const directMatch = aliases[key];
  if (directMatch) {
    return directMatch;
  }
  const normalizedKey = key.trim().toLowerCase();
  return (
    aliases[normalizedKey] ??
    Object.entries(aliases).find(([aliasKey]) => aliasKey.toLowerCase() === normalizedKey)?.[1]
  );
}

function resolveVendorAliasKey(config: ModelPolicyConfig, key: string): string {
  let current = key.trim().toLowerCase();
  const seen = new Set<string>();
  for (let depth = 0; depth < 5; depth += 1) {
    const alias = getVendorAlias(config.vendor_aliases, current);
    const next = alias?.maps_to?.trim().toLowerCase();
    if (!next || seen.has(next)) {
      return current;
    }
    seen.add(current);
    current = next;
  }
  return current;
}

function getPolicyPath(babelRoot = DEFAULT_BABEL_ROOT): string {
  const explicit = process.env['BABEL_MODEL_POLICY_PATH']?.trim();
  return explicit && explicit.length > 0
    ? resolve(explicit)
    : join(babelRoot, 'config', 'model-policy.json');
}

export function loadModelPolicyConfig(babelRoot = DEFAULT_BABEL_ROOT): {
  path: string;
  config: ModelPolicyConfig;
} {
  const policyPath = getPolicyPath(babelRoot);
  if (!existsSync(policyPath)) {
    throw new Error(`Model policy config not found at ${policyPath}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(policyPath, 'utf-8'));
  } catch (error: unknown) {
    throw new Error(
      `Failed to parse model policy config at ${policyPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (parsed === null || typeof parsed !== 'object') {
    throw new Error(`Model policy config at ${policyPath} must be a JSON object.`);
  }

  return { path: policyPath, config: parsed as ModelPolicyConfig };
}

function getCostEstimationDefaults(config: ModelPolicyConfig): {
  inputTokens: number;
  outputTokens: number;
} {
  const inputTokens = config.cost_estimation?.default_input_tokens;
  const outputTokens = config.cost_estimation?.default_output_tokens;

  return {
    inputTokens:
      typeof inputTokens === 'number' && Number.isFinite(inputTokens) && inputTokens > 0
        ? inputTokens
        : 3000,
    outputTokens:
      typeof outputTokens === 'number' && Number.isFinite(outputTokens) && outputTokens > 0
        ? outputTokens
        : 1000,
  };
}

function getResolvedEntry(
  config: ModelPolicyConfig,
  backendKey: string,
  hardFail: boolean,
): ResolvedModelPolicyEntry | null {
  const entry = config.models?.[backendKey];
  if (!entry) {
    if (hardFail) {
      throw new Error(`Model policy backend "${backendKey}" is not defined in models.`);
    }
    return null;
  }

  return {
    backendKey,
    provider: entry.provider,
    providerModelId: entry.model_id,
    tier: entry.tier,
    ...(entry.context_window !== undefined ? { contextWindow: entry.context_window } : {}),
    expensive: entry.expensive === true,
    enabled: entry.enabled !== false,
    experimental: entry.experimental === true,
    ...(entry.selection_reason !== undefined ? { selectionReason: entry.selection_reason } : {}),
    ...(Array.isArray(entry.notes) ? { notes: [...entry.notes] } : {}),
    ...(entry.estimated_cost_per_1m_input !== undefined
      ? { estimatedCostPer1MInput: entry.estimated_cost_per_1m_input }
      : {}),
    ...(entry.estimated_cost_per_1m_output !== undefined
      ? { estimatedCostPer1MOutput: entry.estimated_cost_per_1m_output }
      : {}),
    ...(entry.source_url !== undefined ? { sourceUrl: entry.source_url } : {}),
    ...(entry.verified_at !== undefined ? { verifiedAt: entry.verified_at } : {}),
    ...(entry.expires_at !== undefined ? { expiresAt: entry.expires_at } : {}),
    ...(entry.context_limit !== undefined ? { contextLimit: entry.context_limit } : {}),
    ...(entry.native_tool_use !== undefined ? { nativeToolUse: entry.native_tool_use } : {}),
    ...(Array.isArray(entry.capabilities) ? { capabilities: [...entry.capabilities] } : {}),
  };
}

function parseDateOnly(value: string | undefined): number | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(time) ? time : null;
}

export function validateModelPolicyMetadataFreshness(options?: {
  babelRoot?: string;
  now?: Date;
}): ModelMetadataFreshnessResult {
  const { config } = loadModelPolicyConfig(options?.babelRoot);
  const now = options?.now ?? new Date();
  const nowStart = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
  const issues: string[] = [];

  for (const [backendKey, entry] of Object.entries(config.models ?? {})) {
    const hasCostMetadata =
      entry.estimated_cost_per_1m_input !== undefined ||
      entry.estimated_cost_per_1m_output !== undefined ||
      Array.isArray((entry as { capabilities?: unknown }).capabilities);

    if (!hasCostMetadata) {
      continue;
    }

    if (!entry.source_url || !/^https?:\/\//.test(entry.source_url)) {
      issues.push(`${backendKey}: source_url is required for pricing/capability metadata.`);
    }

    const verifiedAt = parseDateOnly(entry.verified_at);
    if (verifiedAt === null) {
      issues.push(`${backendKey}: verified_at must be a YYYY-MM-DD date.`);
    } else if (verifiedAt > nowStart) {
      issues.push(`${backendKey}: verified_at ${entry.verified_at} is in the future.`);
    }

    const expiresAt = parseDateOnly(entry.expires_at);
    if (expiresAt === null) {
      issues.push(`${backendKey}: expires_at must be a YYYY-MM-DD date.`);
    } else if (expiresAt < nowStart) {
      issues.push(`${backendKey}: expires_at ${entry.expires_at} is expired.`);
    }
  }

  return {
    status: issues.length === 0 ? 'pass' : 'fail',
    checkedAt: now.toISOString(),
    issues,
  };
}

function assertEnterpriseModelAllowed(
  entry: ResolvedModelPolicyEntry,
  explicitOptIn = false,
): void {
  const decision = evaluateModelBackendPolicy(
    {
      backendKey: entry.backendKey,
      provider: entry.provider,
      providerModelId: entry.providerModelId,
    },
    { explicitOptIn },
  );
  if (!decision.allowed) {
    throw new Error(`[ENTERPRISE_POLICY] ${formatEnterprisePolicyDecision(decision)}`);
  }
}

function isEnterpriseModelAllowed(entry: ResolvedModelPolicyEntry, explicitOptIn = false): boolean {
  return evaluateModelBackendPolicy(
    {
      backendKey: entry.backendKey,
      provider: entry.provider,
      providerModelId: entry.providerModelId,
    },
    { explicitOptIn },
  ).allowed;
}

function getExperimentRecommendation(
  config: ModelPolicyConfig,
  selectedTier: ModelPolicyTier,
): ResolvedModelPolicyExperiment | null {
  if (selectedTier !== 'standard') {
    return null;
  }

  const standardAlt = config.experiments?.['standard_alt'];
  if (!standardAlt) {
    return null;
  }

  return {
    name: 'standard_alt',
    backendKey: standardAlt.backend_key,
    ...(standardAlt.status !== undefined ? { status: standardAlt.status } : {}),
    ...(standardAlt.selection_reason !== undefined
      ? { selectionReason: standardAlt.selection_reason }
      : {}),
    ...(Array.isArray(standardAlt.gates) ? { gates: [...standardAlt.gates] } : {}),
  };
}

function resolveStagePolicies(
  config: ModelPolicyConfig,
  hardFail: boolean,
): ResolvedModelPolicyStageRoute[] {
  const stagePolicies: ResolvedModelPolicyStageRoute[] = [];

  for (const stage of MODEL_POLICY_STAGES) {
    const stageConfig = config.stages?.[stage];
    if (!stageConfig) continue;

    const primaryEntry = getResolvedEntry(config, stageConfig.primary_backend_key, hardFail);
    if (!primaryEntry) {
      throw new Error(
        `Unable to resolve primary stage backend "${stageConfig.primary_backend_key}" for stage "${stage}".`,
      );
    }

    const orderedBackends: ResolvedModelPolicyEntry[] = [];
    const seenBackendKeys = new Set<string>();
    for (const backendKey of stageConfig.ordered_backend_keys ?? []) {
      if (seenBackendKeys.has(backendKey)) continue;
      const resolvedEntry = getResolvedEntry(config, backendKey, hardFail);
      if (!resolvedEntry || !resolvedEntry.enabled) continue;
      orderedBackends.push(resolvedEntry);
      seenBackendKeys.add(backendKey);
    }

    if (!seenBackendKeys.has(primaryEntry.backendKey)) {
      orderedBackends.unshift(primaryEntry);
    }

    const enterpriseAllowedBackends = orderedBackends.filter((entry) =>
      isEnterpriseModelAllowed(entry),
    );
    if (enterpriseAllowedBackends.length === 0) {
      throw new Error(
        `[ENTERPRISE_POLICY] No enterprise-allowed model backends remain for stage "${stage}".`,
      );
    }
    const enterprisePrimary = enterpriseAllowedBackends[0]!;

    stagePolicies.push({
      stage,
      primaryBackendKey: enterprisePrimary.backendKey,
      primaryProvider: enterprisePrimary.provider,
      primaryProviderModelId: enterprisePrimary.providerModelId,
      orderedBackends: enterpriseAllowedBackends,
      ...(stageConfig.selection_reason !== undefined
        ? { selectionReason: stageConfig.selection_reason }
        : {}),
      ...(Array.isArray(stageConfig.notes) ? { notes: [...stageConfig.notes] } : {}),
    });
  }

  return stagePolicies;
}

export function resolveStagePolicyRoutes(options?: {
  babelRoot?: string;
}): ResolvedModelPolicyStageRoute[] {
  const { config } = loadModelPolicyConfig(options?.babelRoot);
  const hardFail = config.hard_fail_on_unknown_model !== false;
  return resolveStagePolicies(config, hardFail);
}

export function getAvailableModels(options?: {
  babelRoot?: string;
}): { key: string; entry: ModelPolicyModelEntry }[] {
  const { config } = loadModelPolicyConfig(options?.babelRoot);
  return Object.entries(config.models ?? {})
    .map(([key, entry]) => ({ key, entry }))
    .filter(
      ({ key, entry }) =>
        evaluateModelBackendPolicy({
          backendKey: key,
          provider: entry.provider,
          providerModelId: entry.model_id,
        }).allowed,
    );
}

export function resolveModelByKey(options: {
  key: string;
  allowExpensive?: boolean;
  babelRoot?: string;
}): ResolvedModelPolicy {
  const { path: policyPath, config } = loadModelPolicyConfig(options.babelRoot);
  const hardFail = config.hard_fail_on_unknown_model !== false;

  const normalizedRequestedKey = options.key.trim().toLowerCase();
  const modelKey = config.models?.[normalizedRequestedKey]
    ? normalizedRequestedKey
    : resolveVendorAliasKey(config, normalizedRequestedKey);

  const resolvedBackend = getResolvedEntry(config, modelKey, hardFail);
  if (!resolvedBackend) {
    throw new Error(`Model policy backend "${modelKey}" is not defined.`);
  }

  if (!resolvedBackend.enabled) {
    throw new Error(`Model policy backend "${modelKey}" is disabled.`);
  }
  assertEnterpriseModelAllowed(resolvedBackend, options.allowExpensive === true);

  const allowExpensive = options.allowExpensive === true;
  const blockedWithoutOptIn = new Set(config.policy?.blocked_without_explicit_opt_in ?? []);
  const blockedByPolicy = blockedWithoutOptIn.has(modelKey);
  const expensiveRequiresOptIn =
    config.require_explicit_opt_in_for_expensive !== false &&
    (resolvedBackend.expensive || blockedByPolicy);

  if (expensiveRequiresOptIn && !allowExpensive) {
    throw new Error(
      `Model policy backend "${modelKey}" is expensive or blocked by policy. Re-run with --allow-expensive to opt in explicitly.`,
    );
  }

  const { inputTokens, outputTokens } = getCostEstimationDefaults(config);
  const approximateCostPerRunUsd =
    (resolvedBackend.estimatedCostPer1MInput ?? 0) * (inputTokens / 1_000_000) +
    (resolvedBackend.estimatedCostPer1MOutput ?? 0) * (outputTokens / 1_000_000);

  const warnings: string[] = [];
  const warnThreshold = config.policy?.warn_if_estimated_cost_per_run_usd_at_least;
  if (typeof warnThreshold === 'number' && approximateCostPerRunUsd >= warnThreshold) {
    warnings.push(
      `Approximate per-run cost $${approximateCostPerRunUsd.toFixed(4)} meets or exceeds warning threshold $${warnThreshold.toFixed(2)}.`,
    );
  }

  const stagePolicies = resolveStagePolicies(config, hardFail);

  return {
    policyPath,
    family: modelKey, // using key as family for legacy compatibility
    selectedTier: resolvedBackend.tier,
    resolvedBackendKey: modelKey,
    provider: resolvedBackend.provider,
    providerModelId: resolvedBackend.providerModelId,
    expensive: resolvedBackend.expensive,
    enabled: resolvedBackend.enabled,
    experimental: resolvedBackend.experimental,
    ...(resolvedBackend.selectionReason !== undefined
      ? { selectionReason: resolvedBackend.selectionReason }
      : {}),
    ...(resolvedBackend.notes !== undefined ? { notes: resolvedBackend.notes } : {}),
    blockedWithoutExplicitOptIn: blockedByPolicy,
    ...(resolvedBackend.estimatedCostPer1MInput !== undefined
      ? { estimatedCostPer1MInput: resolvedBackend.estimatedCostPer1MInput }
      : {}),
    ...(resolvedBackend.estimatedCostPer1MOutput !== undefined
      ? { estimatedCostPer1MOutput: resolvedBackend.estimatedCostPer1MOutput }
      : {}),
    approximateCostPerRunUsd,
    approximateInputTokens: inputTokens,
    approximateOutputTokens: outputTokens,
    warnings,
    waterfall: [resolvedBackend], // single-model selection has no waterfall other than itself
    stagePolicies,
    experimentRecommendation: null,
  };
}

export function resolveFamilyModelPolicy(options: {
  family: string;
  requestedTier?: string;
  requestedStage?: string;
  allowExpensive?: boolean;
  babelRoot?: string;
}): ResolvedModelPolicy {
  const { path: policyPath, config } = loadModelPolicyConfig(options.babelRoot);
  const familyDefaults = resolveFamilyDefaults(config.family_defaults, options.family);

  if (!familyDefaults) {
    // If family is not configured, try to resolve as a direct key as fallback
    try {
      return resolveModelByKey({
        key: resolveVendorAliasKey(config, options.family),
        ...(options.allowExpensive !== undefined ? { allowExpensive: options.allowExpensive } : {}),
        ...(options.babelRoot !== undefined ? { babelRoot: options.babelRoot } : {}),
      });
    } catch {
      throw new Error(`Model policy family "${options.family}" is not configured.`);
    }
  }
  const requestedStage = normalizeStage(options.requestedStage);

  const selectedTier = normalizeTier(config.default_tier, 'cheap');
  const effectiveTier = normalizeTier(options.requestedTier, selectedTier);
  const backendKey = familyDefaults[effectiveTier];
  if (!backendKey) {
    throw new Error(
      `Model policy family "${options.family}" has no backend configured for tier "${effectiveTier}".`,
    );
  }

  const blockedWithoutOptIn = new Set(config.policy?.blocked_without_explicit_opt_in ?? []);
  const allowedDefaultTiers = (config.policy?.allowed_default_tiers ?? MODEL_POLICY_TIERS)
    .map((tier) => normalizeTier(tier, selectedTier))
    .filter((tier, index, array) => array.indexOf(tier) === index);
  const allowExpensive = options.allowExpensive === true;
  const hardFail = config.hard_fail_on_unknown_model !== false;
  const resolvedBackend = getResolvedEntry(config, backendKey, hardFail);

  if (!resolvedBackend) {
    throw new Error(`Unable to resolve backend "${backendKey}" for family "${options.family}".`);
  }
  if (!resolvedBackend.enabled) {
    throw new Error(`Model policy backend "${backendKey}" is disabled and cannot be selected.`);
  }
  assertEnterpriseModelAllowed(resolvedBackend, options.allowExpensive === true);

  const blockedByPolicy = blockedWithoutOptIn.has(backendKey);
  const expensiveRequiresOptIn =
    config.require_explicit_opt_in_for_expensive !== false &&
    (resolvedBackend.expensive || blockedByPolicy);

  if (expensiveRequiresOptIn && !allowExpensive) {
    throw new Error(
      `Model policy backend "${backendKey}" is expensive or blocked by policy. Re-run with --allow-expensive to opt in explicitly.`,
    );
  }

  const { inputTokens, outputTokens } = getCostEstimationDefaults(config);
  const approximateCostPerRunUsd =
    (resolvedBackend.estimatedCostPer1MInput ?? 0) * (inputTokens / 1_000_000) +
    (resolvedBackend.estimatedCostPer1MOutput ?? 0) * (outputTokens / 1_000_000);

  const warnings: string[] = [];
  const warnThreshold = config.policy?.warn_if_estimated_cost_per_run_usd_at_least;
  if (typeof warnThreshold === 'number' && approximateCostPerRunUsd >= warnThreshold) {
    warnings.push(
      `Approximate per-run cost $${approximateCostPerRunUsd.toFixed(4)} meets or exceeds warning threshold $${warnThreshold.toFixed(2)}.`,
    );
  }

  const maxThreshold = config.policy?.max_estimated_cost_per_run_usd;
  if (typeof maxThreshold === 'number' && approximateCostPerRunUsd > maxThreshold) {
    throw new Error(
      `Model policy backend "${backendKey}" exceeds the approximate per-run cost ceiling ($${approximateCostPerRunUsd.toFixed(4)} > $${maxThreshold.toFixed(2)}).`,
    );
  }

  const orderedTiers = [
    effectiveTier,
    ...allowedDefaultTiers.filter((tier) => tier !== effectiveTier),
  ];
  const waterfall: ResolvedModelPolicyEntry[] = [];
  const seenBackendKeys = new Set<string>();

  for (const tier of orderedTiers) {
    const tierBackendKey = familyDefaults[tier];
    if (!tierBackendKey || seenBackendKeys.has(tierBackendKey)) {
      continue;
    }

    const resolvedTierEntry = getResolvedEntry(config, tierBackendKey, hardFail);
    if (!resolvedTierEntry) {
      continue;
    }
    if (!resolvedTierEntry.enabled) {
      continue;
    }
    if (
      (resolvedTierEntry.expensive || blockedWithoutOptIn.has(tierBackendKey)) &&
      !allowExpensive
    ) {
      continue;
    }
    if (!isEnterpriseModelAllowed(resolvedTierEntry, allowExpensive)) {
      continue;
    }

    waterfall.push(resolvedTierEntry);
    seenBackendKeys.add(tierBackendKey);
  }

  if (!waterfall.some((entry) => entry.backendKey === backendKey)) {
    waterfall.unshift(resolvedBackend);
  }

  const stagePolicies = resolveStagePolicies(config, hardFail);

  return {
    policyPath,
    family: options.family,
    selectedTier: effectiveTier,
    ...(requestedStage !== undefined ? { requestedStage } : {}),
    ...(config.selection_policy?.[effectiveTier]?.selection_reason !== undefined
      ? { tierSelectionReason: config.selection_policy[effectiveTier]!.selection_reason }
      : {}),
    resolvedBackendKey: backendKey,
    provider: resolvedBackend.provider,
    providerModelId: resolvedBackend.providerModelId,
    expensive: resolvedBackend.expensive,
    enabled: resolvedBackend.enabled,
    experimental: resolvedBackend.experimental,
    ...(resolvedBackend.selectionReason !== undefined
      ? { selectionReason: resolvedBackend.selectionReason }
      : {}),
    ...(resolvedBackend.notes !== undefined ? { notes: resolvedBackend.notes } : {}),
    blockedWithoutExplicitOptIn: blockedByPolicy,
    ...(resolvedBackend.estimatedCostPer1MInput !== undefined
      ? { estimatedCostPer1MInput: resolvedBackend.estimatedCostPer1MInput }
      : {}),
    ...(resolvedBackend.estimatedCostPer1MOutput !== undefined
      ? { estimatedCostPer1MOutput: resolvedBackend.estimatedCostPer1MOutput }
      : {}),
    approximateCostPerRunUsd,
    approximateInputTokens: inputTokens,
    approximateOutputTokens: outputTokens,
    warnings,
    waterfall,
    stagePolicies,
    ...(getExperimentRecommendation(config, effectiveTier) !== null
      ? { experimentRecommendation: getExperimentRecommendation(config, effectiveTier) }
      : { experimentRecommendation: null }),
    ...(resolvedBackend.contextLimit !== undefined
      ? { contextLimit: resolvedBackend.contextLimit }
      : {}),
    ...(resolvedBackend.nativeToolUse !== undefined
      ? { nativeToolUse: resolvedBackend.nativeToolUse }
      : {}),
    ...(resolvedBackend.capabilities !== undefined
      ? { capabilities: resolvedBackend.capabilities }
      : {}),
  };
}

/**
 * Look up a model's context window size from the model policy config.
 *
 * Checks the `models.{modelId}.context_window` field in model-policy.json.
 * Returns `undefined` when the model is not listed or has no context_window set.
 * This allows callers to fall back to a hardcoded map for models not in the policy.
 */
export function getModelContextWindow(
  modelId: string,
  babelRoot?: string,
): number | undefined {
  try {
    const { config } = loadModelPolicyConfig(babelRoot);
    const entry = config.models?.[modelId];
    return entry?.context_window;
  } catch {
    return undefined;
  }
}

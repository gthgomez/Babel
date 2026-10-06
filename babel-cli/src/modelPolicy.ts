import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveRuntimeConfigPath, resolveRuntimePaths } from './config/runtimePaths.js';

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

export const LIVE_DEEPSEEK_BACKEND_KEYS = [
  'deepseek-v4-flash',
  'deepseek-v4-pro',
] as const;

/** Explicit live campaign route for the exact GLM model under test. */
export const LIVE_OPENROUTER_BACKEND_KEY = 'glm-5.3-flash' as const;
export const LIVE_OPENROUTER_MODEL_ID = 'z-ai/glm-5.3-flash' as const;

/** OpenRouter-only DeepSeek control routes. Direct DeepSeek credentials are
 * intentionally not used by live benchmark/canary entrypoints. */
export const LIVE_OPENROUTER_DEEPSEEK_BACKEND_KEYS = [
  'deepseek-v4-flash-openrouter',
  'deepseek-v4-pro-openrouter',
] as const;
export const LIVE_OPENROUTER_DEEPSEEK_MODEL_IDS = [
  'deepseek/deepseek-v4-flash-0731',
  'deepseek/deepseek-v4-pro',
] as const;
export const LIVE_OPENROUTER_API_BASE = 'https://openrouter.ai/api/v1/chat/completions' as const;

/** Map the historical DeepSeek selector to the OpenRouter-only control key. */
export function resolveOpenRouterDeepSeekBackendKey(modelId: string):
  | (typeof LIVE_OPENROUTER_DEEPSEEK_BACKEND_KEYS)[number]
  | null {
  switch (modelId.trim()) {
    case 'deepseek':
    case 'deepseek-v4-pro':
    case 'deepseek/deepseek-v4-pro':
    case 'deepseek-v4-pro-openrouter':
      return 'deepseek-v4-pro-openrouter';
    case 'deepseek-v4-flash':
    case 'deepseek/deepseek-v4-flash':
    case 'deepseek/deepseek-v4-flash-0731':
    case 'deepseek-v4-flash-openrouter':
      return 'deepseek-v4-flash-openrouter';
    default:
      return null;
  }
}

export function resolveOpenRouterDeepSeekModelId(modelId: string): string | null {
  const backendKey = resolveOpenRouterDeepSeekBackendKey(modelId);
  if (!backendKey) return null;
  return backendKey === 'deepseek-v4-pro-openrouter'
    ? LIVE_OPENROUTER_DEEPSEEK_MODEL_IDS[1]
    : LIVE_OPENROUTER_DEEPSEEK_MODEL_IDS[0];
}

/**
 * Build the child-process environment for a live DeepSeek control. The
 * returned environment deliberately removes direct-provider credentials and
 * switches auxiliary compaction/critic calls to the same OpenRouter model.
 */
export function buildOpenRouterDeepSeekLiveEnv(
  base: NodeJS.ProcessEnv = process.env,
  model: string = LIVE_OPENROUTER_DEEPSEEK_MODEL_IDS[0],
): NodeJS.ProcessEnv {
  const routedModel = resolveOpenRouterDeepSeekModelId(model);
  if (!routedModel) {
    throw new Error(
      `[LIVE_MODEL_POLICY] OpenRouter DeepSeek live environment requires an approved selector; received "${model}".`,
    );
  }
  const env: NodeJS.ProcessEnv = {
    ...base,
    BABEL_LITE_OFFLINE: '0',
    BABEL_COMPACTION_MODEL: routedModel,
    BABEL_COMPACTION_API_BASE: LIVE_OPENROUTER_API_BASE,
    BABEL_DIFF_CRITIC_MODEL: routedModel,
  };
  if (env['OPENROUTER_API_KEY']) {
    env['BABEL_COMPACTION_API_KEY'] = env['OPENROUTER_API_KEY'];
  }
  delete env['DEEPSEEK_API_KEY'];
  delete env['BABEL_BENCHMARK_DEEPSEEK_ONLY'];
  return env;
}

export type LiveDeepSeekBackendKey = (typeof LIVE_DEEPSEEK_BACKEND_KEYS)[number];

export function isDeepSeekLiveModelId(modelId: string): boolean {
  return (LIVE_DEEPSEEK_BACKEND_KEYS as readonly string[]).includes(modelId.trim());
}

export function isOpenRouterDeepSeekLiveModelId(modelId: string): boolean {
  return resolveOpenRouterDeepSeekBackendKey(modelId) !== null;
}

export function assertDeepSeekLiveModelId(modelId: string, context = 'live run'): void {
  if (isDeepSeekLiveModelId(modelId) || isOpenRouterDeepSeekLiveModelId(modelId)) return;
  throw new Error(
    `[LIVE_MODEL_POLICY] ${context} requires an approved DeepSeek v4 Flash/Pro route; ` +
      `received "${modelId}".`,
  );
}

export function isLiveModelId(modelId: string): boolean {
  const normalized = modelId.trim();
  return (
    isDeepSeekLiveModelId(normalized) ||
    isOpenRouterDeepSeekLiveModelId(normalized) ||
    (LIVE_OPENROUTER_DEEPSEEK_BACKEND_KEYS as readonly string[]).includes(normalized) ||
    normalized === LIVE_OPENROUTER_BACKEND_KEY ||
    normalized === LIVE_OPENROUTER_MODEL_ID
  );
}

export function assertLiveModelId(modelId: string, context = 'live run'): void {
  if (isLiveModelId(modelId)) return;
  throw new Error(
    `[LIVE_MODEL_POLICY] ${context} received an unapproved live model "${modelId}"; ` +
      `supported exact live ids are ${[
        ...LIVE_DEEPSEEK_BACKEND_KEYS,
        ...LIVE_OPENROUTER_DEEPSEEK_BACKEND_KEYS,
        ...LIVE_OPENROUTER_DEEPSEEK_MODEL_IDS,
        LIVE_OPENROUTER_BACKEND_KEY,
        LIVE_OPENROUTER_MODEL_ID,
      ].join(', ')}.`,
  );
}

export interface ModelPolicyModelEntry {
  provider: string;
  model_id: string;
  tier: ModelPolicyTier;
  context_window?: number;
  max_output_tokens?: number;
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
  maxOutputTokens?: number;
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

export type CapabilityProvenance = 'policy' | 'provider' | 'provider_default' | 'unknown';

export interface NormalizedModelCapabilities {
  backendKey: string;
  provider: string;
  modelId: string;
  contextWindow?: number;
  contextWindowSource: CapabilityProvenance;
  maxOutputTokens?: number;
  maxOutputTokensSource: CapabilityProvenance;
  nativeToolUse?: boolean;
  nativeToolUseSource: CapabilityProvenance;
  capabilities: string[];
  estimatedCostPer1MInput?: number;
  estimatedCostPer1MOutput?: number;
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
  contextWindow?: number;
  maxOutputTokens?: number;
  contextLimit?: number;
  nativeToolUse?: boolean;
  capabilities?: string[];
}

export function isDeepSeekLiveBackend(
  entry: Pick<ResolvedModelPolicyEntry, 'backendKey' | 'provider' | 'providerModelId'>,
): boolean {
  return (
    entry.provider === 'deepseek' &&
    ((LIVE_DEEPSEEK_BACKEND_KEYS as readonly string[]).includes(entry.backendKey) ||
      entry.backendKey === 'deepseek') &&
    (LIVE_DEEPSEEK_BACKEND_KEYS as readonly string[]).includes(entry.providerModelId)
  );
}

export function isOpenRouterDeepSeekLiveBackend(
  entry: Pick<ResolvedModelPolicyEntry, 'backendKey' | 'provider' | 'providerModelId'>,
): boolean {
  return (
    entry.provider === 'openrouter' &&
    (
      (LIVE_OPENROUTER_DEEPSEEK_BACKEND_KEYS as readonly string[]).includes(entry.backendKey) ||
      (LIVE_DEEPSEEK_BACKEND_KEYS as readonly string[]).includes(entry.backendKey) ||
      entry.backendKey === 'deepseek'
    ) &&
    (LIVE_OPENROUTER_DEEPSEEK_MODEL_IDS as readonly string[]).includes(entry.providerModelId)
  );
}

export function isLiveModelBackend(
  entry: Pick<ResolvedModelPolicyEntry, 'backendKey' | 'provider' | 'providerModelId'>,
): boolean {
  if (isDeepSeekLiveBackend(entry)) return true;
  if (isOpenRouterDeepSeekLiveBackend(entry)) return true;
  return (
    entry.provider === 'openrouter' &&
    entry.backendKey === LIVE_OPENROUTER_BACKEND_KEY &&
    entry.providerModelId === LIVE_OPENROUTER_MODEL_ID
  );
}

export function assertLiveModelBackend(
  entry: Pick<ResolvedModelPolicyEntry, 'backendKey' | 'provider' | 'providerModelId'>,
  context = 'live run',
): void {
  if (isLiveModelBackend(entry)) return;
  throw new Error(
    `[LIVE_MODEL_POLICY] ${context} received an unapproved live backend ` +
      `"${entry.backendKey}" resolving to ${entry.provider}/${entry.providerModelId}.`,
  );
}

export function assertDeepSeekLiveBackend(
  entry: Pick<ResolvedModelPolicyEntry, 'backendKey' | 'provider' | 'providerModelId'>,
  context = 'live run',
): void {
  if (isDeepSeekLiveBackend(entry) || isOpenRouterDeepSeekLiveBackend(entry)) return;
  throw new Error(
    `[LIVE_MODEL_POLICY] ${context} requires DeepSeek v4 Flash or v4 Pro; ` +
      `backend "${entry.backendKey}" resolves to ${entry.provider}/${entry.providerModelId}.`,
  );
}

/**
 * Model policy configuration that has passed {@link decodeModelPolicy}
 * structural validation.
 *
 * v2 keeps its family/stage/alias semantics and `BABEL_MODEL_POLICY_PATH`
 * precedence. Validation rejects malformed shapes with a field path instead of
 * casting, and unknown fields follow a documented version policy (see
 * {@link decodeModelPolicy}).
 */
export interface ValidatedModelPolicy {
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

/** Internal alias: the validated shape is the only accepted config form. */
type ModelPolicyConfig = ValidatedModelPolicy;

/** Versions this decoder understands; newer versions must migrate explicitly. */
const MODEL_POLICY_ALLOWED_VERSIONS = [1, 2, 3] as const;

/**
 * Forward-compatible extension escape hatch. Unknown fields are rejected, so
 * future annotations must use an `x_` prefix instead of silently drifting.
 */
const MODEL_POLICY_EXTENSION_PREFIX = 'x_';

const MODEL_POLICY_TOP_LEVEL_KEYS = [
  'version',
  'default_tier',
  'require_explicit_opt_in_for_expensive',
  'show_preflight_cost_estimate',
  'hard_fail_on_unknown_model',
  'cost_estimation',
  'selection_policy',
  'family_defaults',
  'experiments',
  'vendor_aliases',
  'models',
  'stages',
  'policy',
] as const;

const MODEL_ENTRY_KEYS = [
  'provider',
  'model_id',
  'tier',
  'context_window',
  'max_output_tokens',
  'estimated_cost_per_1m_input',
  'estimated_cost_per_1m_output',
  'source_url',
  'verified_at',
  'expires_at',
  'expensive',
  'enabled',
  'experimental',
  'selection_reason',
  'notes',
  'context_limit',
  'native_tool_use',
  'capabilities',
] as const;

/**
 * Fields that make a model entry an independent fact owner are not a policy
 * validation concern: the policy document is a decision/routing graph where
 * multiple backend keys may intentionally reference one served model (the
 * shipped v2 document does). One-fact-owner-per-identity is enforced by the
 * catalog projection (`createCatalogSnapshot`), not here.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const type = typeof value;
  if (type === 'number' || type === 'boolean') return String(value);
  return type;
}

function policyPath(base: string, key: string | number): string {
  return base.length === 0 ? String(key) : `${base}.${key}`;
}

function invalidPolicy(path: string, message: string): never {
  throw new Error(`Invalid model policy at "${path}": ${message}`);
}

function assertObject(value: unknown, path: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    invalidPolicy(path, `expected an object but received ${describeValue(value)}`);
  }
  return value;
}

function assertKnownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  const allowedSet = new Set<string>(allowed);
  for (const key of Object.keys(record)) {
    if (allowedSet.has(key) || key.startsWith(MODEL_POLICY_EXTENSION_PREFIX)) continue;
    invalidPolicy(policyPath(path, key), 'unknown configuration field');
  }
}

function assertTier(value: unknown, path: string): void {
  if (typeof value !== 'string' || !isKnownTier(value.trim().toLowerCase())) {
    invalidPolicy(
      path,
      `expected one of ${MODEL_POLICY_TIERS.join(', ')} but received ${describeValue(value)}`,
    );
  }
}

function assertStage(value: unknown, path: string): void {
  if (typeof value !== 'string' || !isKnownStage(value.trim().toLowerCase())) {
    invalidPolicy(
      path,
      `expected one of ${MODEL_POLICY_STAGES.join(', ')} but received ${describeValue(value)}`,
    );
  }
}

function assertOptionalString(
  record: Record<string, unknown>,
  key: string,
  basePath: string,
): void {
  const value = record[key];
  if (value === undefined) return;
  if (typeof value !== 'string') {
    invalidPolicy(policyPath(basePath, key), `expected a string but received ${describeValue(value)}`);
  }
}

/**
 * Require a non-empty string field. Missing identity fields (an undefined
 * provider/model_id or a vendor alias without a target) must fail validation
 * here rather than reaching the runner as `undefined`.
 */
function assertRequiredString(
  record: Record<string, unknown>,
  key: string,
  basePath: string,
): void {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    invalidPolicy(
      policyPath(basePath, key),
      `expected a non-empty string but received ${value === '' ? 'an empty string' : describeValue(value)}`,
    );
  }
}

function assertOptionalBoolean(
  record: Record<string, unknown>,
  key: string,
  basePath: string,
): void {
  const value = record[key];
  if (value === undefined) return;
  if (typeof value !== 'boolean') {
    invalidPolicy(
      policyPath(basePath, key),
      `expected a boolean but received ${describeValue(value)}`,
    );
  }
}

function assertOptionalNonNegativeNumber(
  record: Record<string, unknown>,
  key: string,
  basePath: string,
): void {
  const value = record[key];
  if (value === undefined) return;
  const path = policyPath(basePath, key);
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    invalidPolicy(path, `expected a finite number but received ${describeValue(value)}`);
  }
  if (value < 0) {
    invalidPolicy(path, `expected a non-negative number but received ${String(value)}`);
  }
}

function assertOptionalPositiveSafeInteger(
  record: Record<string, unknown>,
  key: string,
  basePath: string,
): void {
  const value = record[key];
  if (value === undefined) return;
  const path = policyPath(basePath, key);
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    invalidPolicy(path, `expected a positive safe integer but received ${describeValue(value)}`);
  }
}

function assertOptionalStringArray(
  record: Record<string, unknown>,
  key: string,
  basePath: string,
): void {
  const value = record[key];
  if (value === undefined) return;
  const path = policyPath(basePath, key);
  if (!Array.isArray(value)) {
    invalidPolicy(path, `expected an array but received ${describeValue(value)}`);
  }
  value.forEach((item: unknown, index: number) => {
    if (typeof item !== 'string') {
      invalidPolicy(policyPath(path, index), `expected a string but received ${describeValue(item)}`);
    }
  });
}

function validateModelEntries(value: unknown): void {
  const models = assertObject(value, 'models');

  for (const [backendKey, rawEntry] of Object.entries(models)) {
    const path = `models.${backendKey}`;
    const entry = assertObject(rawEntry, path);
    assertKnownKeys(entry, MODEL_ENTRY_KEYS, path);

    // `provider` and `model_id` are identity fields: a missing value would be
    // cast into `ResolvedModelPolicyEntry` and reach the runner as `undefined`.
    assertRequiredString(entry, 'provider', path);
    assertRequiredString(entry, 'model_id', path);
    if (entry['tier'] !== undefined) {
      assertTier(entry['tier'], `${path}.tier`);
    }

    for (const key of ['context_window', 'max_output_tokens', 'context_limit'] as const) {
      assertOptionalPositiveSafeInteger(entry, key, path);
    }
    for (const key of [
      'estimated_cost_per_1m_input',
      'estimated_cost_per_1m_output',
    ] as const) {
      assertOptionalNonNegativeNumber(entry, key, path);
    }
    assertOptionalString(entry, 'source_url', path);
    assertOptionalString(entry, 'verified_at', path);
    assertOptionalString(entry, 'expires_at', path);
    assertOptionalString(entry, 'selection_reason', path);
    for (const key of ['expensive', 'enabled', 'experimental', 'native_tool_use'] as const) {
      assertOptionalBoolean(entry, key, path);
    }
    assertOptionalStringArray(entry, 'notes', path);
    assertOptionalStringArray(entry, 'capabilities', path);
  }
}

/**
 * Validate an unknown parsed document as a model policy and return it as a
 * {@link ValidatedModelPolicy}.
 *
 * Rejections carry a dotted field path. Unknown fields are rejected so future
 * schema drift is explicit; forward-compatible annotations must use an `x_`
 * prefix and a supported `version`. Version 1/2/3 documents are accepted and
 * keep their existing family/stage/alias semantics.
 */
export function decodeModelPolicy(input: unknown): ValidatedModelPolicy {
  const root = assertObject(input, '<root>');
  assertKnownKeys(root, MODEL_POLICY_TOP_LEVEL_KEYS, '');

  if (root['version'] !== undefined) {
    const version = root['version'];
    if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
      invalidPolicy('version', `expected a positive safe integer but received ${describeValue(version)}`);
    }
    if (!(MODEL_POLICY_ALLOWED_VERSIONS as readonly number[]).includes(version)) {
      invalidPolicy(
        'version',
        `unsupported model policy version ${String(version)}; supported: ${MODEL_POLICY_ALLOWED_VERSIONS.join(', ')}`,
      );
    }
  }

  if (root['default_tier'] !== undefined) {
    assertTier(root['default_tier'], 'default_tier');
  }
  for (const key of [
    'require_explicit_opt_in_for_expensive',
    'show_preflight_cost_estimate',
    'hard_fail_on_unknown_model',
  ] as const) {
    assertOptionalBoolean(root, key, '');
  }

  if (root['cost_estimation'] !== undefined) {
    const costEstimation = assertObject(root['cost_estimation'], 'cost_estimation');
    assertKnownKeys(
      costEstimation,
      ['default_input_tokens', 'default_output_tokens'],
      'cost_estimation',
    );
    assertOptionalPositiveSafeInteger(costEstimation, 'default_input_tokens', 'cost_estimation');
    assertOptionalPositiveSafeInteger(costEstimation, 'default_output_tokens', 'cost_estimation');
  }

  if (root['selection_policy'] !== undefined) {
    const selectionPolicy = assertObject(root['selection_policy'], 'selection_policy');
    for (const [tier, rawEntry] of Object.entries(selectionPolicy)) {
      const path = `selection_policy.${tier}`;
      assertTier(tier, path);
      const entry = assertObject(rawEntry, path);
      assertKnownKeys(entry, ['selection_reason'], path);
      assertOptionalString(entry, 'selection_reason', path);
    }
  }

  if (root['family_defaults'] !== undefined) {
    const familyDefaults = assertObject(root['family_defaults'], 'family_defaults');
    for (const [family, rawEntry] of Object.entries(familyDefaults)) {
      const path = `family_defaults.${family}`;
      const entry = assertObject(rawEntry, path);
      for (const [tier, backendKey] of Object.entries(entry)) {
        const tierPath = `${path}.${tier}`;
        assertTier(tier, tierPath);
        if (typeof backendKey !== 'string' || backendKey.length === 0) {
          invalidPolicy(
            tierPath,
            `expected a backend key string but received ${describeValue(backendKey)}`,
          );
        }
      }
    }
  }

  if (root['experiments'] !== undefined) {
    const experiments = assertObject(root['experiments'], 'experiments');
    for (const [name, rawEntry] of Object.entries(experiments)) {
      const path = `experiments.${name}`;
      const entry = assertObject(rawEntry, path);
      assertKnownKeys(entry, ['backend_key', 'status', 'selection_reason', 'gates'], path);
      assertOptionalString(entry, 'backend_key', path);
      assertOptionalString(entry, 'status', path);
      assertOptionalString(entry, 'selection_reason', path);
      assertOptionalStringArray(entry, 'gates', path);
    }
  }

  if (root['vendor_aliases'] !== undefined) {
    const vendorAliases = assertObject(root['vendor_aliases'], 'vendor_aliases');
    for (const [alias, rawEntry] of Object.entries(vendorAliases)) {
      const path = `vendor_aliases.${alias}`;
      const entry = assertObject(rawEntry, path);
      assertKnownKeys(entry, ['maps_to', 'notes'], path);
      // A vendor alias without a target would resolve to an empty backend key.
      assertRequiredString(entry, 'maps_to', path);
      assertOptionalString(entry, 'notes', path);
    }
  }

  if (root['stages'] !== undefined) {
    const stages = assertObject(root['stages'], 'stages');
    for (const [stage, rawEntry] of Object.entries(stages)) {
      const path = `stages.${stage}`;
      assertStage(stage, path);
      const entry = assertObject(rawEntry, path);
      assertKnownKeys(
        entry,
        ['primary_backend_key', 'ordered_backend_keys', 'selection_reason', 'notes'],
        path,
      );
      assertOptionalString(entry, 'primary_backend_key', path);
      assertOptionalString(entry, 'selection_reason', path);
      assertOptionalStringArray(entry, 'ordered_backend_keys', path);
      assertOptionalStringArray(entry, 'notes', path);
    }
  }

  if (root['policy'] !== undefined) {
    const policy = assertObject(root['policy'], 'policy');
    assertKnownKeys(
      policy,
      [
        'vendor_mode',
        'blocked_without_explicit_opt_in',
        'allowed_default_tiers',
        'max_estimated_cost_per_run_usd',
        'warn_if_estimated_cost_per_run_usd_at_least',
      ],
      'policy',
    );
    assertOptionalBoolean(policy, 'vendor_mode', 'policy');
    assertOptionalStringArray(policy, 'blocked_without_explicit_opt_in', 'policy');
    const allowedTiers = policy['allowed_default_tiers'];
    if (allowedTiers !== undefined) {
      if (!Array.isArray(allowedTiers)) {
        invalidPolicy(
          'policy.allowed_default_tiers',
          `expected an array but received ${describeValue(allowedTiers)}`,
        );
      }
      allowedTiers.forEach((tier: unknown, index: number) => {
        assertTier(tier, `policy.allowed_default_tiers.${index}`);
      });
    }
    assertOptionalNonNegativeNumber(policy, 'max_estimated_cost_per_run_usd', 'policy');
    assertOptionalNonNegativeNumber(policy, 'warn_if_estimated_cost_per_run_usd_at_least', 'policy');
  }

  if (root['models'] !== undefined) {
    validateModelEntries(root['models']);
  }

  return root as ValidatedModelPolicy;
}

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

export function getPolicyPath(babelRoot = resolveRuntimePaths().resourceRoot): string {
  const explicit = process.env['BABEL_MODEL_POLICY_PATH']?.trim();
  return explicit && explicit.length > 0
    ? resolve(explicit)
    : resolveRuntimePaths().isInstalled &&
      (babelRoot === resolveRuntimePaths().resourceRoot || babelRoot === process.env['BABEL_ROOT'])
      ? resolveRuntimeConfigPath('model-policy.json')
      : join(babelRoot, 'config', 'model-policy.json');
}

export function loadModelPolicyConfig(babelRoot = resolveRuntimePaths().resourceRoot): {
  path: string;
  config: ValidatedModelPolicy;
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

  return { path: policyPath, config: decodeModelPolicy(parsed) };
}

/** Resolve a backend key from either its configured key or exact model id. */
export function resolveModelPolicyBackendKey(
  modelOrBackendKey: string,
  babelRoot?: string,
): string | undefined {
  const { config } = loadModelPolicyConfig(babelRoot);
  const normalized = modelOrBackendKey.trim().toLowerCase();
  if (config.models?.[normalized]) return normalized;
  return Object.entries(config.models ?? {}).find(
    ([, entry]) => entry.model_id.trim().toLowerCase() === normalized,
  )?.[0];
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
    ...(entry.context_window !== undefined
      ? { contextWindow: entry.context_window }
      : entry.context_limit !== undefined
        ? { contextWindow: entry.context_limit }
        : {}),
    ...(entry.max_output_tokens !== undefined ? { maxOutputTokens: entry.max_output_tokens } : {}),
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

function mapLiveDeepSeekEntry(
  config: ModelPolicyConfig,
  entry: ResolvedModelPolicyEntry,
  hardFail: boolean,
): ResolvedModelPolicyEntry {
  if (!isDeepSeekLiveBackend(entry)) return entry;
  const openRouterKey = resolveOpenRouterDeepSeekBackendKey(entry.backendKey);
  if (!openRouterKey || !config.models?.[openRouterKey]) return entry;
  return getResolvedEntry(config, openRouterKey, hardFail) ?? entry;
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
  liveOnly = false,
): ResolvedModelPolicyStageRoute[] {
  const stagePolicies: ResolvedModelPolicyStageRoute[] = [];

  for (const stage of MODEL_POLICY_STAGES) {
    const stageConfig = config.stages?.[stage];
    if (!stageConfig) continue;

    const primaryEntryRaw = getResolvedEntry(config, stageConfig.primary_backend_key, hardFail);
    if (!primaryEntryRaw) {
      throw new Error(
        `Unable to resolve primary stage backend "${stageConfig.primary_backend_key}" for stage "${stage}".`,
      );
    }
    const primaryEntry = liveOnly
      ? mapLiveDeepSeekEntry(config, primaryEntryRaw, hardFail)
      : primaryEntryRaw;

    const orderedBackends: ResolvedModelPolicyEntry[] = [];
    const seenBackendKeys = new Set<string>();
    for (const backendKey of stageConfig.ordered_backend_keys ?? []) {
      if (seenBackendKeys.has(backendKey)) continue;
      const resolvedEntryRaw = getResolvedEntry(config, backendKey, hardFail);
      const resolvedEntry = resolvedEntryRaw && liveOnly
        ? mapLiveDeepSeekEntry(config, resolvedEntryRaw, hardFail)
        : resolvedEntryRaw;
      if (!resolvedEntry || !resolvedEntry.enabled) continue;
      orderedBackends.push(resolvedEntry);
      seenBackendKeys.add(resolvedEntry.backendKey);
    }

    if (!seenBackendKeys.has(primaryEntry.backendKey)) {
      orderedBackends.unshift(primaryEntry);
    }

    const enterpriseAllowedBackends = orderedBackends.filter((entry) =>
      isEnterpriseModelAllowed(entry),
    );
    const allowedBackends = liveOnly
      ? enterpriseAllowedBackends.filter(
          (entry) => isDeepSeekLiveBackend(entry) || isOpenRouterDeepSeekLiveBackend(entry),
        )
      : enterpriseAllowedBackends;
    if (allowedBackends.length === 0) {
      if (liveOnly) {
        throw new Error(
          `[LIVE_MODEL_POLICY] No DeepSeek backend remains for live stage "${stage}".`,
        );
      }
      throw new Error(
        `[ENTERPRISE_POLICY] No enterprise-allowed model backends remain for stage "${stage}".`,
      );
    }
    stagePolicies.push({
      stage,
      primaryBackendKey: allowedBackends[0]!.backendKey,
      primaryProvider: allowedBackends[0]!.provider,
      primaryProviderModelId: allowedBackends[0]!.providerModelId,
      orderedBackends: allowedBackends,
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
  liveOnly?: boolean;
}): ResolvedModelPolicyStageRoute[] {
  const { config } = loadModelPolicyConfig(options?.babelRoot);
  const hardFail = config.hard_fail_on_unknown_model !== false;
  return resolveStagePolicies(config, hardFail, options?.liveOnly === true);
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
  liveOnly?: boolean;
}): ResolvedModelPolicy {
  const { path: policyPath, config } = loadModelPolicyConfig(options.babelRoot);
  const hardFail = config.hard_fail_on_unknown_model !== false;

  const normalizedRequestedKey = options.key.trim().toLowerCase();
  const liveMappedKey = options.liveOnly === true
    ? resolveOpenRouterDeepSeekBackendKey(normalizedRequestedKey)
    : null;
  const candidateKey = liveMappedKey && config.models?.[liveMappedKey]
    ? liveMappedKey
    : normalizedRequestedKey;
  const modelKey = config.models?.[candidateKey]
    ? candidateKey
    : resolveVendorAliasKey(config, candidateKey);

  const resolvedBackend = getResolvedEntry(config, modelKey, hardFail);
  if (!resolvedBackend) {
    throw new Error(`Model policy backend "${modelKey}" is not defined.`);
  }

  if (!resolvedBackend.enabled) {
    throw new Error(`Model policy backend "${modelKey}" is disabled.`);
  }
  if (options.liveOnly === true) {
    assertLiveModelBackend(resolvedBackend);
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

  const stagePolicies =
    modelKey === LIVE_OPENROUTER_BACKEND_KEY
      ? MODEL_POLICY_STAGES.map((stage) => ({
          stage,
          primaryBackendKey: resolvedBackend.backendKey,
          primaryProvider: resolvedBackend.provider,
          primaryProviderModelId: resolvedBackend.providerModelId,
          orderedBackends: [resolvedBackend],
          selectionReason: 'Exact experimental GLM route is locked across all phases.',
        }))
      : resolveStagePolicies(config, hardFail, options.liveOnly === true);

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
    ...(resolvedBackend.contextWindow !== undefined
      ? { contextWindow: resolvedBackend.contextWindow }
      : {}),
    ...(resolvedBackend.maxOutputTokens !== undefined
      ? { maxOutputTokens: resolvedBackend.maxOutputTokens }
      : {}),
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

export function resolveFamilyModelPolicy(options: {
  family: string;
  requestedTier?: string;
  requestedStage?: string;
  allowExpensive?: boolean;
  babelRoot?: string;
  liveOnly?: boolean;
}): ResolvedModelPolicy {
  const { path: policyPath, config } = loadModelPolicyConfig(options.babelRoot);
  const familyDefaults = resolveFamilyDefaults(config.family_defaults, options.family);

  if (!familyDefaults) {
    // If family is not configured, try to resolve as a direct key as fallback
    try {
      return resolveModelByKey({
        key: resolveVendorAliasKey(config, options.family),
        ...(options.allowExpensive !== undefined ? { allowExpensive: options.allowExpensive } : {}),
        ...(options.liveOnly === true ? { liveOnly: true } : {}),
        ...(options.babelRoot !== undefined ? { babelRoot: options.babelRoot } : {}),
      });
    } catch {
      throw new Error(`Model policy family "${options.family}" is not configured.`);
    }
  }
  const requestedStage = normalizeStage(options.requestedStage);

  const selectedTier = normalizeTier(config.default_tier, 'cheap');
  const effectiveTier = normalizeTier(options.requestedTier, selectedTier);
  const configuredBackendKey = familyDefaults[effectiveTier];
  if (!configuredBackendKey) {
    throw new Error(
      `Model policy family "${options.family}" has no backend configured for tier "${effectiveTier}".`,
    );
  }
  const backendKey = options.liveOnly
    ? resolveOpenRouterDeepSeekBackendKey(configuredBackendKey) ?? configuredBackendKey
    : configuredBackendKey;

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
  if (options.liveOnly === true) {
    assertLiveModelBackend(resolvedBackend, `live family "${options.family}"`);
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
    const configuredTierBackendKey = familyDefaults[tier];
    const tierBackendKey = options.liveOnly && configuredTierBackendKey
      ? resolveOpenRouterDeepSeekBackendKey(configuredTierBackendKey) ?? configuredTierBackendKey
      : configuredTierBackendKey;
    if (!tierBackendKey || seenBackendKeys.has(tierBackendKey)) {
      continue;
    }

    const resolvedTierEntryRaw = getResolvedEntry(config, tierBackendKey, hardFail);
    const resolvedTierEntry = resolvedTierEntryRaw && options.liveOnly
      ? mapLiveDeepSeekEntry(config, resolvedTierEntryRaw, hardFail)
      : resolvedTierEntryRaw;
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

  const stagePolicies = resolveStagePolicies(config, hardFail, options.liveOnly === true);

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
    ...(resolvedBackend.contextWindow !== undefined
      ? { contextWindow: resolvedBackend.contextWindow }
      : {}),
    ...(resolvedBackend.maxOutputTokens !== undefined
      ? { maxOutputTokens: resolvedBackend.maxOutputTokens }
      : {}),
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
 * Checks the `models.{modelId}.context_window` field in model-policy.json,
 * resolving vendor aliases if needed.
 * Returns `undefined` when the model is not listed or has no context_window set.
 */
export function getModelContextWindow(
  modelId: string,
  babelRoot?: string,
): number | undefined {
  try {
    const { config } = loadModelPolicyConfig(babelRoot);
    const resolvedKey = config.vendor_aliases?.[modelId]?.maps_to ?? modelId;
    const entry = config.models?.[resolvedKey] ?? config.models?.[modelId];
    return entry?.context_window ?? entry?.context_limit;
  } catch {
    return undefined;
  }
}

/**
 * Look up a model's max output tokens from the model policy config.
 */
export function getModelMaxOutputTokens(
  modelId: string,
  babelRoot?: string,
): number | undefined {
  try {
    const { config } = loadModelPolicyConfig(babelRoot);
    const resolvedKey = config.vendor_aliases?.[modelId]?.maps_to ?? modelId;
    const entry = config.models?.[resolvedKey] ?? config.models?.[modelId];
    return entry?.max_output_tokens;
  } catch {
    return undefined;
  }
}

/**
 * Resolve canonical NormalizedModelCapabilities for a model ID from model policy.
 */
export function getNormalizedModelCapabilities(
  modelId: string,
  babelRoot?: string,
): NormalizedModelCapabilities | null {
  try {
    const { config } = loadModelPolicyConfig(babelRoot);
    const resolvedKey = config.vendor_aliases?.[modelId]?.maps_to ?? modelId;
    const entry = config.models?.[resolvedKey] ?? config.models?.[modelId];
    if (!entry) return null;

    const hasContextWindow = entry.context_window !== undefined || entry.context_limit !== undefined;
    const contextWindow = entry.context_window ?? entry.context_limit;
    const hasMaxOutput = entry.max_output_tokens !== undefined;
    const hasNativeToolUse = entry.native_tool_use !== undefined;

    return {
      backendKey: resolvedKey,
      provider: entry.provider,
      modelId: entry.model_id,
      ...(hasContextWindow ? { contextWindow } : {}),
      contextWindowSource: hasContextWindow ? 'policy' : 'unknown',
      ...(hasMaxOutput ? { maxOutputTokens: entry.max_output_tokens } : {}),
      maxOutputTokensSource: hasMaxOutput ? 'policy' : 'unknown',
      ...(hasNativeToolUse ? { nativeToolUse: entry.native_tool_use } : {}),
      nativeToolUseSource: hasNativeToolUse ? 'policy' : 'unknown',
      capabilities: Array.isArray(entry.capabilities) ? [...entry.capabilities] : [],
      ...(entry.estimated_cost_per_1m_input !== undefined
        ? { estimatedCostPer1MInput: entry.estimated_cost_per_1m_input }
        : {}),
      ...(entry.estimated_cost_per_1m_output !== undefined
        ? { estimatedCostPer1MOutput: entry.estimated_cost_per_1m_output }
        : {}),
    };
  } catch {
    return null;
  }
}

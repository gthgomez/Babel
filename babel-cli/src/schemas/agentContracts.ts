/**
 * agentContracts.ts — Babel Multi-Agent Pipeline Handoff Schemas
 *
 * Defines strict Zod schemas for every inter-agent JSON contract in the
 * Orchestrator → SWE Agent → QA Reviewer → CLI Executor pipeline.
 *
 * These schemas are the single source of truth for runtime validation.
 * All agent outputs MUST parse against their respective schema before
 * the harness advances the pipeline to the next stage.
 */

import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// § 1  SHARED ENUMERATIONS
// ─────────────────────────────────────────────────────────────────────────────

export const TargetProjectSchema = z.enum([
  'example_saas_backend',
  'example_llm_router',
  'example_web_audit',
  'example_mobile_suite',
  'global',
]);
export type TargetProject = z.infer<typeof TargetProjectSchema>;

export const TaskCategorySchema = z.enum([
  'bug_fix',
  'feature',
  'refactor',
  'infrastructure',
  'compliance',
  'research',
  'unknown',
]);
export type TaskCategory = z.infer<typeof TaskCategorySchema>;

export const ModelAdapterSchema = z.enum([
  'Deepseek_Standard',
  'Qwen_Balanced',
  'Qwen_UltraTerse',
  'StepFlash_LongContext',
]);
export type ModelAdapter = z.infer<typeof ModelAdapterSchema>;

export const PlanTypeSchema = z.enum(['EVIDENCE_REQUEST', 'IMPLEMENTATION_PLAN']);
export type PlanType = z.infer<typeof PlanTypeSchema>;

/**
 * Live pipeline modes only (product lock 2026-07-12 hard cut).
 * Legacy names (direct|verified|autonomous|manual|parallel_swarm) are NOT accepted
 * by this schema — use {@link normalizePipelineMode} at ingest edges, then parse.
 */
export const LIVE_PIPELINE_MODES = ['chat', 'chat-headless', 'plan', 'deep'] as const;
export type LivePipelineMode = (typeof LIVE_PIPELINE_MODES)[number];

/** Map historical mode strings → live modes (ingest only; schema rejects legacy). */
export const LEGACY_PIPELINE_MODE_MAP: Record<string, LivePipelineMode> = {
  default: 'chat',
  direct: 'chat',
  verified: 'deep',
  autonomous: 'deep',
  manual: 'plan',
  parallel_swarm: 'deep',
};

/**
 * Normalize a raw pipeline_mode string to a live mode, or null if unknown.
 * Use before Zod parse when loading old manifests/fixtures.
 */
export function normalizePipelineMode(raw: string | null | undefined): LivePipelineMode | null {
  if (raw == null) return null;
  const n = raw.toLowerCase().trim();
  if ((LIVE_PIPELINE_MODES as readonly string[]).includes(n)) {
    return n as LivePipelineMode;
  }
  return LEGACY_PIPELINE_MODE_MAP[n] ?? null;
}

export const PipelineModeSchema = z.enum(LIVE_PIPELINE_MODES);
export type PipelineMode = z.infer<typeof PipelineModeSchema>;

export const PurposeModeSchema = z.enum([
  'execution',
  'verification',
  'learning',
  'exploration',
  'audit',
]);
export type PurposeMode = z.infer<typeof PurposeModeSchema>;

export const PurposeSourceSchema = z.enum([
  'explicit_user_request',
  'router_inferred',
  'fallback_default',
]);
export type PurposeSource = z.infer<typeof PurposeSourceSchema>;

export const OrchestratorVersionSchema = z.enum(['9.0']);
export type OrchestratorVersion = z.infer<typeof OrchestratorVersionSchema>;

function unwrapSingleObjectArray(value: unknown): unknown {
  return Array.isArray(value) &&
    value.length === 1 &&
    value[0] !== null &&
    typeof value[0] === 'object'
    ? value[0]
    : value;
}

function normalizeOptionalSwarm(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.swarm === null) {
    console.warn(
      '[agentContracts] Orchestrator emitted `swarm: null` — swarm stripped. Pipeline will run as a single task.',
    );
    const normalized = { ...candidate };
    delete normalized.swarm;
    return normalized;
  }

  const swarm = candidate.swarm;
  const subTasks =
    typeof swarm === 'object' && swarm !== null && !Array.isArray(swarm)
      ? (swarm as Record<string, unknown>).sub_tasks
      : undefined;
  if (Array.isArray(subTasks) && subTasks.length === 0) {
    console.warn(
      '[agentContracts] Orchestrator emitted swarm with empty sub_tasks array — swarm stripped. Pipeline will run as a single task.',
    );
    const normalized = { ...candidate };
    delete normalized.swarm;
    return normalized;
  }
  return value;
}

function normalizeTargetModel(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }

  const normalized = value.trim().toLowerCase();

  const BROAD_FAMILY_ALIASES = new Set([
    'openai',
    'gpt',
    'claude',
    'anthropic',
    'gemini',
    'google',
  ]);
  if (BROAD_FAMILY_ALIASES.has(normalized)) {
    console.warn(
      `[agentContracts] normalizeTargetModel: broad family alias "${value}" mapped to a Babel backend model`,
    );
  }

  if (
    [
      'codex',
      'openai',
      'gpt',
      'gpt-5',
      'gpt-5 pro',
      'gpt-5-pro',
      'gpt5',
      'gpt5pro',
      'openai/gpt-5',
      'openai/gpt-5-pro',
      'qwen',
      'qwen3',
      'qwen3-235b',
      'qwen/qwen3-235b-a22b-instruct-2507',
    ].includes(normalized)
  ) {
    return 'qwen3';
  }
  if (['claude', 'anthropic'].includes(normalized)) {
    return 'deepseek';
  }
  if (['deepseek'].includes(normalized)) {
    return 'deepseek-v4-pro'; // Default DeepSeek family → best available (v4 pro)
  }
  if (['deepseek-v3', 'deepseek-ai/deepseek-v3-0324'].includes(normalized)) {
    return 'deepseek-v4-flash'; // V3-era alias → current flash tier
  }
  if (['deepseek-v4-pro', 'deepseek-pro', 'deepseekv4pro'].includes(normalized)) {
    return 'deepseek-v4-pro';
  }
  if (['deepseek-v4-flash', 'deepseek-flash', 'deepseekv4flash'].includes(normalized)) {
    return 'deepseek-v4-flash';
  }
  if (['gemini', 'google'].includes(normalized)) {
    return 'qwen3';
  }
  if (
    [
      'llama',
      'llama4',
      'llama-4-scout',
      'scout',
      'meta-llama/llama-4-scout-17b-16e-instruct',
    ].includes(normalized)
  ) {
    return 'scout';
  }
  if (['step', 'step-flash', 'stepflash', 'stepfun-ai/step-3.5-flash'].includes(normalized)) {
    return 'step-flash';
  }
  if (['nemotron', 'nvidia/nvidia-nemotron-3-super-120b-a12b'].includes(normalized)) {
    return 'nemotron';
  }
  if (['qwen3-32b', 'qwen/qwen3-32b'].includes(normalized)) {
    return 'qwen3-32b';
  }

  return value;
}

function readAlias(record: Record<string, unknown>, aliases: string[]): unknown {
  for (const alias of aliases) {
    if (record[alias] !== undefined) {
      return record[alias];
    }
  }
  return undefined;
}

function stringifyLooseValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value === null || value === undefined) {
    return '';
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function firstSentence(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return trimmed;
  const match = trimmed.match(/^[\s\S]*?[.!?](?:\s|$)/);
  const sentence = match ? match[0].trim() : trimmed;
  return sentence.length > 200 ? `${sentence.slice(0, 197)}...` : sentence;
}

function normalizeAskAnswer(value: unknown): unknown {
  const unwrapped = unwrapSingleObjectArray(value);
  if (unwrapped === null || typeof unwrapped !== 'object' || Array.isArray(unwrapped)) {
    return unwrapped;
  }

  const record = { ...(unwrapped as Record<string, unknown>) };
  // Normalize missing/invalid schema_version and status (previously silent .catch()).
  if (record['schema_version'] === undefined || record['schema_version'] === null) {
    record['schema_version'] = 1;
  }
  if (
    record['status'] === undefined ||
    record['status'] === null ||
    !['ANSWER_READY', 'NEEDS_MORE_CONTEXT', 'BLOCKED', 'BUDGET_EXCEEDED', 'ASK_FAILED'].includes(
      String(record['status']),
    )
  ) {
    record['status'] = 'ANSWER_READY';
  }
  // Deduce summary from answer and vice versa — belt-and-suspenders against
  // models that omit one of the two required fields.
  const summary = typeof record['summary'] === 'string' ? record['summary'].trim() : '';
  const answer = typeof record['answer'] === 'string' ? record['answer'].trim() : '';
  if (summary.length === 0 && answer.length > 0) {
    record['summary'] = firstSentence(answer);
  } else if (summary.length === 0) {
    record['summary'] = '';
  }
  if (answer.length === 0 && summary.length > 0) {
    record['answer'] = summary;
  } else if (answer.length === 0) {
    record['answer'] = '';
  }
  if (Array.isArray(record['evidence'])) {
    record['evidence'] = record['evidence'].map((entry) => {
      if (typeof entry === 'string') {
        const summary = entry.trim();
        return summary.length > 0
          ? { source: 'model_evidence', summary }
          : { source: 'model_evidence', summary: 'Unspecified evidence.' };
      }
      return entry;
    });
  }
  return record;
}

const LooseStringSchema = z.preprocess((value) => {
  if (Array.isArray(value)) {
    return value
      .map((item) => stringifyLooseValue(item))
      .filter((item) => item.length > 0)
      .join('\n');
  }
  // Normalize null/undefined/numbers → string so .catch('') is unnecessary.
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return value;
}, z.string());

function normalizeExecutorTurn(value: unknown): unknown {
  const unwrapped = unwrapSingleObjectArray(value);
  if (unwrapped === null || typeof unwrapped !== 'object' || Array.isArray(unwrapped)) {
    return unwrapped;
  }

  const record = { ...(unwrapped as Record<string, unknown>) };
  if (record['type'] === undefined && record['tool'] !== undefined) {
    record['type'] = 'tool_call';
  }

  if (record['type'] !== 'tool_call') {
    return record;
  }

  if (record['thinking'] === undefined) {
    record['thinking'] = '';
  } else if (Array.isArray(record['thinking'])) {
    record['thinking'] = record['thinking']
      .map((item) => stringifyLooseValue(item))
      .filter((item) => item.length > 0)
      .join('\n');
  }

  const toolAlias = readAlias(record, ['tool_name', 'toolName', 'name']);
  if (record['tool'] === undefined && typeof toolAlias === 'string') {
    record['tool'] = toolAlias;
  }

  const pathAlias = readAlias(record, ['filepath', 'file_path', 'filePath', 'target']);
  if (record['path'] === undefined && typeof pathAlias === 'string') {
    record['path'] = pathAlias;
  }

  const contentAlias = readAlias(record, ['body', 'text', 'file_content', 'fileContent']);
  if (record['content'] === undefined && typeof contentAlias === 'string') {
    record['content'] = contentAlias;
  }

  const commandAlias = readAlias(record, ['cmd', 'shell_command']);
  if (record['command'] === undefined && typeof commandAlias === 'string') {
    record['command'] = commandAlias;
  }

  const argumentAlias = readAlias(record, ['args', 'params', 'input']);
  if (
    record['arguments'] === undefined &&
    argumentAlias !== null &&
    typeof argumentAlias === 'object' &&
    !Array.isArray(argumentAlias)
  ) {
    record['arguments'] = argumentAlias;
  }

  return record;
}

/**
 * The model backends Babel can route to.
 * Stored in `worker_configuration.assigned_model` of the Orchestrator manifest.
 * External CLI family aliases are normalized because real model outputs often
 * describe the family ("Codex", "Claude", "Gemini") rather than the backend key.
 */
export const TargetModelSchema = z.preprocess(
  normalizeTargetModel,
  z.enum([
    'deepseek',
    'deepseek-v4-pro',
    'deepseek-v4-flash',
    'qwen3',
    'qwen3-32b',
    'step-flash',
    'scout',
    'nemotron',
  ]),
);
export type TargetModel = z.infer<typeof TargetModelSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// § 2  ORCHESTRATOR MANIFEST SCHEMA
//      Source: OLS-v8-Orchestrator.md § 4 (JSON Output Contract)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single entry in the `prompt_manifest` array.
 * The harness loads these files in `load_order` sequence to compile the context.
 */
export const PromptManifestEntrySchema = z.object({
  load_order: z.number().int().min(1),
  layer: z.enum([
    'behavioral_os',
    'domain_architect',
    'model_adapter',
    'pipeline_stage',
    'project_overlay',
    'task_overlay',
  ]),
  path: z.string().min(1),
  role: z.string().min(1), // Human-readable description of why this file is loaded
});
export type PromptManifestEntry = z.infer<typeof PromptManifestEntrySchema>;

/**
 * Structured analysis block — mirrors the actual `analysis` object emitted by
 * OLS-v8-Orchestrator.md (Section 4, JSON Output Contract).
 */
export const OrchestrationAnalysisSchema = z.object({
  task_summary: z.string().min(1),
  task_category: z.string().min(1).max(100), // Domain category (Backend, Frontend, Mobile, Compliance, DevOps, Research, etc.)
  secondary_category: z.string().nullable(),
  task_overlay_ids: z.array(z.string()).default([]), // Legacy v8 field; v9 overlay selection lives in instruction_stack
  complexity_estimate: z.enum(['Low', 'Medium', 'High']),
  pipeline_mode: PipelineModeSchema,
  purpose_mode: PurposeModeSchema.default('execution'),
  purpose_source: PurposeSourceSchema.default('fallback_default'),
  purpose_confidence: z.number().min(0).max(1).default(0.7),
  ambiguity_note: z.string().nullable(),
  /**
   * Optional 0–1 confidence score for the routing decision emitted by the
   * orchestrator. Pipeline logs a warning when present and below 0.8.
   * Foundation for future semantic validator cascade (Phase 3).
   */
  routing_confidence: z.number().min(0).max(1).optional(),
  /**
   * Required alongside routing_confidence. One sentence the model must write
   * explaining WHY it chose that confidence score. Makes "confidently wrong"
   * routing decisions visible during local log inspection.
   * Added: Fix A — critique remediation 2026-04-26.
   */
  routing_confidence_rationale: z.string().optional(),
  /**
   * Populated when 2+ domain keyword families matched the same request.
   * Comma-separated list of candidate domain IDs, e.g.
   * "domain_android_kotlin, domain_python_backend".
   * Null when routing was unambiguous.
   * Added: Fix B — critique remediation 2026-04-26.
   */
  routing_conflict_log: z.string().nullable().optional(),
});
export type OrchestrationAnalysis = z.infer<typeof OrchestrationAnalysisSchema>;

const ProfileSourceSchema = z.enum([
  'explicit_user_request',
  'inferred_from_product_feature',
  'not_required_for_routing',
]);

const ClientSurfaceSchema = z.enum([
  'chatgpt_web',
  'claude_web',
  'gemini_web',
  'grok_web',
  'unspecified',
]);

const ContainerModelSchema = z.enum(['chat', 'project', 'gem', 'canvas', 'artifact']);

const IngestionModeSchema = z.enum([
  'none',
  'file_upload',
  'repo_snapshot',
  'repo_selective_sync',
  'repo_live_query',
  'full_repo_integration',
]);

const RepoWriteModeSchema = z.enum([
  'no_repo_writeback',
  'limited_write_surfaces',
  'repo_writeback',
]);

const OutputSurfaceSchema = z.enum(['none', 'canvas', 'artifact', 'project_share', 'chat_share']);

const TrustLevelSchema = z.enum(['high', 'medium', 'low']);

const ApprovalModeSchema = z.enum([
  'none',
  'explicit_confirmation',
  'takeover_or_confirmation',
  'implicit_permissions',
  'unknown',
]);

const DEFAULT_PLATFORM_PROFILE = {
  profile_source: 'not_required_for_routing' as const,
  client_surface: 'unspecified' as const,
  container_model: null,
  ingestion_mode: 'none' as const,
  repo_write_mode: null,
  output_surface: [] as z.infer<typeof OutputSurfaceSchema>[],
  platform_modes: [] as string[],
  execution_trust: null,
  data_trust: null,
  freshness_trust: null,
  action_trust: null,
  approval_mode: 'none' as const,
};

export const PlatformProfileSchema = z
  .object({
    profile_source: ProfileSourceSchema.default(DEFAULT_PLATFORM_PROFILE.profile_source),
    client_surface: ClientSurfaceSchema.default(DEFAULT_PLATFORM_PROFILE.client_surface),
    container_model: ContainerModelSchema.nullable().default(
      DEFAULT_PLATFORM_PROFILE.container_model,
    ),
    ingestion_mode: IngestionModeSchema.default(DEFAULT_PLATFORM_PROFILE.ingestion_mode),
    repo_write_mode: RepoWriteModeSchema.nullable().default(
      DEFAULT_PLATFORM_PROFILE.repo_write_mode,
    ),
    output_surface: z
      .array(OutputSurfaceSchema)
      .default([...DEFAULT_PLATFORM_PROFILE.output_surface]),
    platform_modes: z.array(z.string()).default([...DEFAULT_PLATFORM_PROFILE.platform_modes]),
    execution_trust: TrustLevelSchema.nullable().default(DEFAULT_PLATFORM_PROFILE.execution_trust),
    data_trust: TrustLevelSchema.nullable().default(DEFAULT_PLATFORM_PROFILE.data_trust),
    freshness_trust: TrustLevelSchema.nullable().default(DEFAULT_PLATFORM_PROFILE.freshness_trust),
    action_trust: TrustLevelSchema.nullable().default(DEFAULT_PLATFORM_PROFILE.action_trust),
    approval_mode: ApprovalModeSchema.default(DEFAULT_PLATFORM_PROFILE.approval_mode),
  })
  .default(DEFAULT_PLATFORM_PROFILE);
export type PlatformProfile = z.infer<typeof PlatformProfileSchema>;

/**
 * The `handoff_payload` mirrors the actual object emitted by the Orchestrator.
 * `user_request` is the verbatim user prompt; `system_directive` instructs the
 * Worker Agent to load the prompt_manifest files and enter PLAN state.
 */
export const HandoffPayloadSchema = z.object({
  user_request: z.string().min(1),
  system_directive: z.string().min(1),
});
export type HandoffPayload = z.infer<typeof HandoffPayloadSchema>;

export const ResolutionPolicySchema = z.object({
  apply_domain_default_skills: z.boolean().default(true),
  expand_skill_dependencies: z.boolean().default(true),
  strict_conflict_mode: z.enum(['error', 'warn']).default('error'),
  task_shape_profile: z
    .enum([
      'full',
      'greenfield_file_creation',
      'synthesis_write',
      'android_utility_file',
      'android_ui_improvement',
      'android_warning_cleanup',
      'compliance_artifact_write',
      'audit_verification',
    ])
    .default('full'),
});
export type ResolutionPolicy = z.infer<typeof ResolutionPolicySchema>;

export const BudgetDiagnosticSeveritySchema = z.enum(['info', 'warn', 'severe']);
export type BudgetDiagnosticSeverity = z.infer<typeof BudgetDiagnosticSeveritySchema>;

export const BudgetDiagnosticCodeSchema = z.enum([
  'total_token_budget',
  'missing_token_budget',
  'token_count_unavailable',
  'actual_declared_token_drift',
  'budget_threshold_warning',
  'budget_threshold_severe',
]);
export type BudgetDiagnosticCode = z.infer<typeof BudgetDiagnosticCodeSchema>;

export const BudgetPolicyScopeSchema = z.object({
  domain_ids: z.array(z.string().min(1)).default([]),
  required_pipeline_stage_ids: z.array(z.string().min(1)).default([]),
  orchestrator_versions: z.array(OrchestratorVersionSchema).default(['9.0']),
});
export type BudgetPolicyScope = z.infer<typeof BudgetPolicyScopeSchema>;

export const BudgetPolicySchema = z.object({
  enabled: z.boolean(),
  scope: BudgetPolicyScopeSchema,
  warn_threshold: z.number().int().nonnegative(),
  severe_warn_threshold: z.number().int().nonnegative(),
  hard_limit: z.number().int().nonnegative().optional(),
  count_layers: z.enum(['all_compiled_layers']),
  missing_budget_mode: z.enum(['warn', 'severe']),
});
export type BudgetPolicy = z.infer<typeof BudgetPolicySchema>;

export const BudgetDiagnosticSchema = z.object({
  severity: BudgetDiagnosticSeveritySchema,
  code: BudgetDiagnosticCodeSchema,
  message: z.string().min(1),
  entry_ids: z.array(z.string().min(1)).optional(),
});
export type BudgetDiagnostic = z.infer<typeof BudgetDiagnosticSchema>;

export const CompilationStateSchema = z.enum(['uncompiled', 'compiled']);
export type CompilationState = z.infer<typeof CompilationStateSchema>;

export const CompiledArtifactsSchema = z.object({
  selected_entry_ids: z.array(z.string().min(1)).min(1),
  prompt_manifest: z.array(z.string()).min(1),
  token_budget_total: z.number().int().nonnegative().optional(),
  token_budget_missing: z.array(z.string().min(1)).optional(),
  token_budget_by_entry: z.record(z.string(), z.number().int().nonnegative()).optional(),
  actual_prompt_tokens: z.number().int().nonnegative().nullable().optional(),
  actual_token_by_entry: z.record(z.string(), z.number().int().nonnegative()).optional(),
  actual_minus_declared: z.number().int().nullable().optional(),
  tokenizer_encoding: z.literal('o200k_base').optional(),
  token_count_source: z.enum(['runtime', 'audit', 'unavailable']).optional(),
  token_count_warnings: z.array(z.string()).optional(),
  budget_policy: BudgetPolicySchema.optional(),
  budget_diagnostics: z.array(BudgetDiagnosticSchema).optional(),
  warnings: z.array(z.string()).optional(),
  dropped_entry_ids: z.array(z.string().min(1)).optional(),
});
export type CompiledArtifacts = z.infer<typeof CompiledArtifactsSchema>;

export const RuntimeTelemetrySchema = z.object({
  orchestrator_version: OrchestratorVersionSchema,
  domain_id: z.string().min(1),
  skill_ids: z.array(z.string().min(1)),
  model_adapter_id: z.string().min(1),
  selected_entry_ids: z.array(z.string().min(1)),
  token_budget_total: z.number().int().nonnegative().nullable(),
  actual_prompt_tokens: z.number().int().nonnegative().nullable().optional(),
  actual_minus_declared: z.number().int().nullable().optional(),
  token_count_source: z.enum(['runtime', 'audit', 'unavailable']).optional(),
  token_budget_missing_count: z.number().int().nonnegative(),
  budget_warning_severity: BudgetDiagnosticSeveritySchema.nullable(),
  budget_policy_enabled: z.boolean(),
  pipeline_mode: PipelineModeSchema,
  qa_verdict: z.enum(['PASS', 'REJECT']).nullable(),
  qa_failure_tags: z.array(z.string().min(1)),
  final_outcome: z.string().nullable(),
  routing_confidence: z.number().min(0).max(1).optional(),
  routing_confidence_band: z.enum(['high', 'medium', 'low']).optional(),
  routing_action: z
    .enum([
      'accepted',
      'downgraded',
      'validated',
      'validator_still_low',
      'medium_confidence_regular',
    ])
    .optional(),
  routing_validator_used: z.boolean().optional(),
  routing_validator_improved: z.boolean().nullable().optional(),
  jit_latency_ms: z.number().int().nonnegative().optional(),
  stream_pause_duration_ms: z.number().int().nonnegative().optional(),
  lock_wait_ms: z.number().int().nonnegative().optional(),
  buffer_peak_bytes: z.number().int().nonnegative().optional(),
});
export type RuntimeTelemetry = z.infer<typeof RuntimeTelemetrySchema>;

export const InstructionStackSchema = z.object({
  behavioral_ids: z.array(z.string().min(1)).min(1),
  domain_id: z.string().min(1),
  skill_ids: z.array(z.string().min(1)).default([]),
  model_adapter_id: z.string().min(1),
  project_overlay_id: z.string().min(1).nullable().default(null),
  task_overlay_ids: z.array(z.string().min(1)).default([]),
  pipeline_stage_ids: z.array(z.string().min(1)).default([]),
});
export type InstructionStack = z.infer<typeof InstructionStackSchema>;

export const SubTaskSchema = z.object({
  sub_task_id: z.string().min(1),
  instruction_stack: InstructionStackSchema,
  sector: z.string().optional(), // Recommended directory boundary
  handoff_payload: HandoffPayloadSchema,
});
export type SubTask = z.infer<typeof SubTaskSchema>;

export const SwarmManifestSchema = z.object({
  parent_run_id: z.string().min(1),
  sub_tasks: z.array(SubTaskSchema).min(1),
  coordination_policy: z.enum(['isolated', 'interdependent']).default('isolated'),
});
export type SwarmManifest = z.infer<typeof SwarmManifestSchema>;

/**
 * Successful Orchestrator output — the harness advances to Stage 2.
 *
 * Schema aligned with OLS-v8-Orchestrator.md and OLS-v9-Orchestrator.md:
 *   - `worker_configuration` has `assigned_model` + `rationale`
 *     (not domain_agent / model_adapter / pipeline_mode — those live in `analysis`)
 *   - `prompt_manifest` remains a flat array of absolute Windows path strings
 *     for backward compatibility
 *   - `compilation_state` makes resolver lifecycle explicit for v9
 *   - `instruction_stack` + `resolution_policy` are additive v9 fields
 *   - `compiled_artifacts` captures the resolved stack IDs and mirrored manifest
 *   - `target_project_path` is optional (Windows absolute path to the project root)
 */
export const OrchestratorManifestSchema = z.preprocess(
  normalizeOptionalSwarm,
  z
    .object({
      orchestrator_version: OrchestratorVersionSchema,
      target_project: z
        .string()
        .min(1)
        .refine((val) => !val.includes('..') && !val.includes('/') && !val.includes('\\'), {
          message: 'target_project must not contain path separators or traversal segments',
        }),
      target_project_path: z.string().optional(), // Absolute Windows path, may be omitted
      session_id: z.string().min(1).optional(),
      session_start_path: z.string().min(1).optional(),
      local_learning_root: z.string().min(1).optional(),
      analysis: OrchestrationAnalysisSchema,
      platform_profile: PlatformProfileSchema,
      worker_configuration: z.object({
        assigned_model: TargetModelSchema,
        rationale: z.string().min(1),
      }),
      compilation_state: CompilationStateSchema.optional(),
      instruction_stack: InstructionStackSchema.optional(),
      resolution_policy: ResolutionPolicySchema.optional(),
      compiled_artifacts: CompiledArtifactsSchema.optional(),
      runtime_telemetry: RuntimeTelemetrySchema.optional(),
      prompt_manifest: z.array(z.string()), // Ordered absolute Windows path strings
      handoff_payload: HandoffPayloadSchema,
      swarm: SwarmManifestSchema.optional(),
    })
    .superRefine((value, ctx) => {
      const hasInstructionStack = value.instruction_stack !== undefined;

      if (!hasInstructionStack) {
        // Pipeline will create a minimal default stack if missing
      }

      if (hasInstructionStack && value.resolution_policy === undefined) {
        // Pipeline will default to 'full' if missing
      }

      if (hasInstructionStack && value.compilation_state === undefined) {
        // Pipeline will default to 'uncompiled' if missing
      }

      if (value.compilation_state === 'uncompiled' && value.prompt_manifest.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['prompt_manifest'],
          message: 'prompt_manifest must be empty while compilation_state is uncompiled',
        });
      }

      if (value.compilation_state === 'compiled' && value.prompt_manifest.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['prompt_manifest'],
          message: 'compiled manifests must provide a non-empty prompt_manifest',
        });
      }

      // Neither compilation_state nor prompt_manifest entries — the manifest
      // provides no prompt files, which produces an empty context at runtime.
      if (value.compilation_state === undefined && value.prompt_manifest.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['prompt_manifest'],
          message: 'prompt_manifest must be non-empty when compilation_state is absent',
        });
      }

      if (value.compilation_state === 'uncompiled' && value.compiled_artifacts !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['compiled_artifacts'],
          message: 'compiled_artifacts must not be present while compilation_state is uncompiled',
        });
      }

      if (value.compilation_state === 'compiled' && hasInstructionStack) {
        if (value.compiled_artifacts === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['compiled_artifacts'],
            message: 'compiled_artifacts are required when a typed stack has been compiled',
          });
        } else {
          const compiledPromptManifest = value.compiled_artifacts.prompt_manifest;
          if (
            compiledPromptManifest.length !== value.prompt_manifest.length ||
            compiledPromptManifest.some(
              (filePath, index) => filePath !== value.prompt_manifest[index],
            )
          ) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['compiled_artifacts', 'prompt_manifest'],
              message: 'compiled_artifacts.prompt_manifest must mirror the root prompt_manifest',
            });
          }
        }
      }
    }),
);
export type OrchestratorManifest = z.infer<typeof OrchestratorManifestSchema>;

/**
 * Orchestrator error-halt — emitted when the task is destructive or out of scope.
 * The harness must not advance the pipeline.
 *
 * Schema aligned with OLS-v8-Orchestrator.md § 5 HARD CONSTRAINTS:
 *   fields are `error_reason` and `blocked_request` (not reason/remediation).
 */
export const OrchestratorErrorHaltSchema = z.object({
  orchestrator_version: OrchestratorVersionSchema,
  error_halt: z.literal(true),
  error_reason: z.string().min(1),
  blocked_request: z.string().min(1),
  prompt_manifest: z.array(z.unknown()),
});
export type OrchestratorErrorHalt = z.infer<typeof OrchestratorErrorHaltSchema>;

// Union for parsing unknown Orchestrator output.
// z.union (not z.discriminatedUnion) is required here because
// discriminatedUnion only accepts plain ZodObject members, and
// OrchestratorManifestSchema does not carry an `error_halt` field.
// The pipeline detects which variant was returned by checking
// `'error_halt' in output && output.error_halt === true`.
export const OrchestratorOutputSchema = z.preprocess(
  unwrapSingleObjectArray,
  z.union([OrchestratorErrorHaltSchema, OrchestratorManifestSchema]),
);

// ─────────────────────────────────────────────────────────────────────────────
// § 3  SWE PLAN SCHEMA
//      Source: QA_Adversarial_Reviewer-v1.0.md § 2 (Valid Submission Format)
//              CLI_Executor-v1.0.md § 2 (Activation Gate)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * BCDP Assessment — required when the plan touches an external contract
 * (API, database schema, shared type, event shape, environment variable).
 */
export const BcdpAssessmentSchema = z.object({
  contracts_modified: z.array(z.string()), // List of affected contracts
  breaking_change: z.boolean(),
  migration_strategy: z.string().optional(), // Required if breaking_change = true
  rollback_available: z.boolean(),
  downstream_consumers: z.array(z.string()),
});
export type BcdpAssessment = z.infer<typeof BcdpAssessmentSchema>;

/**
 * A single step in the MINIMAL_ACTION_SET.
 * Each step maps to exactly one tool call the CLI Executor will emit.
 */
export const ActionStepSchema = z.object({
  step: z.number().int().min(1),
  description: z.string().min(1),
  tool: z.enum([
    'directory_list',
    'file_read',
    'file_write',
    'shell_exec',
    'test_run',
    'mcp_request',
    'mcp_resource_list',
    'mcp_resource_read',
    'mcp_prompt_list',
    'mcp_prompt_get',
    'mcp_tool_search',
    'web_search',
    'web_fetch',
    'plugin_tool',
    'audit_ui',
    'memory_store',
    'memory_query',
    'enter_plan_mode',
    'exit_plan_mode',
    'semantic_search',
    'grep',
    'glob',
    'workspace_symbol_search',
    'workspace_map',
    'git_context',
    'get_code_outline',
    'find_code_definition',
    'find_code_references',
    'load_skill_manifest',
    'lsp',
  ]),
  target: z.string().min(1), // File path or shell command
  rationale: z.string().min(1), // Why this step is in the minimal set
  reversible: z.boolean(),
  verification: z.string().min(1), // How the CLI Executor confirms this step succeeded
});
export type ActionStep = z.infer<typeof ActionStepSchema>;

/**
 * Full SWE Agent PLAN — must pass QA before CLI Executor activates.
 */
export const SwePlanSchema = z.preprocess(
  unwrapSingleObjectArray,
  z.object({
    plan_version: z.string().catch('1.0'), // e.g., "1.0"; .catch handles missing/undefined from models
    thinking: LooseStringSchema.describe(
      'Internal reasoning and architectural critique before the final plan.',
    ),
    // Optional for backward compatibility with older plans; pipeline normalizes if missing.
    plan_type: PlanTypeSchema.optional(),
    task_summary: z.string().min(1),
    known_facts: z.array(z.string()).max(50).default([]),
    assumptions: z.array(z.string()).max(50),
    risks: z
      .array(
        z.object({
          risk: z.string().min(1),
          likelihood: z.enum(['low', 'medium', 'high']),
          mitigation: z.string().min(1),
        }),
      )
      .max(50),
    minimal_action_set: z.array(ActionStepSchema).min(1).max(100),
    bcdp_assessment: BcdpAssessmentSchema.optional(), // Required if any contract is touched
    root_cause: z.string().catch('N/A — not provided'), // For bug fixes; may be "N/A — feature request"; .catch handles missing/undefined from models
    out_of_scope: z.array(z.string()).max(50), // Explicit list of what this plan does NOT do
  }),
);
export type SwePlan = z.infer<typeof SwePlanSchema>;

/**
 * Minimal read-only answer contract for `babel ask` / `bl ask`.
 *
 * This is intentionally smaller than `SwePlanSchema`: ask mode answers the
 * user's question and records lightweight evidence, but it does not emit an
 * implementation plan or require a `minimal_action_set`.
 */
export const AskAnswerSchema = z.preprocess(
  normalizeAskAnswer,
  z.object({
    schema_version: z.literal(1),
    status: z
      .enum(['ANSWER_READY', 'NEEDS_MORE_CONTEXT', 'BLOCKED', 'BUDGET_EXCEEDED', 'ASK_FAILED'])
      .catch('ANSWER_READY'),
    summary: z.string().min(1).catch(''),
    answer: z.string().min(1).catch(''),
    facts: z.array(z.string()).default([]),
    assumptions: z.array(z.string()).default([]),
    evidence: z
      .array(
        z.object({
          source: z.string().min(1),
          summary: z.string().min(1),
        }),
      )
      .default([]),
    next: z.array(z.string()).default([]),
  }),
);
export type AskAnswer = z.infer<typeof AskAnswerSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// § 3b  BLOCKED REPORT SCHEMA  (R1: Honest Termination)
//
//       When an agent correctly diagnoses that a task cannot be completed
//       (missing files, insufficient permissions, unsatisfiable preconditions),
//       it may exit with a structured blocked-report instead of looping.
//       The gate validates `checked` against the tool-call log before
//       accepting BLOCKED as a terminal state.
// ─────────────────────────────────────────────────────────────────────────────

export const BlockedReportSchema = z.object({
  schema_version: z.literal(1),
  status: z.literal('BLOCKED'),
  /** Why the task cannot be completed — the root cause. */
  reason: z.string().min(1).describe('Root cause: why this task cannot be completed.'),
  /** What is missing — file, dependency, permission, API key, etc. */
  missing: z.string().min(1).describe('What specific thing is absent or unavailable.'),
  /** Evidence of what was checked before concluding blocked.
   *  Each entry must correspond to an actual tool call in the session log. */
  checked: z
    .array(
      z.object({
        /** Tool used to check (read_file, grep, glob, run_command, etc.). */
        action: z.string().min(1),
        /** Target of the check (file path, search pattern, command). */
        target: z.string().min(1),
        /** What the check found (or didn't find). */
        finding: z.string().min(1),
      }),
    )
    .min(1)
    .max(50)
    .describe('Evidence: what was checked before concluding BLOCKED.'),
  /** Optional next steps the user could take to unblock. */
  next_steps: z.array(z.string().min(1)).max(10).optional(),
});

export type BlockedReport = z.infer<typeof BlockedReportSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// § 3c  TERMINAL OUTCOME  (Phase P0-D: Honest Termination)
//
//       A discriminated union of every possible way a chat task can terminate.
//       Unlike the legacy string `status` field on ChatResult, which conflates
//       semantically distinct states (e.g. BLOCKED rendered as "pass"),
//       TerminalOutcome preserves the exact reason for termination unchanged
//       through all layers — engine, event dispatch, structured output.
// ─────────────────────────────────────────────────────────────────────────────

/** Honest, non-conflatable terminal outcomes for chat tasks. */
export type TerminalOutcome =
  | 'VERIFIED_COMPLETE'      // task done, verifier passed
  | 'UNVERIFIED_PATCH'       // task done, no verifier or verifier skipped
  | 'BLOCKED_EXTERNAL'       // external blocker (missing dep, permission, etc.)
  | 'BLOCKED_POLICY'         // policy intervention stopped the task
  | 'BUDGET_EXHAUSTED'       // wall, cost, or token budget exhausted
  | 'CANCELLED'              // user cancelled
  | 'INFRA_FAILURE'          // provider/infra error
  | 'AGENT_FAILURE';         // agent logic error, crash, unrecoverable

/** Returns true for outcomes that represent a passing result. */
export function isPassingOutcome(o: TerminalOutcome): boolean {
  return o === 'VERIFIED_COMPLETE' || o === 'UNVERIFIED_PATCH';
}

/** Returns true for outcomes where the task was blocked. */
export function isBlockedOutcome(o: TerminalOutcome): boolean {
  return o === 'BLOCKED_EXTERNAL' || o === 'BLOCKED_POLICY';
}

/** Returns true for outcomes that represent a terminal failure (not passing, not blocked). */
export function isFailureOutcome(o: TerminalOutcome): boolean {
  return o === 'BUDGET_EXHAUSTED' || o === 'CANCELLED' || o === 'INFRA_FAILURE' || o === 'AGENT_FAILURE';
}

/** Human-readable label for a terminal outcome. */
export function terminalOutcomeLabel(o: TerminalOutcome): string {
  switch (o) {
    case 'VERIFIED_COMPLETE': return 'Verified — all checks passed';
    case 'UNVERIFIED_PATCH': return 'Completed — no verification performed';
    case 'BLOCKED_EXTERNAL': return 'Blocked — external constraint';
    case 'BLOCKED_POLICY': return 'Blocked — policy intervention';
    case 'BUDGET_EXHAUSTED': return 'Budget limit reached';
    case 'CANCELLED': return 'Cancelled by user';
    case 'INFRA_FAILURE': return 'Infrastructure error';
    case 'AGENT_FAILURE': return 'Agent error';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// § 4  QA VERDICT SCHEMA
//      Source: QA_Adversarial_Reviewer-v1.0.md § 5 (Verdict Report Format)
//              and § 7 (Failure Tag Reference)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Complete enumeration of all failure tags the QA agent may issue.
 * Organised by audit layer to match Section 7 of QA_Adversarial_Reviewer-v1.0.md.
 */
export const FailureTagSchema = z.enum([
  // Submission integrity
  'INCOMPLETE_SUBMISSION',

  // Evidence Gate
  'EVIDENCE-GATE',

  // SFDIPOT layers
  'SFDIPOT-S', // Structure
  'SFDIPOT-F', // Function
  'SFDIPOT-D', // Data
  'SFDIPOT-I', // Interfaces
  'SFDIPOT-P', // Platform
  'SFDIPOT-O', // Operations
  'SFDIPOT-T', // Time

  // NAMIT layers
  'NAMIT-N', // Null / undefined
  'NAMIT-A', // Array / collection bounds
  'NAMIT-M', // Multi-threading / concurrency (NOT arithmetic)
  'NAMIT-I', // Input validation
  'NAMIT-T', // Timing / race conditions

  // BCDP (Breaking Change Detection Protocol)
  'BCDP-MISSING', // No BCDP_ASSESSMENT when one is required
  'BCDP-BREAKING-UNMARKED', // Breaking change not flagged
  'BCDP-NO-MIGRATION', // Breaking change with no migration strategy
  'BCDP-NO-ROLLBACK', // No rollback strategy for irreversible change

  // Security
  'SECURITY-INJECTION', // SQL / command / XSS injection risk
  'SECURITY-SECRETS', // Secrets hardcoded or logged
  'SECURITY-AUTHZ', // Missing authorisation check
  'SECURITY-EXPOSURE', // Sensitive data leaked in response/log

  // Root Cause
  'ROOT-CAUSE-MISSING', // Bug fix with no root cause identified
  'ROOT-CAUSE-SHALLOW', // Root cause treats symptom, not cause
]);
export type FailureTag = z.infer<typeof FailureTagSchema>;

/**
 * A single failure finding in a REJECT verdict.
 */
export const QaFailureSchema = z.object({
  tag: FailureTagSchema,
  condition: z.string().min(1), // Exact condition — no fix, no suggestion
  confidence: z.number().transform(Math.round).pipe(z.number().int().min(1).max(5)),
  /**
   * Optional one-sentence directional hint the QA agent may emit alongside a
   * failure. Injected into the next SWE prompt to help escape anchor bias on
   * the specific failing condition (complements `proposed_fix_strategy` which
   * is a global direction; `fix_hint` is per-failure).
   */
  fix_hint: z.string().optional(),
});
export type QaFailure = z.infer<typeof QaFailureSchema>;

/**
 * PASS verdict — pipeline advances to CLI Executor.
 */
export const QaVerdictPassSchema = z.object({
  verdict: z.literal('PASS'),
  overall_confidence: z.number().transform(Math.round).pipe(z.number().int().min(1).max(5)),
  notes: z.string().optional(),
});
export type QaVerdictPass = z.infer<typeof QaVerdictPassSchema>;

/**
 * REJECT verdict — pipeline loops back to SWE Agent.
 * `failure_count` must equal `failures.length`.
 *
 * `proposed_fix_strategy` is an optional one-sentence DIRECTION (not a
 * detailed fix) the QA agent may emit to help the SWE Agent escape anchor
 * bias on repeated REJECT loops. It is machine-injected into the next SWE
 * prompt and is the only carve-out from the QA "no fix suggestions" rule.
 */
export const QaVerdictRejectSchema = z
  .object({
    verdict: z.literal('REJECT'),
    failure_count: z.number().int().min(1),
    failures: z.array(QaFailureSchema).min(1),
    overall_confidence: z.number().transform(Math.round).pipe(z.number().int().min(1).max(5)),
    proposed_fix_strategy: z.string().optional(),
  })
  .refine((v) => v.failure_count === v.failures.length, {
    message: 'failure_count must equal failures.length',
  });
export type QaVerdictReject = z.infer<typeof QaVerdictRejectSchema>;

/**
 * Union — parse any QA output with a single call.
 * z.union is used instead of z.discriminatedUnion because QaVerdictRejectSchema
 * uses .refine(), which produces ZodEffects rather than a plain ZodObject.
 * discriminatedUnion rejects ZodEffects members; z.union handles them correctly.
 */
export const QaVerdictSchema = z.preprocess(
  unwrapSingleObjectArray,
  z.union([QaVerdictPassSchema, QaVerdictRejectSchema]),
);
export type QaVerdict = z.infer<typeof QaVerdictSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// § 5  EXECUTOR REPORT SCHEMA
//      Source: CLI_Executor-v1.0.md § 7 (Terminal Report Format)
//              and § 9 (Halt Tag Reference)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Complete enumeration of halt tags the CLI Executor may emit.
 * [HALLUCINATED_OUTPUT] is first — highest priority halt.
 */
export const HaltTagSchema = z.enum([
  'HALLUCINATED_OUTPUT', // Executor generated/simulated tool output itself
  'STEP_VERIFICATION_FAIL', // Step ran but verification check failed
  'TOOL_CALL_ERROR', // Tool returned non-zero exit code or threw
  'AMBIGUOUS_PLAN', // MINIMAL_ACTION_SET step is underspecified
  'SCOPE_VIOLATION', // Step touches files/systems outside the plan scope
  'IRREVERSIBLE_DETECTED', // Non-reversible operation without INFRA_ACT gate
  'TEST_REGRESSION', // test_run detected a regression
  'VERIFICATION_TOOL_UNAVAILABLE', // Pipeline-owned verifier could not launch required runtime tool
  'REPAIR_REQUIRED_ARTIFACT_INVALID', // Post-execution runnable artifact gate failed
  'REPAIR_BUDGET_EXCEEDED', // Deterministic post-execution artifact repair could not converge
  'BUDGET_EXCEEDED', // Phase 1d: Token budget limit exceeded mid-execution
  'ACTIVATION_GATE_FAIL', // One of the four activation conditions not met
]);
export type HaltTag = z.infer<typeof HaltTagSchema>;

/**
 * Structured payload for governed sandbox/executor policy denials.
 * This is additive metadata; raw stdout/stderr/exit_code remain authoritative.
 */
export const StructuredDenialSchema = z.object({
  category: z.enum(['sandbox_policy', 'executor_policy', 'planning_restricted']),
  reason_code: z.string().min(1),
  message: z.string().min(1),
  tool: z.string().min(1).nullable(),
  active_mode: z.string().min(1).nullable(),
  required_mode: z.string().min(1).nullable(),
  evidence: z.array(z.string()).nullable(),
});
export type StructuredDenial = z.infer<typeof StructuredDenialSchema>;

/**
 * Structured lifecycle snapshot for read-only MCP requests.
 * Records the last meaningful phase reached by the simplified MCP harness.
 */
export const McpLifecycleSchema = z.object({
  phase: z.enum([
    'server_lookup',
    'spawn',
    'write_request',
    'await_response',
    'response_parse',
    'complete',
  ]),
  outcome: z.enum(['success', 'failure']),
  reason_code: z.string().min(1).nullable(),
  server: z.string().min(1),
  evidence: z.array(z.string()).nullable(),
});
export type McpLifecycle = z.infer<typeof McpLifecycleSchema>;

/**
 * Log entry for a single tool call — injected by the host environment.
 * `stdout` and `stderr` are the verbatim strings returned by the host.
 */
export const ToolCallLogSchema = z.object({
  step: z.number().int().min(1),
  tool: z.enum([
    'directory_list',
    'file_read',
    'file_write',
    'shell_exec',
    'test_run',
    'mcp_request',
    'mcp_resource_list',
    'mcp_resource_read',
    'mcp_prompt_list',
    'mcp_prompt_get',
    'mcp_tool_search',
    'web_search',
    'web_fetch',
    'plugin_tool',
    'audit_ui',
    'memory_store',
    'memory_query',
    'enter_plan_mode',
    'exit_plan_mode',
    'semantic_search',
    'grep',
    'glob',
    'workspace_symbol_search',
    'workspace_map',
    'git_context',
    'acquire_lock',
    'release_lock',
    'tool_catalog',
    'file_delete',
    'git_reset',
    'git_push',
    'get_code_outline',
    'find_code_definition',
    'find_code_references',
    'load_skill_manifest',
    'kg_trace_path',
    'kg_search_graph',
    'kg_impact_analysis',
    'kg_architecture',
    'kg_index_status',
    'lsp',
  ]),
  target: z.string().min(1),
  exit_code: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  denial: StructuredDenialSchema.optional(),
  mcp_lifecycle: McpLifecycleSchema.optional(),
  checkpoint_ids: z.array(z.string().min(1)).optional(),
  verified: z.boolean(), // Did the step's verification check pass?
  status: z.string().optional(),
  fingerprint: z.string().optional(),
  retry_forbidden: z.boolean().optional(),
});
export type ToolCallLog = z.infer<typeof ToolCallLogSchema>;

/**
 * Structured payload for EXECUTION_HALTED reports.
 */
export const PipelineErrorSchema = z.object({
  halt_tag: HaltTagSchema,
  halted_at_step: z.number().int().min(1),
  condition: z.string().min(1),
  last_tool_output: ToolCallLogSchema.optional(),
});
export type PipelineError = z.infer<typeof PipelineErrorSchema>;

/**
 * EXECUTION_COMPLETE — all steps verified; diff is ready.
 */
export const ExecutorReportCompleteSchema = z.object({
  status: z.literal('EXECUTION_COMPLETE'),
  stage_status: z
    .enum([
      'TOOL_EXECUTION_COMPLETE',
      'FILES_WRITTEN_UNVERIFIED',
      'EXECUTION_ATTEMPTED',
      'VERIFIER_FAILED',
      'REPAIR_ATTEMPT_FAILED',
      'REPAIRED_AND_COMPLETE',
    ])
    .optional(),
  pipeline_completion_note: z.string().optional(),
  steps_executed: z.number().int().min(1),
  tool_call_log: z.array(ToolCallLogSchema).min(1),
  diff_path: z.string().min(1), // Path to the Evidence Bundle 05_diff.patch
  execution_log_path: z.string().min(1), // Path to 04_execution_report.json
  artifact_gate: z.unknown().optional(),
  checkpoint_ids: z.array(z.string().min(1)).optional(),
  warnings: z.array(z.string()).optional(),
});
export type ExecutorReportComplete = z.infer<typeof ExecutorReportCompleteSchema>;

/**
 * EXECUTION_HALTED — a halt condition was triggered mid-pipeline.
 * The harness must not accept any partial output.
 */
export const ExecutorReportHaltedSchema = z.object({
  status: z.literal('EXECUTION_HALTED'),
  stage_status: z
    .enum(['EXECUTION_ATTEMPTED', 'VERIFIER_FAILED', 'REPAIR_ATTEMPT_FAILED'])
    .optional(),
  steps_executed: z.number().int().min(0),
  tool_call_log: z.array(ToolCallLogSchema), // May be empty if halt on step 1
  pipeline_error: PipelineErrorSchema,
  artifact_gate: z.unknown().optional(),
  checkpoint_ids: z.array(z.string().min(1)).optional(),
  warnings: z.array(z.string()).optional(),
});
export type ExecutorReportHalted = z.infer<typeof ExecutorReportHaltedSchema>;

/**
 * ACTIVATION_REFUSED — one or more of the four activation gate conditions
 * was not met; the Executor did not run any steps.
 */
export const ExecutorReportRefusedSchema = z.object({
  status: z.literal('ACTIVATION_REFUSED'),
  reason: z.string().min(1), // Which activation condition failed
  gate: HaltTagSchema, // Always ACTIVATION_GATE_FAIL
  checkpoint_ids: z.array(z.string().min(1)).optional(),
  warnings: z.array(z.string()).optional(),
});
export type ExecutorReportRefused = z.infer<typeof ExecutorReportRefusedSchema>;

/**
 * Discriminated union — parse any Executor terminal report with a single call.
 */
export const ExecutorReportSchema = z.discriminatedUnion('status', [
  ExecutorReportCompleteSchema,
  ExecutorReportHaltedSchema,
  ExecutorReportRefusedSchema,
]);
export type ExecutorReport = z.infer<typeof ExecutorReportSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// § 6  EXECUTOR TURN SCHEMA  (Stateless Text-Loop — Stage 4)
//
//      Stage 4 runs a stateless ping-pong loop via runWithFallback instead of
//      a stateful Anthropic SDK conversation. Each round-trip the executor
//      emits exactly one of:
//        • a tool call  (type: "tool_call")  — host executes the tool and
//          appends the result to the executionHistory string.
//        • a completion (type: "completion") — host terminates the loop.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single tool-call turn from the executor.
 *
 * All tool-specific argument fields are optional at this level; the pipeline
 * re-validates with the strict `ToolCallRequestSchema` (which enforces the
 * per-tool required fields via its discriminated union on `tool`) before
 * passing the request to `executeTool`. This two-pass approach lets
 * `ExecutorTurnSchema` use a simple `discriminatedUnion` on `type`.
 */
export const ExecutorTurnToolCallSchema = z.object({
  type: z.literal('tool_call'),
  thinking: LooseStringSchema.describe(
    'Internal monologue and verification checks before emitting the tool call.',
  ),
  tool: z.enum([
    'directory_list',
    'file_read',
    'file_write',
    'shell_exec',
    'test_run',
    'mcp_request',
    'mcp_resource_list',
    'mcp_resource_read',
    'mcp_prompt_list',
    'mcp_prompt_get',
    'mcp_tool_search',
    'web_search',
    'web_fetch',
    'plugin_tool',
    'audit_ui',
    'memory_store',
    'memory_query',
    'enter_plan_mode',
    'exit_plan_mode',
    'semantic_search',
    'grep',
    'glob',
    'workspace_symbol_search',
    'workspace_map',
    'git_context',
    'acquire_lock',
    'release_lock',
    'tool_catalog',
    'file_delete',
    'git_reset',
    'git_push',
    'get_code_outline',
    'find_code_definition',
    'find_code_references',
    'load_skill_manifest',
  ]),
  // directory_list / file_read / file_write
  path: z.string().max(4096).optional(),
  content: z.string().max(10_485_760).optional(),
  // shell_exec / test_run
  command: z.string().max(10_240).optional(),
  working_directory: z.string().max(4096).optional(),
  timeout_seconds: z.number().int().optional(),
  // mcp_request
  server: z.string().max(1024).optional(),
  query: z.string().max(1024).optional(),
  uri: z.string().max(4096).optional(),
  name: z.string().max(1024).optional(),
  arguments: z.record(z.string(), z.unknown()).optional(),
  schema_limit: z.number().int().optional(),
  // web_fetch
  url: z.string().max(4096).optional(),
  max_bytes: z.number().int().optional(),
  // plugin_tool
  plugin: z.string().max(1024).optional(),
  input: z.record(z.string(), z.unknown()).optional(),
  // audit_ui
  run_id: z.string().max(1024).optional(),
  // memory_store / memory_query
  key: z.string().max(1024).optional(),
  value: z.string().max(1_048_576).optional(),
  // semantic_search
  limit: z.number().int().optional(),
  max_results: z.number().int().optional(),
  max_matches: z.number().int().optional(),
  // acquire_lock / release_lock
  reason: z.string().max(4096).optional(),
  ttl_sec: z.number().int().optional(),
  // tool_catalog / git_context
  category: z.string().max(256).optional(),
  mutating: z.boolean().optional(),
  format: z.string().max(256).optional(),
});
export type ExecutorTurnToolCall = z.infer<typeof ExecutorTurnToolCallSchema>;

/**
 * A terminal completion signal from the executor — one of three statuses.
 *
 * TypeScript narrows correctly on `status` even though the Zod schema uses
 * `z.union` (required because `z.discriminatedUnion` does not accept members
 * that are themselves union types).
 */
export const ExecutorTurnCompletionSchema = z.union([
  z.object({
    type: z.literal('completion'),
    status: z.literal('EXECUTION_COMPLETE'),
  }),
  z.object({
    type: z.literal('completion'),
    status: z.literal('PARTIAL'),
  }),
  z.object({
    type: z.literal('completion'),
    status: z.literal('EXECUTION_HALTED'),
    halt_tag: HaltTagSchema,
    condition: z.string().min(1),
  }),
  z.object({
    type: z.literal('completion'),
    status: z.literal('ACTIVATION_REFUSED'),
    reason: z.string().min(1),
  }),
]);
export type ExecutorTurnCompletion = z.infer<typeof ExecutorTurnCompletionSchema>;

/**
 * Union of all valid executor turn shapes.
 * Passed to `runWithFallback` on every iteration of the Stage 4 loop.
 */
export const ExecutorTurnSchema = z.preprocess(
  normalizeExecutorTurn,
  z.union([ExecutorTurnToolCallSchema, ExecutorTurnCompletionSchema]),
);
export type ExecutorTurn = z.infer<typeof ExecutorTurnSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// § 7  PIPELINE STAGE UNION  (convenience re-exports for the harness)
// ─────────────────────────────────────────────────────────────────────────────

/** All schemas keyed by pipeline stage — used by the harness dispatcher. */
export const BabelSchemas = {
  orchestratorManifest: OrchestratorManifestSchema,
  orchestratorErrorHalt: OrchestratorErrorHaltSchema,
  swePlan: SwePlanSchema,
  qaVerdict: QaVerdictSchema,
  executorReport: ExecutorReportSchema,
} as const;
// ─────────────────────────────────────────────────────────────────────────────
// § 7  UTILITY & MAINTENANCE SCHEMAS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stage 4 Context Compaction — dense summary of executor history.
 */
export const CompactionSummarySchema = z.object({
  summary_text: z
    .string()
    .describe('A dense, high-fidelity summary of the tool execution history.'),
  applied_changes: z.array(z.string()).describe('List of files modified so far.'),
  current_state: z.string().describe('Current status of the task completion.'),
});
export type CompactionSummary = z.infer<typeof CompactionSummarySchema>;

/**
 * Long-term Project Memory — extracted from successful run logs.
 */
export const MemoryExtractionSchema = z.object({
  memories: z
    .array(
      z.object({
        topic: z.string(),
        memory_content: z.string(),
        impact_severity: z.enum(['low', 'medium', 'high']),
        source_run_id: z.string(),
      }),
    )
    .max(50),
  reasoning: z.string(),
});
export type MemoryExtraction = z.infer<typeof MemoryExtractionSchema>;

/**
 * Stage 0 Surgical Pruning — classifies files as critical or supplementary.
 */
export const PruningAnalysisSchema = z.object({
  critical_files: z.array(z.string()).describe('Absolute paths of files required at 100% volume.'),
  supplementary_files: z
    .array(
      z.object({
        path: z.string(),
        summary: z.string().describe('1-sentence purpose of the file for the stub.'),
      }),
    )
    .describe('Files to be stubbed to save tokens.'),
  reasoning: z.string(),
});
export type PruningAnalysis = z.infer<typeof PruningAnalysisSchema>;

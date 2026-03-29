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
  'Claude_AntiEager',
  'Codex_Balanced',
  'Codex_UltraTerse',
  'Gemini_LongContext',
]);
export type ModelAdapter = z.infer<typeof ModelAdapterSchema>;

export const PlanTypeSchema = z.enum([
  'EVIDENCE_REQUEST',
  'IMPLEMENTATION_PLAN',
]);
export type PlanType = z.infer<typeof PlanTypeSchema>;

export const PipelineModeSchema = z.enum([
  'direct',     // Orchestrator + Domain only
  'verified',   // + QA Reviewer
  'autonomous', // + QA Reviewer + CLI Executor
  'manual',     // Export SWE prompt for human completion and pause
]);
export type PipelineMode = z.infer<typeof PipelineModeSchema>;

export const OrchestratorVersionSchema = z.enum(['8.0', '9.0']);
export type OrchestratorVersion = z.infer<typeof OrchestratorVersionSchema>;

/**
 * The three CLI backends Babel can route to.
 * Stored in `worker_configuration.assigned_model` of the Orchestrator manifest
 * and consumed by `runWithFallback` to select the correct CLI runner.
 */
export const TargetModelSchema = z.enum(['Claude', 'Codex', 'Gemini']);
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
  task_summary:        z.string().min(1),
  task_category:       z.string().min(1),   // Frontend | Backend | Mobile | Compliance | DevOps | Research
  secondary_category:  z.string().nullable(),
  task_overlay_ids:    z.array(z.string()).default([]), // Legacy v8 field; v9 overlay selection lives in instruction_stack
  complexity_estimate: z.string().min(1),   // Low | Medium | High
  pipeline_mode:       PipelineModeSchema,
  ambiguity_note:      z.string().nullable(),
  /**
   * Optional 0–1 confidence score for the routing decision emitted by the
   * orchestrator. Pipeline logs a warning when present and below 0.8.
   * Foundation for future semantic validator cascade (Phase 3).
   */
  routing_confidence:  z.number().min(0).max(1).optional(),
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

const ContainerModelSchema = z.enum([
  'chat',
  'project',
  'gem',
  'canvas',
  'artifact',
]);

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

const OutputSurfaceSchema = z.enum([
  'none',
  'canvas',
  'artifact',
  'project_share',
  'chat_share',
]);

const TrustLevelSchema = z.enum([
  'high',
  'medium',
  'low',
]);

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

export const PlatformProfileSchema = z.object({
  profile_source:   ProfileSourceSchema.default(DEFAULT_PLATFORM_PROFILE.profile_source),
  client_surface:   ClientSurfaceSchema.default(DEFAULT_PLATFORM_PROFILE.client_surface),
  container_model:  ContainerModelSchema.nullable().default(DEFAULT_PLATFORM_PROFILE.container_model),
  ingestion_mode:   IngestionModeSchema.default(DEFAULT_PLATFORM_PROFILE.ingestion_mode),
  repo_write_mode:  RepoWriteModeSchema.nullable().default(DEFAULT_PLATFORM_PROFILE.repo_write_mode),
  output_surface:   z.array(OutputSurfaceSchema).default([...DEFAULT_PLATFORM_PROFILE.output_surface]),
  platform_modes:   z.array(z.string()).default([...DEFAULT_PLATFORM_PROFILE.platform_modes]),
  execution_trust:  TrustLevelSchema.nullable().default(DEFAULT_PLATFORM_PROFILE.execution_trust),
  data_trust:       TrustLevelSchema.nullable().default(DEFAULT_PLATFORM_PROFILE.data_trust),
  freshness_trust:  TrustLevelSchema.nullable().default(DEFAULT_PLATFORM_PROFILE.freshness_trust),
  action_trust:     TrustLevelSchema.nullable().default(DEFAULT_PLATFORM_PROFILE.action_trust),
  approval_mode:    ApprovalModeSchema.default(DEFAULT_PLATFORM_PROFILE.approval_mode),
}).default(DEFAULT_PLATFORM_PROFILE);
export type PlatformProfile = z.infer<typeof PlatformProfileSchema>;

/**
 * The `handoff_payload` mirrors the actual object emitted by the Orchestrator.
 * `user_request` is the verbatim user prompt; `system_directive` instructs the
 * Worker Agent to load the prompt_manifest files and enter PLAN state.
 */
export const HandoffPayloadSchema = z.object({
  user_request:     z.string().min(1),
  system_directive: z.string().min(1),
});
export type HandoffPayload = z.infer<typeof HandoffPayloadSchema>;

export const ResolutionPolicySchema = z.object({
  apply_domain_default_skills: z.boolean().default(true),
  expand_skill_dependencies: z.boolean().default(true),
  strict_conflict_mode: z.enum(['error', 'warn']).default('error'),
});
export type ResolutionPolicy = z.infer<typeof ResolutionPolicySchema>;

export const BudgetDiagnosticSeveritySchema = z.enum(['info', 'warn', 'severe']);
export type BudgetDiagnosticSeverity = z.infer<typeof BudgetDiagnosticSeveritySchema>;

export const BudgetDiagnosticCodeSchema = z.enum([
  'total_token_budget',
  'missing_token_budget',
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
  token_budget_by_entry: z.record(z.number().int().nonnegative()).optional(),
  budget_policy: BudgetPolicySchema.optional(),
  budget_diagnostics: z.array(BudgetDiagnosticSchema).optional(),
  warnings: z.array(z.string()).optional(),
});
export type CompiledArtifacts = z.infer<typeof CompiledArtifactsSchema>;

export const RuntimeTelemetrySchema = z.object({
  orchestrator_version: OrchestratorVersionSchema,
  domain_id: z.string().min(1),
  skill_ids: z.array(z.string().min(1)),
  model_adapter_id: z.string().min(1),
  selected_entry_ids: z.array(z.string().min(1)),
  token_budget_total: z.number().int().nonnegative().nullable(),
  token_budget_missing_count: z.number().int().nonnegative(),
  budget_warning_severity: BudgetDiagnosticSeveritySchema.nullable(),
  budget_policy_enabled: z.boolean(),
  pipeline_mode: PipelineModeSchema,
  qa_verdict: z.enum(['PASS', 'REJECT']).nullable(),
  qa_failure_tags: z.array(z.string().min(1)),
  final_outcome: z.string().nullable(),
  routing_confidence:        z.number().min(0).max(1).optional(),
  routing_confidence_band:   z.enum(['high', 'medium', 'low']).optional(),
  routing_action:            z.enum(['accepted', 'downgraded', 'validated', 'validator_still_low']).optional(),
  routing_validator_used:    z.boolean().optional(),
  routing_validator_improved: z.boolean().nullable().optional(),
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
export const OrchestratorManifestSchema = z.object({
  orchestrator_version: OrchestratorVersionSchema,
  target_project:       z.string(),                 // example_saas_backend | example_llm_router | example_web_audit | example_mobile_suite | global
  target_project_path:  z.string().optional(),      // Absolute Windows path, may be omitted
  session_id:           z.string().min(1).optional(),
  session_start_path:   z.string().min(1).optional(),
  local_learning_root:  z.string().min(1).optional(),
  analysis:             OrchestrationAnalysisSchema,
  platform_profile:     PlatformProfileSchema,
  worker_configuration: z.object({
    assigned_model: TargetModelSchema,
    rationale:      z.string().min(1),
  }),
  compilation_state: CompilationStateSchema.optional(),
  instruction_stack: InstructionStackSchema.optional(),
  resolution_policy: ResolutionPolicySchema.optional(),
  compiled_artifacts: CompiledArtifactsSchema.optional(),
  runtime_telemetry: RuntimeTelemetrySchema.optional(),
  prompt_manifest:  z.array(z.string()),            // Ordered absolute Windows path strings
  handoff_payload:  HandoffPayloadSchema,
}).superRefine((value, ctx) => {
  const isV9 = value.orchestrator_version === '9.0';
  const hasInstructionStack = value.instruction_stack !== undefined;

  if (isV9 && !hasInstructionStack) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['instruction_stack'],
      message: 'instruction_stack is required when orchestrator_version is 9.0',
    });
  }

  if (hasInstructionStack && value.resolution_policy === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['resolution_policy'],
      message: 'resolution_policy is required when instruction_stack is present',
    });
  }

  if (hasInstructionStack && value.compilation_state === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['compilation_state'],
      message: 'compilation_state is required when instruction_stack is present',
    });
  }

  if (!hasInstructionStack && value.prompt_manifest.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['prompt_manifest'],
      message: 'legacy manifests must provide a non-empty prompt_manifest',
    });
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
      if (compiledPromptManifest.length !== value.prompt_manifest.length ||
          compiledPromptManifest.some((filePath, index) => filePath !== value.prompt_manifest[index])) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['compiled_artifacts', 'prompt_manifest'],
          message: 'compiled_artifacts.prompt_manifest must mirror the root prompt_manifest',
        });
      }
    }
  }
});
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
  error_halt:           z.literal(true),
  error_reason:         z.string().min(1),
  blocked_request:      z.string().min(1),
  prompt_manifest:      z.array(z.unknown()),
});
export type OrchestratorErrorHalt = z.infer<typeof OrchestratorErrorHaltSchema>;

// Union for parsing unknown Orchestrator output.
// z.union (not z.discriminatedUnion) is required here because
// discriminatedUnion only accepts plain ZodObject members, and
// OrchestratorManifestSchema does not carry an `error_halt` field.
// The pipeline detects which variant was returned by checking
// `'error_halt' in output && output.error_halt === true`.
export const OrchestratorOutputSchema = z.union([
  OrchestratorErrorHaltSchema,
  OrchestratorManifestSchema,
]);

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
  contracts_modified:    z.array(z.string()),  // List of affected contracts
  breaking_change:       z.boolean(),
  migration_strategy:    z.string().optional(), // Required if breaking_change = true
  rollback_available:    z.boolean(),
  downstream_consumers:  z.array(z.string()),
});
export type BcdpAssessment = z.infer<typeof BcdpAssessmentSchema>;

/**
 * A single step in the MINIMAL_ACTION_SET.
 * Each step maps to exactly one tool call the CLI Executor will emit.
 */
export const ActionStepSchema = z.object({
  step:         z.number().int().min(1),
  description:  z.string().min(1),
  tool:         z.enum(['file_read', 'file_write', 'shell_exec', 'test_run', 'mcp_request', 'audit_ui', 'memory_store', 'memory_query']),
  target:       z.string().min(1),   // File path or shell command
  rationale:    z.string().min(1),   // Why this step is in the minimal set
  reversible:   z.boolean(),
  verification: z.string().min(1),   // How the CLI Executor confirms this step succeeded
});
export type ActionStep = z.infer<typeof ActionStepSchema>;

/**
 * Full SWE Agent PLAN — must pass QA before CLI Executor activates.
 */
export const SwePlanSchema = z.object({
  plan_version:      z.string().catch("1.0"),  // e.g., "1.0"; .catch handles missing/undefined from models
  // Optional for backward compatibility with older plans; pipeline normalizes if missing.
  plan_type:         PlanTypeSchema.optional(),
  task_summary:      z.string().min(1),
  known_facts:       z.array(z.string()).min(1),
  assumptions:       z.array(z.string()),
  risks:             z.array(z.object({
    risk:        z.string().min(1),
    likelihood:  z.enum(['low', 'medium', 'high']),
    mitigation:  z.string().min(1),
  })),
  minimal_action_set: z.array(ActionStepSchema).min(1),
  bcdp_assessment:    BcdpAssessmentSchema.optional(),  // Required if any contract is touched
  root_cause:         z.string().catch("N/A — not provided"),  // For bug fixes; may be "N/A — feature request"; .catch handles missing/undefined from models
  out_of_scope:       z.array(z.string()), // Explicit list of what this plan does NOT do
});
export type SwePlan = z.infer<typeof SwePlanSchema>;

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
  'SFDIPOT-S',  // Structure
  'SFDIPOT-F',  // Function
  'SFDIPOT-D',  // Data
  'SFDIPOT-I',  // Interfaces
  'SFDIPOT-P',  // Platform
  'SFDIPOT-O',  // Operations
  'SFDIPOT-T',  // Time

  // NAMIT layers
  'NAMIT-N',  // Null / undefined
  'NAMIT-A',  // Array / collection bounds
  'NAMIT-M',  // Multi-threading / concurrency (NOT arithmetic)
  'NAMIT-I',  // Input validation
  'NAMIT-T',  // Timing / race conditions

  // BCDP (Breaking Change Detection Protocol)
  'BCDP-MISSING',           // No BCDP_ASSESSMENT when one is required
  'BCDP-BREAKING-UNMARKED', // Breaking change not flagged
  'BCDP-NO-MIGRATION',      // Breaking change with no migration strategy
  'BCDP-NO-ROLLBACK',       // No rollback strategy for irreversible change

  // Security
  'SECURITY-INJECTION',     // SQL / command / XSS injection risk
  'SECURITY-SECRETS',       // Secrets hardcoded or logged
  'SECURITY-AUTHZ',         // Missing authorisation check
  'SECURITY-EXPOSURE',      // Sensitive data leaked in response/log

  // Root Cause
  'ROOT-CAUSE-MISSING',     // Bug fix with no root cause identified
  'ROOT-CAUSE-SHALLOW',     // Root cause treats symptom, not cause
]);
export type FailureTag = z.infer<typeof FailureTagSchema>;

/**
 * A single failure finding in a REJECT verdict.
 */
export const QaFailureSchema = z.object({
  tag:        FailureTagSchema,
  condition:  z.string().min(1),   // Exact condition — no fix, no suggestion
  confidence: z.number().transform(Math.round).pipe(z.number().int().min(1).max(5)),
  /**
   * Optional one-sentence directional hint the QA agent may emit alongside a
   * failure. Injected into the next SWE prompt to help escape anchor bias on
   * the specific failing condition (complements `proposed_fix_strategy` which
   * is a global direction; `fix_hint` is per-failure).
   */
  fix_hint:   z.string().optional(),
});
export type QaFailure = z.infer<typeof QaFailureSchema>;

/**
 * PASS verdict — pipeline advances to CLI Executor.
 */
export const QaVerdictPassSchema = z.object({
  verdict:           z.literal('PASS'),
  overall_confidence: z.number().transform(Math.round).pipe(z.number().int().min(1).max(5)),
  notes:             z.string().optional(),
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
export const QaVerdictRejectSchema = z.object({
  verdict:               z.literal('REJECT'),
  failure_count:         z.number().int().min(1),
  failures:              z.array(QaFailureSchema).min(1),
  overall_confidence:    z.number().transform(Math.round).pipe(z.number().int().min(1).max(5)),
  proposed_fix_strategy: z.string().optional(),
}).refine(
  v => v.failure_count === v.failures.length,
  { message: 'failure_count must equal failures.length' },
);
export type QaVerdictReject = z.infer<typeof QaVerdictRejectSchema>;

/**
 * Union — parse any QA output with a single call.
 * z.union is used instead of z.discriminatedUnion because QaVerdictRejectSchema
 * uses .refine(), which produces ZodEffects rather than a plain ZodObject.
 * discriminatedUnion rejects ZodEffects members; z.union handles them correctly.
 */
export const QaVerdictSchema = z.union([
  QaVerdictPassSchema,
  QaVerdictRejectSchema,
]);
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
  'HALLUCINATED_OUTPUT',   // Executor generated/simulated tool output itself
  'STEP_VERIFICATION_FAIL', // Step ran but verification check failed
  'TOOL_CALL_ERROR',        // Tool returned non-zero exit code or threw
  'AMBIGUOUS_PLAN',         // MINIMAL_ACTION_SET step is underspecified
  'SCOPE_VIOLATION',        // Step touches files/systems outside the plan scope
  'IRREVERSIBLE_DETECTED',  // Non-reversible operation without INFRA_ACT gate
  'TEST_REGRESSION',        // test_run detected a regression
  'ACTIVATION_GATE_FAIL',   // One of the four activation conditions not met
]);
export type HaltTag = z.infer<typeof HaltTagSchema>;

/**
 * Log entry for a single tool call — injected by the host environment.
 * `stdout` and `stderr` are the verbatim strings returned by the host.
 */
export const ToolCallLogSchema = z.object({
  step:       z.number().int().min(1),
  tool:       z.enum(['file_read', 'file_write', 'shell_exec', 'test_run', 'mcp_request', 'audit_ui', 'memory_store', 'memory_query']),
  target:     z.string().min(1),
  exit_code:  z.number().int(),
  stdout:     z.string(),
  stderr:     z.string(),
  verified:   z.boolean(),  // Did the step's verification check pass?
});
export type ToolCallLog = z.infer<typeof ToolCallLogSchema>;

/**
 * Structured payload for EXECUTION_HALTED reports.
 */
export const PipelineErrorSchema = z.object({
  halt_tag:         HaltTagSchema,
  halted_at_step:   z.number().int().min(1),
  condition:        z.string().min(1),
  last_tool_output: ToolCallLogSchema.optional(),
});
export type PipelineError = z.infer<typeof PipelineErrorSchema>;

/**
 * EXECUTION_COMPLETE — all steps verified; diff is ready.
 */
export const ExecutorReportCompleteSchema = z.object({
  status:           z.literal('EXECUTION_COMPLETE'),
  steps_executed:   z.number().int().min(1),
  tool_call_log:    z.array(ToolCallLogSchema).min(1),
  diff_path:        z.string().min(1),   // Path to the Evidence Bundle 05_diff.patch
  execution_log_path: z.string().min(1), // Path to 04_execution_report.json
  warnings:         z.array(z.string()).optional(),
});
export type ExecutorReportComplete = z.infer<typeof ExecutorReportCompleteSchema>;

/**
 * EXECUTION_HALTED — a halt condition was triggered mid-pipeline.
 * The harness must not accept any partial output.
 */
export const ExecutorReportHaltedSchema = z.object({
  status:         z.literal('EXECUTION_HALTED'),
  steps_executed: z.number().int().min(0),
  tool_call_log:  z.array(ToolCallLogSchema),  // May be empty if halt on step 1
  pipeline_error: PipelineErrorSchema,
  warnings:       z.array(z.string()).optional(),
});
export type ExecutorReportHalted = z.infer<typeof ExecutorReportHaltedSchema>;

/**
 * ACTIVATION_REFUSED — one or more of the four activation gate conditions
 * was not met; the Executor did not run any steps.
 */
export const ExecutorReportRefusedSchema = z.object({
  status:  z.literal('ACTIVATION_REFUSED'),
  reason:  z.string().min(1),  // Which activation condition failed
  gate:    HaltTagSchema,      // Always ACTIVATION_GATE_FAIL
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
  type:              z.literal('tool_call'),
  tool:              z.enum(['file_read', 'file_write', 'shell_exec', 'test_run', 'mcp_request', 'audit_ui', 'memory_store', 'memory_query']),
  // file_read / file_write
  path:              z.string().optional(),
  content:           z.string().optional(),
  // shell_exec / test_run
  command:           z.string().optional(),
  working_directory: z.string().optional(),
  timeout_seconds:   z.number().int().optional(),
  // mcp_request
  server:            z.string().optional(),
  query:             z.string().optional(),
  // audit_ui
  url:               z.string().optional(),
  run_id:            z.string().optional(),
  // memory_store / memory_query
  key:               z.string().optional(),
  value:             z.string().optional(),
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
    type:   z.literal('completion'),
    status: z.literal('EXECUTION_COMPLETE'),
  }),
  z.object({
    type:      z.literal('completion'),
    status:    z.literal('EXECUTION_HALTED'),
    halt_tag:  HaltTagSchema,
    condition: z.string().min(1),
  }),
  z.object({
    type:   z.literal('completion'),
    status: z.literal('ACTIVATION_REFUSED'),
    reason: z.string().min(1),
  }),
]);
export type ExecutorTurnCompletion = z.infer<typeof ExecutorTurnCompletionSchema>;

/**
 * Union of all valid executor turn shapes.
 * Passed to `runWithFallback` on every iteration of the Stage 4 loop.
 */
export const ExecutorTurnSchema = z.union([
  ExecutorTurnToolCallSchema,
  ExecutorTurnCompletionSchema,
]);
export type ExecutorTurn = z.infer<typeof ExecutorTurnSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// § 7  PIPELINE STAGE UNION  (convenience re-exports for the harness)
// ─────────────────────────────────────────────────────────────────────────────

/** All schemas keyed by pipeline stage — used by the harness dispatcher. */
export const BabelSchemas = {
  orchestratorManifest: OrchestratorManifestSchema,
  orchestratorErrorHalt: OrchestratorErrorHaltSchema,
  swePlan:              SwePlanSchema,
  qaVerdict:            QaVerdictSchema,
  executorReport:       ExecutorReportSchema,
} as const;

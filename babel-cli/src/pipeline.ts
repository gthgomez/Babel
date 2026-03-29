/**
 * pipeline.ts — Babel Multi-Agent State Machine
 *
 * Implements the four-stage pipeline:
 *   Stage 1: Orchestrator     — routes task, selects domain + model, emits manifest
 *   Stage 2: SWE Agent        — produces a MINIMAL_ACTION_SET plan
 *   Stage 3: QA Reviewer      — adversarially audits plan (loop up to MAX_LOOPS)
 *   Stage 4: CLI Executor     — multi-turn tool execution loop (autonomous mode)
 *
 * Execution model:
 *   All four stages use `runWithFallback` (single-turn: CLI → API waterfall).
 *   Stage 4 maintains a stateless text-loop: execution history is accumulated
 *   as a string and appended to the prompt on every iteration so the stateless
 *   runner can see what has already been executed.
 *
 * Path resolution:
 *   All prompt file paths are relative to BABEL_ROOT (two directories above this
 *   file: babel-cli/src/ → babel-cli/ → Babel/).
 *   Override with the BABEL_ROOT environment variable.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath }          from 'node:url';
import { SpanStatusCode }         from '@opentelemetry/api';
import { z }                      from 'zod';

import { getHighestBudgetSeverity } from './budgetPolicy.js';
import { compileContext,
         resolveInstructionStackManifest } from './compiler.js';
import {
  getRoutingConfidenceBand,
  getValidatorTierIndex,
  isConfidenceGateEnabled,
}                                  from './confidenceGate.js';
import { runWithFallback }        from './execute.js';
import { EvidenceBundle }         from './evidence.js';
import { truncateLogs }           from './utils/truncate.js';
import { collectHarnessMetadata } from './telemetry/metadata.js';
import { PipelineTrace, endSpan } from './telemetry/tracing.js';
import { executeTool,
         ToolCallRequestSchema,
         DRY_RUN }                from './localTools.js';
import {
  OrchestratorManifestSchema,
  OrchestratorErrorHaltSchema,
  SwePlanSchema,
  QaVerdictSchema,
  ExecutorTurnSchema,
  ExecutorReportSchema,
  PipelineErrorSchema,
} from './schemas/agentContracts.js';

import type {
  BudgetDiagnostic,
  HaltTag,
  OrchestratorManifest,
  PipelineMode,
  RuntimeTelemetry,
  SwePlan,
  QaVerdictReject,
  ToolCallLog,
  ExecutorTurnCompletion,
} from './schemas/agentContracts.js';

import type { TargetModel } from './execute.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

/** Absolute path to the Babel prompt library root (parent of babel-cli/). */
const BABEL_ROOT     = process.env['BABEL_ROOT']     ?? resolve(__dirname, '../..');
const BABEL_RUNS_DIR = process.env['BABEL_RUNS_DIR'] ?? join(BABEL_ROOT, 'runs');

/** Maximum SWE → QA iterations before halting with an error. */
const MAX_SWE_QA_LOOPS    = 3;
/** Maximum multi-turn rounds in the executor loop. */
const MAX_EXECUTOR_TURNS  = 20;
/** Maximum times the SWE Agent may request evidence before the pipeline halts. */
const MAX_EVIDENCE_LOOPS  = 2;
const OBJECTIVE_PREFIX    = 'OBJECTIVE: ';
const DEFAULT_ORCHESTRATOR_VERSION = 'v9' as const;
type OrchestratorRuntimeVersion = 'v8' | 'v9';

// ─── Prompt file path sets (relative to BABEL_ROOT) ──────────────────────────

const ORCHESTRATOR_PATHS_V8 = [
  '01_Behavioral_OS/OLS-v7-Core-Universal.md',
  '01_Behavioral_OS/OLS-v7-Guard-Auto.md',
  '00_System_Router/OLS-v8-Orchestrator.md',
];

const ORCHESTRATOR_PATHS_V9 = [
  '01_Behavioral_OS/OLS-v7-Core-Universal.md',
  '01_Behavioral_OS/OLS-v7-Guard-Auto.md',
  '00_System_Router/OLS-v9-Orchestrator.md',
];

const QA_PATHS = [
  '01_Behavioral_OS/OLS-v7-Core-Universal.md',
  '01_Behavioral_OS/OLS-v7-Guard-Auto.md',
  '02_Domain_Architects/QA_Adversarial_Reviewer-v1.0.md',
];

const EXECUTOR_PATHS = [
  '01_Behavioral_OS/OLS-v7-Core-Universal.md',
  '01_Behavioral_OS/OLS-v7-Guard-Auto.md',
  '02_Domain_Architects/CLI_Executor-v1.0.md',
];

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PipelineOptions {
  /** Override the project detected by the Orchestrator. */
  project?: string;
  /** Override the pipeline mode from the Orchestrator manifest. */
  mode?:    'direct' | 'verified' | 'autonomous' | 'manual';
  /** Select which orchestrator contract Stage 1 should use. */
  orchestratorVersion?: OrchestratorRuntimeVersion;
  /** Skip Orchestrator model-selection and force a specific worker model. */
  modelOverride?: string;
  /** Associate the raw evidence bundle with a Local Mode session ID. */
  sessionId?: string;
  /** Optional session-start artifact path for exact protocol reconciliation. */
  sessionStartPath?: string;
  /** Optional Local Mode runtime root for exact protocol reconciliation. */
  localLearningRoot?: string;
}

export interface PipelineResult {
  runDir:   string;
  manifest: OrchestratorManifest;
  plan:     SwePlan | null;
  status:   'COMPLETE' | 'QA_REJECTED_MAX_LOOPS' | 'EXECUTOR_HALTED' | 'EVIDENCE_LOOP_EXCEEDED' | 'MANUAL_BRIDGE_REQUIRED' | 'MANUAL_PLAN_INVALID';
  manualPromptPath?: string;
  repairPromptPath?: string;
  errors?: string[];
}

interface RuntimeCompiledArtifacts {
  selected_entry_ids: string[];
  prompt_manifest: string[];
  token_budget_total?: number;
  token_budget_missing?: string[];
  token_budget_by_entry?: Record<string, number>;
  budget_policy?: {
    enabled: boolean;
  };
  budget_diagnostics?: BudgetDiagnostic[];
  warnings?: string[];
}

// ─── Logger ───────────────────────────────────────────────────────────────────

function log(msg: string): void {
  const t = new Date().toLocaleTimeString('en-US', { hour12: false });
  console.log(`[babel] ${t}  ${msg}`);
}

function logDetail(msg: string): void {
  const t = new Date().toLocaleTimeString('en-US', { hour12: false });
  console.log(`[babel] ${t}    ${msg}`);
}

// ─── Path helpers ─────────────────────────────────────────────────────────────

function abs(relativePaths: readonly string[]): string[] {
  return relativePaths.map(p => join(BABEL_ROOT, p));
}

function resolveOrchestratorVersion(
  requestedVersion?: string,
): OrchestratorRuntimeVersion {
  const rawVersion =
    requestedVersion?.trim() ||
    process.env['BABEL_ORCHESTRATOR_VERSION']?.trim() ||
    DEFAULT_ORCHESTRATOR_VERSION;

  if (rawVersion === 'v8' || rawVersion === 'v9') {
    return rawVersion;
  }

  throw new Error(
    `Invalid orchestrator version "${rawVersion}". Valid values: v8, v9.`,
  );
}

function getOrchestratorPaths(
  version: OrchestratorRuntimeVersion,
): string[] {
  return version === 'v9' ? ORCHESTRATOR_PATHS_V9 : ORCHESTRATOR_PATHS_V8;
}

function inferProjectRoot(manifest: OrchestratorManifest): string | undefined {
  const explicit = manifest.target_project_path?.trim();
  if (explicit && explicit.length > 0) {
    return explicit;
  }

  if (manifest.target_project === 'global') {
    return undefined;
  }

  const candidate = resolve(BABEL_ROOT, '..', manifest.target_project);
  return existsSync(candidate) ? candidate : undefined;
}

function configureToolProjectRoot(manifest: OrchestratorManifest): void {
  const root = inferProjectRoot(manifest);
  if (!root) return;
  process.env['BABEL_PROJECT_ROOT'] = root;
  logDetail(`Tool project root: ${root}`);
}

function writeLatestRunPointers(runDir: string, project: string): void {
  const payload = {
    run_dir: runDir,
    project,
    created_at: new Date().toISOString(),
  };
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  const safeProject = project.replace(/[^a-zA-Z0-9_-]/g, '_');

  try {
    writeFileSync(join(BABEL_RUNS_DIR, '.latest.json'), serialized, 'utf-8');
    writeFileSync(join(BABEL_RUNS_DIR, `.latest.${safeProject}.json`), serialized, 'utf-8');
  } catch (err) {
    logDetail(
      `[LATEST_RUN_WARNING] Failed to write latest pointers: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function buildV9StackTelemetry(
  manifest: OrchestratorManifest,
  compiledArtifacts: RuntimeCompiledArtifacts,
): RuntimeTelemetry | null {
  if (!manifest.instruction_stack) {
    return null;
  }

  return {
    orchestrator_version: manifest.orchestrator_version,
    domain_id: manifest.instruction_stack.domain_id,
    skill_ids: compiledArtifacts.selected_entry_ids.filter(entryId => entryId.startsWith('skill_')),
    model_adapter_id: manifest.instruction_stack.model_adapter_id,
    selected_entry_ids: [...compiledArtifacts.selected_entry_ids],
    token_budget_total:
      typeof compiledArtifacts.token_budget_total === 'number'
        ? compiledArtifacts.token_budget_total
        : null,
    token_budget_missing_count: compiledArtifacts.token_budget_missing?.length ?? 0,
    budget_warning_severity:
      getHighestBudgetSeverity(compiledArtifacts.budget_diagnostics ?? []),
    budget_policy_enabled: compiledArtifacts.budget_policy?.enabled ?? false,
    pipeline_mode: manifest.analysis.pipeline_mode,
    qa_verdict: null,
    qa_failure_tags: [],
    final_outcome: null,
  };
}

function writeRuntimeTelemetrySnapshot(
  evidence: EvidenceBundle,
  telemetry: RuntimeTelemetry | null,
): void {
  if (!telemetry) {
    return;
  }
  evidence.writeRuntimeTelemetry(telemetry);
}

function markRuntimeTelemetryQaPass(
  telemetry: RuntimeTelemetry | null,
): RuntimeTelemetry | null {
  if (!telemetry) {
    return null;
  }
  return {
    ...telemetry,
    qa_verdict: 'PASS',
    qa_failure_tags: [],
  };
}

function markRuntimeTelemetryQaReject(
  telemetry: RuntimeTelemetry | null,
  verdict: QaVerdictReject,
): RuntimeTelemetry | null {
  if (!telemetry) {
    return null;
  }
  return {
    ...telemetry,
    qa_verdict: 'REJECT',
    qa_failure_tags: verdict.failures.map(failure => failure.tag),
  };
}

function markRuntimeTelemetryOutcome(
  telemetry: RuntimeTelemetry | null,
  finalOutcome: PipelineResult['status'],
  pipelineMode: PipelineMode,
): RuntimeTelemetry | null {
  if (!telemetry) {
    return null;
  }
  return {
    ...telemetry,
    pipeline_mode: pipelineMode,
    final_outcome: finalOutcome,
  };
}

// ─── Task context builders ────────────────────────────────────────────────────

function buildV8OrchestratorTask(task: string, options: PipelineOptions): string {
  const lines = [
    'Analyze the task below and output the orchestration manifest as a single raw JSON object.',
    'Respond with ONLY valid JSON — no markdown fences, no explanation, no tool calls.',
    '',
    'Required JSON shape (follow the schema defined in OLS-v8-Orchestrator.md exactly):',
    '{',
    '  "orchestrator_version": "8.0",',
    '  "target_project": "example_saas_backend|example_llm_router|example_web_audit|global",',
    '  "target_project_path": "<absolute path or omit>",',
    '  "analysis": {',
    '    "task_summary": "...", "task_category": "Backend|Frontend|...",',
    '    "secondary_category": null, "task_overlay_ids": [],',
    '    "complexity_estimate": "Low|Medium|High",',
    '    "pipeline_mode": "direct|verified|autonomous|manual", "ambiguity_note": null,',
    '    "routing_confidence": 0.95',
    '  },',
    '  "platform_profile": {',
    '    "profile_source": "explicit_user_request|inferred_from_product_feature|not_required_for_routing",',
    '    "client_surface": "chatgpt_web|claude_web|gemini_web|grok_web|unspecified",',
    '    "container_model": "chat|project|gem|canvas|artifact|null",',
    '    "ingestion_mode": "none|file_upload|repo_snapshot|repo_selective_sync|repo_live_query|full_repo_integration",',
    '    "repo_write_mode": "no_repo_writeback|limited_write_surfaces|repo_writeback|null",',
    '    "output_surface": ["none|canvas|artifact|project_share|chat_share"],',
    '    "platform_modes": [],',
    '    "execution_trust": "high|medium|low|null",',
    '    "data_trust": "high|medium|low|null",',
    '    "freshness_trust": "high|medium|low|null",',
    '    "action_trust": "high|medium|low|null",',
    '    "approval_mode": "none|explicit_confirmation|takeover_or_confirmation|implicit_permissions|unknown"',
    '  },',
    '  "worker_configuration": { "assigned_model": "Codex|Claude|Gemini", "rationale": "..." },',
    '  "prompt_manifest": ["<absolute path 1>", "<absolute path 2>"],',
    '  "handoff_payload": { "user_request": "...", "system_directive": "..." }',
    '}',
    '',
    'routing_confidence guidance (0.0–1.0):',
    '  0.8–1.0 (high)   — task category, target project, and pipeline_mode are unambiguous.',
    '  0.6–0.79 (medium) — category or pipeline_mode has multiple plausible options.',
    '  <0.6 (low)        — task is genuinely unclear, cross-project, or domain fit is uncertain.',
    '',
    `Task: ${task}`,
  ];
  if (options.project) lines.push(`Preferred project: ${options.project}`);
  if (options.mode)    lines.push(`Preferred pipeline mode: ${options.mode}`);
  return lines.join('\n');
}

function buildV9OrchestratorTask(task: string, options: PipelineOptions): string {
  const lines = [
    'Analyze the task below and output the orchestration manifest as a single raw JSON object.',
    'Respond with ONLY valid JSON — no markdown fences, no explanation, no tool calls.',
    '',
    'Required JSON shape (follow the schema defined in OLS-v9-Orchestrator.md exactly):',
    '{',
    '  "orchestrator_version": "9.0",',
    '  "target_project": "example_saas_backend|example_llm_router|example_web_audit|example_mobile_suite|global",',
    '  "target_project_path": "<absolute path or omit>",',
    '  "analysis": {',
    '    "task_summary": "...",',
    '    "task_category": "Backend|Frontend|Mobile|Compliance|DevOps|Research",',
    '    "secondary_category": null,',
    '    "complexity_estimate": "Low|Medium|High",',
    '    "pipeline_mode": "direct|verified|autonomous|manual",',
    '    "ambiguity_note": null,',
    '    "routing_confidence": 0.95',
    '  },',
    '  "compilation_state": "uncompiled",',
    '  "instruction_stack": {',
    '    "behavioral_ids": ["behavioral_core_v7", "behavioral_guard_v7"],',
    '    "domain_id": "...",',
    '    "skill_ids": [],',
    '    "model_adapter_id": "...",',
    '    "project_overlay_id": null,',
    '    "task_overlay_ids": [],',
    '    "pipeline_stage_ids": []',
    '  },',
    '  "resolution_policy": {',
    '    "apply_domain_default_skills": true,',
    '    "expand_skill_dependencies": true,',
    '    "strict_conflict_mode": "error"',
    '  },',
    '  "platform_profile": {',
    '    "profile_source": "explicit_user_request|inferred_from_product_feature|not_required_for_routing",',
    '    "client_surface": "chatgpt_web|claude_web|gemini_web|grok_web|unspecified",',
    '    "container_model": "chat|project|gem|canvas|artifact|null",',
    '    "ingestion_mode": "none|file_upload|repo_snapshot|repo_selective_sync|repo_live_query|full_repo_integration",',
    '    "repo_write_mode": "no_repo_writeback|limited_write_surfaces|repo_writeback|null",',
    '    "output_surface": ["none|canvas|artifact|project_share|chat_share"],',
    '    "platform_modes": [],',
    '    "execution_trust": "high|medium|low|null",',
    '    "data_trust": "high|medium|low|null",',
    '    "freshness_trust": "high|medium|low|null",',
    '    "action_trust": "high|medium|low|null",',
    '    "approval_mode": "none|explicit_confirmation|takeover_or_confirmation|implicit_permissions|unknown"',
    '  },',
    '  "worker_configuration": { "assigned_model": "Codex|Claude|Gemini", "rationale": "..." },',
    '  "prompt_manifest": [],',
    '  "handoff_payload": { "user_request": "...", "system_directive": "Resolve instruction_stack against prompt_catalog.yaml, expand dependencies, compile prompt_manifest, then load the compiled files in order." }',
    '}',
    '',
    'routing_confidence guidance (0.0–1.0):',
    '  0.8–1.0 (high)   — task category, target project, and pipeline_mode are unambiguous.',
    '  0.6–0.79 (medium) — category or pipeline_mode has multiple plausible options.',
    '  <0.6 (low)        — task is genuinely unclear, cross-project, or domain fit is uncertain.',
    '',
    `Task: ${task}`,
  ];
  if (options.project) lines.push(`Preferred project: ${options.project}`);
  if (options.mode)    lines.push(`Preferred pipeline mode: ${options.mode}`);
  return lines.join('\n');
}

function buildOrchestratorTask(
  task: string,
  options: PipelineOptions,
  version: OrchestratorRuntimeVersion,
): string {
  return version === 'v9'
    ? buildV9OrchestratorTask(task, options)
    : buildV8OrchestratorTask(task, options);
}

function buildSweTask(
  manifest:            OrchestratorManifest,
  qaRejections:        string[],
  proposedFixStrategy: string | undefined,
  evidenceContext:     string = '',
): string {
  const { user_request } = manifest.handoff_payload;

  const lines = [
    'Analyze the task below and produce the SWE Plan as a single raw JSON object.',
    'Respond with ONLY valid JSON — no markdown fences, no explanation, no tool calls.',
    '',
    'Required JSON shape:',
    '{',
    '  "plan_version": "1.0",',
    '  "plan_type": "EVIDENCE_REQUEST|IMPLEMENTATION_PLAN",',
    '  "task_summary": "OBJECTIVE: <one-sentence summary>",',
    '  "known_facts":  ["<fact>"],',
    '  "assumptions":  ["<assumption>"],',
    '  "risks": [{ "risk": "...", "likelihood": "low|medium|high", "mitigation": "..." }],',
    '  "minimal_action_set": [{',
    '    "step": 1, "description": "...",',
    '    "tool": "file_read|file_write|shell_exec|test_run|mcp_request|audit_ui|memory_store|memory_query",',
    '    "target": "<path or command>", "rationale": "...",',
    '    "reversible": true, "verification": "<how to confirm success>"',
    '  }],',
    '  "root_cause": "N/A — feature request",',
    '  "out_of_scope": ["<excluded item>"]',
    '}',
    '',
    `Task: ${user_request}`,
  ];

  if (qaRejections.length > 0) {
    lines.push(
      '',
      '--- QA REJECTION FEEDBACK ---',
      '',
      'Your previous plan was rejected. You MUST address ALL of the following',
      'failures in your revised plan. Do not omit any of them:',
      '',
      ...qaRejections.map((r, i) => `  ${i + 1}. ${r}`),
    );

    if (proposedFixStrategy) {
      lines.push(
        '',
        '--- QA DIRECTIONAL HINT ---',
        `The QA Reviewer suggested this direction: ${proposedFixStrategy}`,
        '(This is a dimension to address, not a complete fix. You must still',
        ' resolve every listed failure independently.)',
      );
    }

    lines.push(
      '',
      'Produce a corrected plan that eliminates every listed failure.',
    );
  }

  if (evidenceContext) {
    lines.push(
      '',
      '--- GATHERED EVIDENCE ---',
      'The following context was collected by prior read-only evidence passes.',
      'Use it to produce a concrete implementation plan.',
      'Set "plan_type" to "IMPLEMENTATION_PLAN".',
      'Do NOT emit another EVIDENCE_REQUEST — proceed with full implementation.',
      '',
      evidenceContext.trim(),
    );
  }

  return lines.join('\n');
}

function buildQaTask(swePlan: SwePlan): string {
  return [
    'Review the SWE Plan below and produce a QA verdict as a single raw JSON object.',
    'Respond with ONLY valid JSON — no markdown fences, no explanation, no tool calls.',
    '',
    '--- FIELD MAPPING (JSON format is the approved submission format) ---',
    'The plan is submitted in machine-readable JSON. Map fields as follows:',
    '  task_summary          → OBJECTIVE',
    '  known_facts           → KNOWN FACTS',
    '  assumptions           → ASSUMPTIONS',
    '  risks[]               → RISKS',
    '  minimal_action_set[]  → MINIMAL ACTION SET',
    '    each step.verification → VERIFICATION METHOD for that step',
    '  root_cause            → ROOT CAUSE',
    '  out_of_scope[]        → scope boundaries',
    'Do NOT use INCOMPLETE_SUBMISSION for missing text sections; the JSON fields above',
    'are the valid submission format. Only use INCOMPLETE_SUBMISSION if a required JSON',
    'field is missing entirely (e.g., minimal_action_set is empty or absent).',
    '',
    '--- EVIDENCE-GATE CLARIFICATION ---',
    'EVIDENCE-GATE requires file visibility ONLY when modifying an EXISTING file.',
    'Do NOT raise EVIDENCE-GATE for steps that CREATE a new file (the file does not exist',
    'yet — there is no current content to inspect). A file_write step with a target path',
    'that the plan is creating from scratch is NOT an EVIDENCE-GATE violation.',
    '',
    'PASS shape:   { "verdict": "PASS", "overall_confidence": <1-5>, "notes": "..." }',
    'REJECT shape: { "verdict": "REJECT", "failure_count": <N>, "overall_confidence": <1-5>,',
    '  "failures": [{ "tag": "NAMIT-I", "condition": "...", "confidence": <1-5> }],',
    '  "proposed_fix_strategy": "<one-sentence direction for the SWE Agent — dimension only, no code>" }',
    'IMPORTANT: tag must be a BARE string — NO square brackets — from this exact list:',
    '  INCOMPLETE_SUBMISSION | EVIDENCE-GATE',
    '  SFDIPOT-S | SFDIPOT-F | SFDIPOT-D | SFDIPOT-I | SFDIPOT-P | SFDIPOT-O | SFDIPOT-T',
    '  NAMIT-N | NAMIT-A | NAMIT-M | NAMIT-I | NAMIT-T',
    '  BCDP-MISSING | BCDP-BREAKING-UNMARKED | BCDP-NO-MIGRATION | BCDP-NO-ROLLBACK',
    '  SECURITY-INJECTION | SECURITY-SECRETS | SECURITY-AUTHZ | SECURITY-EXPOSURE',
    '  ROOT-CAUSE-MISSING | ROOT-CAUSE-SHALLOW',
    '',
    'SWE Plan to review:',
    JSON.stringify(swePlan, null, 2),
  ].join('\n');
}

// ─── Orchestrator output parser ───────────────────────────────────────────────

const OrchestratorOutputSchema = z.union([
  OrchestratorManifestSchema,
  OrchestratorErrorHaltSchema,
]);

function assertManifest(
  output: z.input<typeof OrchestratorOutputSchema>,
): asserts output is z.input<typeof OrchestratorManifestSchema> {
  if ('error_halt' in output && output.error_halt === true) {
    throw new Error(
      `Orchestrator issued an error halt.\n` +
      `  Reason:  ${output.error_reason}\n` +
      `  Blocked: ${output.blocked_request}`,
    );
  }
}

// ─── SWE plan normalization ───────────────────────────────────────────────────

type NormalizedSwePlan = SwePlan & {
  plan_type: 'EVIDENCE_REQUEST' | 'IMPLEMENTATION_PLAN';
  task_summary: string;
};

function normalizeSwePlan(swePlan: SwePlan): {
  plan: NormalizedSwePlan;
  warnings: string[];
} {
  const warnings: string[] = [];

  const taskSummary = swePlan.task_summary.startsWith(OBJECTIVE_PREFIX)
    ? swePlan.task_summary
    : `${OBJECTIVE_PREFIX}${swePlan.task_summary}`;

  let planType = swePlan.plan_type;
  if (planType === undefined) {
    const inferred = taskSummary.includes('EVIDENCE_REQUEST')
      ? 'EVIDENCE_REQUEST'
      : 'IMPLEMENTATION_PLAN';
    planType = inferred;
    warnings.push(
      `[PLAN_TYPE_INFERRED] Missing plan_type; inferred "${inferred}" from task_summary.`,
    );
  }

  return {
    plan: {
      ...swePlan,
      task_summary: taskSummary,
      plan_type: planType,
    },
    warnings,
  };
}

function formatZodErrors(err: z.ZodError): string[] {
  return err.issues.map(issue => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${path}: ${issue.message}`;
  });
}

function buildManualPlanRepairPrompt(
  errors: string[],
  rawPlanText: string,
): string {
  return [
    '# Manual Plan Repair Required',
    '',
    'Your previous plan.json failed SwePlanSchema validation.',
    'Return ONLY valid JSON matching SwePlanSchema. No markdown fences, no prose.',
    '',
    'Validation errors:',
    ...errors.map((e, i) => `${i + 1}. ${e}`),
    '',
    'Original submitted plan:',
    '```json',
    rawPlanText.trim() || '{}',
    '```',
  ].join('\n');
}

// ─── Execution report validation ──────────────────────────────────────────────

function writeValidatedExecutionReport(
  evidence: EvidenceBundle,
  report: unknown,
  toolCallLog: ToolCallLog[],
  warnings: string[] = [],
): void {
  const uniqueWarnings = [...new Set(warnings)];
  const reportWithWarnings = (
    uniqueWarnings.length > 0 &&
    typeof report === 'object' &&
    report !== null
  )
    ? { ...(report as Record<string, unknown>), warnings: uniqueWarnings }
    : report;

  try {
    const parsed = ExecutorReportSchema.parse(reportWithWarnings);
    evidence.writeExecutionLog(parsed);
    return;
  } catch (err) {
    const schemaError = err instanceof Error ? err.message : String(err);
    const condition =
      `[PIPELINE_ERROR] ExecutorReportSchema validation failed: ${schemaError}`;

    const pipelineError = PipelineErrorSchema.parse({
      halt_tag:       'TOOL_CALL_ERROR',
      halted_at_step: Math.max(1, toolCallLog.length),
      condition,
      ...(toolCallLog.length > 0
        ? { last_tool_output: toolCallLog[toolCallLog.length - 1] }
        : {}),
    });

    const fallback = ExecutorReportSchema.parse({
      status:         'EXECUTION_HALTED',
      steps_executed: toolCallLog.length,
      tool_call_log:  toolCallLog,
      pipeline_error: pipelineError,
      ...(uniqueWarnings.length > 0
        ? { warnings: [...uniqueWarnings, condition] }
        : {}),
    });

    evidence.writeExecutionLog(fallback);
  }
}

// ─── Stage 4: Stateless text-loop executor ────────────────────────────────────

function getTarget(req: z.infer<typeof ToolCallRequestSchema>): string {
  if (req.tool === 'file_read'  || req.tool === 'file_write')   return req.path;
  if (req.tool === 'shell_exec' || req.tool === 'test_run')     return req.command;
  if (req.tool === 'mcp_request')                               return `${req.server} → ${req.query}`;
  if (req.tool === 'audit_ui')                                  return req.url ?? JSON.stringify(req);
  if (req.tool === 'memory_store' || req.tool === 'memory_query') return req.key;
  return JSON.stringify(req);
}

// ─── Evidence result formatter ────────────────────────────────────────────────

/**
 * Converts a completed tool-call log into a human-readable block that can be
 * injected into the next SWE Agent prompt as gathered evidence.
 *
 * Only stdout is included (read-only tools return all useful data there).
 * Stderr is included only when non-empty, to keep the context concise.
 */
function formatExecutionResults(toolCallLog: ToolCallLog[], loopCount: number): string {
  const header = `--- GATHERED EVIDENCE (Loop ${loopCount}) ---`;
  const entries = toolCallLog.map(entry =>
    [
      `[Step ${entry.step}] ${entry.tool} → ${entry.target}`,
      `stdout: ${entry.stdout.trim() || '(empty)'}`,
      ...(entry.stderr.trim() ? [`stderr: ${entry.stderr.trim()}`] : []),
    ].join('\n'),
  );
  return [header, ...entries].join('\n\n');
}

/**
 * Builds the task slot injected into the compiled executor context.
 * Includes the approved plan and the JSON output contract for both tool calls
 * and completion signals.
 */
function buildExecutorTask(approvedPlan: SwePlan): string {
  return [
    'Execute the following approved SWE Plan.',
    'Respond with ONLY valid JSON — no markdown fences, no explanation, no prose.',
    '',
    'On each turn emit EXACTLY ONE of these JSON shapes:',
    '  file_read:  { "type": "tool_call", "tool": "file_read",  "path": "<project-relative or /project/... path>" }',
    '  file_write: { "type": "tool_call", "tool": "file_write", "path": "<project-relative or /project/... path>", "content": "<full file content>" }',
    '  shell_exec: { "type": "tool_call", "tool": "shell_exec", "command": "<cmd>", "working_directory": "<project-relative or /project/... path>", "timeout_seconds": 120 }',
    '  test_run:     { "type": "tool_call", "tool": "test_run",     "command": "<cmd>", "working_directory": "<project-relative or /project/... path>", "timeout_seconds": 300 }',
    '  mcp_request:  { "type": "tool_call", "tool": "mcp_request",  "server": "<server_name>", "query": "<query>" }',
    '  audit_ui:     { "type": "tool_call", "tool": "audit_ui",     "url": "<url>", "run_id": "<run_id>" }',
    '  memory_store: { "type": "tool_call", "tool": "memory_store", "key": "<key>", "value": "<value>" }',
    '  memory_query: { "type": "tool_call", "tool": "memory_query", "key": "<key>" }',
    '  Done:       { "type": "completion", "status": "EXECUTION_COMPLETE" }',
    '  Halt:       { "type": "completion", "status": "EXECUTION_HALTED",   "halt_tag": "<TAG>", "condition": "<exact condition>" }',
    '  Refused:    { "type": "completion", "status": "ACTIVATION_REFUSED", "reason": "<reason>" }',
    '',
    'Approved SWE Plan:',
    JSON.stringify(approvedPlan, null, 2),
  ].join('\n');
}

/**
 * Formats a completed tool-call log entry as a human-readable history block
 * that the executor can read to know what has already been done.
 */
function formatHistoryEntry(entry: ToolCallLog): string {
  return [
    `[Step ${entry.step}] ${entry.tool} → ${entry.target}`,
    `Exit code: ${entry.exit_code}`,
    `Stdout: ${truncateLogs(entry.stdout) || '(empty)'}`,
    `Stderr: ${truncateLogs(entry.stderr) || '(empty)'}`,
    `Verification: ${entry.verified ? 'PASSED' : 'FAILED'}`,
  ].join('\n');
}

/**
 * Appends the execution history and a "next action" prompt to the compiled
 * base context so each stateless runner call has full situational awareness.
 */
function buildExecutorTurnPrompt(
  baseContext:   string,
  history:       string,
  stepsComplete: number,
): string {
  const historyBlock = history.trim() ||
    '(No steps executed yet — this is the first turn.)';

  const nextAction = stepsComplete > 0
    ? `${stepsComplete} step(s) already executed (see history above). ` +
      `Emit your next JSON tool call, or a completion signal if the plan is finished.`
    : `Emit your first JSON tool call. If the activation gate fails, emit ACTIVATION_REFUSED.`;

  return [
    baseContext,
    '',
    '### EXECUTION HISTORY SO FAR:',
    historyBlock,
    '',
    '### NEXT ACTION:',
    nextAction,
  ].join('\n');
}

/**
 * Builds a focused repair prompt when a tool call passes `ExecutorTurnSchema`
 * but fails the stricter `ToolCallRequestSchema`.
 * Injects the bad JSON + Zod issue list into the original turn prompt so the
 * runner has full context without re-sending the entire base context.
 */
function buildExecutorRepairPrompt(
  originalTurnPrompt: string,
  badToolArgs:        Record<string, unknown>,
  zodError:           z.ZodError,
): string {
  const toolName = typeof badToolArgs['tool'] === 'string' ? badToolArgs['tool'] : 'unknown';
  const issues = zodError.issues
    .map(i => `  - ${i.path.join('.') || '<root>'}: ${i.message}`)
    .join('\n');

  return [
    originalTurnPrompt,
    '',
    '---',
    '### SCHEMA REPAIR REQUIRED',
    '',
    `Your previous tool call for \`${toolName}\` passed basic structure validation but`,
    'failed the strict per-tool field check. Validation errors:',
    issues,
    '',
    'Your invalid output:',
    '```json',
    JSON.stringify(badToolArgs, null, 2),
    '```',
    '',
    'Emit a corrected JSON `ExecutorTurn` with all required fields for `' + toolName + '` present.',
    'Output ONLY the corrected JSON — no prose, no explanation.',
  ].join('\n');
}

function getLatestQaVerdictPath(runDir: string): string | null {
  const pattern = /^03_qa_verdict_v(\d+)\.json$/;
  const candidates = readdirSync(runDir)
    .filter(name => pattern.test(name))
    .sort((left, right) => {
      const leftMatch = pattern.exec(left);
      const rightMatch = pattern.exec(right);
      const leftVersion = leftMatch ? Number.parseInt(leftMatch[1] ?? '0', 10) : 0;
      const rightVersion = rightMatch ? Number.parseInt(rightMatch[1] ?? '0', 10) : 0;
      return rightVersion - leftVersion;
    });

  return candidates.length > 0 ? join(runDir, candidates[0]!) : null;
}

function assertExecutorGate(runDir: string): void {
  const qaVerdictPath = getLatestQaVerdictPath(runDir);
  if (!qaVerdictPath) {
    throw new Error(
      `Executor activation refused: no QA verdict found for run "${runDir}". ` +
      'Stage 4 requires an explicit PASS verdict.',
    );
  }

  const qaVerdictRaw = JSON.parse(readFileSync(qaVerdictPath, 'utf-8')) as Record<string, unknown>;
  const verdict = String(qaVerdictRaw['verdict'] ?? '').trim().toUpperCase();
  if (verdict !== 'PASS') {
    throw new Error(
      `Executor activation refused: latest QA verdict is "${verdict || 'UNKNOWN'}" in "${qaVerdictPath}". ` +
      'Stage 4 requires PASS.',
    );
  }
}

/**
 * Stage 4: runs the CLI Executor in a stateless text-loop via `runWithFallback`.
 *
 * Each iteration compiles a fresh prompt = base context + execution history +
 * next-action instruction, calls `runWithFallback` expecting an `ExecutorTurn`
 * (either a tool call or a completion signal), executes any tool call, and
 * appends the result to `executionHistory` for the next iteration.
 *
 * No Anthropic SDK — all LLM calls go through the same waterfall as Stages 1-3.
 */
async function runExecutorLoop(
  approvedPlan: SwePlan,
  evidence:     EvidenceBundle,
  targetModel:  TargetModel,
  reportWarnings: string[] = [],
): Promise<{ toolCallLog: ToolCallLog[] }> {
  assertExecutorGate(evidence.runDir);

  // ── Compile base context once ────────────────────────────────────────────
  const baseContext = compileContext(
    abs(EXECUTOR_PATHS),
    buildExecutorTask(approvedPlan),
  );
  evidence.writeCompiledContext('executor', baseContext);

  let executionHistory = '';
  const toolCallLog: ToolCallLog[] = [];

  for (let turn = 1; turn <= MAX_EXECUTOR_TURNS; turn++) {
    logDetail(`Executor turn ${turn}/${MAX_EXECUTOR_TURNS}...`);

    // ── Call runWithFallback with the history-enriched prompt ───────────────
    const turnPrompt = buildExecutorTurnPrompt(
      baseContext, executionHistory, toolCallLog.length,
    );

    let executorTurn: z.infer<typeof ExecutorTurnSchema>;
    try {
      executorTurn = await runWithFallback(turnPrompt, ExecutorTurnSchema, {
        evidence,
        stage: 'executor',
      });
    } catch (err) {
      // All tiers exhausted — treat as hallucinated output.
      const report = buildHaltReport(
        toolCallLog, 'HALLUCINATED_OUTPUT', toolCallLog.length + 1,
        `All runner tiers failed to produce a valid executor turn. ` +
        `Last error: ${err instanceof Error ? err.message : String(err)}`,
      );
      writeValidatedExecutionReport(evidence, report, toolCallLog, reportWarnings);
      log('  Executor: EXECUTION_HALTED [HALLUCINATED_OUTPUT]');
      return { toolCallLog };
    }

    // ── Terminal completion ──────────────────────────────────────────────────
    if (executorTurn.type === 'completion') {
      const report = buildTerminalReport(executorTurn, toolCallLog, evidence);
      writeValidatedExecutionReport(evidence, report, toolCallLog, reportWarnings);

      if (executorTurn.status === 'EXECUTION_COMPLETE') {
        log(`  Executor: EXECUTION_COMPLETE (${toolCallLog.length} steps)`);
      } else if (executorTurn.status === 'EXECUTION_HALTED') {
        log(`  Executor: EXECUTION_HALTED [${executorTurn.halt_tag}]`);
        logDetail(executorTurn.condition);
      } else {
        log(`  Executor: ACTIVATION_REFUSED — ${executorTurn.reason}`);
      }
      return { toolCallLog };
    }

    // ── Tool call ────────────────────────────────────────────────────────────
    // Re-validate with strict ToolCallRequestSchema (enforces per-tool required fields).
    const { type: _type, ...toolArgs } = executorTurn;
    let parsedReq = ToolCallRequestSchema.safeParse(toolArgs);

    if (!parsedReq.success) {
      // ── Repair mode: one retry with a targeted fix prompt ────────────────
      log('  Executor: tool call failed strict validation — attempting schema repair');
      const repairPrompt = buildExecutorRepairPrompt(turnPrompt, toolArgs, parsedReq.error);
      try {
        const repairedTurn = await runWithFallback(repairPrompt, ExecutorTurnSchema, {
          evidence, stage: 'executor',
        });
        if (repairedTurn.type === 'tool_call') {
          const { type: _rt, ...repairedArgs } = repairedTurn;
          const repairedParse = ToolCallRequestSchema.safeParse(repairedArgs);
          if (repairedParse.success) {
            log('  Executor: schema repair succeeded — continuing execution');
            parsedReq = repairedParse;
          }
        }
      } catch {
        // repair attempt exhausted all tiers — fall through to AMBIGUOUS_PLAN halt
      }
    }

    if (!parsedReq.success) {
      const report = buildHaltReport(
        toolCallLog, 'AMBIGUOUS_PLAN', toolCallLog.length + 1,
        `Executor tool call failed strict validation (repair attempted and failed). ` +
        `Zod error: ${parsedReq.error.toString().slice(0, 200)}`,
      );
      writeValidatedExecutionReport(evidence, report, toolCallLog, reportWarnings);
      log('  Executor: EXECUTION_HALTED [AMBIGUOUS_PLAN]');
      return { toolCallLog };
    }

    const req     = parsedReq.data;
    const stepNum = toolCallLog.length + 1;
    logDetail(`  Step ${stepNum}: ${req.tool} → ${getTarget(req)}`);

    const toolResult = await executeTool(req);

    const entry: ToolCallLog = {
      step:      stepNum,
      tool:      req.tool,
      target:    getTarget(req),
      exit_code: toolResult.exit_code,
      stdout:    toolResult.stdout,
      stderr:    toolResult.stderr,
      verified:  toolResult.exit_code === 0,
    };
    toolCallLog.push(entry);

    // Halt immediately on live tool failure.
    if (!DRY_RUN && toolResult.exit_code !== 0) {
      const report = buildHaltReport(
        toolCallLog, 'STEP_VERIFICATION_FAIL', stepNum,
        `Tool ${req.tool} on "${getTarget(req)}" exited with code ${toolResult.exit_code}. ` +
        `stderr: ${toolResult.stderr.slice(0, 200)}`,
      );
      writeValidatedExecutionReport(evidence, report, toolCallLog, reportWarnings);
      log(`  Executor: EXECUTION_HALTED [STEP_VERIFICATION_FAIL] at step ${stepNum}`);
      return { toolCallLog };
    }

    // Append result to history so the next turn has full context.
    executionHistory +=
      (executionHistory ? '\n\n' : '') + formatHistoryEntry(entry);
  }

  // Exceeded max turns without a terminal signal.
  const report = buildHaltReport(
    toolCallLog, 'TOOL_CALL_ERROR', toolCallLog.length,
    `Executor exceeded the maximum of ${MAX_EXECUTOR_TURNS} turns without a terminal signal.`,
  );
  writeValidatedExecutionReport(evidence, report, toolCallLog, reportWarnings);
  log(`  Executor: EXECUTION_HALTED — exceeded ${MAX_EXECUTOR_TURNS} turns`);
  return { toolCallLog };
}

// ─── Report builders ──────────────────────────────────────────────────────────

function buildTerminalReport(
  signal:      ExecutorTurnCompletion,
  toolCallLog: ToolCallLog[],
  evidence:    EvidenceBundle,
): object {
  if (signal.status === 'EXECUTION_COMPLETE') {
    return {
      status:               'EXECUTION_COMPLETE',
      steps_executed:       toolCallLog.length,
      tool_call_log:        toolCallLog,
      diff_path:            join(evidence.runDir, '05_diff.patch'),
      execution_log_path:   join(evidence.runDir, '04_execution_report.json'),
    };
  }

  if (signal.status === 'EXECUTION_HALTED') {
    return {
      status:         'EXECUTION_HALTED',
      steps_executed: toolCallLog.length,
      tool_call_log:  toolCallLog,
      pipeline_error: {
        halt_tag:       signal.halt_tag,
        halted_at_step: toolCallLog.length + 1,
        condition:      signal.condition,
      },
    };
  }

  // ACTIVATION_REFUSED
  return {
    status:  'ACTIVATION_REFUSED',
    reason:  signal.reason,
    gate:    'ACTIVATION_GATE_FAIL',
  };
}

function buildHaltReport(
  toolCallLog:  ToolCallLog[],
  haltTag:      HaltTag,
  haltedAtStep: number,
  condition:    string,
): object {
  return {
    status:         'EXECUTION_HALTED',
    steps_executed: toolCallLog.length,
    tool_call_log:  toolCallLog,
    pipeline_error: {
      halt_tag:       haltTag,
      halted_at_step: haltedAtStep,
      condition,
    },
  };
}

// ─── Main pipeline ────────────────────────────────────────────────────────────

/**
 * Runs the full Babel pipeline for a given task string.
 *
 * @param task    - Raw task description from the user.
 * @param options - Optional overrides for project and pipeline mode.
 * @returns       `PipelineResult` with the run directory and final state.
 */
export async function runBabelPipeline(
  task:    string,
  options: PipelineOptions = {},
): Promise<PipelineResult> {

  const evidence = new EvidenceBundle(task, BABEL_RUNS_DIR);
  log(`Run directory: ${evidence.runDir}`);

  const orchestratorVersion = resolveOrchestratorVersion(options.orchestratorVersion);
  const sessionId = options.sessionId?.trim() || process.env['BABEL_SESSION_ID']?.trim() || undefined;
  const sessionStartPath = options.sessionStartPath?.trim() || process.env['BABEL_SESSION_START_PATH']?.trim() || undefined;
  const localLearningRoot = options.localLearningRoot?.trim() || process.env['BABEL_LOCAL_LEARNING_ROOT']?.trim() || undefined;
  const harnessMetadata = collectHarnessMetadata(sessionStartPath, localLearningRoot);
  const traceOptions = {
    runDir: evidence.runDir,
    orchestratorVersion,
    metadata: harnessMetadata,
    ...(options.mode ? { requestedMode: options.mode } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(sessionStartPath ? { sessionStartPath } : {}),
    ...(localLearningRoot ? { localLearningRoot } : {}),
  };
  const pipelineTrace = await PipelineTrace.start(traceOptions);

  const finalizeResult = async (result: PipelineResult): Promise<PipelineResult> => {
    const traceSummary = await pipelineTrace.finish(result.status);
    evidence.writeTraceContext(traceSummary);
    evidence.writeWaterfallTelemetry();
    return result;
  };

  const finalizeError = async (error: unknown): Promise<never> => {
    const traceSummary = await pipelineTrace.finish('FATAL_ERROR', error);
    evidence.writeTraceContext(traceSummary);
    evidence.writeWaterfallTelemetry();
    throw error;
  };

  if (DRY_RUN) {
    log('DRY RUN mode active. Destructive tools will be mocked.');
  }

  try {
    // ── Stage 1: Orchestrator ───────────────────────────────────────────────────
    log('Stage 1 / 4  —  Orchestrator');
    logDetail(`Orchestrator version: ${orchestratorVersion}`);

    const orchestratorContext = compileContext(
      abs(getOrchestratorPaths(orchestratorVersion)),
      buildOrchestratorTask(task, options, orchestratorVersion),
    );
    evidence.writeCompiledContext('orchestrator', orchestratorContext);

    const orchestratorSpan = pipelineTrace.startChildSpan('babel.orchestrator', {
      'babel.orchestrator.version': orchestratorVersion,
    });

    let manifest: OrchestratorManifest;
    try {
      const orchestratorOutput = await runWithFallback(orchestratorContext, OrchestratorOutputSchema, {
        evidence,
        stage: 'orchestrator',
      });
      assertManifest(orchestratorOutput as z.input<typeof OrchestratorOutputSchema>); // throws on error_halt
      manifest = OrchestratorManifestSchema.parse(orchestratorOutput);
      endSpan(orchestratorSpan, SpanStatusCode.OK);
    } catch (error) {
      endSpan(orchestratorSpan, SpanStatusCode.ERROR, {}, error);
      throw error;
    }
    let manifestArtifact: Record<string, unknown> = manifest as unknown as Record<string, unknown>;
    let v9StackTelemetry: RuntimeTelemetry | null = null;

    if (
      orchestratorVersion === 'v9' &&
      manifest.instruction_stack &&
      manifest.compilation_state === 'uncompiled'
    ) {
      const compilerSpan = pipelineTrace.startChildSpan('babel.compiler', {
        'babel.compilation.state.before': manifest.compilation_state,
        'babel.stack.domain_id': manifest.instruction_stack.domain_id,
        'babel.stack.model_adapter_id': manifest.instruction_stack.model_adapter_id,
        'babel.stack.behavioral_count': manifest.instruction_stack.behavioral_ids.length,
        'babel.stack.skill_count.requested': manifest.instruction_stack.skill_ids.length,
        'babel.stack.task_overlay_count': manifest.instruction_stack.task_overlay_ids.length,
        'babel.stack.pipeline_stage_count': manifest.instruction_stack.pipeline_stage_ids.length,
      });

      try {
        const resolvedManifest = resolveInstructionStackManifest(
          manifest,
          BABEL_ROOT,
        );
        const resolvedCompiledArtifacts =
          (resolvedManifest as OrchestratorManifest & {
            compiled_artifacts?: RuntimeCompiledArtifacts;
          }).compiled_artifacts;

        manifest = OrchestratorManifestSchema.parse(resolvedManifest);
        manifestArtifact = resolvedManifest as unknown as Record<string, unknown>;
        logDetail(
          `Resolved typed stack to ${manifest.prompt_manifest.length} prompt file(s).`,
        );

        if (resolvedCompiledArtifacts) {
          const typedInstructionStack = manifest.instruction_stack;
          v9StackTelemetry = buildV9StackTelemetry(manifest, resolvedCompiledArtifacts);
          pipelineTrace.recordCompilerSummary({
            selectedEntryIds: [...resolvedCompiledArtifacts.selected_entry_ids],
            promptManifestCount: manifest.prompt_manifest.length,
            skillCount: resolvedCompiledArtifacts.selected_entry_ids.filter(entryId => entryId.startsWith('skill_')).length,
            tokenBudgetTotal: resolvedCompiledArtifacts.token_budget_total ?? null,
            tokenBudgetMissingCount: resolvedCompiledArtifacts.token_budget_missing?.length ?? 0,
            budgetWarningSeverity: getHighestBudgetSeverity(resolvedCompiledArtifacts.budget_diagnostics ?? []),
            budgetPolicyEnabled: resolvedCompiledArtifacts.budget_policy?.enabled ?? false,
            ...(typedInstructionStack?.domain_id ? { domainId: typedInstructionStack.domain_id } : {}),
            ...(typedInstructionStack?.model_adapter_id ? { modelAdapterId: typedInstructionStack.model_adapter_id } : {}),
          });
          if (v9StackTelemetry) {
            logDetail(`v9 stack telemetry: ${JSON.stringify(v9StackTelemetry)}`);
          }
        }

        endSpan(compilerSpan, SpanStatusCode.OK, {
          'babel.compilation.state.after': manifest.compilation_state ?? 'compiled',
          'babel.stack.selected_entry_count': manifest.compiled_artifacts?.selected_entry_ids.length,
          'babel.stack.prompt_manifest_count': manifest.prompt_manifest.length,
        });
      } catch (error) {
        endSpan(compilerSpan, SpanStatusCode.ERROR, {}, error);
        throw error;
      }
    }

    configureToolProjectRoot(manifest);

    // ── Routing confidence gate ─────────────────────────────────────────────
    const routingConf = manifest.analysis.routing_confidence;
    if (routingConf !== undefined) {
      if (isConfidenceGateEnabled()) {
        const band   = getRoutingConfidenceBand(routingConf);
        let action:             'accepted' | 'downgraded' | 'validated' | 'validator_still_low' = 'accepted';
        let validatorUsed       = false;
        let validatorImproved:  boolean | null = null;

        if (band === 'low') {
          // Run a bounded validator pass (starts at tier 1, no dynamic routing).
          validatorUsed = true;
          log(
            `[babel:orchestrator] ⚠ Low routing confidence: ${routingConf.toFixed(2)} — ` +
            `running validator pass (tier ${getValidatorTierIndex() + 1}).`,
          );
          // Validator reuses the existing orchestrator waterfall at startTierIndex — no new runner or schema.
          let validatorManifest: OrchestratorManifest | null = null;
          try {
            const validatorOutput = await runWithFallback(
              orchestratorContext,
              OrchestratorOutputSchema,
              { evidence, stage: 'orchestrator', startTierIndex: getValidatorTierIndex(), dynamicRouting: false },
            );
            assertManifest(validatorOutput as z.input<typeof OrchestratorOutputSchema>);
            validatorManifest = OrchestratorManifestSchema.parse(validatorOutput);
          } catch {
            log(`[babel:orchestrator] ⚠ Validator pass failed — proceeding with original manifest.`);
          }
          if (validatorManifest) {
            const validatorConf = validatorManifest.analysis.routing_confidence;
            if (validatorConf !== undefined && validatorConf >= routingConf) {
              validatorImproved = validatorConf > routingConf;
            } else {
              validatorImproved = false;
            }
            const stillLow = validatorConf === undefined || validatorConf < routingConf + 0.05;
            if (!stillLow) {
              manifest         = validatorManifest;
              manifestArtifact = validatorManifest as unknown as Record<string, unknown>;
              action           = 'validated';
              log(`[babel:orchestrator] Validator improved confidence: ${(validatorConf ?? 0).toFixed(2)} — using validator manifest.`);
            } else {
              action = 'validator_still_low';
              log(
                `[babel:orchestrator] ⚠ Validator confidence still low: ${(validatorConf ?? routingConf).toFixed(2)} ` +
                `— proceeding with original manifest.`,
              );
            }
          } else {
            action = 'validator_still_low';
          }
        } else if (band === 'medium') {
          // New object (spread) so downstream `effectiveMode = options.mode ?? manifest.analysis.pipeline_mode`
          // reads the downgraded value. CLI override (options.mode) always wins.
          if (!options.mode && manifest.analysis.pipeline_mode === 'direct') {
            manifest         = { ...manifest, analysis: { ...manifest.analysis, pipeline_mode: 'verified' } };
            manifestArtifact = manifest as unknown as Record<string, unknown>;
            action           = 'downgraded';
            log(
              `[babel:orchestrator] ⚠ Medium confidence (${routingConf.toFixed(2)}): ` +
              `downgraded pipeline_mode direct → verified.`,
            );
          }
        }

        evidence.writeRoutingDecision({
          routing_confidence:       routingConf,
          routing_confidence_band:  band,
          routing_action:           action,
          routing_validator_used:   validatorUsed,
          routing_validator_improved: validatorImproved,
          ts: new Date().toISOString(),
        });

        if (v9StackTelemetry) {
          v9StackTelemetry = {
            ...v9StackTelemetry,
            routing_confidence:        routingConf,
            routing_confidence_band:   band,
            routing_action:            action,
            routing_validator_used:    validatorUsed,
            routing_validator_improved: validatorImproved,
          };
        }
      } else if (routingConf < 0.8) {
        // Gate disabled — passive warning only.
        log(
          `[babel:orchestrator] ⚠ Low routing confidence: ${routingConf.toFixed(2)} ` +
          `(threshold 0.80) — routing decision may need review.`,
        );
      }
    }

    const manifestWithProtocol = {
      ...manifestArtifact,
      ...(sessionId ? { session_id: sessionId } : {}),
      ...(sessionStartPath ? { session_start_path: sessionStartPath } : {}),
      ...(localLearningRoot ? { local_learning_root: localLearningRoot } : {}),
      ...(v9StackTelemetry ? { runtime_telemetry: v9StackTelemetry } : {}),
    };

    evidence.writeManifest(manifestWithProtocol);
    writeRuntimeTelemetrySnapshot(evidence, v9StackTelemetry);
    writeLatestRunPointers(evidence.runDir, manifest.target_project);

    const effectiveMode  = options.mode ?? manifest.analysis.pipeline_mode;
    const effectiveModel = (
      options.modelOverride ?? manifest.worker_configuration.assigned_model ?? 'Codex'
    ) as TargetModel;

    pipelineTrace.setRootAttributes({
      'babel.target_project': manifest.target_project,
      'babel.pipeline.mode': effectiveMode,
      'babel.worker.assigned_model': effectiveModel,
      'babel.orchestrator.version': manifest.orchestrator_version,
    });
    pipelineTrace.updateBaggage({
      'babel.lane.id': `${manifest.orchestrator_version}:${effectiveMode}`,
    });

    if (v9StackTelemetry) {
      v9StackTelemetry = {
        ...v9StackTelemetry,
        pipeline_mode: effectiveMode,
      };
      writeRuntimeTelemetrySnapshot(evidence, v9StackTelemetry);
    }

    logDetail(`Project:  ${manifest.target_project}`);
    logDetail(`Model:    ${effectiveModel}${options.modelOverride ? ' (forced override)' : ''}`);
    logDetail(`Mode:     ${effectiveMode}`);
    if (sessionId) {
      logDetail(`Session:  ${sessionId}`);
    }

    if (options.mode) {
      logDetail(`Pipeline mode overridden by CLI flag: ${options.mode}`);
    }
    if (options.modelOverride) {
      logDetail(`Worker model overridden by CLI flag: ${options.modelOverride}`);
    }

    if (effectiveMode === 'manual') {
      log('Stage 2 / 4  —  Manual Bridge Export');
      const sweTask    = buildSweTask(manifest, [], undefined, '');
      const sweContext = compileContext(manifest.prompt_manifest, sweTask);
      evidence.writeManualSwePrompt(sweContext);
      evidence.writeCompiledContext('swe_manual', sweContext);
      v9StackTelemetry = markRuntimeTelemetryOutcome(
        v9StackTelemetry,
        'MANUAL_BRIDGE_REQUIRED',
        effectiveMode,
      );
      writeRuntimeTelemetrySnapshot(evidence, v9StackTelemetry);

      return await finalizeResult({
        runDir:           evidence.runDir,
        manifest,
        plan:             null,
        status:           'MANUAL_BRIDGE_REQUIRED',
        manualPromptPath: join(evidence.runDir, '02_manual_swe_prompt.md'),
      });
    }

    // ── Evidence loop state ─────────────────────────────────────────────────────
    // `approvedPlan` is declared outside the while so it is accessible after break.
    let approvedPlan:             SwePlan | null = null;
    let evidenceLoopCount         = 0;
    let additionalEvidenceContext = '';
    const executionReportWarnings: string[] = [];

    // ── Outer evidence loop ──────────────────────────────────────────────────────
    // Stages 2 → 3 → 4 repeat when the SWE Agent emits a plan_type=EVIDENCE_REQUEST plan.
    // The loop is hard-capped at MAX_EVIDENCE_LOOPS to prevent infinite context
    // accumulation. On each iteration, gathered evidence is injected back into the
    // Stage 2 prompt so the SWE Agent can produce a concrete implementation plan.
    while (true) {

      // Reset SWE↔QA state for this evidence-loop pass.
      approvedPlan        = null;
      let qaRejections:        string[]           = [];
      let proposedFixStrategy: string | undefined = undefined;

      // ── Stage 2 & 3: SWE Agent → QA Reviewer loop ───────────────────────────
      for (let attempt = 1; attempt <= MAX_SWE_QA_LOOPS; attempt++) {

      // ── Stage 2: SWE Agent ─────────────────────────────────────────────────
      log(
        `Stage 2 / 4  —  SWE Agent` +
        (attempt > 1 ? ` (attempt ${attempt}/${MAX_SWE_QA_LOOPS})` : '') +
        (evidenceLoopCount > 0 ? ` [evidence pass ${evidenceLoopCount}]` : ''),
      );

      // prompt_manifest contains ordered absolute path strings — use directly.
      const swePaths = manifest.prompt_manifest;

      const sweTask    = buildSweTask(manifest, qaRejections, proposedFixStrategy, additionalEvidenceContext);
      const sweContext = compileContext(swePaths, sweTask);
      evidence.writeCompiledContext(`swe_v${attempt}`, sweContext);

      const swePlanRaw = await runWithFallback(sweContext, SwePlanSchema, {
        evidence,
        stage: 'planning',
      });
      const { plan: swePlan, warnings: planWarnings } = normalizeSwePlan(swePlanRaw);
      if (planWarnings.length > 0) {
        executionReportWarnings.push(...planWarnings);
        planWarnings.forEach(w => logDetail(`SWE plan warning: ${w}`));
      }
      evidence.writeSwePlan(swePlan, attempt);
      logDetail(
        `Action steps: ${swePlan.minimal_action_set.length} | ` +
        `plan_type: ${swePlan.plan_type}`,
      );

      // ── Direct mode: skip QA and CLI ───────────────────────────────────────
      if (effectiveMode === 'direct') {
        logDetail('Mode is "direct" — skipping QA Reviewer and CLI Executor.');
        approvedPlan = swePlan;
        break;
      }

      // ── Stage 3: QA Reviewer ───────────────────────────────────────────────
      log(
        `Stage 3 / 4  —  QA Reviewer` +
        (attempt > 1 ? ` (attempt ${attempt}/${MAX_SWE_QA_LOOPS})` : ''),
      );

      const qaContext = compileContext(abs(QA_PATHS), buildQaTask(swePlan));
      evidence.writeCompiledContext(`qa_v${attempt}`, qaContext);

      const qaSpan = pipelineTrace.startChildSpan('babel.qa', {
        'babel.qa.attempt': attempt,
        'babel.pipeline.mode': effectiveMode,
      });
      let verdict: z.infer<typeof QaVerdictSchema>;
      try {
        verdict = await runWithFallback(qaContext, QaVerdictSchema, {
          evidence,
          stage: 'qa',
        });
      } catch (error) {
        endSpan(qaSpan, SpanStatusCode.ERROR, {}, error);
        throw error;
      }
      evidence.writeQaVerdict(verdict, attempt);

      if (verdict.verdict === 'PASS') {
        logDetail(`QA: PASS  (confidence: ${verdict.overall_confidence}/5)`);
        v9StackTelemetry = markRuntimeTelemetryQaPass(v9StackTelemetry);
        writeRuntimeTelemetrySnapshot(evidence, v9StackTelemetry);
        pipelineTrace.recordQaVerdict('PASS', []);
        endSpan(qaSpan, SpanStatusCode.OK, {
          'babel.qa.verdict': 'PASS',
          'babel.qa.failure_count': 0,
          'babel.qa.confidence': verdict.overall_confidence,
          'babel.evidence_gate.status': 'satisfied',
        });
        approvedPlan = swePlan;
        break;
      }

      // ── QA rejected — collect failures and loop ────────────────────────────
      const rejectVerdict = verdict as z.infer<typeof QaVerdictSchema> & { verdict: 'REJECT' };
      const rejVerdict    = rejectVerdict as QaVerdictReject;

      logDetail(
        `QA: REJECT  (${rejVerdict.failure_count} failure(s), ` +
        `confidence: ${rejVerdict.overall_confidence}/5)`,
      );

      rejVerdict.failures.forEach((f, i) => {
        logDetail(`  ${i + 1}. [${f.tag}]  ${f.condition}`);
      });

      qaRejections        = rejVerdict.failures.map(f =>
        f.fix_hint
          ? `[${f.tag}] ${f.condition} (hint: ${f.fix_hint})`
          : `[${f.tag}] ${f.condition}`,
      );
      proposedFixStrategy = rejVerdict.proposed_fix_strategy;
      v9StackTelemetry = markRuntimeTelemetryQaReject(v9StackTelemetry, rejVerdict);
      writeRuntimeTelemetrySnapshot(evidence, v9StackTelemetry);
      pipelineTrace.recordQaVerdict('REJECT', rejVerdict.failures.map(failure => failure.tag));
      endSpan(qaSpan, SpanStatusCode.OK, {
        'babel.qa.verdict': 'REJECT',
        'babel.qa.failure_count': rejVerdict.failure_count,
        'babel.qa.failure_tags_hash': rejVerdict.failures.length > 0
          ? rejVerdict.failures.map(failure => failure.tag).join(',')
          : undefined,
        'babel.qa.confidence': rejVerdict.overall_confidence,
        'babel.evidence_gate.status': rejVerdict.failures.some(failure => failure.tag === 'EVIDENCE-GATE')
          ? 'violated'
          : 'unknown',
      });

      if (attempt === MAX_SWE_QA_LOOPS) {
        log(`QA rejected ${MAX_SWE_QA_LOOPS} plans. Pipeline halted.`);
        log(`Review evidence bundle for details: ${evidence.runDir}`);
        v9StackTelemetry = markRuntimeTelemetryOutcome(
          v9StackTelemetry,
          'QA_REJECTED_MAX_LOOPS',
          effectiveMode,
        );
        writeRuntimeTelemetrySnapshot(evidence, v9StackTelemetry);
        return await finalizeResult({
          runDir:   evidence.runDir,
          manifest,
          plan:     null,
          status:   'QA_REJECTED_MAX_LOOPS',
        });
      }

      logDetail(`Looping back to SWE Agent with rejection feedback...`);
    }

    // ── Stage 4: CLI Executor ─────────────────────────────────────────────────

    if (effectiveMode !== 'autonomous' || approvedPlan === null) {
      log(`Pipeline complete  —  mode "${effectiveMode}", no CLI execution.`);
      log(`Evidence bundle: ${evidence.runDir}`);
      v9StackTelemetry = markRuntimeTelemetryOutcome(
        v9StackTelemetry,
        'COMPLETE',
        effectiveMode,
      );
      writeRuntimeTelemetrySnapshot(evidence, v9StackTelemetry);
      return await finalizeResult({ runDir: evidence.runDir, manifest, plan: approvedPlan, status: 'COMPLETE' });
    }

    log('Stage 4 / 4  —  CLI Executor');
    // This span records the QA gate clearance and activation decision only —
    // it is intentionally closed before the executor loop runs. Individual
    // executor tool calls are captured in the evidence bundle (05_execution_log.json),
    // not in OTel spans, to prevent raw command strings from entering the trace backend.
    const executorActivationSpan = pipelineTrace.startChildSpan('babel.executor.activation', {
      'babel.executor.status': 'activated',
      'babel.executor.mode': effectiveMode,
      'babel.executor.plan_type': approvedPlan.plan_type,
      'babel.executor.step_count': approvedPlan.minimal_action_set.length,
    });
    endSpan(executorActivationSpan, SpanStatusCode.OK);

    let toolCallLog: ToolCallLog[];
    try {
      ({ toolCallLog } = await runExecutorLoop(
        approvedPlan,
        evidence,
        effectiveModel,
        executionReportWarnings,
      ));
    } catch (err) {
      log(`CLI Executor error: ${err instanceof Error ? err.message : String(err)}`);
      v9StackTelemetry = markRuntimeTelemetryOutcome(
        v9StackTelemetry,
        'EXECUTOR_HALTED',
        effectiveMode,
      );
      writeRuntimeTelemetrySnapshot(evidence, v9StackTelemetry);
      return await finalizeResult({ runDir: evidence.runDir, manifest, plan: approvedPlan, status: 'EXECUTOR_HALTED' });
    }

    // ── Evidence loop evaluation ──────────────────────────────────────────────
    // If the approved plan was an evidence-gathering pass, rebound to Stage 2
    // with the collected results injected into the next SWE Agent prompt.
    if (approvedPlan.plan_type === 'EVIDENCE_REQUEST') {
      evidenceLoopCount++;

      if (evidenceLoopCount > MAX_EVIDENCE_LOOPS) {
        log(`Maximum evidence loops (${MAX_EVIDENCE_LOOPS}) exceeded. Halting pipeline.`);
        log(`Review evidence bundle for details: ${evidence.runDir}`);
        v9StackTelemetry = markRuntimeTelemetryOutcome(
          v9StackTelemetry,
          'EVIDENCE_LOOP_EXCEEDED',
          effectiveMode,
        );
        writeRuntimeTelemetrySnapshot(evidence, v9StackTelemetry);
        return await finalizeResult({
          runDir:   evidence.runDir,
          manifest,
          plan:     approvedPlan,
          status:   'EVIDENCE_LOOP_EXCEEDED',
        });
      }

      log(
        `Evidence gathered. Rebounding to SWE Agent ` +
        `(Loop ${evidenceLoopCount}/${MAX_EVIDENCE_LOOPS})...`,
      );
      additionalEvidenceContext += formatExecutionResults(toolCallLog, evidenceLoopCount);
      continue; // outer while — back to Stage 2 with enriched context
    }

    // Standard (non-evidence) implementation plan — pipeline complete.
    break;
  }

  log(`Pipeline complete  —  Evidence bundle: ${evidence.runDir}`);
  v9StackTelemetry = markRuntimeTelemetryOutcome(
    v9StackTelemetry,
    'COMPLETE',
    effectiveMode,
  );
  writeRuntimeTelemetrySnapshot(evidence, v9StackTelemetry);
  return await finalizeResult({ runDir: evidence.runDir, manifest, plan: approvedPlan, status: 'COMPLETE' });
  } catch (error) {
    return await finalizeError(error);
  }
}

export async function resumeManualBridge(
  runDir: string,
  planInput: string | { planPath?: string; rawPlanText?: string },
): Promise<PipelineResult> {
  const manifestPath = join(runDir, '01_manifest.json');
  const manifestRaw  = JSON.parse(readFileSync(manifestPath, 'utf-8')) as unknown;
  const manifest     = OrchestratorManifestSchema.parse(manifestRaw);
  configureToolProjectRoot(manifest);

  let rawPlanText: string;
  if (typeof planInput === 'string') {
    rawPlanText = readFileSync(planInput, 'utf-8');
  } else if (planInput.rawPlanText !== undefined) {
    rawPlanText = planInput.rawPlanText;
  } else if (planInput.planPath) {
    rawPlanText = readFileSync(planInput.planPath, 'utf-8');
  } else {
    throw new Error('resumeManualBridge requires planPath or rawPlanText.');
  }
  let planJson: unknown;
  const sanitizedPlanText = rawPlanText.replace(/^\uFEFF/, '').trim();
  try {
    planJson = JSON.parse(sanitizedPlanText);
  } catch (err) {
    const errors = [
      `plan.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    ];
    const evidence = EvidenceBundle.fromExistingRun(runDir);
    evidence.writeManualPlanRepair(buildManualPlanRepairPrompt(errors, sanitizedPlanText));
    return {
      runDir,
      manifest,
      plan: null,
      status: 'MANUAL_PLAN_INVALID',
      repairPromptPath: join(runDir, '02_manual_plan_repair.md'),
      errors,
    };
  }

  const parsedPlan = SwePlanSchema.safeParse(planJson);
  if (!parsedPlan.success) {
    const errors   = formatZodErrors(parsedPlan.error);
    const evidence = EvidenceBundle.fromExistingRun(runDir);
    evidence.writeManualPlanRepair(buildManualPlanRepairPrompt(errors, sanitizedPlanText));
    return {
      runDir,
      manifest,
      plan: null,
      status: 'MANUAL_PLAN_INVALID',
      repairPromptPath: join(runDir, '02_manual_plan_repair.md'),
      errors,
    };
  }

  const { plan: swePlan, warnings: planWarnings } = normalizeSwePlan(parsedPlan.data);
  const evidence = EvidenceBundle.fromExistingRun(runDir);
  const canonicalPlan = `${JSON.stringify(swePlan, null, 2)}\n`;
  const manualDir = join(runDir, 'manual');
  mkdirSync(manualDir, { recursive: true });
  writeFileSync(join(manualDir, 'plan.json'), canonicalPlan, 'utf-8');
  writeFileSync(join(runDir, '02_swe_plan_v1.json'), canonicalPlan, 'utf-8');

  const targetModel = manifest.worker_configuration.assigned_model as TargetModel;
  log('Stage 3 / 4  —  QA Reviewer (resume)');
  const qaContext = compileContext(abs(QA_PATHS), buildQaTask(swePlan));
  evidence.writeCompiledContext('qa_v1', qaContext);

  const verdict = await runWithFallback(qaContext, QaVerdictSchema, {
    evidence,
    stage: 'qa',
  });
  evidence.writeQaVerdict(verdict, 1);

  if (verdict.verdict !== 'PASS') {
    log(`QA rejected the resumed manual plan. Pipeline halted at Stage 3.`);
    return {
      runDir,
      manifest,
      plan: null,
      status: 'QA_REJECTED_MAX_LOOPS',
    };
  }

  log('Stage 4 / 4  —  CLI Executor');
  try {
    await runExecutorLoop(swePlan, evidence, targetModel, planWarnings);
  } catch (err) {
    log(`CLI Executor error: ${err instanceof Error ? err.message : String(err)}`);
    return {
      runDir,
      manifest,
      plan: swePlan,
      status: 'EXECUTOR_HALTED',
    };
  }

  return {
    runDir,
    manifest,
    plan: swePlan,
    status: 'COMPLETE',
  };
}

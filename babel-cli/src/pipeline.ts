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
import { spawnSync }              from 'node:child_process';
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
import { resolveFamilyModelPolicy } from './modelPolicy.js';
import { EvidenceBundle }         from './evidence.js';
import { truncateLogs }           from './utils/truncate.js';
import { collectHarnessMetadata } from './telemetry/metadata.js';
import { PipelineTrace, endSpan } from './telemetry/tracing.js';
import { executeTool,
         ToolCallRequestSchema,
         DRY_RUN }                from './localTools.js';
import type { ToolResult }        from './localTools.js';
import {
  buildGroundingQaReject,
  buildTaskGrounding,
  classifyTaskContract,
  collectPlanGroundingViolations,
  formatGroundingContext,
  normalizePlanTargetsAgainstGrounding,
} from './taskCompletion.js';
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
import type { ResolvedModelPolicy } from './modelPolicy.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

/** Absolute path to the Babel prompt library root (parent of babel-cli/). */
const BABEL_ROOT     = process.env['BABEL_ROOT']     ?? resolve(__dirname, '../..');
const BABEL_RUNS_DIR = process.env['BABEL_RUNS_DIR'] ?? join(BABEL_ROOT, 'runs');
const GRADLE_CACHE_DIR = join(BABEL_ROOT, 'cache', 'gradle-distributions');

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
  /** Select which configured model-policy tier should be resolved. */
  modelTier?: string;
  /** Opt in explicitly to model-policy entries marked expensive. */
  allowExpensive?: boolean;
  /** Include resolved model-policy details in user-visible outputs. */
  showModelPolicy?: boolean;
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
  modelPolicy?: ResolvedModelPolicy;
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

type JavaRuntimeStatus = {
  available: boolean;
  source: 'java_home' | 'path' | 'missing';
  summary: string;
};

type AndroidSdkStatus = {
  available: boolean;
  source: 'android_home' | 'android_sdk_root' | 'local_default' | 'missing';
  sdkRoot: string | null;
  sdkManagerPath: string | null;
  adbPath: string | null;
  platforms: string[];
  buildTools: string[];
  summary: string;
};

type CommandRuntimeStatus = {
  available: boolean;
  source: 'path' | 'missing';
  summary: string;
  command: string;
  resolvedPath: string | null;
};

function detectCommandOnPath(command: string): CommandRuntimeStatus {
  const locatorCommand = process.platform === 'win32' ? 'where' : 'which';
  const locatorResult = spawnSync(locatorCommand, [command], {
    encoding: 'utf-8',
    windowsHide: true,
  });
  if (locatorResult.status === 0) {
    const firstMatch = String(locatorResult.stdout ?? '')
      .split(/\r?\n/)
      .map(line => line.trim())
      .find(line => line.length > 0);
    if (firstMatch) {
      return {
        available: true,
        source: 'path',
        summary: `${command} available on PATH (${firstMatch})`,
        command,
        resolvedPath: firstMatch,
      };
    }
  }

  return {
    available: false,
    source: 'missing',
    summary: `${command} is NOT available on PATH in the current executor environment.`,
    command,
    resolvedPath: null,
  };
}

function detectGradleInstallCandidate(): string | null {
  const roots = process.platform === 'win32'
    ? [
        'C:\\Program Files\\Gradle',
        'C:\\Program Files (x86)\\Gradle',
      ]
    : ['/opt/gradle', '/usr/local/gradle'];

  const candidates: string[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    try {
      const entries = readdirSync(root, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => join(
          root,
          entry.name,
          'bin',
          process.platform === 'win32' ? 'gradle.bat' : 'gradle',
        ))
        .filter(candidate => existsSync(candidate))
        .sort((left, right) => right.localeCompare(left));
      candidates.push(...entries);
    } catch {
      continue;
    }
  }

  return candidates[0] ?? null;
}

function prependProcessPath(pathEntry: string): void {
  const currentPath = process.env.PATH ?? '';
  const delimiter = process.platform === 'win32' ? ';' : ':';
  const normalizedEntry = resolve(pathEntry);
  const existing = currentPath
    .split(delimiter)
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0);

  const alreadyPresent = existing.some(entry =>
    process.platform === 'win32'
      ? entry.toLowerCase() === normalizedEntry.toLowerCase()
      : entry === normalizedEntry,
  );
  if (alreadyPresent) {
    return;
  }

  process.env.PATH = [normalizedEntry, ...existing].join(delimiter);
}

function parseGradleDistributionUrl(propertiesContent: string): string | null {
  const match = String(propertiesContent ?? '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => line.startsWith('distributionUrl='));
  if (!match) {
    return null;
  }

  return match
    .slice('distributionUrl='.length)
    .trim()
    .replace(/\\:/g, ':')
    .replace(/\\=/g, '=');
}

function detectGradleBinaryFromExtractedRoot(extractedRoot: string): string | null {
  const binaryName = process.platform === 'win32' ? 'gradle.bat' : 'gradle';
  const directCandidate = join(extractedRoot, 'bin', binaryName);
  if (existsSync(directCandidate)) {
    return directCandidate;
  }

  if (!existsSync(extractedRoot)) {
    return null;
  }

  try {
    const entries = readdirSync(extractedRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => join(extractedRoot, entry.name, 'bin', binaryName))
      .filter(candidate => existsSync(candidate))
      .sort((left, right) => right.localeCompare(left));
    return entries[0] ?? null;
  } catch {
    return null;
  }
}

function repairSettingsGradleKtsContent(content: string): {
  content: string;
  changed: boolean;
  notes: string[];
} {
  let next = String(content ?? '');
  const notes: string[] = [];

  const includeBareStringRe = /^(\s*)include\s+"([^"]+)"\s*$/gm;
  if (includeBareStringRe.test(next)) {
    next = next.replace(includeBareStringRe, '$1include("$2")');
    notes.push('Normalized bare include syntax to include("...").');
  }

  return {
    content: next,
    changed: notes.length > 0,
    notes,
  };
}

function buildDeterministicRootBuildGradleKtsContent(): string {
  return [
    'plugins {',
    '    id("com.android.application") version "8.7.3" apply false',
    '    id("org.jetbrains.kotlin.android") version "1.9.24" apply false',
    '}',
    '',
  ].join('\n');
}

function detectJavaRuntimeStatus(): JavaRuntimeStatus {
  const javaHome = process.env.JAVA_HOME?.trim();
  if (javaHome) {
    const javaHomeCandidate = join(
      javaHome,
      'bin',
      process.platform === 'win32' ? 'java.exe' : 'java',
    );
    if (existsSync(javaHomeCandidate)) {
      return {
        available: true,
        source: 'java_home',
        summary: `Java available via JAVA_HOME (${javaHomeCandidate})`,
      };
    }
  }

  const javaPathStatus = detectCommandOnPath('java');
  if (javaPathStatus.available) {
    return {
      available: true,
      source: 'path',
      summary: `Java available on PATH (${javaPathStatus.resolvedPath})`,
    };
  }

  return {
    available: false,
    source: 'missing',
    summary: 'Java is NOT available in the current executor environment. JAVA_HOME is unset or invalid and no java executable is on PATH.',
  };
}

function listDirectoryNamesIfPresent(dirPath: string): string[] {
  if (!existsSync(dirPath)) {
    return [];
  }

  try {
    return readdirSync(dirPath, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

function detectAndroidSdkStatus(): AndroidSdkStatus {
  const candidates: Array<{ source: AndroidSdkStatus['source']; root: string | null }> = [
    { source: 'android_home', root: process.env.ANDROID_HOME?.trim() ?? null },
    { source: 'android_sdk_root', root: process.env.ANDROID_SDK_ROOT?.trim() ?? null },
    {
      source: 'local_default',
      root: process.env.LOCALAPPDATA
        ? join(process.env.LOCALAPPDATA, 'Android', 'Sdk')
        : null,
    },
  ];

  for (const candidate of candidates) {
    if (!candidate.root || !existsSync(candidate.root)) {
      continue;
    }

    const platforms = listDirectoryNamesIfPresent(join(candidate.root, 'platforms'));
    const buildTools = listDirectoryNamesIfPresent(join(candidate.root, 'build-tools'));
    const platformToolsDir = join(candidate.root, 'platform-tools');
    const toolsBinDir = join(candidate.root, 'tools', 'bin');
    const adbPath = existsSync(join(platformToolsDir, process.platform === 'win32' ? 'adb.exe' : 'adb'))
      ? join(platformToolsDir, process.platform === 'win32' ? 'adb.exe' : 'adb')
      : null;
    const sdkManagerPath = existsSync(join(toolsBinDir, process.platform === 'win32' ? 'sdkmanager.bat' : 'sdkmanager'))
      ? join(toolsBinDir, process.platform === 'win32' ? 'sdkmanager.bat' : 'sdkmanager')
      : null;

    if (platforms.length > 0 && buildTools.length > 0) {
      return {
        available: true,
        source: candidate.source,
        sdkRoot: candidate.root,
        sdkManagerPath,
        adbPath,
        platforms,
        buildTools,
        summary: `Android SDK available via ${candidate.source} (${candidate.root}); platforms=${platforms.join(', ') || 'none'}; build-tools=${buildTools.join(', ') || 'none'}`,
      };
    }
  }

  return {
    available: false,
    source: 'missing',
    sdkRoot: null,
    sdkManagerPath: null,
    adbPath: null,
    platforms: [],
    buildTools: [],
    summary: 'Android SDK is NOT available in the executor environment. ANDROID_HOME / ANDROID_SDK_ROOT are unset or invalid and no usable local SDK was discovered.',
  };
}

function buildLocalPropertiesSdkLine(sdkRoot: string): string {
  return `sdk.dir=${sdkRoot.replace(/\\/g, '\\\\')}`;
}

function ensureAndroidSdkEnvironment(sdkStatus: AndroidSdkStatus): string[] {
  if (!sdkStatus.available || !sdkStatus.sdkRoot) {
    return [];
  }

  process.env.ANDROID_HOME = sdkStatus.sdkRoot;
  process.env.ANDROID_SDK_ROOT = sdkStatus.sdkRoot;

  const prependedPaths: string[] = [];
  for (const dirPath of [
    join(sdkStatus.sdkRoot, 'platform-tools'),
    join(sdkStatus.sdkRoot, 'tools', 'bin'),
    join(sdkStatus.sdkRoot, 'emulator'),
  ]) {
    if (existsSync(dirPath)) {
      prependProcessPath(dirPath);
      prependedPaths.push(dirPath);
    }
  }

  return prependedPaths;
}

function usesGradleLikeCommand(target: string): boolean {
  return /\b(?:gradle|gradlew(?:\.bat)?)\b/i.test(String(target ?? ''));
}

function isGradleProvisioningStep(step: SwePlan['minimal_action_set'][number]): boolean {
  if (step.tool !== 'shell_exec' && step.tool !== 'test_run') {
    return false;
  }

  const target = String(step.target ?? '').trim();
  if (!target) {
    return false;
  }

  return /\b(winget|choco|scoop)\b.*\bgradle\b/i.test(target);
}

function shouldUseDeterministicGradleBootstrapLane(
  manifest: OrchestratorManifest,
): boolean {
  const projectRoot = inferProjectRoot(manifest);
  if (!projectRoot || !existsSync(projectRoot)) {
    return false;
  }

  const wrapperJarPath = join(projectRoot, 'gradle', 'wrapper', 'gradle-wrapper.jar');
  const gradlewPath = join(projectRoot, 'gradlew');
  const gradlewBatPath = join(projectRoot, 'gradlew.bat');
  const wrapperPropertiesPath = join(projectRoot, 'gradle', 'wrapper', 'gradle-wrapper.properties');

  return (
    !existsSync(wrapperJarPath) &&
    existsSync(wrapperPropertiesPath) &&
    (existsSync(gradlewPath) || existsSync(gradlewBatPath))
  );
}

function shouldUseDeterministicAndroidSdkBootstrapLane(
  manifest: OrchestratorManifest,
): boolean {
  const projectRoot = inferProjectRoot(manifest);
  if (!projectRoot || !existsSync(projectRoot)) {
    return false;
  }

  return (
    existsSync(join(projectRoot, 'settings.gradle.kts')) ||
    existsSync(join(projectRoot, 'app', 'build.gradle.kts')) ||
    existsSync(join(projectRoot, 'app', 'src', 'main', 'AndroidManifest.xml'))
  );
}

function isJavaProvisioningStep(step: SwePlan['minimal_action_set'][number]): boolean {
  if (step.tool !== 'shell_exec' && step.tool !== 'test_run') {
    return false;
  }

  const target = String(step.target ?? '').trim();
  if (!target) {
    return false;
  }

  return (
    /\b(winget|choco|scoop)\b.*\b(jdk|java|temurin|openjdk|corretto|microsoft-openjdk)\b/i.test(target) ||
    /\b(setx|export)\b[^\r\n]*\bJAVA_HOME\b/i.test(target) ||
    /\bJAVA_HOME\s*=/.test(target) ||
    /\bgradle\s+wrapper\b/i.test(target)
  );
}

function buildSweTask(
  manifest:            OrchestratorManifest,
  qaRejections:        string[],
  proposedFixStrategy: string | undefined,
  evidenceContext:     string = '',
  groundingContext:    string = '',
): string {
  const { user_request } = manifest.handoff_payload;
  const projectRoot = inferProjectRoot(manifest);
  const projectRootLines: string[] = [];
  const wrapperBootstrapLines: string[] = [];
  const runtimePreflightLines: string[] = [];
  const deterministicLaneLines: string[] = [];
  const javaRuntimeStatus = detectJavaRuntimeStatus();
  const gradleRuntimeStatus = detectCommandOnPath('gradle');
  const androidSdkStatus = detectAndroidSdkStatus();
  const wingetRuntimeStatus = process.platform === 'win32'
    ? detectCommandOnPath('winget')
    : { available: false, source: 'missing', summary: 'winget is unavailable on non-Windows platforms.', command: 'winget', resolvedPath: null } satisfies CommandRuntimeStatus;

  if (projectRoot) {
    projectRootLines.push(`Target project root: ${projectRoot}`);

    if (existsSync(projectRoot)) {
      const topLevelEntries = readdirSync(projectRoot, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((entry) => `${entry.isDirectory() ? 'dir' : 'file'} ${entry.name}`);
      const hasExistingAndroidProject =
        existsSync(join(projectRoot, 'app')) ||
        existsSync(join(projectRoot, 'settings.gradle.kts')) ||
        existsSync(join(projectRoot, 'app', 'build.gradle.kts')) ||
        existsSync(join(projectRoot, 'app', 'src', 'main', 'AndroidManifest.xml'));

      projectRootLines.push(
        `Current top-level entries: ${topLevelEntries.length > 0 ? topLevelEntries.join(', ') : '(empty)'}`,
      );
      projectRootLines.push(
        hasExistingAndroidProject
          ? 'Existing target state: partial Android project already exists at the target root. Continue in place; do not create a second nested app root.'
          : 'Existing target state: no Android project markers detected yet at the target root.',
      );

      const wrapperPropertiesPath = join(projectRoot, 'gradle', 'wrapper', 'gradle-wrapper.properties');
      const wrapperJarPath = join(projectRoot, 'gradle', 'wrapper', 'gradle-wrapper.jar');
      const gradlewPath = join(projectRoot, 'gradlew');
      const gradlewBatPath = join(projectRoot, 'gradlew.bat');
      const wrapperPropertiesExists = existsSync(wrapperPropertiesPath);
      const wrapperJarExists = existsSync(wrapperJarPath);
      const gradlewExists = existsSync(gradlewPath);
      const gradlewBatExists = existsSync(gradlewBatPath);
      const rootBuildGradlePath = join(projectRoot, 'build.gradle.kts');
      const appBuildGradlePath = join(projectRoot, 'app', 'build.gradle.kts');
      const rootBuildGradleExists = existsSync(rootBuildGradlePath);
      const appBuildGradleExists = existsSync(appBuildGradlePath);
      const mirroredGradleCandidates = [
        join(projectRoot, 'reference-montecarlo-ledger', 'build.gradle.kts'),
        join(projectRoot, 'reference-montecarlo-ledger', 'settings.gradle.kts'),
        join(projectRoot, 'reference-montecarlo-ledger', 'app', 'build.gradle.kts'),
        join(projectRoot, 'reference-montecarlo-ledger', 'gradle', 'wrapper', 'gradle-wrapper.properties'),
        join(projectRoot, 'reference-montecarlo-ledger', 'gradle', 'wrapper', 'gradle-wrapper.jar'),
      ];
      const missingMirroredGradleFiles = mirroredGradleCandidates
        .filter(candidatePath => !existsSync(candidatePath))
        .map(candidatePath => candidatePath.replace(/\\/g, '/'));

      projectRootLines.push(
        `Gradle wrapper state: properties=${wrapperPropertiesExists ? 'present' : 'missing'}, jar=${wrapperJarExists ? 'present' : 'missing'}, gradlew=${gradlewExists ? 'present' : 'missing'}, gradlew.bat=${gradlewBatExists ? 'present' : 'missing'}`,
      );
      projectRootLines.push(
        `Build file state: root build.gradle.kts=${rootBuildGradleExists ? 'present' : 'missing'}, app/build.gradle.kts=${appBuildGradleExists ? 'present' : 'missing'}, settings.gradle.kts=${existsSync(join(projectRoot, 'settings.gradle.kts')) ? 'present' : 'missing'}`,
      );
      runtimePreflightLines.push(`Executor Java runtime: ${javaRuntimeStatus.summary}`);
      runtimePreflightLines.push(`Executor Gradle runtime: ${gradleRuntimeStatus.summary}`);
      runtimePreflightLines.push(`Executor Android SDK runtime: ${androidSdkStatus.summary}`);
      runtimePreflightLines.push(`Executor winget runtime: ${wingetRuntimeStatus.summary}`);
      if (missingMirroredGradleFiles.length > 0) {
        runtimePreflightLines.push(
          `Known missing mirrored Gradle files: ${missingMirroredGradleFiles.join(', ')}`,
        );
      }

      if (!gradlewExists || !gradlewBatExists || !wrapperPropertiesExists) {
        wrapperBootstrapLines.push(
          'Wrapper bootstrap mode is ACTIVE.',
          'If gradle/wrapper/gradle-wrapper.properties exists in the target root, treat that target file as the source of truth and create missing gradlew / gradlew.bat directly with file_write.',
          'Do NOT plan file_read or directory_list steps against wrapper files in the mirrored reference repo unless those exact wrapper files are already known to exist there.',
          'Known wrapper generation rule:',
          '  - write gradlew as a standard POSIX Gradle launcher script that invokes "%APP_HOME%/gradle/wrapper/gradle-wrapper.jar" via Java when present',
          '  - write gradlew.bat as a standard Windows Gradle launcher script that invokes "%APP_HOME%\\gradle\\wrapper\\gradle-wrapper.jar" via Java when present',
          '  - if gradle-wrapper.properties is missing, create it directly at gradle/wrapper/gradle-wrapper.properties with a valid Gradle distributionUrl before creating wrapper scripts',
          '  - if wrapper scripts are missing, create them directly in the target root instead of trying to copy or inspect them from the mirrored source repo',
          '  - if gradle-wrapper.jar is also missing, prefer a direct shell_exec step like "gradle wrapper" in the target root after the project files are in place',
        );
      }

      if (!gradleRuntimeStatus.available && !wrapperJarExists) {
        wrapperBootstrapLines.push(
          'Gradle bootstrap sequencing is REQUIRED because gradle-wrapper.jar is missing and global gradle is also missing.',
          'A deterministic executor bootstrap lane will provision Gradle and generate gradle-wrapper.jar before normal execution begins.',
          'Do NOT spend plan steps on installing Gradle, running `gradle --version`, or running `gradle wrapper` when this lane is active.',
          'The plan MUST provision Gradle first (for example via winget install) BEFORE any step that runs `gradle wrapper`, `gradle --version`, or other global Gradle commands.',
          'Do NOT place `gradle --version` before the Gradle provisioning step.',
          'Do NOT plan any file_read or directory_list steps against known-missing mirrored Gradle files while bootstrapping Gradle.',
          'Until the lane completes, focus the action set on concrete project files and post-bootstrap verification/build steps only.',
        );
        deterministicLaneLines.push(
          'Deterministic Gradle bootstrap lane is ACTIVE for this task.',
          'The plan must assume wrapper/bootstrap prerequisites will be satisfied before normal execution begins.',
          'BANNED plan steps while this lane is active:',
          '  - `winget install Gradle.Gradle` or any other Gradle provisioning command',
          '  - `gradle --version`',
          '  - `gradle wrapper`',
          '  - reading `gradle-wrapper.jar` as if it already exists',
          '  - verifying future APK output files by reading them before the build runs',
          'Allowed post-bootstrap work:',
          '  - read existing project files that already exist',
          '  - create missing build files directly with file_write when target files are missing',
          '  - run wrapper-based commands like `gradlew tasks` or `gradlew assembleDebug` after bootstrap',
        );
      }

      if (!gradleRuntimeStatus.available && wrapperJarExists && (gradlewExists || gradlewBatExists)) {
        deterministicLaneLines.push(
          'Existing Gradle wrapper mode is ACTIVE for this task.',
          'The target project already has gradlew / gradlew.bat and gradle-wrapper.jar, while global gradle is missing from PATH.',
          'BANNED plan steps in this mode:',
          '  - any global `gradle ...` command, including `gradle --version` and `gradle wrapper`',
          '  - provisioning or re-creating the wrapper when the existing wrapper files are already present',
          'Required behavior in this mode:',
          '  - use only wrapper-based commands such as `gradlew tasks` or `gradlew assembleDebug` for build verification',
          '  - treat wrapper execution as the canonical Gradle path for this task',
        );
      }

      if (!rootBuildGradleExists) {
        deterministicLaneLines.push(
          'Target root build.gradle.kts is currently missing. If needed, CREATE it directly with file_write; do not try to file_read it first.',
        );
      }
      if (appBuildGradleExists) {
        deterministicLaneLines.push(
          'Target app/build.gradle.kts already exists. Prefer reading this real target file instead of any mirrored build.gradle.kts.',
        );
      }
    } else {
      projectRootLines.push('Current top-level entries: target root does not exist yet.');
    }
  }

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
    '    "tool": "directory_list|file_read|file_write|shell_exec|test_run|mcp_request|audit_ui|memory_store|memory_query",',
    '    "target": "<path or command>", "rationale": "...",',
    '    "reversible": true, "verification": "<how to confirm success>"',
    '  }],',
    '  "root_cause": "N/A — feature request",',
    '  "out_of_scope": ["<excluded item>"]',
    '}',
    '',
    `Task: ${user_request}`,
    ...(projectRootLines.length > 0
      ? [
          '',
          'Target project context:',
          ...projectRootLines,
        ]
      : []),
    '',
    'Planning rules for executable steps:',
    '  - Use "directory_list" to inspect folders. Do NOT use "file_read" on a directory path.',
    '  - Use "file_read" only for actual files whose contents need inspection.',
    '  - Every file_read target must be a concrete file path. Never use placeholder targets like <path-to-main-source-file>.',
    '  - For "shell_exec" and "test_run", the target must be the executable command itself.',
    '  - Do NOT wrap commands with "cmd /c", PowerShell, bash, shell chaining, helper scripts, or "cd ... &&".',
    '  - Use project-root or module-root paths in working_directory instead of shell wrappers.',
    '  - Prefer file_write over shell-based bulk transforms. Do NOT create or run wrapper scripts to rewrite many files.',
    '  - If the target root already contains a partial project, continue by editing that existing tree in place.',
    '  - Do NOT create a second nested application root inside the target root unless the user explicitly asked for that.',
    '  - If a mirrored reference repo already lives inside the target root, read from that mirrored path instead of any external path.',
    '  - Prefer a small number of concrete file_read steps followed by direct file_write steps for the files that need to change.',
    '  - When the task is to restore or generate missing wrapper/build scripts (for example gradlew or gradlew.bat), do NOT plan file_read steps against those missing files.',
    '  - If a required wrapper script is missing but its companion config exists (for example gradle/wrapper/gradle-wrapper.properties), read the existing config and then create the missing wrapper script directly with file_write.',
    '  - Do not use the mirrored reference repo as a source of truth for wrapper files unless those exact wrapper files actually exist there.',
    '  - Treat runtime prerequisites as part of the executable plan. Do not assume Java, JAVA_HOME, SDKs, or build tools exist unless the target context confirms that they do.',
    ...(javaRuntimeStatus.available
      ? [
          `  - Current Java preflight: ${javaRuntimeStatus.summary}.`,
        ]
      : [
          '  - Current Java preflight: Java is missing in the executor environment.',
          '  - If you plan any gradle/gradlew verification or build step, add an explicit Java bootstrap/configuration step BEFORE the first Gradle command.',
          '  - That bootstrap step must install or configure a JDK / JAVA_HOME, not just assume java exists.',
        ]),
    ...(gradleRuntimeStatus.available
      ? [
          `  - Current Gradle preflight: ${gradleRuntimeStatus.summary}.`,
        ]
      : [
          '  - Current Gradle preflight: global gradle is missing from PATH.',
          '  - If gradle-wrapper.jar is missing, do NOT plan a `gradle wrapper` step unless the plan first installs/configures Gradle or uses another explicit bootstrap path.',
          '  - When global gradle is absent and gradle-wrapper.jar is missing, the first global-Gradle-related step must be a provisioning step, not `gradle --version` and not a mirrored Gradle file read.',
          ...(wingetRuntimeStatus.available
            ? ['  - A valid recovery path is to install Gradle explicitly with winget before invoking `gradle wrapper`, because winget is available in this executor environment.']
            : []),
        ]),
    ...(androidSdkStatus.available
      ? [
          `  - Current Android SDK preflight: ${androidSdkStatus.summary}.`,
          '  - For Android build verification, prefer relying on the deterministic executor Android SDK lane rather than planning manual SDK discovery steps.',
          '  - If local.properties is missing, do NOT plan a file_read against it; the executor SDK lane can create or repair it directly.',
        ]
      : [
          '  - Current Android SDK preflight: no usable Android SDK has been discovered yet.',
          '  - If you plan Android build verification steps like `gradlew assembleDebug`, the plan must either provision/configure the Android SDK first or explicitly rely on an executor bootstrap lane when one is active.',
          '  - Do NOT treat missing local.properties as an existing file that must be read first; if needed, create it directly with file_write.',
        ]),
    ...(wrapperBootstrapLines.length > 0
      ? [
          '',
          'Wrapper bootstrap context:',
          ...wrapperBootstrapLines,
        ]
      : []),
    ...(runtimePreflightLines.length > 0
      ? [
          '',
          'Runtime preflight context:',
          ...runtimePreflightLines,
        ]
      : []),
    ...(deterministicLaneLines.length > 0
      ? [
          '',
          'Deterministic bootstrap context:',
          ...deterministicLaneLines,
        ]
      : []),
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

  if (groundingContext.trim().length > 0) {
    lines.push(
      '',
      groundingContext.trim(),
    );
  }

  return lines.join('\n');
}

function buildQaTask(
  swePlan: SwePlan,
  javaRuntimeStatus: JavaRuntimeStatus,
  gradleRuntimeStatus: CommandRuntimeStatus,
  androidSdkStatus: AndroidSdkStatus,
  deterministicGradleBootstrapLaneActive = false,
): string {
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
    '--- EXECUTOR SAFETY RULES ---',
    'Reject the plan if any minimal_action_set step contains any of the following:',
    '  - unresolved placeholder targets such as <path-to-file> or other angle-bracket placeholders',
    '  - file or directory targets outside target_project_path',
    '  - shell-wrapped commands such as cmd /c, powershell -c, bash -lc, sh -c',
    '  - command chaining or directory-changing wrappers such as cd ... &&',
    '  - gradle/gradlew verification steps that assume Java exists when the runtime preflight says Java is missing and the plan does not bootstrap/configure Java first',
    '  - `gradle ...` steps that assume global Gradle exists when the runtime preflight says Gradle is missing and the plan does not install/configure Gradle first',
    'Use INCOMPLETE_SUBMISSION for unresolved placeholders.',
    'Use SFDIPOT-P for executor/runtime-incompatible paths or shell-wrapped commands.',
    `Current Java runtime preflight: ${javaRuntimeStatus.summary}`,
    `Current Gradle runtime preflight: ${gradleRuntimeStatus.summary}`,
    `Current Android SDK runtime preflight: ${androidSdkStatus.summary}`,
    ...(deterministicGradleBootstrapLaneActive
      ? [
          'Deterministic Gradle bootstrap lane status: ACTIVE.',
          'When this lane is ACTIVE, the executor/runtime owns Gradle provisioning, root build bootstrap repair, wrapper generation, and halting if bootstrap fails.',
          'Do NOT reject a plan merely because global gradle is missing when the plan only uses post-bootstrap wrapper commands such as `gradlew tasks` or `gradlew assembleDebug`.',
          'Do NOT require the plan to include its own bootstrap/failure-handling steps for gradle-wrapper.jar generation when the lane is ACTIVE.',
          'Only reject for Gradle/bootstrap reasons if the plan still includes forbidden global `gradle ...` commands, mirrored Gradle file probes, or other executor-incompatible steps.',
        ]
      : []),
    ...(process.platform === 'win32'
      ? [
          'Windows-specific rule: do NOT reject a plan merely because it does not include wrapper permission, chmod, or Unblock-File steps for `gradlew` / `gradlew.bat`.',
          'Only reject for Windows wrapper-permission issues if the grounded evidence explicitly shows the wrapper file is blocked, unreadable, or failing because of a permission/MOTW issue.',
        ]
      : []),
    'Wrapper rule: if gradlew / gradlew.bat already exists in the target project, do NOT reject a plan merely because global gradle is unavailable on PATH when the plan uses wrapper-based commands only.',
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

function sanitizeQaVerdictForDeterministicGradleBootstrapLane(
  verdict: z.infer<typeof QaVerdictSchema>,
  swePlan: SwePlan,
  manifest: OrchestratorManifest,
): z.infer<typeof QaVerdictSchema> {
  if (
    verdict.verdict !== 'REJECT' ||
    !shouldUseDeterministicGradleBootstrapLane(manifest)
  ) {
    return verdict;
  }

  const usesForbiddenGlobalGradle = swePlan.minimal_action_set.some(step =>
    (step.tool === 'shell_exec' || step.tool === 'test_run') &&
    /\bgradle\b/i.test(String(step.target ?? '')) &&
    !/\bgradlew(?:\.bat)?\b/i.test(String(step.target ?? '')) &&
    !/\b(winget|choco|scoop)\b/i.test(String(step.target ?? '')),
  );

  if (usesForbiddenGlobalGradle) {
    return verdict;
  }

  const filteredFailures = verdict.failures.filter(failure => {
    const condition = String(failure.condition ?? '');
    if (
      failure.tag === 'SFDIPOT-P' &&
      /gradle is not available on path/i.test(condition) &&
      /gradlew/i.test(condition)
    ) {
      return false;
    }

    if (
      failure.tag === 'NAMIT-N' &&
      /gradle-wrapper\.jar generation fails during bootstrap/i.test(condition)
    ) {
      return false;
    }

    return true;
  });

  if (filteredFailures.length === verdict.failures.length) {
    return verdict;
  }

  if (filteredFailures.length === 0) {
    return {
      verdict: 'PASS',
      overall_confidence: Math.max(3, verdict.overall_confidence),
      notes: 'Deterministic Gradle bootstrap lane owns Gradle provisioning and wrapper-generation failure handling for this plan.',
    };
  }

  return {
    ...verdict,
    failure_count: filteredFailures.length,
    failures: filteredFailures,
  };
}

function sanitizeWindowsGradlewPermissionQaVerdict(
  verdict: z.infer<typeof QaVerdictSchema>,
  swePlan: SwePlan,
): z.infer<typeof QaVerdictSchema> {
  if (process.platform !== 'win32' || verdict.verdict !== 'REJECT') {
    return verdict;
  }

  const filteredFailures = verdict.failures.filter(failure => {
    const condition = String(failure.condition ?? '');
    return !(
      failure.tag === 'SFDIPOT-P' &&
      /\bgradlew(?:\.bat)?\b/i.test(condition) &&
      (
        /permission/i.test(condition) ||
        /mark of the web/i.test(condition) ||
        /unblock-file/i.test(condition) ||
        /executable permissions/i.test(condition)
      )
    );
  });

  if (filteredFailures.length === verdict.failures.length) {
    return verdict;
  }

  if (filteredFailures.length === 0) {
    return {
      verdict: 'PASS',
      overall_confidence: Math.max(3, verdict.overall_confidence),
      notes: 'Windows wrapper-permission rejection removed because no grounded evidence showed gradlew / gradlew.bat was blocked.',
    };
  }

  return {
    ...verdict,
    failure_count: filteredFailures.length,
    failures: filteredFailures,
  };
}

function sanitizeExistingWrapperQaVerdict(
  verdict: z.infer<typeof QaVerdictSchema>,
  swePlan: SwePlan,
  manifest: OrchestratorManifest,
): z.infer<typeof QaVerdictSchema> {
  if (verdict.verdict !== 'REJECT') {
    return verdict;
  }

  const projectRoot = inferProjectRoot(manifest);
  if (!projectRoot) {
    return verdict;
  }

  const wrapperExists =
    existsSync(join(projectRoot, 'gradlew')) ||
    existsSync(join(projectRoot, 'gradlew.bat'));
  const usesGlobalGradle = swePlan.minimal_action_set.some(step =>
    (step.tool === 'shell_exec' || step.tool === 'test_run') &&
    /\bgradle\b/i.test(String(step.target ?? '')) &&
    !/\bgradlew(?:\.bat)?\b/i.test(String(step.target ?? '')) &&
    !/\b(winget|choco|scoop)\b/i.test(String(step.target ?? '')),
  );

  if (!wrapperExists || usesGlobalGradle) {
    return verdict;
  }

  const filteredFailures = verdict.failures.filter(failure => {
    const condition = String(failure.condition ?? '');
    return !(
      failure.tag === 'SFDIPOT-P' &&
      /gradle (?:wrapper )?execution steps/i.test(condition) &&
      /not available on path/i.test(condition)
    );
  });

  if (filteredFailures.length === verdict.failures.length) {
    return verdict;
  }

  if (filteredFailures.length === 0) {
    return {
      verdict: 'PASS',
      overall_confidence: Math.max(3, verdict.overall_confidence),
      notes: 'Existing gradlew / gradlew.bat wrapper allows wrapper-based execution without requiring global gradle on PATH.',
    };
  }

  return {
    ...verdict,
    failure_count: filteredFailures.length,
    failures: filteredFailures,
  };
}

function sanitizeGroundingViolationsForAndroidSdkLane(
  violations: string[],
  manifest: OrchestratorManifest,
): string[] {
  if (!shouldUseDeterministicAndroidSdkBootstrapLane(manifest)) {
    return violations;
  }

  return violations.filter(condition => !/references missing path: .*local\.properties/i.test(condition));
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

function isWithinProjectRootPath(projectRoot: string, candidatePath: string): boolean {
  const root = resolve(projectRoot);
  const target = resolve(candidatePath);

  if (process.platform === 'win32') {
    const rootNorm = root.toLowerCase();
    const targetNorm = target.toLowerCase();
    return targetNorm === rootNorm || targetNorm.startsWith(`${rootNorm}\\`);
  }

  return target === root || target.startsWith(`${root}/`);
}

function extractWindowsAbsolutePaths(value: string): string[] {
  const quotedMatches = Array.from(value.matchAll(/["']([A-Za-z]:\\[^"']+)["']/g), match => match[1] ?? '');
  const bareMatches = Array.from(value.matchAll(/\b([A-Za-z]:\\[^\s"'|;&]+)/g), match => match[1] ?? '');
  return [...new Set([...quotedMatches, ...bareMatches].filter(match => match.length > 0))];
}

function collectExecutorSafetyViolations(
  swePlan: SwePlan,
  manifest: OrchestratorManifest,
): QaVerdictReject | null {
  const projectRoot = inferProjectRoot(manifest);
  if (!projectRoot) {
    return null;
  }

  const failures: QaVerdictReject['failures'] = [];
  const shellWrapperRe = /\b(cmd(\.exe)?\s*\/c|powershell(\.exe)?\b|pwsh\b|bash\b|sh\b)\b/i;
  const shellChainingRe = /&&|\|\||[;|]/;
  const cdWrapperRe = /\bcd\s+[A-Za-z]:\\/i;

  for (const step of swePlan.minimal_action_set) {
    const target = String(step.target ?? '').trim();
    if (!target) continue;

    if (/<[^>]+>/.test(target)) {
      failures.push({
        tag: 'INCOMPLETE_SUBMISSION',
        condition: `[EXECUTOR_SAFETY] Step ${step.step} contains an unresolved placeholder target: ${target}`,
        confidence: 5,
        fix_hint: 'Replace placeholders with a concrete in-project path or command before sending the plan to executor.',
      });
      continue;
    }

    if (step.tool === 'directory_list' || step.tool === 'file_read' || step.tool === 'file_write') {
      const resolvedTarget = /^[A-Za-z]:[\\/]/.test(target)
        ? resolve(target)
        : resolve(projectRoot, target);
      if (!isWithinProjectRootPath(projectRoot, resolvedTarget)) {
        failures.push({
          tag: 'SFDIPOT-P',
          condition: `[EXECUTOR_SAFETY] Step ${step.step} targets a path outside target_project_path: ${target}`,
          confidence: 5,
          fix_hint: 'Use only project-root-relative paths or mirrored in-root references for executor-accessible files.',
        });
      }
      continue;
    }

    if (step.tool === 'shell_exec' || step.tool === 'test_run') {
      if (shellWrapperRe.test(target) || shellChainingRe.test(target) || cdWrapperRe.test(target)) {
        failures.push({
          tag: 'SFDIPOT-P',
          condition: `[EXECUTOR_SAFETY] Step ${step.step} uses shell-wrapped or chained command syntax that violates executor contract: ${target}`,
          confidence: 5,
          fix_hint: 'Emit the executable command only and rely on working_directory instead of shell wrappers or chaining.',
        });
      }

      const outOfRootPaths = extractWindowsAbsolutePaths(target)
        .filter(candidatePath => !isWithinProjectRootPath(projectRoot, candidatePath));
      if (outOfRootPaths.length > 0) {
        failures.push({
          tag: 'SFDIPOT-P',
          condition: `[EXECUTOR_SAFETY] Step ${step.step} references out-of-root path(s) in command target: ${outOfRootPaths.join(', ')}`,
          confidence: 5,
          fix_hint: 'Use only paths rooted under target_project_path or stage mirrored references inside the project root first.',
        });
      }
    }
  }

  if (failures.length === 0) {
    return null;
  }

  return {
    verdict: 'REJECT',
    failure_count: failures.length,
    failures,
    overall_confidence: 5,
    proposed_fix_strategy: 'Regenerate the plan so every executor-facing target is concrete, in-root, and free of shell-wrapper syntax.',
  };
}

function collectRuntimePrerequisiteViolations(
  swePlan: SwePlan,
  javaRuntimeStatus: JavaRuntimeStatus,
  gradleRuntimeStatus: CommandRuntimeStatus,
): QaVerdictReject | null {
  const failures: QaVerdictReject['failures'] = [];

  const firstGradleLikeStep = swePlan.minimal_action_set.find(step =>
    (step.tool === 'shell_exec' || step.tool === 'test_run') &&
    usesGradleLikeCommand(String(step.target ?? '')),
  );

  if (!firstGradleLikeStep) {
    return null;
  }

  const priorSteps = swePlan.minimal_action_set.filter(step => step.step < firstGradleLikeStep.step);
  const hasJavaProvisioning = priorSteps.some(step => isJavaProvisioningStep(step));
  const hasGradleProvisioning = priorSteps.some(step => isGradleProvisioningStep(step));

  if (!javaRuntimeStatus.available && !hasJavaProvisioning) {
    failures.push({
      tag: 'SFDIPOT-P',
      condition: `[RUNTIME_PREFLIGHT] Step ${firstGradleLikeStep.step} invokes Gradle (${firstGradleLikeStep.target}) but Java is currently unavailable in the executor environment.`,
      confidence: 5,
      fix_hint: 'Add an earlier step that installs or configures Java/JDK and JAVA_HOME before the first gradle/gradlew command.',
    });
  }

  const usesGlobalGradle = swePlan.minimal_action_set.some(step =>
    (step.tool === 'shell_exec' || step.tool === 'test_run') &&
    /\bgradle\b/i.test(String(step.target ?? '')) &&
    !/\b(winget|choco|scoop)\b/i.test(String(step.target ?? '')) &&
    !/\bgradlew(?:\.bat)?\b/i.test(String(step.target ?? '')),
  );

  if (usesGlobalGradle && !gradleRuntimeStatus.available && !hasGradleProvisioning) {
    const firstGlobalGradleStep = swePlan.minimal_action_set.find(step =>
      (step.tool === 'shell_exec' || step.tool === 'test_run') &&
      /\bgradle\b/i.test(String(step.target ?? '')) &&
      !/\b(winget|choco|scoop)\b/i.test(String(step.target ?? '')) &&
      !/\bgradlew(?:\.bat)?\b/i.test(String(step.target ?? '')),
    );
    if (firstGlobalGradleStep) {
      failures.push({
        tag: 'SFDIPOT-P',
        condition: `[RUNTIME_PREFLIGHT] Step ${firstGlobalGradleStep.step} invokes global Gradle (${firstGlobalGradleStep.target}) but gradle is not available on PATH in the executor environment.`,
        confidence: 5,
        fix_hint: 'Install or configure Gradle before the first global `gradle` command, or switch to a wrapper-based path that does not assume global Gradle already exists.',
      });
    }
  }

  if (failures.length === 0) {
    return null;
  }

  return {
    verdict: 'REJECT',
    failure_count: failures.length,
    failures,
    overall_confidence: 5,
    proposed_fix_strategy: 'Regenerate the plan so runtime prerequisites are satisfied first: bootstrap the missing Java/Gradle dependency, then run Gradle verification or builds.',
  };
}

function collectGradleBootstrapSequencingViolations(
  swePlan: SwePlan,
  manifest: OrchestratorManifest,
  gradleRuntimeStatus: CommandRuntimeStatus,
): QaVerdictReject | null {
  const projectRoot = inferProjectRoot(manifest);
  if (!projectRoot) {
    return null;
  }

  const wrapperJarPath = join(projectRoot, 'gradle', 'wrapper', 'gradle-wrapper.jar');
  const wrapperJarExists = existsSync(wrapperJarPath);
  if (gradleRuntimeStatus.available || wrapperJarExists) {
    return null;
  }

  const failures: QaVerdictReject['failures'] = [];
  const provisioningIndex = swePlan.minimal_action_set.findIndex(step => isGradleProvisioningStep(step));
  const provisioningStepNumber = provisioningIndex >= 0
    ? swePlan.minimal_action_set[provisioningIndex]?.step ?? null
    : null;

  for (const step of swePlan.minimal_action_set) {
    const target = String(step.target ?? '').trim();
    if (!target) continue;

    const normalizedTarget = target.replace(/\//g, '\\').toLowerCase();
    const isMirroredGradleRead = (
      (step.tool === 'file_read' || step.tool === 'directory_list') &&
      normalizedTarget.includes('\\reference-montecarlo-ledger\\') &&
      normalizedTarget.includes('gradle')
    ) || (
      (step.tool === 'file_read' || step.tool === 'directory_list') &&
      normalizedTarget.includes('\\reference-montecarlo-ledger\\build.gradle.kts')
    ) || (
      (step.tool === 'file_read' || step.tool === 'directory_list') &&
      normalizedTarget.includes('\\reference-montecarlo-ledger\\settings.gradle.kts')
    ) || (
      (step.tool === 'file_read' || step.tool === 'directory_list') &&
      normalizedTarget.includes('\\reference-montecarlo-ledger\\app\\build.gradle.kts')
    );

    if (isMirroredGradleRead) {
      failures.push({
        tag: 'SFDIPOT-P',
        condition: `[GRADLE_BOOTSTRAP] Step ${step.step} probes mirrored Gradle files during bootstrap even though global gradle is absent and gradle-wrapper.jar is missing: ${target}`,
        confidence: 5,
        fix_hint: 'Provision Gradle first, then generate/verify gradle-wrapper.jar. Do not read mirrored Gradle files during bootstrap unless they are already confirmed to exist.',
      });
    }

    const usesGlobalGradle = (step.tool === 'shell_exec' || step.tool === 'test_run')
      && /\bgradle\b/i.test(target)
      && !/\b(winget|choco|scoop)\b/i.test(target)
      && !/\bgradlew(?:\.bat)?\b/i.test(target);
    if (
      usesGlobalGradle &&
      (provisioningStepNumber === null || step.step < provisioningStepNumber)
    ) {
      failures.push({
        tag: 'SFDIPOT-P',
        condition: `[GRADLE_BOOTSTRAP] Step ${step.step} uses global Gradle before any concrete provisioning step while gradle is absent and gradle-wrapper.jar is missing: ${target}`,
        confidence: 5,
        fix_hint: 'Make the first global-Gradle-related step a concrete provisioning step such as winget install Gradle.Gradle, then verify gradle, then run gradle wrapper.',
      });
    }
  }

  if (failures.length === 0) {
    return null;
  }

  return {
    verdict: 'REJECT',
    failure_count: failures.length,
    failures,
    overall_confidence: 5,
    proposed_fix_strategy: 'Regenerate the Gradle bootstrap portion so it provisions Gradle first, avoids mirrored Gradle file reads during bootstrap, and only then generates/verifies gradle-wrapper.jar.',
  };
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
  if (req.tool === 'directory_list' || req.tool === 'file_read'  || req.tool === 'file_write')   return req.path;
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
      ...(entry.denial ? [`denial: ${JSON.stringify(entry.denial)}`] : []),
      ...(entry.mcp_lifecycle ? [`mcp_lifecycle: ${JSON.stringify(entry.mcp_lifecycle)}`] : []),
    ].join('\n'),
  );
  return [header, ...entries].join('\n\n');
}

function formatDenialSummary(denial: ToolCallLog['denial']): string | null {
  if (!denial) return null;
  return `${denial.category}/${denial.reason_code}: ${denial.message}`;
}

function formatMcpLifecycleSummary(lifecycle: ToolCallLog['mcp_lifecycle']): string | null {
  if (!lifecycle) return null;
  const reason = lifecycle.reason_code ? ` (${lifecycle.reason_code})` : '';
  return `${lifecycle.phase}/${lifecycle.outcome}${reason}`;
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
    'ACTIVATION STATUS:',
    '- The pipeline has already verified a QA PASS verdict for this plan.',
    '- You are authorized to begin tool execution now.',
    '- Do NOT refuse activation for missing QA approval unless the prompt explicitly says QA failed.',
    '',
    'On each turn emit EXACTLY ONE of these JSON shapes:',
    '  directory_list: { "type": "tool_call", "tool": "directory_list", "path": "<project-relative or /project/... path>" }',
    '  file_read:  { "type": "tool_call", "tool": "file_read",  "path": "<project-relative or /project/... path>" }',
    '  file_write: { "type": "tool_call", "tool": "file_write", "path": "<project-relative or /project/... path>", "content": "<full file content>" }',
    '  shell_exec: { "type": "tool_call", "tool": "shell_exec", "command": "<cmd-without-cmd-slash-c-or-cd>", "working_directory": "<project-relative or /project/... path>", "timeout_seconds": 120 }',
    '  test_run:     { "type": "tool_call", "tool": "test_run",     "command": "<cmd-without-cmd-slash-c-or-cd>", "working_directory": "<project-relative or /project/... path>", "timeout_seconds": 300 }',
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
    ...(entry.denial ? [`Denial: ${formatDenialSummary(entry.denial)}`] : []),
    ...(entry.mcp_lifecycle ? [`MCP lifecycle: ${formatMcpLifecycleSummary(entry.mcp_lifecycle)}`] : []),
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
  initialToolCallLog: ToolCallLog[] = [],
): Promise<{ toolCallLog: ToolCallLog[] }> {
  assertExecutorGate(evidence.runDir);

  // ── Compile base context once ────────────────────────────────────────────
  const baseContext = compileContext(
    abs(EXECUTOR_PATHS),
    buildExecutorTask(approvedPlan),
  );
  evidence.writeCompiledContext('executor', baseContext);

  let executionHistory = initialToolCallLog.map(formatHistoryEntry).join('\n\n');
  const toolCallLog: ToolCallLog[] = [...initialToolCallLog];

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
      ...(toolResult.denial ? { denial: toolResult.denial } : {}),
      ...(toolResult.mcp_lifecycle ? { mcp_lifecycle: toolResult.mcp_lifecycle } : {}),
      verified:  toolResult.exit_code === 0,
    };
    toolCallLog.push(entry);

    // Halt immediately on live tool failure.
    if (!DRY_RUN && toolResult.exit_code !== 0) {
      const denialSummary = formatDenialSummary(toolResult.denial);
      const mcpLifecycleSummary = formatMcpLifecycleSummary(toolResult.mcp_lifecycle);
      const report = buildHaltReport(
        toolCallLog, 'STEP_VERIFICATION_FAIL', stepNum,
        `Tool ${req.tool} on "${getTarget(req)}" exited with code ${toolResult.exit_code}. ` +
        `stderr: ${toolResult.stderr.slice(0, 200)}` +
        `${denialSummary ? ` denial: ${denialSummary}` : ''}` +
        `${mcpLifecycleSummary ? ` mcp_lifecycle: ${mcpLifecycleSummary}` : ''}`,
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

async function runDeterministicAndroidSdkBootstrapLane(
  manifest: OrchestratorManifest,
): Promise<{ toolCallLog: ToolCallLog[]; haltedReport?: object }> {
  const projectRoot = inferProjectRoot(manifest);
  if (!projectRoot) {
    return { toolCallLog: [] };
  }

  const toolCallLog: ToolCallLog[] = [];
  const recordSyntheticStep = (
    tool: ToolCallLog['tool'],
    target: string,
    exitCode: number,
    stdout: string,
    stderr = '',
  ): void => {
    toolCallLog.push({
      step: toolCallLog.length + 1,
      tool,
      target,
      exit_code: exitCode,
      stdout,
      stderr,
      verified: exitCode === 0,
    });
  };

  const sdkStatus = detectAndroidSdkStatus();
  if (!sdkStatus.available || !sdkStatus.sdkRoot) {
    return {
      toolCallLog,
      haltedReport: buildHaltReport(
        toolCallLog,
        'STEP_VERIFICATION_FAIL',
        toolCallLog.length + 1,
        'Deterministic Android SDK bootstrap lane requires a usable Android SDK, but none was discovered in the executor environment.',
      ),
    };
  }

  const prependedPaths = ensureAndroidSdkEnvironment(sdkStatus);
  recordSyntheticStep(
    'directory_list',
    sdkStatus.sdkRoot,
    0,
    `Configured Android SDK environment from ${sdkStatus.sdkRoot}. PATH additions: ${prependedPaths.length > 0 ? prependedPaths.join(', ') : 'none'}`,
  );

  const localPropertiesPath = join(projectRoot, 'local.properties');
  const desiredSdkLine = buildLocalPropertiesSdkLine(sdkStatus.sdkRoot);
  const existingLocalProperties = existsSync(localPropertiesPath)
    ? readFileSync(localPropertiesPath, 'utf-8')
    : '';
  const existingLines = existingLocalProperties
    .split(/\r?\n/)
    .filter(line => line.trim().length > 0 && !line.trim().startsWith('sdk.dir='));
  const nextLocalProperties = `${[desiredSdkLine, ...existingLines].join('\n')}\n`;

  if (existingLocalProperties !== nextLocalProperties) {
    writeFileSync(localPropertiesPath, nextLocalProperties, 'utf-8');
    recordSyntheticStep(
      'file_write',
      localPropertiesPath,
      0,
      `Wrote deterministic Android SDK local.properties using ${sdkStatus.sdkRoot}.`,
    );
  } else {
    recordSyntheticStep(
      'file_read',
      localPropertiesPath,
      0,
      `Reused existing local.properties with matching sdk.dir for ${sdkStatus.sdkRoot}.`,
    );
  }

  return { toolCallLog };
}

async function runDeterministicGradleBootstrapLane(
  manifest: OrchestratorManifest,
): Promise<{ toolCallLog: ToolCallLog[]; haltedReport?: object }> {
  const projectRoot = inferProjectRoot(manifest);
  if (!projectRoot) {
    return { toolCallLog: [] };
  }

  const wrapperJarPath = join(projectRoot, 'gradle', 'wrapper', 'gradle-wrapper.jar');
  if (existsSync(wrapperJarPath)) {
    return { toolCallLog: [] };
  }
  const settingsGradlePath = join(projectRoot, 'settings.gradle.kts');

  const toolCallLog: ToolCallLog[] = [];
  const recordSyntheticStep = (
    tool: ToolCallLog['tool'],
    target: string,
    exitCode: number,
    stdout: string,
    stderr = '',
  ): void => {
    toolCallLog.push({
      step: toolCallLog.length + 1,
      tool,
      target,
      exit_code: exitCode,
      stdout,
      stderr,
      verified: exitCode === 0,
    });
  };
  const executeLaneTool = async (
    req: z.infer<typeof ToolCallRequestSchema>,
  ): Promise<ToolResult> => {
    const stepNum = toolCallLog.length + 1;
    const toolResult = await executeTool(req);
    const entry: ToolCallLog = {
      step: stepNum,
      tool: req.tool,
      target: getTarget(req),
      exit_code: toolResult.exit_code,
      stdout: toolResult.stdout,
      stderr: toolResult.stderr,
      ...(toolResult.denial ? { denial: toolResult.denial } : {}),
      ...(toolResult.mcp_lifecycle ? { mcp_lifecycle: toolResult.mcp_lifecycle } : {}),
      verified: toolResult.exit_code === 0,
    };
    toolCallLog.push(entry);
    return toolResult;
  };

  const javaStatus = detectJavaRuntimeStatus();
  if (!javaStatus.available) {
    return {
      toolCallLog,
      haltedReport: buildHaltReport(
        toolCallLog,
        'STEP_VERIFICATION_FAIL',
        toolCallLog.length + 1,
        'Deterministic Gradle bootstrap lane requires Java, but Java is unavailable in the executor environment.',
      ),
    };
  }

  const javaProbe = await executeLaneTool({
    tool: 'shell_exec',
    command: 'java -version',
    working_directory: projectRoot,
    timeout_seconds: 60,
  });
  if (javaProbe.exit_code !== 0) {
    return {
      toolCallLog,
      haltedReport: buildHaltReport(
        toolCallLog,
        'STEP_VERIFICATION_FAIL',
        toolCallLog.length,
        `Deterministic Gradle bootstrap lane failed while verifying Java. stderr: ${javaProbe.stderr.slice(0, 200)}`,
      ),
    };
  }

  if (existsSync(settingsGradlePath)) {
    const settingsContent = readFileSync(settingsGradlePath, 'utf-8');
    const repairedSettings = repairSettingsGradleKtsContent(settingsContent);
    if (repairedSettings.changed) {
      writeFileSync(settingsGradlePath, repairedSettings.content, 'utf-8');
      recordSyntheticStep(
        'file_write',
        settingsGradlePath,
        0,
        `Applied deterministic settings.gradle.kts repair: ${repairedSettings.notes.join(' ')}`,
      );
    }
  }

  const rootBuildGradlePath = join(projectRoot, 'build.gradle.kts');
  if (!existsSync(rootBuildGradlePath)) {
    writeFileSync(
      rootBuildGradlePath,
      buildDeterministicRootBuildGradleKtsContent(),
      'utf-8',
    );
    recordSyntheticStep(
      'file_write',
      rootBuildGradlePath,
      0,
      'Created deterministic root build.gradle.kts with Android and Kotlin plugin versions for bootstrap.',
    );
  }

  let gradleStatus = detectCommandOnPath('gradle');
  if (!gradleStatus.available) {
    const propertiesRead = await executeLaneTool({
      tool: 'file_read',
      path: join(projectRoot, 'gradle', 'wrapper', 'gradle-wrapper.properties'),
    });
    if (propertiesRead.exit_code !== 0) {
      return {
        toolCallLog,
        haltedReport: buildHaltReport(
          toolCallLog,
          'STEP_VERIFICATION_FAIL',
          toolCallLog.length,
          `Deterministic Gradle bootstrap lane failed while reading gradle-wrapper.properties. stderr: ${propertiesRead.stderr.slice(0, 200)}`,
        ),
      };
    }

    const distributionUrl = parseGradleDistributionUrl(propertiesRead.stdout);
    if (!distributionUrl) {
      return {
        toolCallLog,
        haltedReport: buildHaltReport(
          toolCallLog,
          'STEP_VERIFICATION_FAIL',
          toolCallLog.length + 1,
          'Deterministic Gradle bootstrap lane could not parse distributionUrl from gradle-wrapper.properties.',
        ),
      };
    }

    mkdirSync(GRADLE_CACHE_DIR, { recursive: true });
    const archiveName = distributionUrl.split('/').pop() ?? 'gradle-distribution.zip';
    const archivePath = join(GRADLE_CACHE_DIR, archiveName);
    const extractedRoot = join(
      GRADLE_CACHE_DIR,
      archiveName.replace(/\.zip$/i, ''),
    );

    if (!existsSync(archivePath)) {
      const response = await fetch(distributionUrl);
      if (!response.ok) {
        recordSyntheticStep(
          'file_write',
          archivePath,
          1,
          '',
          `Failed to download Gradle distribution from ${distributionUrl} (HTTP ${response.status}).`,
        );
        return {
          toolCallLog,
          haltedReport: buildHaltReport(
            toolCallLog,
            'STEP_VERIFICATION_FAIL',
            toolCallLog.length,
            `Deterministic Gradle bootstrap lane failed while downloading Gradle from distributionUrl. HTTP ${response.status}.`,
          ),
        };
      }

      const archiveBuffer = Buffer.from(await response.arrayBuffer());
      writeFileSync(archivePath, archiveBuffer);
      recordSyntheticStep(
        'file_write',
        archivePath,
        0,
        `Cached Gradle distribution from ${distributionUrl} to ${archivePath}`,
      );
    } else {
      recordSyntheticStep(
        'file_read',
        archivePath,
        0,
        `Reusing cached Gradle distribution at ${archivePath}`,
      );
    }

    let gradleCandidate = detectGradleBinaryFromExtractedRoot(extractedRoot);
    if (!gradleCandidate) {
      mkdirSync(extractedRoot, { recursive: true });
      const tarResult = spawnSync(
        'tar',
        ['-xf', archivePath, '-C', extractedRoot],
        { encoding: 'utf-8', windowsHide: true },
      );
      recordSyntheticStep(
        'shell_exec',
        `tar -xf ${archivePath} -C ${extractedRoot}`,
        tarResult.status ?? 1,
        String(tarResult.stdout ?? ''),
        String(tarResult.stderr ?? ''),
      );
      if (tarResult.status !== 0) {
        return {
          toolCallLog,
          haltedReport: buildHaltReport(
            toolCallLog,
            'STEP_VERIFICATION_FAIL',
            toolCallLog.length,
            `Deterministic Gradle bootstrap lane failed while extracting cached Gradle distribution. stderr: ${String(tarResult.stderr ?? '').slice(0, 200)}`,
          ),
        };
      }
      gradleCandidate = detectGradleBinaryFromExtractedRoot(extractedRoot);
    }

    if (!gradleCandidate) {
      return {
        toolCallLog,
        haltedReport: buildHaltReport(
          toolCallLog,
          'STEP_VERIFICATION_FAIL',
          toolCallLog.length + 1,
          `Deterministic Gradle bootstrap lane extracted ${archiveName} but could not locate a Gradle binary in ${extractedRoot}.`,
        ),
      };
    }

    prependProcessPath(dirname(gradleCandidate));
    gradleStatus = detectCommandOnPath('gradle');
    if (!gradleStatus.available) {
      return {
        toolCallLog,
        haltedReport: buildHaltReport(
          toolCallLog,
          'STEP_VERIFICATION_FAIL',
          toolCallLog.length + 1,
          'Deterministic Gradle bootstrap lane cached and extracted Gradle, but the gradle command is still unavailable on PATH.',
        ),
      };
    }
  }

  const gradleProbe = await executeLaneTool({
    tool: 'shell_exec',
    command: 'gradle --version',
    working_directory: projectRoot,
    timeout_seconds: 120,
  });
  if (gradleProbe.exit_code !== 0) {
    return {
      toolCallLog,
      haltedReport: buildHaltReport(
        toolCallLog,
        'STEP_VERIFICATION_FAIL',
        toolCallLog.length,
        `Deterministic Gradle bootstrap lane failed while verifying Gradle. stderr: ${gradleProbe.stderr.slice(0, 200)}`,
      ),
    };
  }

  const wrapperResult = await executeLaneTool({
    tool: 'shell_exec',
    command: 'gradle wrapper',
    working_directory: projectRoot,
    timeout_seconds: 600,
  });
  if (wrapperResult.exit_code !== 0) {
    return {
      toolCallLog,
      haltedReport: buildHaltReport(
        toolCallLog,
        'STEP_VERIFICATION_FAIL',
        toolCallLog.length,
        `Deterministic Gradle bootstrap lane failed while generating gradle-wrapper.jar. stderr: ${wrapperResult.stderr.slice(0, 200)}`,
      ),
    };
  }

  const wrapperListing = await executeLaneTool({
    tool: 'directory_list',
    path: join(projectRoot, 'gradle', 'wrapper'),
  });
  if (
    wrapperListing.exit_code !== 0 ||
    !existsSync(wrapperJarPath)
  ) {
    return {
      toolCallLog,
      haltedReport: buildHaltReport(
        toolCallLog,
        'STEP_VERIFICATION_FAIL',
        toolCallLog.length,
        'Deterministic Gradle bootstrap lane did not produce gradle-wrapper.jar after running gradle wrapper.',
      ),
    };
  }

  return { toolCallLog };
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
  let resolvedModelPolicy: ResolvedModelPolicy | undefined;
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
    if (result.modelPolicy !== undefined || resolvedModelPolicy === undefined) {
      return result;
    }
    return {
      ...result,
      modelPolicy: resolvedModelPolicy,
    };
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
    const taskContract = classifyTaskContract(manifest.handoff_payload.user_request);
    const taskGrounding = buildTaskGrounding(taskContract, inferProjectRoot(manifest));
    const groundingContext = formatGroundingContext(taskGrounding);
    const javaRuntimeStatus = detectJavaRuntimeStatus();
    const gradleRuntimeStatus = detectCommandOnPath('gradle');
    resolvedModelPolicy = resolveFamilyModelPolicy({
      family: effectiveModel,
      ...(options.modelTier !== undefined ? { requestedTier: options.modelTier } : {}),
      ...(options.allowExpensive === true ? { allowExpensive: true } : {}),
      babelRoot: BABEL_ROOT,
    });

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
      const sweTask    = buildSweTask(manifest, [], undefined, '', groundingContext);
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

      const sweTask    = buildSweTask(manifest, qaRejections, proposedFixStrategy, additionalEvidenceContext, groundingContext);
      const sweContext = compileContext(swePaths, sweTask);
      evidence.writeCompiledContext(`swe_v${attempt}`, sweContext);

      const swePlanRaw = await runWithFallback(sweContext, SwePlanSchema, {
        evidence,
        stage: 'planning',
      });
      const { plan: normalizedPlan, warnings: planWarnings } = normalizeSwePlan(swePlanRaw);
      const { plan: groundedPlan, warnings: groundingWarnings } = normalizePlanTargetsAgainstGrounding(taskGrounding, normalizedPlan);
      const swePlan = groundedPlan;
      if (planWarnings.length > 0 || groundingWarnings.length > 0) {
        executionReportWarnings.push(...planWarnings);
        executionReportWarnings.push(...groundingWarnings);
        planWarnings.forEach(w => logDetail(`SWE plan warning: ${w}`));
        groundingWarnings.forEach(w => logDetail(`SWE plan warning: ${w}`));
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

      const groundingViolations = sanitizeGroundingViolationsForAndroidSdkLane(
        collectPlanGroundingViolations(taskContract, taskGrounding, swePlan),
        manifest,
      );
      if (groundingViolations.length > 0) {
        const groundingReject = buildGroundingQaReject(groundingViolations) as QaVerdictReject;
        evidence.writeQaVerdict(groundingReject, attempt);
        logDetail(
          `QA: REJECT  (${groundingReject.failure_count} failure(s), confidence: ${groundingReject.overall_confidence}/5)`,
        );
        groundingReject.failures.forEach((failure, index) => {
          logDetail(`  ${index + 1}. [${failure.tag}]  ${failure.condition}`);
        });

        qaRejections = groundingReject.failures.map(failure =>
          failure.fix_hint
            ? `[${failure.tag}] ${failure.condition} (hint: ${failure.fix_hint})`
            : `[${failure.tag}] ${failure.condition}`,
        );
        proposedFixStrategy = groundingReject.proposed_fix_strategy;
        v9StackTelemetry = markRuntimeTelemetryQaReject(v9StackTelemetry, groundingReject);
        writeRuntimeTelemetrySnapshot(evidence, v9StackTelemetry);
        pipelineTrace.recordQaVerdict('REJECT', groundingReject.failures.map(failure => failure.tag));
        continue;
      }

      const executorSafetyReject = collectExecutorSafetyViolations(swePlan, manifest);
      if (executorSafetyReject) {
        evidence.writeQaVerdict(executorSafetyReject, attempt);
        logDetail(
          `QA: REJECT  (${executorSafetyReject.failure_count} failure(s), confidence: ${executorSafetyReject.overall_confidence}/5)`,
        );
        executorSafetyReject.failures.forEach((failure, index) => {
          logDetail(`  ${index + 1}. [${failure.tag}]  ${failure.condition}`);
        });

        qaRejections = executorSafetyReject.failures.map(failure =>
          failure.fix_hint
            ? `[${failure.tag}] ${failure.condition} (hint: ${failure.fix_hint})`
            : `[${failure.tag}] ${failure.condition}`,
        );
        proposedFixStrategy = executorSafetyReject.proposed_fix_strategy;
        v9StackTelemetry = markRuntimeTelemetryQaReject(v9StackTelemetry, executorSafetyReject);
        writeRuntimeTelemetrySnapshot(evidence, v9StackTelemetry);
        pipelineTrace.recordQaVerdict('REJECT', executorSafetyReject.failures.map(failure => failure.tag));
        continue;
      }

      const runtimePrereqReject = collectRuntimePrerequisiteViolations(
        swePlan,
        javaRuntimeStatus,
        gradleRuntimeStatus,
      );
      if (runtimePrereqReject) {
        evidence.writeQaVerdict(runtimePrereqReject, attempt);
        logDetail(
          `QA: REJECT  (${runtimePrereqReject.failure_count} failure(s), confidence: ${runtimePrereqReject.overall_confidence}/5)`,
        );
        runtimePrereqReject.failures.forEach((failure, index) => {
          logDetail(`  ${index + 1}. [${failure.tag}]  ${failure.condition}`);
        });

        qaRejections = runtimePrereqReject.failures.map(failure =>
          failure.fix_hint
            ? `[${failure.tag}] ${failure.condition} (hint: ${failure.fix_hint})`
            : `[${failure.tag}] ${failure.condition}`,
        );
        proposedFixStrategy = runtimePrereqReject.proposed_fix_strategy;
        v9StackTelemetry = markRuntimeTelemetryQaReject(v9StackTelemetry, runtimePrereqReject);
        writeRuntimeTelemetrySnapshot(evidence, v9StackTelemetry);
        pipelineTrace.recordQaVerdict('REJECT', runtimePrereqReject.failures.map(failure => failure.tag));
        continue;
      }

      const gradleBootstrapReject = collectGradleBootstrapSequencingViolations(
        swePlan,
        manifest,
        gradleRuntimeStatus,
      );
      if (gradleBootstrapReject) {
        evidence.writeQaVerdict(gradleBootstrapReject, attempt);
        logDetail(
          `QA: REJECT  (${gradleBootstrapReject.failure_count} failure(s), confidence: ${gradleBootstrapReject.overall_confidence}/5)`,
        );
        gradleBootstrapReject.failures.forEach((failure, index) => {
          logDetail(`  ${index + 1}. [${failure.tag}]  ${failure.condition}`);
        });

        qaRejections = gradleBootstrapReject.failures.map(failure =>
          failure.fix_hint
            ? `[${failure.tag}] ${failure.condition} (hint: ${failure.fix_hint})`
            : `[${failure.tag}] ${failure.condition}`,
        );
        proposedFixStrategy = gradleBootstrapReject.proposed_fix_strategy;
        v9StackTelemetry = markRuntimeTelemetryQaReject(v9StackTelemetry, gradleBootstrapReject);
        writeRuntimeTelemetrySnapshot(evidence, v9StackTelemetry);
        pipelineTrace.recordQaVerdict('REJECT', gradleBootstrapReject.failures.map(failure => failure.tag));
        continue;
      }

      // ── Stage 3: QA Reviewer ───────────────────────────────────────────────
      log(
        `Stage 3 / 4  —  QA Reviewer` +
        (attempt > 1 ? ` (attempt ${attempt}/${MAX_SWE_QA_LOOPS})` : ''),
      );

      const deterministicGradleBootstrapLaneActive = shouldUseDeterministicGradleBootstrapLane(manifest);
      const qaContext = compileContext(
        abs(QA_PATHS),
        buildQaTask(
          swePlan,
          javaRuntimeStatus,
          gradleRuntimeStatus,
          detectAndroidSdkStatus(),
          deterministicGradleBootstrapLaneActive,
        ),
      );
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
        verdict = sanitizeQaVerdictForDeterministicGradleBootstrapLane(
          verdict,
          swePlan,
          manifest,
        );
        verdict = sanitizeWindowsGradlewPermissionQaVerdict(verdict, swePlan);
        verdict = sanitizeExistingWrapperQaVerdict(verdict, swePlan, manifest);
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
    const initialExecutorLog: ToolCallLog[] = [];
    if (shouldUseDeterministicAndroidSdkBootstrapLane(manifest)) {
      logDetail('Deterministic Android SDK bootstrap lane activated.');
      const androidSdkBootstrapResult = await runDeterministicAndroidSdkBootstrapLane(manifest);
      initialExecutorLog.push(...androidSdkBootstrapResult.toolCallLog);
      if (androidSdkBootstrapResult.haltedReport) {
        writeValidatedExecutionReport(
          evidence,
          androidSdkBootstrapResult.haltedReport,
          initialExecutorLog,
          executionReportWarnings,
        );
        log('  Executor: EXECUTION_HALTED [STEP_VERIFICATION_FAIL] during deterministic Android SDK bootstrap lane');
        return await finalizeResult({ runDir: evidence.runDir, manifest, plan: approvedPlan, status: 'EXECUTOR_HALTED' });
      }
    }
    if (shouldUseDeterministicGradleBootstrapLane(manifest)) {
      logDetail('Deterministic Gradle bootstrap lane activated.');
      const bootstrapResult = await runDeterministicGradleBootstrapLane(manifest);
      initialExecutorLog.push(...bootstrapResult.toolCallLog);
      if (bootstrapResult.haltedReport) {
        writeValidatedExecutionReport(
          evidence,
          bootstrapResult.haltedReport,
          initialExecutorLog,
          executionReportWarnings,
        );
        log('  Executor: EXECUTION_HALTED [STEP_VERIFICATION_FAIL] during deterministic Gradle bootstrap lane');
        return await finalizeResult({ runDir: evidence.runDir, manifest, plan: approvedPlan, status: 'EXECUTOR_HALTED' });
      }
    }
    try {
      ({ toolCallLog } = await runExecutorLoop(
        approvedPlan,
        evidence,
        effectiveModel,
        executionReportWarnings,
        initialExecutorLog,
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
  const qaContext = compileContext(
    abs(QA_PATHS),
    buildQaTask(
      swePlan,
      detectJavaRuntimeStatus(),
      detectCommandOnPath('gradle'),
      detectAndroidSdkStatus(),
      shouldUseDeterministicGradleBootstrapLane(manifest),
    ),
  );
  evidence.writeCompiledContext('qa_v1', qaContext);

  const verdict = sanitizeQaVerdictForDeterministicGradleBootstrapLane(
    await runWithFallback(qaContext, QaVerdictSchema, {
      evidence,
      stage: 'qa',
    }),
    swePlan,
    manifest,
  );
  const sanitizedVerdict = sanitizeWindowsGradlewPermissionQaVerdict(verdict, swePlan);
  const normalizedVerdict = sanitizeExistingWrapperQaVerdict(sanitizedVerdict, swePlan, manifest);
  evidence.writeQaVerdict(normalizedVerdict, 1);

  if (normalizedVerdict.verdict !== 'PASS') {
    log(`QA rejected the resumed manual plan. Pipeline halted at Stage 3.`);
    return {
      runDir,
      manifest,
      plan: null,
      status: 'QA_REJECTED_MAX_LOOPS',
    };
  }

  log('Stage 4 / 4  —  CLI Executor');
  const executionReportWarnings: string[] = [];
  const initialExecutorLog: ToolCallLog[] = [];
  if (shouldUseDeterministicAndroidSdkBootstrapLane(manifest)) {
    logDetail('Deterministic Android SDK bootstrap lane activated.');
    const androidSdkBootstrapResult = await runDeterministicAndroidSdkBootstrapLane(manifest);
    initialExecutorLog.push(...androidSdkBootstrapResult.toolCallLog);
    if (androidSdkBootstrapResult.haltedReport) {
      writeValidatedExecutionReport(
        evidence,
        androidSdkBootstrapResult.haltedReport,
        initialExecutorLog,
        executionReportWarnings,
      );
      log('  Executor: EXECUTION_HALTED [STEP_VERIFICATION_FAIL] during deterministic Android SDK bootstrap lane');
      return {
        runDir,
        manifest,
        plan: swePlan,
        status: 'EXECUTOR_HALTED',
      };
    }
  }
  if (shouldUseDeterministicGradleBootstrapLane(manifest)) {
    logDetail('Deterministic Gradle bootstrap lane activated.');
    const bootstrapResult = await runDeterministicGradleBootstrapLane(manifest);
    initialExecutorLog.push(...bootstrapResult.toolCallLog);
    if (bootstrapResult.haltedReport) {
      writeValidatedExecutionReport(
        evidence,
        bootstrapResult.haltedReport,
        initialExecutorLog,
        planWarnings,
      );
      return {
        runDir,
        manifest,
        plan: swePlan,
        status: 'EXECUTOR_HALTED',
      };
    }
  }
  try {
    await runExecutorLoop(swePlan, evidence, targetModel, planWarnings, initialExecutorLog);
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

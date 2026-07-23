/**
 * sweUtils.ts — SWE Plan & Evidence Utility Functions
 *
 * Extracted from pipeline.ts for modularity.
 * Contains: Orchestrator output parsing, SWE plan normalization,
 * Zod error formatting, JSON/evidence file utilities, evidence report
 * builders, and manual plan repair prompt building.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  OrchestratorManifestSchema,
  OrchestratorErrorHaltSchema,
  SwePlanSchema,
} from '../schemas/agentContracts.js';
import type {
  OrchestratorErrorHalt,
  OrchestratorManifest,
  SwePlan,
  ToolCallLog,
} from '../schemas/agentContracts.js';

export type ParsedOrchestratorOutput = OrchestratorErrorHalt | OrchestratorManifest;
import { uniqueList, plannedFileWriteTargets, plannedVerificationCommands } from './grounding.js';
import { inferProjectRoot } from './manifestContext.js';
import type { BabelIntentContract } from '../services/liteFullRouter.js';
import { OBJECTIVE_PREFIX } from './paths.js';

// ─── Orchestrator output parser ──────────────────────────────────────────────

export const OrchestratorOutputSchema: z.ZodType<ParsedOrchestratorOutput> = z.union([
  OrchestratorManifestSchema,
  OrchestratorErrorHaltSchema,
]);

export function assertManifest(
  output: ParsedOrchestratorOutput,
): asserts output is OrchestratorManifest {
  if ('error_halt' in output && output.error_halt === true) {
    throw new Error(
      `Orchestrator issued an error halt.\n` +
        `  Reason:  ${output.error_reason}\n` +
        `  Blocked: ${output.blocked_request}`,
    );
  }
}

// ─── SWE plan normalization ─────────────────────────────────────────────────

type NormalizedSwePlan = SwePlan & {
  plan_type: 'EVIDENCE_REQUEST' | 'IMPLEMENTATION_PLAN';
  task_summary: string;
};

export function normalizeSwePlan(swePlan: SwePlan): {
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

// ─── Zod error formatting ───────────────────────────────────────────────────

export function formatZodErrors(err: z.ZodError): string[] {
  return err.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${path}: ${issue.message}`;
  });
}

// ─── JSON file utilities ────────────────────────────────────────────────────

function safeParseJsonFile(path: string): unknown | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as unknown;
  } catch {
    return null;
  }
}

export function readManifestFromEvidence(runDir: string): OrchestratorManifest | null {
  const parsed = OrchestratorManifestSchema.safeParse(
    safeParseJsonFile(join(runDir, '01_manifest.json')),
  );
  return parsed.success ? parsed.data : null;
}

export function readLatestSwePlanFromEvidence(runDir: string): SwePlan | null {
  const latestPlan = readdirSync(runDir)
    .filter((name) => /^02_swe_plan_v\d+\.json$/.test(name))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
  if (!latestPlan) {
    return null;
  }
  const parsed = SwePlanSchema.safeParse(safeParseJsonFile(join(runDir, latestPlan)));
  return parsed.success ? parsed.data : null;
}

export function hasUsefulEvidence(runDir: string): boolean {
  return ['04_execution_report.json', '10_session_context.json', '02_swe_plan_v1.json'].some(
    (filename) => existsSync(join(runDir, filename)),
  );
}

// ─── Evidence report builders ───────────────────────────────────────────────

export function buildEvidenceReportFinalizerArtifact(input: {
  task: string;
  toolCallLog: readonly ToolCallLog[];
  intent: BabelIntentContract;
  runDir: string;
}): Record<string, unknown> & { answer: string } {
  const targets = uniqueList(input.toolCallLog.map((entry) => String(entry.target ?? '')));
  const readCount = input.toolCallLog.filter((entry) =>
    [
      'file_read',
      'directory_list',
      'semantic_search',
      'grep',
      'glob',
      'web_search',
      'web_fetch',
      'mcp_resource_read',
      'mcp_resource_list',
    ].includes(String(entry.tool ?? '')),
  ).length;
  const targetSummary =
    targets.length > 0
      ? `Inspected ${Math.min(targets.length, 6)} target(s): ${targets.slice(0, 6).join(', ')}.`
      : 'Inspected available run evidence without recording a concrete file target.';
  const compareLine = /\b(compare|versus|vs\.?|trade-?off|options?|paths?)\b/i.test(input.task)
    ? 'Compared options by inspected scope, evidence confidence, implementation risk, and verification effort.'
    : null;
  const auditLine = /\b(audit|diagnos(?:e|is|tic)|assess|evaluate|investigate|findings?)\b/i.test(
    input.task,
  )
    ? 'Observed evidence is sufficient for a read-only finding pass, but not for claiming an implementation or executed verification.'
    : null;
  const findings = uniqueList([
    `Evidence gathering completed with ${readCount} read-only evidence step(s).`,
    targetSummary,
    compareLine,
    auditLine,
    'No source files were changed because the original intent resolved to a read-only task.',
  ]);
  const limitations = [
    'This finalizer used already-gathered local evidence and did not make an extra model call.',
    'No verification command was executed unless it appears in the execution report.',
  ];
  const answer = [
    'Evidence gathered and finalized without editing files.',
    ...findings.map((finding) => `- ${finding}`),
    `- Recommended next action: ${input.intent.task_kind === 'plan_only' ? 'review the plan evidence, then run a fix command when you want edits applied' : 'use the evidence artifact for follow-up implementation or a narrower report'}.`,
  ].join('\n');

  return {
    schema_version: 1,
    artifact_type: 'babel_report_finalizer',
    task: input.task,
    task_kind: input.intent.task_kind,
    evidence_steps: input.toolCallLog.length,
    inspected_targets: targets,
    findings,
    limitations,
    suggested_verification: [
      'Run a targeted verification command only after an implementation task produces changes.',
    ],
    run_dir: input.runDir,
    answer,
  };
}

export function buildBlockedRunSummaryArtifact(input: {
  task: string;
  errorMessage: string;
  condition: string;
  runDir: string;
}): Record<string, unknown> & { answer: string } {
  const manifest = readManifestFromEvidence(input.runDir);
  const plan = readLatestSwePlanFromEvidence(input.runDir);
  const filesLikelyToChange = plannedFileWriteTargets(plan);
  const verificationCommands = plannedVerificationCommands(plan);
  const answer = [
    'Babel Run Blocked after useful evidence was gathered.',
    `- Evidence was preserved in ${input.runDir}.`,
    `- Blocker: ${input.condition}`,
    filesLikelyToChange.length > 0
      ? `- Planned changed files before the block: ${filesLikelyToChange.join(', ')}.`
      : '- No file edits were executed before the block.',
    verificationCommands.length > 0
      ? `- Planned verification: ${verificationCommands.join('; ')}.`
      : '- Verification was not reached.',
    '- Recovery: inspect the evidence, then run babel continue latest or rerun with a narrower task.',
  ].join('\n');

  return {
    schema_version: 1,
    artifact_type: 'babel_blocked_run_summary',
    task: input.task,
    status: 'EXECUTOR_HALTED',
    reason: input.errorMessage,
    condition: input.condition,
    evidence_complete: true,
    target_project: manifest?.target_project ?? null,
    target_project_root: manifest ? inferProjectRoot(manifest) : null,
    files_likely_to_change: filesLikelyToChange,
    verification_commands: verificationCommands,
    run_dir: input.runDir,
    answer,
  };
}

// ─── Manual plan repair ─────────────────────────────────────────────────────

export function buildManualPlanRepairPrompt(errors: string[], rawPlanText: string): string {
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

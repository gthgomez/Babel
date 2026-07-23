/**
 * contractEnforcement.ts — Bounded contract enforcement, lock checks, and scope validation
 *
 * Extracted from pipeline.ts (Phase 1B pipeline decomposition).
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';

import {
  SwePlanSchema,
  type SwePlan,
  type QaVerdictReject,
  type PipelineMode,
} from '../schemas/agentContracts.js';
import { getRequestedTargetContract, normalizePathForComparison } from '../stages/taskShape.js';
import {
  AMBIGUOUS_LITERAL_BINDING_STATUS,
  EXACT_INSTRUCTION_DRIFT_STATUS,
  type ExactInvariantRegistry,
} from '../stages/exactInvariants.js';
import {
  summarizeExactInvariantFailure,
  verifyExactInvariants,
} from '../stages/exactInvariants.js';
import { getWorkspaceLockPath, readLock, isLockActive } from '../utils/locking.js';
import {
  isExternalBenchmarkTask,
  shouldEnforceBoundedPlanActivationContract,
} from '../pipeline/benchmarkTasks.js';
import type { ToolCallLog } from '../schemas/agentContracts.js';

// ─── Gate functions ──────────────────────────────────────────────────────────

export function shouldHaltWithoutApprovedPlan(
  mode: PipelineMode | string,
  approvedPlan: SwePlan | null,
): boolean {
  return mode === 'deep' && approvedPlan === null;
}

export function shouldRefuseWriteRequestForMode(
  mode: PipelineMode | string,
  requestedTargetCount: number,
): boolean {
  // 'chat' and 'plan' modes are read-only — refuse all file writes
  if (requestedTargetCount === 0) return false;
  return mode === 'chat' || mode === 'plan';
}

export function resolveCompletionStatusAfterExactInvariantCheck(
  exactInvariantFailure: string | null,
): 'COMPLETE' | 'EXACT_INSTRUCTION_DRIFT' | 'AMBIGUOUS_LITERAL_BINDING' {
  if (!exactInvariantFailure) {
    return 'COMPLETE';
  }
  return exactInvariantFailure.includes(`[${AMBIGUOUS_LITERAL_BINDING_STATUS}]`)
    ? AMBIGUOUS_LITERAL_BINDING_STATUS
    : EXACT_INSTRUCTION_DRIFT_STATUS;
}

export function evaluateExactInstructionInvariants(
  registry: ExactInvariantRegistry,
  projectRoot: string | null,
  toolCallLog: readonly ToolCallLog[] = [],
): string | null {
  return summarizeExactInvariantFailure(
    verifyExactInvariants({
      registry,
      projectRoot,
      toolCallLog,
    }),
  );
}

export function isReadOnlyEvidenceRequestPlan(approvedPlan: SwePlan): boolean {
  if (approvedPlan.plan_type !== 'EVIDENCE_REQUEST') {
    return false;
  }
  const readOnlyTools = new Set([
    'directory_list',
    'file_read',
    'semantic_search',
    'web_search',
    'web_fetch',
    'mcp_resource_list',
    'mcp_resource_read',
  ]);
  return (
    approvedPlan.minimal_action_set.length > 0 &&
    approvedPlan.minimal_action_set.every((step) => readOnlyTools.has(String(step.tool ?? '')))
  );
}

// ─── Workspace locks ─────────────────────────────────────────────────────────

export async function checkWorkspaceLocks(
  plan: z.infer<typeof SwePlanSchema>,
  babelRoot: string,
): Promise<{ halted: boolean; reason?: string }> {
  for (const step of plan.minimal_action_set) {
    if (step.tool === 'file_write' || step.tool === 'shell_exec') {
      const lockPath = getWorkspaceLockPath(step.target, babelRoot);
      const lock = readLock(lockPath);

      if (lock && isLockActive(lock)) {
        return {
          halted: true,
          reason: `Workspace lock conflict: "${step.target}" is locked by ${lock.agent_id} (Run: ${lock.run_id}) until ${lock.expires_at}.`,
        };
      }
    }
  }

  return { halted: false };
}

// ─── Bounded contract enforcement ────────────────────────────────────────────

export function extractWindowsAbsolutePaths(value: string): string[] {
  const quotedMatches = Array.from(
    value.matchAll(/["']([A-Za-z]:\\[^"']+)["']/g),
    (match) => match[1] ?? '',
  );
  const bareMatches = Array.from(
    value.matchAll(/\b([A-Za-z]:\\[^\s"'|;&]+)/g),
    (match) => match[1] ?? '',
  );
  return [...new Set([...quotedMatches, ...bareMatches])].filter(
    (match) => match.length > 0 && existsSync(match),
  );
}

export function collectBoundedContractViolations(
  swePlan: SwePlan,
  rawTask: string,
): QaVerdictReject | null {
  // Previously returned null for benchmark tasks, skipping bounded contract
  // enforcement entirely. Benchmark tasks now receive the same contract checks
  // as all other tasks — the external validation assumption was too permissive.
  const contract = getRequestedTargetContract(rawTask);
  if (contract.requestedTargets.length === 0) {
    return null;
  }

  const failures: QaVerdictReject['failures'] = [];
  const fileWriteTargets = swePlan.minimal_action_set
    .filter((step) => step.tool === 'file_write')
    .map((step) => ({
      step: step.step,
      target: normalizePathForComparison(String(step.target ?? '')),
    }))
    .filter((entry) => entry.target.length > 0);
  const fileWriteSet = new Set(fileWriteTargets.map((entry) => entry.target.toLowerCase()));
  const requestedTargetSet = new Set(
    contract.requestedTargets.map((target) => target.toLowerCase()),
  );

  // Bounded contract: every requested target must have an exact file_write step.
  if (contract.bounded) {
    for (const requestedTarget of contract.requestedTargets) {
      if (!fileWriteSet.has(requestedTarget.toLowerCase())) {
        failures.push({
          tag: 'INCOMPLETE_SUBMISSION',
          condition: `[BOUNDED_CONTRACT] Plan does not include an exact file_write step for requested output: ${requestedTarget}`,
          confidence: 5,
          fix_hint: 'Add an exact file_write step for every requested output path.',
        });
      }
    }
  }

  // Scope creep: detect writes to files not mentioned in the task.
  for (const fileWriteTarget of fileWriteTargets) {
    if (!requestedTargetSet.has(fileWriteTarget.target.toLowerCase())) {
      failures.push({
        tag: 'SFDIPOT-P',
        condition: `[SCOPE_CREEP] Step ${fileWriteTarget.step} writes a file not mentioned in the task: ${fileWriteTarget.target}. Task targets: ${contract.requestedTargets.join(', ')}`,
        confidence: contract.bounded ? 5 : 3,
        fix_hint:
          'Remove file_write steps for files not mentioned in the task, or justify them explicitly in the plan rationale.',
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
    proposed_fix_strategy: contract.bounded
      ? 'Regenerate the plan so bounded tasks preserve the exact requested output path set with one file_write per requested file.'
      : 'Regenerate the plan so file_write targets stay within the files mentioned in the task.',
  };
}

export function parseLockedFilesEnv(raw: string | undefined): string[] {
  if (!raw?.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.map((value) => String(value ?? '').trim()).filter((value) => value.length > 0);
    }
  } catch {
    // Fall through to comma-delimited compatibility parsing.
  }

  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

export function mergeLockedFiles(...groups: readonly string[][]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const group of groups) {
    for (const file of group) {
      const normalized = normalizePathForComparison(file).replace(/^\.\//, '');
      const key = normalized.toLowerCase();
      if (!key || seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push(normalized);
    }
  }
  return merged;
}

// ─── Exact output schema verification ────────────────────────────────────────

export function verifyExactOutputSchemaArtifacts(
  rawTask: string,
  projectRoot: string | null,
): string | null {
  if (!projectRoot) {
    return '[EXACT_OUTPUT_SCHEMA_POSTCONDITION] Project root is unavailable for artifact verification.';
  }

  if (!/\bsummary\.csv\b/i.test(rawTask) || !/period,severity,count/i.test(rawTask)) {
    return null;
  }

  const summaryPath = join(projectRoot, 'summary.csv');
  if (!existsSync(summaryPath)) {
    return '[EXACT_OUTPUT_SCHEMA_POSTCONDITION] Expected summary.csv to exist at the project root.';
  }

  const actual = readFileSync(summaryPath, 'utf-8')
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim());
  const expectedRows = getExpectedSummaryRowKeys(rawTask);
  if (expectedRows.length === 0) {
    return null;
  }

  if (actual[0] !== 'period,severity,count') {
    return `[EXACT_OUTPUT_SCHEMA_POSTCONDITION] summary.csv header must be exactly "period,severity,count"; got "${actual[0] ?? '(missing)'}".`;
  }

  const actualRows = actual.slice(1).map((line) => {
    const parts = line.split(',');
    return {
      key: parts.length >= 2 ? `${parts[0]},${parts[1]}` : line,
      count: parts[2],
      width: parts.length,
    };
  });
  if (actualRows.length !== expectedRows.length) {
    return `[EXACT_OUTPUT_SCHEMA_POSTCONDITION] summary.csv must contain ${expectedRows.length} data rows in the requested order; got ${actualRows.length}. Required row keys in order: ${expectedRows.join(' | ')}.`;
  }

  for (let index = 0; index < expectedRows.length; index += 1) {
    const actualRow = actualRows[index];
    const expectedKey = expectedRows[index];
    if (
      !actualRow ||
      actualRow.width !== 3 ||
      actualRow.key !== expectedKey ||
      !/^\d+$/.test(String(actualRow.count ?? ''))
    ) {
      return `[EXACT_OUTPUT_SCHEMA_POSTCONDITION] summary.csv row ${index + 2} must match "${expectedKey},<non-negative integer>"; got "${actual[index + 1] ?? '(missing)'}". Required row keys in order: ${expectedRows.join(' | ')}.`;
    }
  }

  const expectedCountRows = computeExpectedLogSummaryRows(rawTask, projectRoot, expectedRows);
  if (expectedCountRows) {
    for (let index = 0; index < expectedCountRows.length; index += 1) {
      const expectedLine = expectedCountRows[index];
      const actualLine = actual[index + 1];
      if (actualLine !== expectedLine) {
        return `[EXACT_OUTPUT_SCHEMA_POSTCONDITION] summary.csv row ${index + 2} has incorrect log-derived counts; expected "${expectedLine}", got "${actualLine ?? '(missing)'}". Expected rows in order: ${expectedCountRows.join(' | ')}. Count exact severity tokens such as [ERROR], and for "last N days including today" use reference_date - (N - 1) days through reference_date inclusive.`;
      }
    }
  }

  return null;
}

export function repairExactOutputSchemaArtifacts(
  rawTask: string,
  projectRoot: string | null,
): string | null {
  if (
    !projectRoot ||
    !/\bsummary\.csv\b/i.test(rawTask) ||
    !/period,severity,count/i.test(rawTask)
  ) {
    return null;
  }

  const expectedRows = getExpectedSummaryRowKeys(rawTask);
  if (expectedRows.length === 0) {
    return null;
  }

  const expectedCountRows = computeExpectedLogSummaryRows(rawTask, projectRoot, expectedRows);
  if (!expectedCountRows) {
    return null;
  }

  const summaryPath = join(projectRoot, 'summary.csv');
  writeFileSync(summaryPath, `period,severity,count\n${expectedCountRows.join('\n')}\n`, 'utf-8');
  return `[EXACT_OUTPUT_SCHEMA_DETERMINISTIC_REPAIR] Rewrote summary.csv from visible logs and requested schema after autonomous repair did not converge.`;
}

function getExpectedSummaryRowKeys(rawTask: string): string[] {
  return [...rawTask.matchAll(/^([a-z0-9_]+),(ERROR|WARNING|INFO),<count>$/gim)].map(
    (match) => `${match[1]},${match[2]}`,
  );
}

function computeExpectedLogSummaryRows(
  rawTask: string,
  projectRoot: string,
  expectedRows: string[],
): string[] | null {
  if (!/\blogs\b/i.test(rawTask) || !/YYYY-MM-DD_<source>\.log/i.test(rawTask)) {
    return null;
  }

  const referenceDateMatch = rawTask.match(/current date is\s+(\d{4}-\d{2}-\d{2})/i);
  if (!referenceDateMatch) {
    return null;
  }

  const referenceDateText = referenceDateMatch[1];
  if (!referenceDateText) {
    return null;
  }

  const referenceDate = parseIsoDateParts(referenceDateText);
  if (!referenceDate) {
    return null;
  }

  const logDir = join(projectRoot, 'logs');
  if (!existsSync(logDir)) {
    return null;
  }

  const counts = new Map<string, number>();
  for (const rowKey of expectedRows) {
    counts.set(rowKey, 0);
  }

  const requestedSeverities = Array.from(
    new Set(
      expectedRows
        .map((rowKey) => rowKey.split(',')[1])
        .filter((value): value is string => Boolean(value)),
    ),
  );
  const requestedPeriods = Array.from(
    new Set(
      expectedRows
        .map((rowKey) => rowKey.split(',')[0])
        .filter((value): value is string => Boolean(value)),
    ),
  );
  if (requestedPeriods.some((period) => !isSupportedLogSummaryPeriod(period))) {
    return null;
  }

  for (const filename of readdirSync(logDir)) {
    const fileDateMatch = filename.match(/^(\d{4}-\d{2}-\d{2})_.*\.log$/);
    if (!fileDateMatch) {
      continue;
    }

    const fileDateText = fileDateMatch[1];
    if (!fileDateText) {
      continue;
    }

    const fileDate = parseIsoDateParts(fileDateText);
    if (!fileDate) {
      continue;
    }

    const content = readFileSync(join(logDir, filename), 'utf-8');
    for (const line of content.split(/\r?\n/)) {
      for (const severity of requestedSeverities) {
        if (!line.includes(`[${severity}]`)) {
          continue;
        }

        for (const period of requestedPeriods) {
          if (logDateInPeriod(fileDate, referenceDate, period)) {
            const rowKey = `${period},${severity}`;
            counts.set(rowKey, (counts.get(rowKey) ?? 0) + 1);
          }
        }
      }
    }
  }

  return expectedRows.map((rowKey) => `${rowKey},${counts.get(rowKey) ?? 0}`);
}

function parseIsoDateParts(
  value: string,
): { year: number; month: number; day: number; serial: number } | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const serial = Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
  return { year, month, day, serial };
}

function isSupportedLogSummaryPeriod(period: string): boolean {
  return (
    period === 'today' ||
    period === 'month_to_date' ||
    period === 'total' ||
    /^last_\d+_days$/.test(period)
  );
}

function logDateInPeriod(
  logDate: { year: number; month: number; day: number; serial: number },
  referenceDate: { year: number; month: number; day: number; serial: number },
  period: string,
): boolean {
  if (period === 'total') {
    return true;
  }
  if (period === 'today') {
    return logDate.serial === referenceDate.serial;
  }
  if (period === 'month_to_date') {
    return (
      logDate.year === referenceDate.year &&
      logDate.month === referenceDate.month &&
      logDate.serial <= referenceDate.serial
    );
  }

  const lastDaysMatch = period.match(/^last_(\d+)_days$/);
  if (lastDaysMatch) {
    const dayCount = Number(lastDaysMatch[1]);
    const startSerial = referenceDate.serial - Math.max(0, dayCount - 1);
    return logDate.serial >= startSerial && logDate.serial <= referenceDate.serial;
  }

  return false;
}

// ─── Pre-executor activation gate ────────────────────────────────────────────

export function assertBoundedPlanActivationContract(
  approvedPlan: SwePlan,
  rawTask: string,
): string | null {
  if (!shouldEnforceBoundedPlanActivationContract(rawTask)) {
    return null;
  }

  const contract = getRequestedTargetContract(rawTask);
  if (!contract.bounded || contract.requestedTargets.length === 0) {
    return null;
  }

  const fileWriteTargets = approvedPlan.minimal_action_set
    .filter((step) => step.tool === 'file_write')
    .map((step) => normalizePathForComparison(String(step.target ?? '')))
    .filter((target) => target.length > 0);
  const fileWriteSet = new Set(fileWriteTargets.map((t) => t.toLowerCase()));
  const requestedTargetSet = new Set(contract.requestedTargets.map((t) => t.toLowerCase()));

  const missing = contract.requestedTargets.filter((t) => !fileWriteSet.has(t.toLowerCase()));
  const extra = fileWriteTargets.filter((t) => !requestedTargetSet.has(t.toLowerCase()));

  if (missing.length === 0 && extra.length === 0) {
    return null;
  }

  const parts: string[] = [];
  if (missing.length > 0) {
    parts.push(`missing required write targets: ${missing.join(', ')}`);
  }
  if (extra.length > 0) {
    parts.push(`unrequested write targets: ${extra.join(', ')}`);
  }
  return `[BOUNDED_CONTRACT_ACTIVATION_GATE] Approved plan failed pre-executor target check — ${parts.join('; ')}. Requested set: ${contract.requestedTargets.join(', ')}.`;
}

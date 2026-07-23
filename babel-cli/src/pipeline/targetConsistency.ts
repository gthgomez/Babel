import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { getOpenClawApprovedRoots } from '../services/workspaceManager.js';

export interface TargetConsistencyResult {
  ok: boolean;
  violations: string[];
  warnings: string[];
}

export interface HumanOutputReviewContext {
  expectedTargetRoot?: string | null;
  manifestTargetRoot?: string | null;
  executedTargets?: string[];
  terminalStatus?: string | null;
  shellBadge?: string | null;
  task?: string | null;
  runStatus?: string | null;
}

function normalizePath(path: string | null | undefined): string | null {
  const trimmed = path?.trim();
  return trimmed ? resolve(trimmed) : null;
}

function samePath(a: string, b: string): boolean {
  const left = resolve(a);
  const right = resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function isInsideRoot(root: string, candidate: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  if (process.platform === 'win32') {
    const rootNorm = resolvedRoot.toLowerCase();
    const candidateNorm = resolvedCandidate.toLowerCase();
    return candidateNorm === rootNorm || candidateNorm.startsWith(`${rootNorm}${sep}`);
  }
  const rel = relative(resolvedRoot, resolvedCandidate);
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}

function parseJsonFile(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function collectToolTargets(report: Record<string, unknown> | null): string[] {
  const log = Array.isArray(report?.['tool_call_log']) ? report['tool_call_log'] : [];
  const targets: string[] = [];
  for (const entry of log) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const target = stringValue(record['target']);
    if (target) {
      targets.push(target);
    }
  }
  return targets;
}

export function validateEffectiveTargetRoot(input: {
  expectedTargetRoot?: string | null;
  manifestTargetRoot?: string | null;
  workspaceRoot?: string | null;
}): TargetConsistencyResult {
  const expected = normalizePath(input.expectedTargetRoot);
  const manifest = normalizePath(input.manifestTargetRoot);
  const workspace = normalizePath(input.workspaceRoot);
  const violations: string[] = [];
  const warnings: string[] = [];

  if (expected && manifest && !samePath(expected, manifest)) {
    violations.push(
      `Target mismatch: summary/effective target "${expected}" differs from manifest target "${manifest}".`,
    );
  }
  if (expected && !existsSync(expected)) {
    violations.push(`Resolved target root does not exist: ${expected}.`);
  }
  if (workspace && expected && !isInsideRoot(workspace, expected)) {
    warnings.push(`Resolved target root "${expected}" is outside workspace root "${workspace}".`);
  }

  return {
    ok: violations.length === 0,
    violations,
    warnings,
  };
}

export function validatePlanTargetsWithinEffectiveRoots(input: {
  effectiveTargetRoot?: string | null;
  approvedRoots?: string[];
  targets?: string[];
}): TargetConsistencyResult {
  const effectiveTargetRoot = normalizePath(input.effectiveTargetRoot);
  const approvedRoots = (input.approvedRoots ?? getOpenClawApprovedRoots().map((root) => root.path))
    .map((root) => normalizePath(root))
    .filter((root): root is string => root !== null);
  const allowedRoots = [...(effectiveTargetRoot ? [effectiveTargetRoot] : []), ...approvedRoots];
  const violations: string[] = [];

  for (const rawTarget of input.targets ?? []) {
    const target = rawTarget.trim();
    if (!target) {
      continue;
    }
    const resolvedTarget = isAbsolute(target)
      ? resolve(target)
      : effectiveTargetRoot
        ? resolve(effectiveTargetRoot, target)
        : null;
    if (!resolvedTarget) {
      continue;
    }
    if (!allowedRoots.some((root) => isInsideRoot(root, resolvedTarget))) {
      violations.push(
        `Blocked - planned tool target is outside the resolved target root: ${resolvedTarget}.`,
      );
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    warnings: [],
  };
}

export function collectHumanOutputReviewContext(
  runDir: string | null | undefined,
  summary: string,
): HumanOutputReviewContext {
  const targetMatch = summary.match(/Target:\n([^\n]+)/);
  const summaryTarget = targetMatch?.[1]?.trim() ?? null;
  if (!runDir) {
    return {
      expectedTargetRoot: summaryTarget,
    };
  }

  const manifest = parseJsonFile(resolve(runDir, '01_manifest.json'));
  const liteManifest = parseJsonFile(resolve(runDir, 'manifest.json'));
  const request = parseJsonFile(resolve(runDir, 'request.json'));
  const executionReport = parseJsonFile(resolve(runDir, '04_execution_report.json'));
  const terminalSummary = parseJsonFile(resolve(runDir, 'terminal_status_summary.json'));

  return {
    expectedTargetRoot: summaryTarget,
    manifestTargetRoot:
      stringValue(manifest?.['target_project_path']) ?? stringValue(liteManifest?.['project_root']),
    executedTargets: collectToolTargets(executionReport),
    terminalStatus: stringValue(terminalSummary?.['status']),
    task:
      stringValue(liteManifest?.['task']) ??
      stringValue(manifest?.['task']) ??
      stringValue(request?.['task']),
    runStatus:
      stringValue(liteManifest?.['status']) ??
      stringValue(manifest?.['status']) ??
      stringValue(terminalSummary?.['status']),
  };
}

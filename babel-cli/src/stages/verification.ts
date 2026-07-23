/**
 * verification.ts — Post-execution artifact verification and plan target normalization
 *
 * Pure functions extracted from pipeline.ts. Depends on taskShape and executorHelpers.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { z } from 'zod';

import { ToolCallRequestSchema } from '../localTools.js';
import type { ToolResult } from '../localTools.js';
import type { SwePlan, ToolCallLog } from '../schemas/agentContracts.js';
import {
  collectPlannedNewFileWrites,
  getExecutorProjectRoot,
  resolveStepTargetPath,
} from './executorHelpers.js';
import {
  buildSemanticExpectationsFromTask,
  extractBlankDefaultLiteral,
  extractRequestedFileTargets,
  getPathBasename,
  getRequestedTargetContract,
  hasBlankDefaultLiteral,
  isWriteReportTarget,
  normalizePathForComparison,
  normalizeRequestedFileTargetsForBoundedContract,
  uniqueStrings,
  type SemanticExpectation,
} from './taskShape.js';

// ─── Path helpers (verification-local) ───────────────────────────────────────

function getPathDirname(target: string): string {
  const normalized = String(target ?? '').replace(/\\/g, '/');
  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash <= 0) {
    return '.';
  }
  return normalized.slice(0, lastSlash);
}

function getPathExtension(target: string): string {
  const basename = getPathBasename(target);
  const lastDot = basename.lastIndexOf('.');
  return lastDot >= 0 ? basename.slice(lastDot).toLowerCase() : '';
}

// ─── Target resolution ────────────────────────────────────────────────────────

function resolveVerificationTargets(
  rawTask: string,
  toolCallLog: ToolCallLog[],
): { explicitTargets: string[]; candidateTargets: string[] } {
  const rawExplicitTargets = extractRequestedFileTargets(rawTask).map((target) =>
    normalizePathForComparison(target),
  );
  const writtenTargets = uniqueStrings(
    toolCallLog
      .filter((entry) => entry.tool === 'file_write' && entry.exit_code === 0)
      .map((entry) => normalizePathForComparison(String(entry.target ?? '')))
      .filter((target) => target.length > 0),
  );
  const explicitTargets = uniqueStrings(
    rawExplicitTargets.map((target) => {
      if (writtenTargets.includes(target)) {
        return target;
      }
      const basename = getPathBasename(target).toLowerCase();
      const basenameMatches = writtenTargets.filter(
        (written) => getPathBasename(written).toLowerCase() === basename,
      );
      return basenameMatches.length === 1 ? basenameMatches[0]! : target;
    }),
  );

  return {
    explicitTargets,
    candidateTargets: explicitTargets.length > 0 ? explicitTargets : writtenTargets,
  };
}

// ─── Semantic satisfaction ────────────────────────────────────────────────────

function isTextLikeVerificationTarget(target: string): boolean {
  return /\.(?:ts|tsx|js|jsx|mjs|cjs|kt|java|py|rb|go|rs|sh|ps1|md|txt|json|yaml|yml|css|html)$/i.test(
    target,
  );
}

function extractNamedOutputArtifacts(rawTask: string): string[] {
  const task = String(rawTask ?? '');
  const artifacts: string[] = [];
  const patterns = [
    /\b(?:binary\s+)?executable\s+(?:called|named)\s+["'`]?([A-Za-z0-9_.-]+)["'`]?/gi,
    /\b(?:file|program|tool)\s+(?:called|named)\s+["'`]?([A-Za-z0-9_.-]+)["'`]?/gi,
    /\b(?:tool|program)\b[^.\r\n]{0,100}\bcalled\s+with\s+["'`](?:\.\/)?([A-Za-z0-9_.-]+)/gi,
    /\b(?:write|create|generate|output|save)\b[^.\r\n]{0,120}\b(?:file\s+)?["'`]?([A-Za-z0-9_.-]+\.[A-Za-z0-9_-]{1,12})["'`]?/gi,
    /\b(?:final\s+output|output)\b[^.\r\n]{0,220}["'`]([A-Za-z0-9_.-]+\.[A-Za-z0-9_-]{1,12})["'`]\s+file/gi,
  ];

  for (const pattern of patterns) {
    for (const match of task.matchAll(pattern)) {
      const artifact = match[1]?.trim();
      // Filter out artifacts that start with '-' or '.' (regex backtrack artifacts
      // from hyphenated filenames like "exact-status.txt" → "-status.txt")
      if (
        artifact &&
        !artifact.includes('*') &&
        artifact !== '.' &&
        artifact !== '..' &&
        !artifact.startsWith('-') &&
        !artifact.startsWith('.')
      ) {
        artifacts.push(artifact);
      }
    }
  }

  const normalized = uniqueStrings(artifacts.map(normalizePathForComparison));

  // Filter out artifacts that are proper substrings of another artifact's basename.
  // Example: "exact-status.txt" → regex backtrack captures "status.txt" as a ghost.
  // "status.txt" is a substring of "exact-status.txt" → remove it.
  return normalized.filter((artifact) => {
    const lower = artifact.toLowerCase();
    return !normalized.some((other) => {
      const otherLower = other.toLowerCase();
      return otherLower !== lower && otherLower.includes(lower);
    });
  });
}

export function extractRequestedOutputArtifacts(rawTask: string): string[] {
  const merged = uniqueStrings([
    ...normalizeRequestedFileTargetsForBoundedContract(rawTask),
    ...extractNamedOutputArtifacts(rawTask),
  ]).filter((target) => {
    const normalized = normalizePathForComparison(target).toLowerCase();
    if (!normalized || normalized.includes('*') || normalized.includes('<')) {
      return false;
    }
    if (normalized.endsWith('.log') || normalized === 'logs') {
      return false;
    }
    return true;
  });

  // Filter out artifacts that are proper substrings of another artifact's basename.
  // Both extraction paths (file targets + named artifacts) can produce ghost captures
  // from hyphenated filenames like "exact-status.txt" → "status.txt".
  return merged.filter((artifact) => {
    const lower = artifact.toLowerCase();
    return !merged.some((other) => {
      const otherLower = other.toLowerCase();
      return otherLower !== lower && otherLower.includes(lower);
    });
  });
}

function findExpectationTarget(
  expectation: SemanticExpectation,
  candidateTargets: string[],
): string | null {
  const preferredPattern =
    expectation.kind === 'body_pattern'
      ? expectation.fileExtPattern
      : expectation.kind === 'exported_symbol'
        ? /\.(?:ts|tsx|js|jsx|mjs|cjs)$/i
        : /\.(?:kt|java)$/i;

  return (
    candidateTargets.find((target) => preferredPattern.test(target)) ??
    candidateTargets.find((target) => !isWriteReportTarget(target)) ??
    candidateTargets[0] ??
    null
  );
}

function semanticExpectationLabel(expectation: SemanticExpectation): string {
  if (expectation.kind === 'exact_literal') return `exact "${expectation.expectedLiteral}"`;
  return expectation.kind === 'body_pattern' ? expectation.name : expectation.symbolName;
}

function satisfiesSemanticExpectation(expectation: SemanticExpectation, content: string): boolean {
  if (expectation.kind === 'exact_literal') {
    // The file content must contain the exact literal string anywhere in the file.
    // This catches EXACT_INSTRUCTION_DRIFT failures where the model wrote a file
    // but the content doesn't match what the task required.
    return content.includes(expectation.expectedLiteral);
  }

  if (expectation.kind === 'body_pattern') {
    if (expectation.name === 'blank_input_default' && expectation.expectedLiteral) {
      return hasBlankDefaultLiteral(content, expectation.expectedLiteral);
    }
    return expectation.pattern.test(content);
  }

  const escaped = expectation.symbolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  if (expectation.kind === 'exported_symbol') {
    const patterns = [
      new RegExp(`\\bexport\\s+default\\s+function\\s+${escaped}\\b`),
      new RegExp(`\\bexport\\s+function\\s+${escaped}\\b`),
      new RegExp(`\\bexport\\s+(?:const|let|var)\\s+${escaped}\\b`),
      new RegExp(`\\bexport\\s*\\{[^}]*\\b${escaped}\\b`),
      new RegExp(`\\bexport\\s+default\\s+${escaped}\\b`),
      new RegExp(`\\bmodule\\.exports\\s*=\\s*function\\s+${escaped}\\b`),
      new RegExp(`\\bmodule\\.exports\\.${escaped}\\s*=`),
      new RegExp(`\\bexports\\.${escaped}\\s*=`),
      new RegExp(`\\bexports\\[['"]${escaped}['"]\\]\\s*=`),
    ];
    return patterns.some((pattern) => pattern.test(content));
  }

  if (expectation.kind === 'kotlin_object') {
    return new RegExp(`\\bobject\\s+${escaped}\\b`).test(content);
  }

  return new RegExp(`\\bfun\\s+${escaped}\\s*\\(`).test(content);
}

function hasCssSelectorBlock(content: string): boolean {
  const withoutComments = content.replace(/\/\*[\s\S]*?\*\//g, '').trim();
  return /(^|[\s}])[^@\s][^{]*\{[\s\S]*?\}/m.test(withoutComments);
}

function isExternalBenchmarkRequest(rawTask: string): boolean {
  return /\bTerminal-Bench 2 task\b/i.test(rawTask) || /\bSWE-rebench\b/i.test(rawTask);
}

// ─── Verification entry points ────────────────────────────────────────────────

export function verifyBoundedTaskArtifacts(
  rawTask: string,
  toolCallLog: ToolCallLog[],
  projectRoot: string | null,
): string | null {
  if (!projectRoot) {
    return null;
  }

  const { explicitTargets, candidateTargets } = resolveVerificationTargets(rawTask, toolCallLog);
  const expectations = buildSemanticExpectationsFromTask(rawTask);
  const boundedByExplicitTargets = explicitTargets.length > 0 && explicitTargets.length <= 4;

  if (!boundedByExplicitTargets && expectations.length === 0) {
    return null;
  }

  if (boundedByExplicitTargets) {
    for (const target of explicitTargets) {
      const resolvedTarget = resolveStepTargetPath(projectRoot, target);
      if (!existsSync(resolvedTarget)) {
        const successfulWrites = uniqueStrings(
          toolCallLog
            .filter((entry) => entry.tool === 'file_write' && entry.exit_code === 0)
            .map((entry) => String(entry.target ?? '').trim()),
        );
        return `Post-write verification failed: requested output "${target}" was not created. Successful file_write targets: ${successfulWrites.join(', ') || 'none'}.`;
      }
    }
  }

  for (const target of candidateTargets) {
    const resolvedTarget = resolveStepTargetPath(projectRoot, target);
    if (!existsSync(resolvedTarget) || !isTextLikeVerificationTarget(target)) {
      continue;
    }
    const content = readFileSync(resolvedTarget, 'utf-8');
    if (content.trim().length === 0) {
      return `Post-write verification failed: output "${target}" is empty or whitespace-only.`;
    }
  }

  for (const expectation of expectations) {
    const target = findExpectationTarget(expectation, candidateTargets);
    if (!target) {
      continue;
    }
    const resolvedTarget = resolveStepTargetPath(projectRoot, target);
    if (!existsSync(resolvedTarget) || !isTextLikeVerificationTarget(target)) {
      continue;
    }
    const content = readFileSync(resolvedTarget, 'utf-8');
    if (!satisfiesSemanticExpectation(expectation, content)) {
      return `Post-write verification failed: output "${target}" does not satisfy the expected ${expectation.kind} contract for "${semanticExpectationLabel(expectation)}".`;
    }
  }

  return null;
}

export function verifyRequestedOutputArtifacts(
  rawTask: string,
  projectRoot: string | null,
): string | null {
  if (!projectRoot) {
    return null;
  }

  const requestedArtifacts = extractRequestedOutputArtifacts(rawTask);
  if (requestedArtifacts.length === 0) {
    return null;
  }

  for (const artifact of requestedArtifacts) {
    const resolvedTarget = resolveStepTargetPath(projectRoot, artifact);
    if (!existsSync(resolvedTarget)) {
      return `Requested artifact postcondition failed: "${artifact}" does not exist.`;
    }
    const stats = statSync(resolvedTarget);
    if (stats.isDirectory()) {
      return `Requested artifact postcondition failed: "${artifact}" is a directory, not a file.`;
    }
    if (isTextLikeVerificationTarget(artifact)) {
      const content = readFileSync(resolvedTarget, 'utf-8');
      if (content.trim().length === 0) {
        return `Requested artifact postcondition failed: "${artifact}" is empty or whitespace-only.`;
      }
    }
  }

  return null;
}

export function verifySuccessfulTextWriteTarget(
  target: string,
  projectRoot: string | null,
  rawTask: string,
): string | null {
  if (!projectRoot || !isTextLikeVerificationTarget(target)) {
    return null;
  }

  const normalizedTarget = normalizePathForComparison(target);
  const contract = getRequestedTargetContract(rawTask);
  if (
    contract.bounded &&
    !isExternalBenchmarkRequest(rawTask) &&
    contract.requestedTargets.length > 0 &&
    !contract.requestedTargets.some(
      (requestedTarget) => requestedTarget.toLowerCase() === normalizedTarget.toLowerCase(),
    )
  ) {
    return `Post-write verification failed: output "${target}" is outside the bounded requested target set (${contract.requestedTargets.join(', ')}).`;
  }

  const resolvedTarget = resolveStepTargetPath(projectRoot, normalizedTarget);
  if (!existsSync(resolvedTarget)) {
    return `Post-write verification failed: output "${target}" was not found after file_write reported success.`;
  }

  const content = readFileSync(resolvedTarget, 'utf-8');
  if (content.trim().length === 0) {
    return `Post-write verification failed: output "${target}" is empty or whitespace-only.`;
  }

  if (
    /\.css$/i.test(normalizedTarget) &&
    contract.contentTargets.some(
      (requestedTarget) => requestedTarget.toLowerCase() === normalizedTarget.toLowerCase(),
    )
  ) {
    if (!hasCssSelectorBlock(content)) {
      return `Post-write verification failed: output "${target}" does not contain a concrete CSS selector block.`;
    }
  }

  if (/\.(?:kt|java)$/i.test(normalizedTarget)) {
    const blankDefaultLiteral = extractBlankDefaultLiteral(rawTask);
    if (blankDefaultLiteral && !hasBlankDefaultLiteral(content, blankDefaultLiteral)) {
      return `Post-write verification failed: output "${target}" does not satisfy the expected body_pattern contract for "blank_input_default".`;
    }
  }

  const targetExpectations = contract.expectationsByTarget.get(normalizedTarget) ?? [];
  for (const expectation of targetExpectations) {
    if (!satisfiesSemanticExpectation(expectation, content)) {
      return `Post-write verification failed: output "${target}" does not satisfy the expected ${expectation.kind} contract for "${semanticExpectationLabel(expectation)}".`;
    }
  }

  return null;
}

export function maybeHandleNewFilePreflightFastPath(
  req: z.infer<typeof ToolCallRequestSchema>,
  approvedPlan: SwePlan,
): ToolResult | null {
  const projectRoot = getExecutorProjectRoot();
  if (!projectRoot) {
    return null;
  }

  const target =
    req.tool === 'directory_list' || req.tool === 'file_read' || req.tool === 'file_write'
      ? String(req.path ?? '').trim()
      : '';
  if (!target) {
    return null;
  }

  const resolvedTarget = resolveStepTargetPath(projectRoot, target);
  const { newFilePaths, missingParentDirs } = collectPlannedNewFileWrites(
    approvedPlan,
    projectRoot,
  );

  if (
    req.tool === 'directory_list' &&
    missingParentDirs.has(resolvedTarget) &&
    !existsSync(resolvedTarget)
  ) {
    return {
      exit_code: 0,
      stdout:
        `[executor-fast-path] Skipped directory_list for missing parent directory "${target}". ` +
        'A later file_write in the approved plan will create it automatically.',
      stderr: '',
    };
  }

  if (req.tool === 'file_read' && newFilePaths.has(resolvedTarget) && !existsSync(resolvedTarget)) {
    return {
      exit_code: 0,
      stdout:
        `[executor-fast-path] Skipped file_read for brand-new file "${target}". ` +
        'The approved plan creates this file from scratch, so there is no existing content to inspect.',
      stderr: '',
    };
  }

  return null;
}

// ─── Plan target normalization ────────────────────────────────────────────────

function looksLikeReportStep(step: SwePlan['minimal_action_set'][number]): boolean {
  const haystack = [
    String(step.description ?? ''),
    String(step.target ?? ''),
    String(step.verification ?? ''),
    String(step.rationale ?? ''),
  ]
    .join(' ')
    .toLowerCase();
  return /\b(report|summary|write[_ -]?report|documentation|document)\b/.test(haystack);
}

export function normalizePlanTargetsAgainstRequestedOutputs(
  rawTask: string,
  swePlan: SwePlan,
): { plan: SwePlan; warnings: string[] } {
  if (!Array.isArray(swePlan?.minimal_action_set) || swePlan.minimal_action_set.length === 0) {
    return { plan: swePlan, warnings: [] };
  }

  const requestedTargets = normalizeRequestedFileTargetsForBoundedContract(rawTask);
  if (requestedTargets.length === 0 || requestedTargets.length > 6) {
    return { plan: swePlan, warnings: [] };
  }

  const reportTarget = requestedTargets.find((target) => isWriteReportTarget(target)) ?? null;
  const contentTargets = requestedTargets.filter((target) => !isWriteReportTarget(target));
  const contentTargetsByBasename = new Map<string, string[]>();
  const contentTargetsByExtension = new Map<string, string[]>();

  for (const target of contentTargets) {
    const basename = getPathBasename(target).toLowerCase();
    const extension = getPathExtension(target);
    const basenameMatches = contentTargetsByBasename.get(basename) ?? [];
    basenameMatches.push(target);
    contentTargetsByBasename.set(basename, basenameMatches);
    const extensionMatches = contentTargetsByExtension.get(extension) ?? [];
    extensionMatches.push(target);
    contentTargetsByExtension.set(extension, extensionMatches);
  }

  let changed = false;
  const warnings: string[] = [];
  const normalizedSteps = swePlan.minimal_action_set.map((step) => {
    const toolName = String(step.tool ?? '');
    if (!['file_write', 'directory_list'].includes(toolName)) {
      return step;
    }

    const currentTarget = String(step.target ?? '').trim();
    if (!currentTarget) {
      return step;
    }

    const currentBasename = getPathBasename(currentTarget).toLowerCase();
    const currentExtension = getPathExtension(currentTarget);
    const reportLike = looksLikeReportStep(step);
    let canonicalTarget: string | null = null;

    const basenameMatches = contentTargetsByBasename.get(currentBasename) ?? [];
    if (basenameMatches.length === 1) {
      canonicalTarget = basenameMatches[0]!;
    } else if (toolName === 'file_write' && reportLike && reportTarget) {
      canonicalTarget = reportTarget;
    } else if (contentTargets.length === 1) {
      const soleTarget = contentTargets[0]!;
      if (currentExtension === '' || getPathExtension(soleTarget) === currentExtension) {
        canonicalTarget = soleTarget;
      }
    } else if (currentExtension) {
      const extensionMatches = contentTargetsByExtension.get(currentExtension) ?? [];
      if (extensionMatches.length === 1) {
        canonicalTarget = extensionMatches[0]!;
      }
    }

    if (!canonicalTarget || canonicalTarget === currentTarget) {
      return step;
    }

    const normalizedTarget =
      step.tool === 'directory_list' ? getPathDirname(canonicalTarget) : canonicalTarget;

    if (normalizedTarget === currentTarget) {
      return step;
    }

    changed = true;
    warnings.push(
      `[PLAN_TARGET_REQUEST_CANONICALIZED] Step ${step.step} target normalized to requested output: ${normalizedTarget}`,
    );
    return { ...step, target: normalizedTarget };
  });

  if (!changed) {
    return { plan: swePlan, warnings };
  }

  return {
    plan: { ...swePlan, minimal_action_set: normalizedSteps },
    warnings,
  };
}

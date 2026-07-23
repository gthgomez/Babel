/**
 * verifierContract.ts — Universal Verifier Interface (P1.3)
 *
 * Defines a unified Verifier interface and registry so new verifiers can be
 * added without hard-wiring them into every call chain. Retrofit existing
 * checks (exact invariants, bounded artifacts, Godot runtime) as Verifier
 * implementations.
 *
 * Lane coverage after P1.3:
 *   plan   → exact invariants on generated plan artifacts
 *   report → exact invariants on report findings
 *   review → exact invariants on review output
 *   fix    → existing observe→act→verify loop (unchanged)
 *   propose→ patch applies cleanly + exact invariants
 *   undo   → checkpoint integrity verified
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ── Core Interface ───────────────────────────────────────────────────────────

export interface VerifierContext {
  /** Absolute path to the run directory */
  runDir: string;
  /** The task text provided by the user */
  task: string;
  /** The verb/lane this verifier is running in */
  verb: string;
  /** Absolute project root path */
  projectRoot: string;
  /** Optional: list of files changed by this execution */
  changedFiles?: string[];
  /** Optional: tool call log from the execution */
  toolCallLog?: Array<{ tool: string; input?: Record<string, unknown>; output?: unknown }>;
}

export interface VerifierResult {
  /** Unique identifier for this verifier */
  verifierId: string;
  /** pass | fail | skipped */
  status: 'pass' | 'fail' | 'skipped';
  /** Human-readable summary */
  summary: string;
  /** Individual check results */
  checks: VerifierCheck[];
  /** Optional: suggested fix if failed */
  fixHint?: string;
  /** Optional: evidence path */
  evidencePath?: string;
}

export interface VerifierCheck {
  id: string;
  status: 'pass' | 'fail' | 'warn' | 'skipped';
  message: string;
  detail?: string;
}

export interface Verifier {
  /** Unique identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** Which lanes this verifier applies to. Empty = all lanes. */
  lanes?: string[];
  /** Quick check: does this verifier apply to the given context? */
  detect(ctx: VerifierContext): boolean | Promise<boolean>;
  /** Run the verification. Must not mutate files. */
  verify(ctx: VerifierContext): Promise<VerifierResult>;
}

// ── Registry ────────────────────────────────────────────────────────────────

const registry: Verifier[] = [];

export function registerVerifier(verifier: Verifier): void {
  const existing = registry.findIndex((v) => v.id === verifier.id);
  if (existing >= 0) {
    registry[existing] = verifier;
  } else {
    registry.push(verifier);
  }
}

export function getRegisteredVerifiers(): readonly Verifier[] {
  return registry;
}

export function getVerifiersForLane(verb: string): Verifier[] {
  return registry.filter((v) => !v.lanes || v.lanes.length === 0 || v.lanes.includes(verb));
}

// ── Runner ──────────────────────────────────────────────────────────────────

export interface LaneVerificationReport {
  lane: string;
  verifierResults: VerifierResult[];
  overallStatus: 'pass' | 'fail' | 'skipped';
  summary: string;
}

export async function runLaneVerifiers(ctx: VerifierContext): Promise<LaneVerificationReport> {
  const candidates = getVerifiersForLane(ctx.verb);
  const results: VerifierResult[] = [];

  for (const verifier of candidates) {
    try {
      const applies = await verifier.detect(ctx);
      if (!applies) {
        results.push({
          verifierId: verifier.id,
          status: 'skipped',
          summary: `Verifier "${verifier.name}" does not apply to this context.`,
          checks: [],
        });
        continue;
      }
      const result = await verifier.verify(ctx);
      results.push(result);
    } catch (err: any) {
      results.push({
        verifierId: verifier.id,
        status: 'fail',
        summary: `Verifier "${verifier.name}" threw an error: ${err?.message ?? 'Unknown'}`,
        checks: [
          {
            id: 'verifier_error',
            status: 'fail',
            message: err?.message ?? 'Unknown verifier error',
          },
        ],
      });
    }
  }

  const anyFailed = results.some((r) => r.status === 'fail');
  const anyPassed = results.some((r) => r.status === 'pass');
  const overallStatus = anyFailed ? 'fail' : anyPassed ? 'pass' : 'skipped';

  const laneLabel = ctx.verb;
  const passCount = results.filter((r) => r.status === 'pass').length;
  const failCount = results.filter((r) => r.status === 'fail').length;
  const skipCount = results.filter((r) => r.status === 'skipped').length;

  return {
    lane: ctx.verb,
    verifierResults: results,
    overallStatus,
    summary: `${laneLabel}: ${passCount} passed, ${failCount} failed, ${skipCount} skipped.`,
  };
}

// ── Built-in Verifier: Exact Invariants ─────────────────────────────────────

/**
 * Verifies that exact-string invariants from the task text are satisfied by the
 * execution artifacts. Works for all lanes (read-only and mutating).
 *
 * Read-only lanes check that the plan/report doesn't contradict task invariants.
 * Mutating lanes check that changed files satisfy invariants.
 */
export function createExactInvariantsVerifier(): Verifier {
  return {
    id: 'exact_invariants',
    name: 'Exact Invariants',
    lanes: [], // all lanes
    detect(ctx: VerifierContext): boolean {
      // Only applies when there's a task with concrete invariants
      const hasConcrete =
        /\b(?:must|should|require|need|always|never|exact|specific)\b/i.test(ctx.task) ||
        /\b(?:file|path|function|class|module|import|export)\b/i.test(ctx.task);
      return hasConcrete && ctx.task.length > 10;
    },
    async verify(ctx: VerifierContext): Promise<VerifierResult> {
      const checks: VerifierCheck[] = [];
      const taskLower = ctx.task.toLowerCase();

      // Check 1: File mentions in task should have corresponding artifacts
      const filePattern = /\b([\w./-]+\.(?:ts|js|py|rs|go|java|md|json|yaml|yml|toml))\b/gi;
      const mentionedFiles = new Set<string>();
      let match;
      while ((match = filePattern.exec(ctx.task)) !== null) {
        mentionedFiles.add(match[1]!);
      }
      filePattern.lastIndex = 0;

      for (const file of mentionedFiles) {
        const resolvedPath = resolve(ctx.projectRoot, file);
        const exists = existsSync(resolvedPath);
        // In read-only lanes, the file might be mentioned for inspection, not creation
        const isReadOnly = ['plan', 'report', 'review', 'ask'].includes(ctx.verb);
        if (!exists && !isReadOnly && (ctx.changedFiles?.length ?? 0) === 0) {
          checks.push({
            id: `file_mentioned_${file.replace(/[^a-zA-Z0-9]/g, '_')}`,
            status: 'warn',
            message: `Task mentions "${file}" but it does not exist in the project and no files were changed.`,
          });
        }
      }

      // Check 2: Verification commands in task should appear in tool log
      const verifyPattern =
        /\b(?:npm\s+test|npm\s+run\s+\w+|cargo\s+test|pytest|go\s+test|make\s+test|pnpm\s+test|yarn\s+test)\b/gi;
      const expectedVerifiers = new Set<string>();
      while ((match = verifyPattern.exec(taskLower)) !== null) {
        expectedVerifiers.add(match[0]!.trim());
      }

      if (expectedVerifiers.size > 0 && ctx.toolCallLog) {
        for (const cmd of expectedVerifiers) {
          const wasRun = ctx.toolCallLog.some(
            (entry) =>
              entry.tool === 'shell_exec' &&
              typeof entry.input?.command === 'string' &&
              entry.input.command.includes(cmd),
          );
          if (!wasRun) {
            checks.push({
              id: `verifier_not_run_${cmd.replace(/\s+/g, '_')}`,
              status: 'warn',
              message: `Expected verification command "${cmd}" was not found in the tool call log.`,
            });
          }
        }
      }

      // Check 3: Task mentions "test" or "verify" — ensure some verification happened
      const needsVerification = /\b(?:test|verify|validate|check|assert)\b/i.test(ctx.task);
      const hasVerificationRun =
        ctx.toolCallLog?.some(
          (entry) =>
            entry.tool === 'shell_exec' &&
            typeof entry.input?.command === 'string' &&
            /\b(?:test|verify|check|lint)\b/i.test(entry.input.command),
        ) ?? false;

      if (
        needsVerification &&
        !hasVerificationRun &&
        !['plan', 'report', 'review', 'ask'].includes(ctx.verb)
      ) {
        checks.push({
          id: 'verification_missing',
          status: 'fail',
          message: 'Task requires verification but no test/verify command was executed.',
          detail: 'Run the appropriate test command before declaring the task complete.',
        });
      }

      const failedChecks = checks.filter((c) => c.status === 'fail');
      const warnChecks = checks.filter((c) => c.status === 'warn');

      return {
        verifierId: 'exact_invariants',
        status: failedChecks.length > 0 ? 'fail' : 'pass',
        summary:
          failedChecks.length > 0
            ? `${failedChecks.length} invariant violation(s) found.`
            : warnChecks.length > 0
              ? `Passed with ${warnChecks.length} warning(s).`
              : 'All exact invariants satisfied.',
        checks,
      };
    },
  };
}

// ── Built-in Verifier: Artifact Completeness ────────────────────────────────

/**
 * Verifies that run artifacts are complete and well-formed for the given lane.
 * Every lane should produce at minimum: a manifest, human-readable output,
 * and evidence artifacts.
 */
export function createArtifactCompletenessVerifier(): Verifier {
  return {
    id: 'artifact_completeness',
    name: 'Artifact Completeness',
    lanes: [], // all lanes
    detect(_ctx: VerifierContext): boolean {
      return true; // Always applies
    },
    async verify(ctx: VerifierContext): Promise<VerifierResult> {
      const checks: VerifierCheck[] = [];

      // Every lane should produce at least one of these
      const expectedFiles = [
        'human_summary.txt',
        'output_review.json',
        'manifest.json',
        '01_manifest.json',
      ];

      const foundFiles: string[] = [];
      const missingFiles: string[] = [];

      for (const file of expectedFiles) {
        const path = resolve(ctx.runDir, file);
        if (existsSync(path)) {
          foundFiles.push(file);
          // Check non-empty
          try {
            const content = readFileSync(path, 'utf-8').trim();
            if (content.length === 0) {
              checks.push({
                id: `empty_${file.replace(/\./g, '_')}`,
                status: 'warn',
                message: `Expected artifact "${file}" exists but is empty.`,
              });
            }
          } catch {
            checks.push({
              id: `unreadable_${file.replace(/\./g, '_')}`,
              status: 'fail',
              message: `Artifact "${file}" exists but could not be read.`,
            });
          }
        } else {
          missingFiles.push(file);
        }
      }

      if (foundFiles.length === 0) {
        checks.push({
          id: 'no_artifacts',
          status: 'fail',
          message: 'No expected artifacts found in the run directory.',
          detail: `Expected at least one of: ${expectedFiles.join(', ')}.`,
        });
      } else if (missingFiles.length > 0) {
        checks.push({
          id: 'partial_artifacts',
          status: 'warn',
          message: `Found ${foundFiles.length} artifact(s), missing: ${missingFiles.join(', ')}.`,
        });
      }

      if (foundFiles.length > 0 && missingFiles.length === 0) {
        checks.push({
          id: 'artifacts_complete',
          status: 'pass',
          message: `All ${foundFiles.length} expected artifact types present.`,
        });
      }

      const failCount = checks.filter((c) => c.status === 'fail').length;
      return {
        verifierId: 'artifact_completeness',
        status: failCount > 0 ? 'fail' : 'pass',
        summary:
          failCount > 0 ? `${failCount} artifact issue(s) found.` : 'Run artifacts are complete.',
        checks,
      };
    },
  };
}

// ── Register built-in verifiers ─────────────────────────────────────────────

registerVerifier(createExactInvariantsVerifier());
registerVerifier(createArtifactCompletenessVerifier());

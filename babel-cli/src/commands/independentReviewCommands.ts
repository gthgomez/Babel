import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import { Command } from 'commander';

import {
  runIndependentReviewBroker,
  type IndependentReviewCandidate,
  type IndependentReviewProvider,
  type IndependentReviewVerdict,
} from '../services/independentReviewBroker.js';
import {
  resolveLivePullRequestCandidate,
} from '../services/independentReviewProvider.js';
import {
  createProcessAttestationSigner,
  createProcessTrustedReviewIssuer,
  createProcessTrustedReviewVerifier,
  type JsonServiceCommand,
} from '../services/reviewServiceTransport.js';
import { collectCandidateEnvelope } from '../services/candidateCollector.js';
import {
  evaluateMergeReadiness,
  type CodeReviewReceipt,
  type RemoteCICheckObservation,
} from '../services/mergeReadinessBroker.js';
import { CANONICAL_BENCHMARK_FIXTURES, verifyFixtureAntiLeakage } from '../services/babelBench.js';
import {
  collectGitHubPRState,
  adjudicateCandidateReview,
  saveAdjudicatedOutcome,
} from '../services/outcomeCollector.js';
import type {
  AutonomousReviewEvidenceV2,
  HostReviewHandoffV2,
} from '../services/hostReviewController.js';
import {
  createStructuredFinding,
  parseFindingFromModelClaim,
} from '../services/structuredFinding.js';
import { evaluateReviewCoverage, type ToolExecutionTrace } from '../services/reviewCoverage.js';
import { evaluateReviewerIndependence } from '../services/reviewIndependence.js';

export function loadCandidateReviewHandoffs(options: {
  repository: string;
  prNumber?: number;
  candidateDigest: string;
  stateDir?: string;
  ghExec?: (args: string[]) => string;
}): HostReviewHandoffV2[] {
  const handoffs: HostReviewHandoffV2[] = [];
  const candidateDigest = options.candidateDigest;

  const stateDir = options.stateDir ?? process.env['BABEL_REVIEW_STATE_DIR'];
  if (stateDir) {
    const jobDir = join(resolve(stateDir), 'jobs', candidateDigest);
    if (existsSync(jobDir)) {
      try {
        const files = readdirSync(jobDir);
        for (const file of files) {
          if (file.endsWith('-handoff.json')) {
            try {
              const content = JSON.parse(readFileSync(join(jobDir, file), 'utf8')) as HostReviewHandoffV2;
              if (content.kind === 'host_review_handoff_v2' && Array.isArray(content.reviews)) {
                handoffs.push(content);
              }
            } catch {
              // ignore
            }
          }
        }
      } catch {
        // ignore
      }
    }
  }

  if (options.prNumber) {
    const runner = options.ghExec ?? ((args: string[]) =>
      execFileSync('gh', args, {
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      })
    );
    try {
      let ownerId: number | undefined;
      let ownerLogin: string | undefined;
      try {
        const repoRaw = runner(['api', `repos/${options.repository}`]);
        const repoInfo = JSON.parse(repoRaw) as { owner?: { id?: number; login?: string } };
        ownerId = repoInfo.owner?.id;
        ownerLogin = repoInfo.owner?.login;
      } catch {
        // Repo lookup may fail in offline or mocked tests
      }

      const raw = runner(['api', `repos/${options.repository}/issues/${options.prNumber}/comments`]);
      const comments = JSON.parse(raw) as Array<{ body?: string; user?: { id?: number; login?: string } }>;
      const marker = '<!-- babel-controller-ai-reviews-v2 -->';
      for (const comment of comments) {
        if (ownerId !== undefined && comment.user?.id !== ownerId && ownerLogin && comment.user?.login !== ownerLogin) {
          continue;
        }
        if (typeof comment.body === 'string' && comment.body.startsWith(marker)) {
          try {
            const parsed = JSON.parse(comment.body.slice(marker.length)) as unknown;
            if (Array.isArray(parsed)) {
              for (const item of parsed) {
                if ((item as HostReviewHandoffV2)?.kind === 'host_review_handoff_v2') {
                  handoffs.push(item as HostReviewHandoffV2);
                }
              }
            } else if ((parsed as HostReviewHandoffV2)?.kind === 'host_review_handoff_v2') {
              handoffs.push(parsed as HostReviewHandoffV2);
            }
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // Non-fatal if GitHub is unreachable
    }
  }

  return handoffs;
}

export function handoffEvidenceToCodeReviewReceipt(
  review: AutonomousReviewEvidenceV2,
  candidateDigest: string,
): CodeReviewReceipt {
  const structuredFindings = review.findings.map((claim) => {
    const parsed = parseFindingFromModelClaim(claim, review.scope);
    return createStructuredFinding({
      candidateDigest,
      executionId: review.execution_id,
      reviewerId: review.reviewer_id,
      category: parsed.category,
      severity: review.blocking_findings.includes(claim) ? 'P1' : 'P2',
      path: parsed.path,
      ...(parsed.line !== undefined ? { line: parsed.line } : {}),
      ...(parsed.end_line !== undefined ? { end_line: parsed.end_line } : {}),
      claim,
      recommended_blocking: review.blocking_findings.includes(claim),
    });
  });

  const blockingFindings = review.blocking_findings.map((claim) => {
    const parsed = parseFindingFromModelClaim(claim, review.scope);
    return createStructuredFinding({
      candidateDigest,
      executionId: review.execution_id,
      reviewerId: review.reviewer_id,
      category: parsed.category,
      severity: 'P1',
      path: parsed.path,
      ...(parsed.line !== undefined ? { line: parsed.line } : {}),
      ...(parsed.end_line !== undefined ? { end_line: parsed.end_line } : {}),
      claim,
      recommended_blocking: true,
      policy_blocking: true,
    });
  });

  const isolation = review.isolation;
  const hasSandboxedProcess = Boolean(
    isolation && (isolation.mode === 'readonly_sandbox' || isolation.mode === 'text_only_no_tools')
  );
  const isReadOnly = Boolean(
    isolation &&
      isolation.candidate_write === false &&
      isolation.github_mutation === false &&
      isolation.merge === false &&
      isolation.controller_state_access === false
  );
  const isControllerIsolated = Boolean(
    isolation && isolation.controller_state_access === false
  );
  const isFreshContext = Boolean(review.execution_id && isReadOnly);

  const independence = evaluateReviewerIndependence({
    fresh_context: isFreshContext,
    fresh_process: hasSandboxedProcess,
    read_only_capability: isReadOnly,
    controller_state_isolated: isControllerIsolated,
    builder_identity: review.builder_id,
    reviewer_identity: review.reviewer_id,
    reviewer_model: review.reviewer_model,
    reviewer_provider: review.review_provider,
    trusted_harness: Boolean(review.harness?.source_sha && review.harness?.version),
    trusted_source_sha: review.harness?.source_sha ?? '0'.repeat(40),
    installation_digest: review.harness?.version ?? '0'.repeat(64),
    session_id: review.execution_id,
    sandbox_profile: isolation?.mode,
  });

  const toolTraces = ((review as { tool_traces?: ToolExecutionTrace[] }).tool_traces ??
    (review as { calls?: ToolExecutionTrace[] }).calls ??
    []) as ToolExecutionTrace[];

  const coverage = evaluateReviewCoverage({
    scope: review.scope,
    toolTraces,
    claimedReviewedFiles: review.scope,
    ...((review as { changes_diff_fully_read?: boolean }).changes_diff_fully_read !== undefined
      ? { changesDiffFullyRead: (review as { changes_diff_fully_read?: boolean }).changes_diff_fully_read }
      : {}),
  });

  return {
    schema_version: 2,
    receipt_id: review.execution_id,
    candidate_digest: candidateDigest,
    head_sha: review.head_sha,
    verdict: review.verdict === 'APPROVE' ? 'APPROVE' : 'BLOCK',
    reviewer_id: review.reviewer_id,
    reviewer_model: review.reviewer_model,
    independence,
    coverage,
    findings: structuredFindings,
    blocking_findings: blockingFindings,
    certified_at: review.reviewed_at,
    receipt_hash: createHash('sha256').update(JSON.stringify(review)).digest('hex'),
  };
}

function readJson<T>(filePath: string): T {
  try {
    return JSON.parse(readFileSync(resolve(filePath), 'utf8')) as T;
  } catch (error) {
    throw new Error(`Unable to read JSON fixture ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function configuredService(name: string): JsonServiceCommand | undefined {
  const command = process.env[name]?.trim();
  if (!command) return undefined;
  const argsName = `${name}_ARGS`;
  const rawArgs = process.env[argsName]?.trim();
  if (!rawArgs) return { command };
  try {
    const args = JSON.parse(rawArgs) as unknown;
    if (!Array.isArray(args) || args.some((entry) => typeof entry !== 'string')) throw new Error('args');
    return { command, args };
  } catch {
    throw new Error(`${argsName} must be a JSON array of strings.`);
  }
}

/**
 * Shell exit code for `babel review certify`.
 *
 * Invariant: exit 0 means the command achieved the requested trusted success
 * state (CERTIFIED) — never merely that the state machine executed without
 * crashing. A rejected review, a configuration blocker, or a receipt awaiting
 * verification must all exit nonzero so shell automation can never mistake a
 * rejected review for success.
 *
 * Taxonomy: 0 certified · 2 repair required (reviewer rejected the candidate)
 * · 3 configuration/external blocker · 4 verification or certification-
 * lifecycle failure · 1 unknown non-certified terminal state (fail closed).
 */
export function resolveReviewCertifyExitCode(status: string): number {
  switch (status) {
    case 'CERTIFIED':
      return 0;
    case 'REPAIR_REQUIRED':
      return 2;
    case 'REVIEWER_CONFIGURATION_REQUIRED':
    case 'REVIEW_ORCHESTRATOR_REQUIRED':
    case 'ISSUER_CONFIGURATION_REQUIRED':
    case 'SUPERVISOR_CONFIGURATION_REQUIRED':
    case 'STOPPED_EXTERNAL_CAPABILITY':
    case 'STOPPED_AMBIGUOUS_OBJECTIVE':
      return 3;
    case 'CERTIFICATION_RETRY_REQUIRED':
    case 'READY_FOR_TRUST_VERIFICATION':
      return 4;
    default:
      return 1;
  }
}

/** Register review certification. Trusted issuer custody is intentionally not a CLI option. */
export function registerIndependentReviewCommands(program: Command): void {
  const review = new Command('review').description('Run independent review and trusted certification workflows');
  review
    .command('certify')
    .description('Review an exact candidate, then hand PASS to a trusted issuer')
    .option('--pr <number>', 'Resolve the live PR and exact immutable base/head')
    .option('--candidate <path>', 'Test-only JSON candidate fixture; production uses --pr')
    .option('--review-result <path>', 'Read-only reviewer JSON fixture for deterministic local testing')
    .option('--state-dir <dir>', 'Directory containing review job receipts')
    .option('--json', 'Emit structured JSON only')
    .action(async (options: { pr?: string; candidate?: string; reviewResult?: string; stateDir?: string; json?: boolean }) => {
      if (!options.pr && !options.candidate) throw new Error('Provide --pr <number> for live certification or --candidate only for fixture testing.');
      const projectRoot = process.env['BABEL_PROJECT_ROOT'] ?? process.cwd();

      let candidate: IndependentReviewCandidate;
      let candidateDigest = '';

      if (options.pr) {
        const envelope = await collectCandidateEnvelope({
          repoRoot: projectRoot,
          pr: Number(options.pr),
        });
        candidateDigest = envelope.candidate_digest;
        candidate = {
          repository: envelope.repository,
          ...(envelope.pr_number !== undefined ? { pr_number: envelope.pr_number } : {}),
          task_id: envelope.task_id,
          run_id: `review-${Date.now()}-${envelope.pr_number ?? 'local'}`,
          contract_hash: envelope.task_contract_hash ?? envelope.candidate_digest,
          base_sha: envelope.base_sha,
          head_sha: envelope.head_sha,
          builder_id: envelope.builder_id,
          reviewed_scope: { kind: 'files', paths: envelope.scope },
        };
      } else {
        candidate = readJson<IndependentReviewCandidate>(options.candidate as string);
        candidateDigest = createHash('sha256').update(JSON.stringify(candidate)).digest('hex');
      }

      const provenanceSigner = configuredService('BABEL_REVIEW_PROVENANCE_SIGNER');
      const trustedIssuer = configuredService('BABEL_TRUSTED_REVIEW_ISSUER');
      const trustedVerifier = configuredService('BABEL_TRUSTED_REVIEW_VERIFIER');

      let provider: IndependentReviewProvider | undefined;
      if (options.reviewResult) {
        provider = {
          review: async () => readJson<IndependentReviewVerdict>(options.reviewResult as string),
        };
      } else if (options.pr) {
        const handoffs = loadCandidateReviewHandoffs({
          repository: candidate.repository,
          candidateDigest,
          ...(candidate.pr_number !== undefined ? { prNumber: candidate.pr_number } : {}),
          ...(options.stateDir !== undefined ? { stateDir: options.stateDir } : {}),
        });
        if (handoffs.length > 0) {
          const allReviews = handoffs.flatMap((h) => h.reviews);
          if (allReviews.length > 0) {
            const hasBlock = allReviews.some((r) => r.verdict === 'BLOCK');
            const allBlocking = Array.from(new Set(allReviews.flatMap((r) => r.blocking_findings)));
            const allNonBlocking = Array.from(
              new Set(allReviews.flatMap((r) => r.findings.filter((f) => !r.blocking_findings.includes(f))))
            );
            const primary = allReviews[0]!;
            provider = {
              review: async () => ({
                repository: primary.repository,
                ...(primary.pr_number !== undefined ? { pr_number: primary.pr_number } : {}),
                base_sha: primary.base_sha,
                head_sha: primary.head_sha,
                builder_identity: primary.builder_id,
                reviewer_identity: primary.reviewer_id,
                reviewer_model: primary.reviewer_model,
                review_provider: primary.review_provider,
                review_mode: 'independent-read-only',
                verdict: hasBlock ? 'FAIL' : 'PASS',
                blocking_findings: allBlocking,
                non_blocking_findings: allNonBlocking,
                tests_considered: [],
                reviewed_at: primary.reviewed_at,
              }),
            };
          } else {
            provider = undefined;
          }
        } else {
          provider = undefined;
        }
      }

      const result = await runIndependentReviewBroker({
        candidate,
        ...(provider ? { provider } : {}),
        ...(trustedIssuer ? { issuer: createProcessTrustedReviewIssuer(trustedIssuer) } : {}),
        ...(trustedVerifier ? { verifier: createProcessTrustedReviewVerifier(trustedVerifier) } : {}),
      });

      if (options.json === true) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } else {
        process.stdout.write(`Independent review: ${result.status}\n`);
        if (result.blocker) process.stdout.write(`Blocker: ${result.blocker}\n`);
        if (result.verdict) process.stdout.write(`Reviewer verdict: ${result.verdict.verdict}\n`);
        for (const next of result.next) process.stdout.write(`Next: ${next}\n`);
      }
      process.exitCode = resolveReviewCertifyExitCode(result.status);
    });

  review
    .command('collect')
    .description('Collect canonical CandidateEnvelope for a local target, range, or PR')
    .option('--repo-root <dir>', 'Repository root directory')
    .option('--pr <number>', 'Pull request number')
    .option('--range <range>', 'Git revision range (e.g. A...B)')
    .option('--staged', 'Collect staged changes only')
    .option('--json', 'Emit structured CandidateEnvelope JSON')
    .action(async (options: { repoRoot?: string; pr?: string; range?: string; staged?: boolean; json?: boolean }) => {
      const envelope = await collectCandidateEnvelope({
        repoRoot: options.repoRoot,
        pr: options.pr ? Number(options.pr) : undefined,
        range: options.range,
        staged: options.staged,
      });
      if (options.json !== false) {
        process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
      } else {
        process.stdout.write(`Candidate: ${envelope.repository}\n`);
        process.stdout.write(`Digest: ${envelope.candidate_digest}\n`);
        process.stdout.write(`Risk tier: ${envelope.risk_tier} | Trust mode: ${envelope.trust_mode}\n`);
        process.stdout.write(`Scope (${envelope.scope.length} files):\n`);
        for (const file of envelope.scope) process.stdout.write(`  - ${file}\n`);
      }
    });

  review
    .command('readiness')
    .description('Evaluate multi-gate merge readiness for an exact candidate head')
    .option('--repo-root <dir>', 'Repository root directory')
    .option('--pr <number>', 'Pull request number')
    .option('--state-dir <dir>', 'State directory containing review job receipts')
    .option('--json', 'Emit structured MergeReadinessReceipt JSON')
    .action(async (options: { repoRoot?: string; pr?: string; stateDir?: string; json?: boolean }) => {
      const envelope = await collectCandidateEnvelope({
        repoRoot: options.repoRoot,
        pr: options.pr ? Number(options.pr) : undefined,
      });

      const reviews: CodeReviewReceipt[] = [];
      let remoteCI: RemoteCICheckObservation[] | undefined;

      if (options.pr) {
        const prNumber = Number(options.pr);
        try {
          const prState = collectGitHubPRState(envelope.repository, prNumber);
          remoteCI = prState.checks.map((c) => ({
            name: c.name,
            head_sha: prState.head_sha,
            status: c.status,
            conclusion: c.conclusion,
          }));
        } catch {
          // Non-fatal if GitHub is unreachable
        }

        const handoffs = loadCandidateReviewHandoffs({
          repository: envelope.repository,
          candidateDigest: envelope.candidate_digest,
          prNumber,
          ...(options.stateDir !== undefined ? { stateDir: options.stateDir } : {}),
        });

        for (const handoff of handoffs) {
          for (const rev of handoff.reviews) {
            reviews.push(handoffEvidenceToCodeReviewReceipt(rev, envelope.candidate_digest));
          }
        }
      }

      const readiness = evaluateMergeReadiness({
        candidate: envelope,
        reviews,
        ...(remoteCI ? { remoteCIChecks: remoteCI } : {}),
      });

      if (options.json !== false) {
        process.stdout.write(`${JSON.stringify(readiness, null, 2)}\n`);
      } else {
        process.stdout.write(`Merge readiness: ${readiness.verdict}\n`);
        process.stdout.write(`Head: ${readiness.head_sha}\n`);
        if (readiness.unresolved_blockers.length > 0) {
          process.stdout.write(`Blockers:\n`);
          for (const b of readiness.unresolved_blockers) process.stdout.write(`  - ${b}\n`);
        }
      }
      process.exitCode = readiness.verdict === 'READY' ? 0 : 2;
    });

  review
    .command('bench')
    .description('Inspect or verify BabelBench autonomous review benchmark dataset')
    .option('--split <split>', 'Filter fixtures by split (dev|holdout|canary)')
    .option('--json', 'Emit structured JSON output')
    .action((options: { split?: string; json?: boolean }) => {
      const antiLeakageValid = verifyFixtureAntiLeakage();
      const fixtures = options.split
        ? CANONICAL_BENCHMARK_FIXTURES.filter((f) => f.split === options.split)
        : CANONICAL_BENCHMARK_FIXTURES;

      const summary = {
        total_fixtures: fixtures.length,
        anti_leakage_verified: antiLeakageValid,
        splits: {
          dev: fixtures.filter((f) => f.split === 'dev').length,
          holdout: fixtures.filter((f) => f.split === 'holdout').length,
          canary: fixtures.filter((f) => f.split === 'canary').length,
        },
        categories: {
          correctness: fixtures.filter((f) => f.category === 'correctness').length,
          security: fixtures.filter((f) => f.category === 'security').length,
          concurrency: fixtures.filter((f) => f.category === 'concurrency').length,
          clean_control: fixtures.filter((f) => f.category === 'clean_control').length,
        },
        fixtures: fixtures.map((f) => ({
          id: f.id,
          name: f.name,
          category: f.category,
          split: f.split,
          difficulty: f.difficulty,
          expected_verdict: f.groundTruth.expectedVerdict,
        })),
      };

      if (options.json !== false) {
        process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      } else {
        process.stdout.write(`BabelBench: ${summary.total_fixtures} fixtures | Anti-leakage: ${antiLeakageValid ? 'PASS' : 'FAIL'}\n`);
        process.stdout.write(`Splits: dev=${summary.splits.dev}, holdout=${summary.splits.holdout}, canary=${summary.splits.canary}\n`);
        process.stdout.write(`Controls: ${summary.categories.clean_control} | Defects: ${summary.total_fixtures - summary.categories.clean_control}\n`);
      }
      process.exitCode = antiLeakageValid ? 0 : 1;
    });

  review
    .command('adjudicate')
    .description('Adjudicate candidate PR review against observed GitHub and git outcomes')
    .requiredOption('--repo <slug>', 'Repository slug (e.g. gthgomez/Babel)')
    .requiredOption('--pr <number>', 'Pull request number')
    .option('--repo-root <dir>', 'Repository root directory')
    .option('--state-dir <dir>', 'Directory for review state outcomes')
    .option('--json', 'Emit structured JSON output')
    .action(async (options: { repo: string; pr: string; repoRoot?: string; stateDir?: string; json?: boolean }) => {
      const prNumber = Number(options.pr);
      let prState;
      try {
        prState = collectGitHubPRState(options.repo, prNumber);
      } catch (err) {
        if (options.json !== false) {
          process.stdout.write(`${JSON.stringify({
            status: 'UNAVAILABLE',
            error: err instanceof Error ? err.message : String(err),
          }, null, 2)}\n`);
        } else {
          process.stderr.write(`Failed to collect GitHub PR state: ${err instanceof Error ? err.message : String(err)}\n`);
        }
        process.exitCode = 3;
        return;
      }

      let candidateDigest = '0'.repeat(64);
      try {
        const envelope = await collectCandidateEnvelope({
          repoRoot: options.repoRoot ?? process.cwd(),
          pr: prNumber,
          repository: options.repo,
        });
        candidateDigest = envelope.candidate_digest;
      } catch {
        candidateDigest = createHash('sha256')
          .update(JSON.stringify([options.repo, prNumber, prState.head_sha]))
          .digest('hex');
      }

      const handoffs = loadCandidateReviewHandoffs({
        repository: options.repo,
        candidateDigest,
        prNumber,
        ...(options.stateDir !== undefined ? { stateDir: options.stateDir } : {}),
      });

      const allReviews = handoffs.flatMap((h) => h.reviews);
      const outcome = adjudicateCandidateReview({
        candidateDigest,
        prState,
        handoff: allReviews.length > 0 ? {
          reviews: allReviews.map((r) => ({
            reviewer_id: r.reviewer_id,
            reviewer_model: r.reviewer_model,
            verdict: r.verdict,
            blocking_findings: r.blocking_findings,
          })),
        } : undefined,
      });

      if (options.stateDir) {
        saveAdjudicatedOutcome(options.stateDir, outcome);
      }

      if (options.json !== false) {
        process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
      } else {
        process.stdout.write(`Adjudication Outcome: ${outcome.outcome_id}\n`);
        process.stdout.write(`PR state: ${outcome.observed_state.state} | CI: ${outcome.observed_state.overall_ci_verdict}\n`);
        process.stdout.write(`Precision: ${outcome.flywheel_metrics.precision ?? 'N/A'} | Recall: ${outcome.flywheel_metrics.recall ?? 'N/A'}\n`);
      }
    });

  program.addCommand(review);
}

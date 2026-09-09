import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Command } from 'commander';

import {
  runIndependentReviewBroker,
  type IndependentReviewCandidate,
  type IndependentReviewVerdict,
} from '../services/independentReviewBroker.js';
import {
  createLiveIndependentReviewProvider,
  resolveLivePullRequestCandidate,
} from '../services/independentReviewProvider.js';
import {
  createProcessAttestationSigner,
  createProcessTrustedReviewIssuer,
  createProcessTrustedReviewVerifier,
  type JsonServiceCommand,
} from '../services/reviewServiceTransport.js';
import { collectCandidateEnvelope } from '../services/candidateCollector.js';
import { evaluateMergeReadiness } from '../services/mergeReadinessBroker.js';
import { CANONICAL_BENCHMARK_FIXTURES, verifyFixtureAntiLeakage } from '../services/babelBench.js';
import { collectGitHubPRState, adjudicateCandidateReview, saveAdjudicatedOutcome } from '../services/outcomeCollector.js';

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
    .option('--json', 'Emit structured JSON only')
    .action(async (options: { pr?: string; candidate?: string; reviewResult?: string; json?: boolean }) => {
      if (!options.pr && !options.candidate) throw new Error('Provide --pr <number> for live certification or --candidate only for fixture testing.');
      const projectRoot = process.env['BABEL_PROJECT_ROOT'] ?? process.cwd();
      const candidate = options.pr
        ? await resolveLivePullRequestCandidate(projectRoot, Number(options.pr))
        : readJson<IndependentReviewCandidate>(options.candidate as string);
      const provenanceSigner = configuredService('BABEL_REVIEW_PROVENANCE_SIGNER');
      const trustedIssuer = configuredService('BABEL_TRUSTED_REVIEW_ISSUER');
      const trustedVerifier = configuredService('BABEL_TRUSTED_REVIEW_VERIFIER');
      const provider = options.reviewResult
        ? {
            review: async () => readJson<IndependentReviewVerdict>(options.reviewResult as string),
          }
        : options.pr
          ? createLiveIndependentReviewProvider({
              projectRoot,
              ...(provenanceSigner ? { signAttestation: createProcessAttestationSigner(provenanceSigner) } : {}),
            })
          : undefined;
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
    .option('--json', 'Emit structured MergeReadinessReceipt JSON')
    .action(async (options: { repoRoot?: string; pr?: string; json?: boolean }) => {
      const envelope = await collectCandidateEnvelope({
        repoRoot: options.repoRoot,
        pr: options.pr ? Number(options.pr) : undefined,
      });
      const readiness = evaluateMergeReadiness({
        candidate: envelope,
        reviews: [],
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
    .option('--state-dir <dir>', 'Directory for review state outcomes')
    .option('--json', 'Emit structured JSON output')
    .action((options: { repo: string; pr: string; stateDir?: string; json?: boolean }) => {
      const prState = collectGitHubPRState(options.repo, Number(options.pr));
      const outcome = adjudicateCandidateReview({
        candidateDigest: '0'.repeat(64),
        prState,
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

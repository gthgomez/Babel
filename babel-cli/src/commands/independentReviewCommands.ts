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
      process.exitCode = result.status === 'CERTIFIED' || result.status === 'REPAIR_REQUIRED' ? 0 : 1;
    });
  program.addCommand(review);
}

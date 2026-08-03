/**
 * Slice 7 CLI: run a small-N live causal canary (product arm only) and write an
 * improvement ledger — not a vanity pass% scoreboard.
 *
 * Usage:
 *   npx tsx scripts/run_causal_live_canary.ts --i-authorize-live-spend
 *   npx tsx scripts/run_causal_live_canary.ts --i-authorize-live-spend --dataset <path> --limit 1
 *
 * Requires explicit --i-authorize-live-spend (refuses otherwise). Never prints keys.
 */
import { config as dotenvConfig } from 'dotenv';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LIVE_CANARY_PLAN,
  LIVE_SPEND_AUTHORIZE_FLAG,
  analyzeLiveEvidenceDir,
  buildLiveCanaryPlan,
  checkLiveSpendAuthorization,
  writeImprovementLedger,
  writeLiveCanaryPlan,
} from '../src/services/causalLiveEvidence.js';
import {
  defaultSweProDatasetPath,
  resolveSweProDatasetPath,
  runSwebenchProCampaign,
} from '../src/services/swebenchProCampaign.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(packageRoot, '..');
// Load secrets for live provider — never log .env contents.
dotenvConfig({ path: join(packageRoot, '.env'), override: true, quiet: true });

function resolveOperatorPath(value: string): string {
  if (isAbsolute(value)) return value;
  const fromCwd = resolve(value);
  if (existsSync(fromCwd)) return fromCwd;
  return resolve(repositoryRoot, value);
}

function stamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  );
}

interface Opts {
  help: boolean;
  authorize: boolean;
  dataset: string;
  evidenceDir: string;
  limit: number;
  model: string;
  earlyStop: number;
  agentTimeoutMs: number;
  json: boolean;
}

function printHelp(): void {
  process.stdout.write(
    [
      'Usage: npx tsx scripts/run_causal_live_canary.ts --i-authorize-live-spend [options]',
      '',
      'Live causal canary (Slice 7): product arm only, small-N, improvement ledger.',
      'Refuses without --i-authorize-live-spend (API spend).',
      '',
      'Options:',
      `  ${LIVE_SPEND_AUTHORIZE_FLAG}  Required for live spend`,
      '  --dataset <path>            JSONL (default phase2-remeasure-2.jsonl if present)',
      '  --evidence-dir <path>       Evidence root (default runs/.../causal-live-<stamp>)',
      '  --limit <n>                 Instance limit (default 1)',
      '  --model <id>                Live model (default deepseek-v4-flash)',
      '  --early-stop <n>            Consecutive same-signature abort (default 5)',
      '  --agent-timeout-ms <n>      Agent timeout (default 1500000)',
      '  --json                      Print improvement ledger JSON summary only',
      '  --help                      This help',
      '',
    ].join('\n'),
  );
}

function parseArgs(argv: string[]): Opts {
  const opts: Opts = {
    help: false,
    authorize: false,
    dataset: '',
    evidenceDir: '',
    limit: LIVE_CANARY_PLAN.n_tasks,
    model: LIVE_CANARY_PLAN.model,
    earlyStop: LIVE_CANARY_PLAN.early_stop,
    agentTimeoutMs: LIVE_CANARY_PLAN.agent_timeout_ms,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === LIVE_SPEND_AUTHORIZE_FLAG) opts.authorize = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--dataset') opts.dataset = String(argv[++i] ?? '');
    else if (a === '--evidence-dir') opts.evidenceDir = String(argv[++i] ?? '');
    else if (a === '--limit') opts.limit = Number(argv[++i]);
    else if (a === '--model') opts.model = String(argv[++i] ?? LIVE_CANARY_PLAN.model);
    else if (a === '--early-stop') opts.earlyStop = Number(argv[++i]);
    else if (a === '--agent-timeout-ms') opts.agentTimeoutMs = Number(argv[++i]);
    else throw new Error(`Unknown arg: ${a}`);
  }
  return opts;
}

function defaultDatasetPath(): string {
  const phase2 = join(
    repositoryRoot,
    'benchmarks',
    'datasets',
    'swe-bench-pro',
    'phase2-remeasure-2.jsonl',
  );
  if (existsSync(phase2)) return phase2;
  return defaultSweProDatasetPath();
}

function printRedactedSummary(input: {
  evidenceDir: string;
  campaignId: string;
  liveCells: number;
  zeroPatch: number;
  topHypotheses: Array<{ rank: number; id: string; summary: string }>;
  aborted: boolean;
}): void {
  process.stdout.write(
    [
      '=== causal live canary (redacted) ===',
      `evidence_dir: ${input.evidenceDir}`,
      `campaign_id: ${input.campaignId}`,
      `live_cells: ${input.liveCells}`,
      `zero_patch_cells: ${input.zeroPatch}`,
      `aborted: ${input.aborted}`,
      'top_hypotheses:',
      ...input.topHypotheses.map((h) => `  ${h.rank}. ${h.id}: ${h.summary}`),
      '(keys/prompts omitted)',
      '',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const opts = parseArgs(argv);
  if (opts.help) {
    printHelp();
    return;
  }

  const refusal = checkLiveSpendAuthorization(argv);
  if (refusal) {
    process.stderr.write(`${refusal}\n`);
    process.exitCode = 2;
    return;
  }

  const explicitDataset = opts.dataset ? resolveOperatorPath(opts.dataset) : undefined;
  const datasetPath =
    resolveSweProDatasetPath(explicitDataset) ??
    (explicitDataset && existsSync(explicitDataset) ? explicitDataset : defaultDatasetPath());

  if (!existsSync(datasetPath)) {
    process.stderr.write(`Dataset missing: ${datasetPath}\n`);
    process.exitCode = 2;
    return;
  }

  const evidenceDir = opts.evidenceDir
    ? resolveOperatorPath(opts.evidenceDir)
    : join(
        repositoryRoot,
        'runs',
        'agent-benchmark',
        'swe-pro',
        `causal-live-${stamp()}`,
      );
  mkdirSync(evidenceDir, { recursive: true });

  const plan = buildLiveCanaryPlan({
    n_tasks: opts.limit,
    model: opts.model,
    early_stop: opts.earlyStop,
    agent_timeout_ms: opts.agentTimeoutMs,
  });
  writeLiveCanaryPlan(evidenceDir, plan);

  // Honest dual scoreboard for canaries: gold + host fail_to_pass both reported;
  // cell.status requires both under pass_mode=both (never gold-only default).
  process.env['BABEL_SWE_PRO_PASS_MODE'] = 'both';

  process.stdout.write(
    [
      'Starting live causal canary (authorized).',
      `  model: ${plan.plan.model}`,
      `  arms: ${plan.plan.arms_live.join(',')}`,
      `  n_tasks: ${plan.plan.n_tasks}`,
      `  agent_timeout_ms: ${plan.plan.agent_timeout_ms}`,
      `  pass_mode: both (dual-honest gold+ftp)`,
      `  evidence_dir: ${evidenceDir}`,
      `  dataset: ${datasetPath}`,
      '',
    ].join('\n'),
  );

  const report = await runSwebenchProCampaign({
    datasetPath,
    provider: 'live',
    instanceLimit: opts.limit,
    evidenceDir,
    model: opts.model,
    earlyStopN: opts.earlyStop,
    agentTimeoutMs: opts.agentTimeoutMs,
    causalArms: ['babel_enforce'],
    causalReplicates: LIVE_CANARY_PLAN.replicates,
  });

  const ledger = analyzeLiveEvidenceDir(evidenceDir);
  const written = writeImprovementLedger(evidenceDir, ledger);

  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          evidence_dir: evidenceDir,
          campaign_id: report.campaign_id,
          improvement_ledger: written.jsonPath,
          n: ledger.n,
          signatures_histogram: ledger.signatures_histogram,
          patch_bytes: ledger.patch_bytes,
          force_mutate_signals: ledger.force_mutate_signals,
          hypotheses: ledger.hypotheses.map((h) => ({
            rank: h.rank,
            id: h.id,
            severity: h.severity,
            summary: h.summary,
            supporting_cell_count: h.supporting_cell_count,
          })),
          uncertainty_note: ledger.uncertainty_note,
          aborted: Boolean(report.aborted),
        },
        null,
        2,
      )}\n`,
    );
  } else {
    printRedactedSummary({
      evidenceDir,
      campaignId: report.campaign_id,
      liveCells: ledger.n,
      zeroPatch: ledger.patch_bytes.zero_patch_cells,
      topHypotheses: ledger.hypotheses.slice(0, 5).map((h) => ({
        rank: h.rank,
        id: h.id,
        summary: h.summary,
      })),
      aborted: Boolean(report.aborted),
    });
    process.stdout.write(`improvement_ledger: ${written.jsonPath}\n`);
    process.stdout.write(`improvement_ledger_md: ${written.markdownPath}\n`);
  }

  if (report.aborted) process.exitCode = 2;
  else if (report.cells.some((c) => c.phase === 'live' && c.status === 'fail')) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  // Redact: message only, no stack dump of env.
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

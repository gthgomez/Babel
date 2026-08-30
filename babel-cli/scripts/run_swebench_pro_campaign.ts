/**
 * CLI: run SWE-Bench Pro campaign (infra dry-run + optional live agent cells).
 *
 * Usage:
 *   npx tsx scripts/run_swebench_pro_campaign.ts --infra-only --json
 *   npx tsx scripts/run_swebench_pro_campaign.ts --provider live --limit 5 --early-stop 5
 *   npx tsx scripts/run_swebench_pro_campaign.ts --help
 */
import { config as dotenvConfig } from 'dotenv';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  defaultSweProDatasetPath,
  formatCampaignReportHuman,
  resolveSweProDatasetPath,
  runSwebenchProCampaign,
} from '../src/services/swebenchProCampaign.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(packageRoot, '..');
dotenvConfig({ path: join(packageRoot, '.env'), override: true, quiet: true });

/** Resolve operator paths predictably when npm --prefix changes process.cwd(). */
function resolveOperatorPath(value: string): string {
  if (isAbsolute(value)) return value;
  const fromCwd = resolve(value);
  if (existsSync(fromCwd)) return fromCwd;
  return resolve(repositoryRoot, value);
}

interface Opts {
  help: boolean;
  json: boolean;
  provider: 'mock' | 'live';
  infraOnly: boolean;
  earlyStop: number;
  limit: number;
  dataset: string;
  evidenceDir: string;
  dockerPullK: number;
  model: string;
  agentTimeoutMs?: number;
  failToPassTimeoutMs?: number;
  heartbeatFile: string;
}

function printHelp(): void {
  process.stdout.write(
    [
      'Usage: npx tsx scripts/run_swebench_pro_campaign.ts [options]',
      '',
      'SWE-Bench Pro (Scale AI) campaign for Babel shadow scoreboard data.',
      'Infra phase is zero-token. Live phase early-stops after N identical failures.',
      '',
      'Options:',
      '  --infra-only          Checkout only (no LLM)',
      '  --provider mock|live  Default mock',
      '  --live                Alias for --provider live',
      '  --early-stop <n>      Consecutive same-signature fails before abort (default 5)',
      '  --limit <n>           Max instances (default: all in dataset)',
      '  --dataset <path>      JSONL path (or SWEBENCH_PRO_DATASET_PATH)',
      '  --evidence-dir <path> Evidence root',
      '  --docker-pull <k>     Pull first K dockerhub tags during infra (default 0)',
      '  --model <id>          Live model (default deepseek-v4-flash-openrouter)',
      '  --agent-timeout-ms <n> Agent timeout; 0 disables this deadline',
      '  --fail-to-pass-timeout-ms <n> Verifier timeout; 0 disables this deadline',
      '  --heartbeat-file <path> Redacted progress file for detached runs',
      '  --json                Structured JSON only',
      '  --help                This help',
      '',
      'Provision first:',
      '  node scripts/provision_swebench_pro_dataset.mjs',
      '',
    ].join('\n'),
  );
}

function parseArgs(argv: string[]): Opts {
  const opts: Opts = {
    help: false,
    json: false,
    provider: 'mock',
    infraOnly: false,
    earlyStop: 5,
    limit: 0,
    dataset: '',
    evidenceDir: '',
    dockerPullK: 0,
    model: 'deepseek-v4-flash-openrouter',
    heartbeatFile: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--infra-only') opts.infraOnly = true;
    else if (a === '--live') opts.provider = 'live';
    else if (a === '--provider') {
      const v = argv[++i];
      if (v !== 'mock' && v !== 'live') throw new Error('--provider must be mock|live');
      opts.provider = v;
    } else if (a === '--early-stop') opts.earlyStop = Number(argv[++i]);
    else if (a === '--limit') opts.limit = Number(argv[++i]);
    else if (a === '--dataset') opts.dataset = String(argv[++i]);
    else if (a === '--evidence-dir') opts.evidenceDir = String(argv[++i]);
    else if (a === '--docker-pull') opts.dockerPullK = Number(argv[++i]);
    else if (a === '--model') opts.model = String(argv[++i]);
    else if (a === '--agent-timeout-ms') opts.agentTimeoutMs = Number(argv[++i]);
    else if (a === '--fail-to-pass-timeout-ms') opts.failToPassTimeoutMs = Number(argv[++i]);
    else if (a === '--heartbeat-file') opts.heartbeatFile = String(argv[++i]);
    else throw new Error(`Unknown arg: ${a}`);
  }
  return opts;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  const explicitDataset = opts.dataset ? resolveOperatorPath(opts.dataset) : undefined;
  const datasetPath =
    resolveSweProDatasetPath(explicitDataset) ??
    (explicitDataset ?? defaultSweProDatasetPath());

  const report = await runSwebenchProCampaign({
    datasetPath,
    provider: opts.provider,
    infraOnly: opts.infraOnly,
    earlyStopN: opts.earlyStop,
    ...(opts.limit > 0 ? { instanceLimit: opts.limit } : {}),
    ...(opts.evidenceDir ? { evidenceDir: resolveOperatorPath(opts.evidenceDir) } : {}),
    dockerPullFirstK: opts.dockerPullK,
    model: opts.model,
    ...(opts.agentTimeoutMs !== undefined ? { agentTimeoutMs: opts.agentTimeoutMs } : {}),
    ...(opts.failToPassTimeoutMs !== undefined
      ? { failToPassTimeoutMs: opts.failToPassTimeoutMs }
      : {}),
    ...(opts.heartbeatFile ? { heartbeatFile: resolveOperatorPath(opts.heartbeatFile) } : {}),
  });

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatCampaignReportHuman(report)}\n`);
  }

  if (report.aborted) process.exitCode = 2;
  else if (report.cells.some((c) => c.phase === 'live' && c.status === 'fail')) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

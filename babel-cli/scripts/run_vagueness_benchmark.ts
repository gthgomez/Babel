import { config as dotenvConfig } from 'dotenv';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  defaultVaguenessReposPath,
  runVaguenessBenchmark,
  type VaguenessProvider,
} from '../src/services/liteVaguenessBenchmark.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

dotenvConfig({
  path: join(packageRoot, '.env'),
  override: false,
  quiet: true,
});

interface CliOptions {
  provider: VaguenessProvider;
  projectRoot?: string;
  repoManifest?: string;
  workspaceRoot?: string;
  scenariosPath?: string;
  evidenceDir?: string;
  minPassRate?: number;
  json: boolean;
  help: boolean;
}

function printHelp(): void {
  process.stdout.write([
    'Usage: npm --prefix .\\babel-cli run test:vagueness-benchmark -- [options]',
    '',
    'Run tiered vagueness scenarios against workspace repos or a single project root.',
    '',
    'Options:',
    '  --provider <mode>       mock | live (default: mock)',
    '  --project-root <path>   Single repo override (skips repo manifest sweep)',
    '  --repo-manifest <path>  Repo manifest (default: src/fixtures/vagueness/repos.json)',
    '  --workspace-root <path> Workspace root for manifest paths',
    '  --scenarios <path>      Scenario matrix override',
    '  --evidence-dir <path>   Evidence root (default: runs/vagueness-benchmark/<timestamp>)',
    '  --min-pass-rate <n>     Gate threshold 0-1 (default: 0.85 mock, 0.70 live)',
    '  --json                  Emit structured JSON report only',
    '  --help                  Show this help',
    '',
  ].join('\n'));
}

function readValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    provider: 'mock',
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--provider') {
      const provider = readValue(argv, ++index, '--provider');
      if (provider !== 'live' && provider !== 'mock') {
        throw new Error('--provider must be live or mock');
      }
      options.provider = provider;
      continue;
    }
    if (arg === '--project-root') {
      options.projectRoot = readValue(argv, ++index, '--project-root');
      continue;
    }
    if (arg === '--repo-manifest') {
      options.repoManifest = readValue(argv, ++index, '--repo-manifest');
      continue;
    }
    if (arg === '--workspace-root') {
      options.workspaceRoot = readValue(argv, ++index, '--workspace-root');
      continue;
    }
    if (arg === '--scenarios') {
      options.scenariosPath = readValue(argv, ++index, '--scenarios');
      continue;
    }
    if (arg === '--evidence-dir') {
      options.evidenceDir = readValue(argv, ++index, '--evidence-dir');
      continue;
    }
    if (arg === '--min-pass-rate') {
      const raw = Number(readValue(argv, ++index, '--min-pass-rate'));
      if (!Number.isFinite(raw) || raw < 0 || raw > 1) {
        throw new Error('--min-pass-rate must be a number between 0 and 1');
      }
      options.minPassRate = raw;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function hasLiveProviderKey(): boolean {
  return Boolean(process.env['DEEPSEEK_API_KEY'] || process.env['DEEPINFRA_API_KEY']);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (options.provider === 'live' && !hasLiveProviderKey()) {
    throw new Error('Live vagueness benchmark requires DEEPSEEK_API_KEY or DEEPINFRA_API_KEY.');
  }

  const report = runVaguenessBenchmark({
    provider: options.provider,
    ...(options.projectRoot !== undefined ? { projectRoot: resolve(options.projectRoot) } : {}),
    repoManifestPath: resolve(options.repoManifest ?? defaultVaguenessReposPath()),
    ...(options.workspaceRoot !== undefined ? { workspaceRoot: resolve(options.workspaceRoot) } : {}),
    ...(options.scenariosPath !== undefined ? { scenariosPath: resolve(options.scenariosPath) } : {}),
    ...(options.evidenceDir !== undefined ? { evidenceDir: resolve(options.evidenceDir) } : {}),
    ...(options.minPassRate !== undefined ? { minPassRate: options.minPassRate } : {}),
  });

  const reportPath = join(report.evidence_dir, 'report.json');
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`Vagueness benchmark (${report.provider}, profile=${report.daily_profile})\n`);
    process.stdout.write(`Evidence: ${report.evidence_dir}\n`);
    for (const entry of report.scenarios) {
      const checks = entry.checks.filter((check) => !check.pass).map((check) => check.id).join(', ');
      const suffix = checks.length > 0 ? ` [failed: ${checks}]` : '';
      process.stdout.write(`- ${entry.id}: ${entry.status} (${entry.reported_status ?? 'n/a'})${suffix}\n`);
    }
    process.stdout.write(
      `Pass ${report.totals.pass}/${report.totals.executed} `
      + `(skipped ${report.totals.skip}, rate ${(report.totals.pass_rate * 100).toFixed(1)}%)\n`,
    );
    process.stdout.write(`Gate: ${report.gate_passed ? 'PASSED' : 'FAILED'} (min ${(report.min_pass_rate * 100).toFixed(0)}%)\n`);
    process.stdout.write(
      `Metrics: exploration=${(report.metrics.tool_exploration_rate * 100).toFixed(1)}% `
      + `blocked=${(report.metrics.blocked_clarification_rate * 100).toFixed(1)}% `
      + `deep_escalation=${(report.metrics.deep_escalation_rate * 100).toFixed(1)}%\n`,
    );
  }

  if (!report.gate_passed) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
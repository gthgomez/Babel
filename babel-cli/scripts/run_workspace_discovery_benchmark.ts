import { config as dotenvConfig } from 'dotenv';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  defaultWorkspaceDiscoveryReposPath,
  runWorkspaceDiscoveryBenchmark,
  type DiscoveryProvider,
} from '../src/services/liteWorkspaceDiscoveryBenchmark.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

dotenvConfig({
  path: join(packageRoot, '.env'),
  override: false,
  quiet: true,
});

interface CliOptions {
  provider: DiscoveryProvider;
  repoManifest?: string;
  scenariosPath?: string;
  workspaceRoot?: string;
  evidenceDir?: string;
  minPassRate?: number;
  smoke: boolean;
  repoFilter?: string[];
  maxCells?: number;
  json: boolean;
  help: boolean;
}

function printHelp(): void {
  process.stdout.write([
    'Usage: npm --prefix .\\babel-cli run test:workspace-discovery:live -- [options]',
    '',
    'Run live workspace discovery scenarios across curated example_game_suite and example_mobile_suite repos.',
    '',
    'Options:',
    '  --provider <mode>       live | mock (default: live)',
    '  --repo-manifest <path>  Repo manifest (default: fixtures/workspace-discovery/repos.json)',
    '  --scenarios <path>      Scenario matrix override',
    '  --workspace-root <path> Workspace root (default: C:\\Workspace)',
    '  --repo-filter <ids>     Comma-separated repo ids (e.g. relic_run,simlife)',
    '  --smoke                 Run smoke subset (2 scenarios x 4 repos)',
    '  --max-cells <n>         Cap executed cells',
    '  --evidence-dir <path>   Evidence root',
    '  --min-pass-rate <n>     Gate threshold 0-1 (default: 0.90)',
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
    provider: 'live',
    smoke: false,
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
    if (arg === '--smoke') {
      options.smoke = true;
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
    if (arg === '--repo-manifest') {
      options.repoManifest = readValue(argv, ++index, '--repo-manifest');
      continue;
    }
    if (arg === '--scenarios') {
      options.scenariosPath = readValue(argv, ++index, '--scenarios');
      continue;
    }
    if (arg === '--workspace-root') {
      options.workspaceRoot = readValue(argv, ++index, '--workspace-root');
      continue;
    }
    if (arg === '--repo-filter') {
      options.repoFilter = readValue(argv, ++index, '--repo-filter')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
      continue;
    }
    if (arg === '--evidence-dir') {
      options.evidenceDir = readValue(argv, ++index, '--evidence-dir');
      continue;
    }
    if (arg === '--max-cells') {
      const raw = Number(readValue(argv, ++index, '--max-cells'));
      if (!Number.isFinite(raw) || raw < 1) {
        throw new Error('--max-cells must be a positive number');
      }
      options.maxCells = raw;
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
    throw new Error('Live workspace discovery requires DEEPSEEK_API_KEY or DEEPINFRA_API_KEY.');
  }

  const report = runWorkspaceDiscoveryBenchmark({
    provider: options.provider,
    repoManifestPath: resolve(options.repoManifest ?? defaultWorkspaceDiscoveryReposPath()),
    ...(options.scenariosPath !== undefined ? { scenariosPath: resolve(options.scenariosPath) } : {}),
    ...(options.workspaceRoot !== undefined ? { workspaceRoot: resolve(options.workspaceRoot) } : {}),
    ...(options.evidenceDir !== undefined ? { evidenceDir: resolve(options.evidenceDir) } : {}),
    ...(options.minPassRate !== undefined ? { minPassRate: options.minPassRate } : {}),
    ...(options.repoFilter !== undefined ? { repoFilter: options.repoFilter } : {}),
    ...(options.maxCells !== undefined ? { maxCells: options.maxCells } : {}),
    smoke: options.smoke,
  });

  const reportPath = join(report.evidence_dir, 'report.json');
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`Workspace discovery benchmark (${report.provider}${report.smoke_mode ? ', smoke' : ''})\n`);
    process.stdout.write(`Evidence: ${report.evidence_dir}\n`);
    for (const cell of report.cells) {
      if (cell.status === 'skip') {
        process.stdout.write(`- ${cell.id}: skip (${cell.notes[0] ?? 'skipped'})\n`);
        continue;
      }
      const failed = cell.checks.filter((check) => !check.pass).map((check) => check.id).join(', ');
      const suffix = failed.length > 0 ? ` [failed: ${failed}]` : '';
      process.stdout.write(`- ${cell.id}: ${cell.status} (${cell.reported_status ?? 'n/a'})${suffix}\n`);
    }
    process.stdout.write(
      `Pass ${report.totals.pass}/${report.totals.executed} `
      + `(skipped ${report.totals.skip}, rate ${(report.totals.pass_rate * 100).toFixed(1)}%)\n`,
    );
    process.stdout.write(
      `Gate: ${report.gate_passed ? 'PASSED' : 'FAILED'} `
      + `(min pass ${(report.min_pass_rate * 100).toFixed(0)}%, `
      + `min anchors ${(report.min_context_anchor_rate * 100).toFixed(0)}%)\n`,
    );
    process.stdout.write(
      `Metrics: exploration=${(report.metrics.tool_exploration_rate * 100).toFixed(1)}% `
      + `anchors=${(report.metrics.context_anchor_rate * 100).toFixed(1)}% `
      + `grounded=${(report.metrics.grounded_path_rate * 100).toFixed(1)}% `
      + `plan_artifacts=${(report.metrics.plan_artifact_rate * 100).toFixed(1)}%\n`,
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
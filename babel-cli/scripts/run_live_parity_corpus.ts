import { config as dotenvConfig } from 'dotenv';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BABEL_RUNS_DIR } from '../src/cli/constants.js';
import {
  buildParityFixtureFromResults,
  readParityCorpusManifest,
  readParityCorpusTask,
  resolveBabelCliEntry,
  resolveParityCorpusRunMode,
  runParityBabelCell,
  type ParityCorpusRunMode,
  type ParityCorpusProvider,
} from '../src/services/parityCorpus.js';
import type { ParityToolResult } from '../src/services/parityBenchmark.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
dotenvConfig({
  path: join(packageRoot, '.env'),
  override: false,
  quiet: true,
});

interface CliOptions {
  task: string;
  mode?: ParityCorpusRunMode;
  provider: ParityCorpusProvider;
  output?: string;
  evidenceDir?: string;
  json: boolean;
  help: boolean;
}

function printHelp(): void {
  process.stdout.write([
    'Usage: npm --prefix .\\babel-cli run test:live-parity-corpus -- [options]',
    '',
    'Seed parity corpus repos and run one live (or mock) cell per task.',
    'Default mode is per-task (ask for read-only fixtures, fix otherwise).',
    '',
    'Options:',
    '  --task <id|all>       parity corpus task id or all (default: all)',
    '  --mode <mode>         fix | ask | worker-loop (default: per-task)',
    '  --provider <mode>     live | mock (default: live)',
    '  --output <path>       Write parity --fixture compatible JSON',
    '  --evidence-dir <path> Evidence root (default: runs/live-parity-corpus)',
    '  --json                Emit structured JSON only',
    '  --help                Show this help',
    '',
  ].join('\n'));
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    task: 'all',
    provider: 'live',
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
    if (arg === '--task') {
      options.task = readValue(argv, ++index, '--task');
      continue;
    }
    if (arg === '--mode') {
      const mode = readValue(argv, ++index, '--mode');
      if (mode !== 'fix' && mode !== 'ask' && mode !== 'worker-loop') {
        throw new Error('--mode must be fix, ask, or worker-loop');
      }
      options.mode = mode;
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
    if (arg === '--output') {
      options.output = readValue(argv, ++index, '--output');
      continue;
    }
    if (arg === '--evidence-dir') {
      options.evidenceDir = readValue(argv, ++index, '--evidence-dir');
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function readValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  if (options.provider === 'live' && !process.env['DEEPINFRA_API_KEY']?.trim() && !process.env['DEEPSEEK_API_KEY']?.trim()) {
    throw new Error('Live parity corpus requires DEEPINFRA_API_KEY or DEEPSEEK_API_KEY in babel-cli/.env');
  }

  const manifest = readParityCorpusManifest();
  const taskIds = options.task === 'all' ? manifest.tasks : [options.task];
  for (const taskId of taskIds) {
    if (!manifest.tasks.includes(taskId)) {
      throw new Error(`Unknown parity task ${taskId}; expected one of: ${manifest.tasks.join(', ')}`);
    }
  }

  const evidenceDir = resolve(options.evidenceDir ?? join(BABEL_RUNS_DIR, 'live-parity-corpus'));
  mkdirSync(evidenceDir, { recursive: true });
  const cliEntry = resolveBabelCliEntry();

  const results: ParityToolResult[] = [];
  for (const taskId of taskIds) {
    const task = readParityCorpusTask(taskId);
    const mode = resolveParityCorpusRunMode(task, options.mode);
    const result = await runParityBabelCell(taskId, {
      mode,
      provider: options.provider,
      cliEntry,
      evidenceDir,
      humanSummary: true,
    });
    if (result.evidence_path && existsSync(result.evidence_path)) {
      const evidence = JSON.parse(readFileSync(result.evidence_path, 'utf8')) as {
        cli_payload?: { run_dir?: string | null };
      };
      const runDir = evidence.cli_payload?.run_dir ?? null;
      const humanSummaryPath = runDir ? join(runDir, 'human_summary.txt') : null;
      if (humanSummaryPath && existsSync(humanSummaryPath)) {
        writeFileSync(join(evidenceDir, `${taskId}-human.log`), readFileSync(humanSummaryPath, 'utf8'), 'utf8');
      }
    }
    results.push(result);
  }

  const fixture = buildParityFixtureFromResults(results);
  if (options.output) {
    writeFileSync(resolve(options.output), `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
  }

  const report = {
    schema_version: 1,
    report_type: 'babel_live_parity_corpus',
    generated_at: new Date().toISOString(),
    provider: options.provider,
    mode: options.mode ?? 'per-task',
    evidence_dir: evidenceDir,
    results,
    fixture_path: options.output ?? null,
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    for (const result of results) {
      process.stdout.write(`${result.task_id}: ${result.status} verifier=${result.verifier} latency=${result.latency_ms}ms\n`);
    }
  }

  if (results.some(result => result.status !== 'success')) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`[test:live-parity-corpus] failed — ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
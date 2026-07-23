import { config as dotenvConfig } from 'dotenv';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assessAgentBenchmarkReadiness,
  listAgentBenchmarkTasks,
  loadAgentBenchmarkManifest,
  runAgentBenchmarkSuite,
} from '../src/services/agentBenchmark.js';
import { BABEL_RUNS_DIR } from '../src/cli/constants.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
dotenvConfig({
  path: join(packageRoot, '.env'),
  override: true,
  quiet: true,
});

interface CliOptions {
  list: boolean;
  plan: boolean;
  tier: string;
  task: string;
  provider: 'mock' | 'live';
  surface: string;
  runnableOnly: boolean;
  executeExternal: boolean;
  full: boolean;
  output: string;
  evidenceDir: string;
  json: boolean;
  help: boolean;
}

function printHelp(): void {
  process.stdout.write(
    [
      'Usage: npm --prefix .\\babel-cli run benchmark:agent -- [options]',
      '',
      'Catered Babel agent benchmark: SWE-bench Verified + HUNK4J + Terminal-Bench 2.1 + local parity/governance.',
      '',
      'Options:',
      '  --list                List tasks in the manifest',
      '  --plan                Show dataset/Docker readiness without running',
      '  --tier <id|all>       A_daily | B_weekly | C_monthly | D_governance | all (default: all)',
      '  --task <id>           Run a single benchmark task id',
      '  --provider <p>        mock | live (default: mock for local fixtures)',
      '  --live                Alias for --provider live --surface chat --runnable-only',
      '  --full                Live full 32-task suite (SWE/HUNK/TB + local; requires Docker)',
      '  --runnable-only         Skip external SWE/HUNK/TB tasks that need datasets/Docker',
      '  --surface <s>         chat | plan | deep (override manifest default)',
      '  --output <path>       Report JSON path',
      '  --evidence-dir <path> Evidence root (default: runs/agent-benchmark)',
      '  --json                Emit structured JSON only',
      '  --help                Show this help',
      '',
      'Examples:',
      '  npm --prefix .\\babel-cli run benchmark:agent -- --plan --json',
      '  npm --prefix .\\babel-cli run benchmark:agent -- --tier A_daily --provider mock --json',
      '  npm --prefix .\\babel-cli run benchmark:agent:live',
      '  npm --prefix .\\babel-cli run benchmark:agent:live:full',
      '',
      'External corpora:',
      '  SWEBENCH_DATASET_PATH   Path to SWE-bench Verified JSONL export',
      '  HUNK4J_MANIFEST_PATH    Optional HUNK4J overlay manifest',
      '  TERMINAL_BENCH_ROOT     Root containing scripts/run_babel_terminal_bench_pilot.mjs',
      '',
    ].join('\n'),
  );
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    list: false,
    plan: false,
    tier: 'all',
    task: '',
    provider: 'mock',
    surface: '',
    runnableOnly: false,
    executeExternal: false,
    full: false,
    output: '',
    evidenceDir: '',
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
    if (arg === '--list') {
      options.list = true;
      continue;
    }
    if (arg === '--plan') {
      options.plan = true;
      continue;
    }
    if (arg === '--tier') {
      options.tier = readValue(argv, ++index, '--tier');
      continue;
    }
    if (arg === '--task') {
      options.task = readValue(argv, ++index, '--task');
      continue;
    }
    if (arg === '--provider') {
      const provider = readValue(argv, ++index, '--provider');
      if (provider !== 'mock' && provider !== 'live') {
        throw new Error('--provider must be mock or live');
      }
      options.provider = provider;
      continue;
    }
    if (arg === '--live') {
      options.provider = 'live';
      options.surface = 'chat';
      options.runnableOnly = true;
      continue;
    }
    if (arg === '--full') {
      options.provider = 'live';
      options.surface = 'chat';
      options.runnableOnly = false;
      options.executeExternal = true;
      options.full = true;
      continue;
    }
    if (arg === '--runnable-only') {
      options.runnableOnly = true;
      continue;
    }
    if (arg === '--surface') {
      options.surface = readValue(argv, ++index, '--surface');
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

function emit(payload: unknown, jsonOnly: boolean): void {
  const text = JSON.stringify(payload, null, 2);
  if (jsonOnly) {
    process.stdout.write(`${text}\n`);
    return;
  }
  process.stdout.write(`${text}\n`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const manifest = loadAgentBenchmarkManifest();
  const tier =
    options.tier === 'all'
      ? 'all'
      : (options.tier as 'A_daily' | 'B_weekly' | 'C_monthly' | 'D_governance');

  if (options.list) {
    const tasks = listAgentBenchmarkTasks(manifest, tier);
    emit(
      {
        benchmark_id: manifest.benchmark_id,
        tier,
        tasks: tasks.map((task) => ({
          task_id: task.task_id,
          source: task.source,
          title: task.title,
          external_ref: task.external_ref,
          readiness: task.readiness,
          babel_surface: task.babel_surface,
        })),
      },
      options.json,
    );
    return;
  }

  if (options.plan) {
    emit(assessAgentBenchmarkReadiness(manifest), options.json);
    return;
  }

  const evidenceDir = options.evidenceDir
    ? resolve(options.evidenceDir)
    : join(
        BABEL_RUNS_DIR,
        options.full ? 'agent-benchmark-live-full' : 'agent-benchmark-live',
      );
  mkdirSync(evidenceDir, { recursive: true });

  const report = await runAgentBenchmarkSuite({
    tier,
    provider: options.provider,
    runnableOnly: options.runnableOnly,
    executeExternal: options.executeExternal || options.full,
    ...(options.task ? { taskId: options.task } : {}),
    ...(options.surface
      ? { surface: options.surface as 'chat' | 'plan' | 'deep' }
      : {}),
    evidenceDir,
    ...(options.output ? { outputPath: resolve(options.output) } : {}),
  });

  if (!options.json) {
    process.stdout.write(`Report: ${report.artifact_path}\n`);
    process.stdout.write(
      `Summary: ${report.summary.success}/${report.summary.runnable} runnable passed; ` +
        `${report.summary.manual_required} manual/external; ` +
        `${report.summary.false_complete} false-complete\n`,
    );
    if (report.summary.total_cost_usd !== null) {
      process.stdout.write(
        `Cost: $${report.summary.total_cost_usd.toFixed(4)} total` +
          (report.summary.total_tokens !== null ? `; ${report.summary.total_tokens} tokens` : '') +
          (report.summary.mean_latency_ms !== null
            ? `; mean latency ${report.summary.mean_latency_ms}ms`
            : '') +
          '\n',
      );
    }
    for (const row of report.results) {
      if (row.latency_ms !== null) {
        const cost = row.cost_usd !== null ? `$${row.cost_usd.toFixed(4)}` : 'n/a';
        const tokens = row.token_count !== null ? String(row.token_count) : 'n/a';
        const flags: string[] = [];
        if (row.false_complete) flags.push('FALSE_COMPLETE');
        if (row.status === 'success' && row.verifier === 'pass') {
          // Check notes for mutation/claim indicators added in Phase 1
          const notesStr = (row.notes ?? []).join(' ');
          if (notesStr.includes('mutation_ok=false')) flags.push('NO_MUTATION');
          if (notesStr.includes('claimed=false')) flags.push('NO_CLAIM');
          if (row.false_complete) flags.push('FALSE_COMPLETE');
        }
        const flagStr = flags.length > 0 ? ` [${flags.join(',')}]` : '';
        process.stdout.write(
          `  ${row.benchmark_task_id}: ${row.status}/${row.verifier} ` +
            `${row.latency_ms}ms cost=${cost} tokens=${tokens}${flagStr}\n`,
        );
      }
    }
    for (const action of report.improvement_actions) {
      process.stdout.write(`- ${action}\n`);
    }
  }

  emit(report, options.json);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});

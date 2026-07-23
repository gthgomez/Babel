import { config as dotenvConfig } from 'dotenv';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BABEL_RUNS_DIR } from '../src/cli/constants.js';
import {
  readParityCorpusTask,
  resolveBabelCliEntry,
  runParityBabelCell,
  writeParityCorpusRepo,
} from '../src/services/parityCorpus.js';
import { runBabelCli } from '../src/services/liteTrustDemo.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_TASK_ID = 'small_bug_fix';
const DEFAULT_TIMEOUT_MS = 600_000;

dotenvConfig({
  path: join(packageRoot, '.env'),
  override: false,
  quiet: true,
});

type ProbeProvider = 'mock' | 'live';

interface CliOptions {
  provider: ProbeProvider;
  taskId: string;
  timeoutMs: number;
  evidenceDir?: string;
  json: boolean;
  help: boolean;
}

interface ProbeEvidence {
  schema_version: 1;
  report_type: 'babel_bounded_deep_probe';
  generated_at: string;
  provider: ProbeProvider;
  task_id: string;
  probe_kind: 'mock_parity_fix' | 'live_deep';
  status: 'success' | 'failure' | 'skipped';
  latency_ms: number;
  cli_exit_code: number | null;
  cli_status: string | null;
  execution_mode: string | null;
  run_dir: string | null;
  evidence_path: string;
  notes: string[];
}

function printHelp(): void {
  process.stdout.write([
    'Usage: npm --prefix .\\babel-cli run test:bounded-deep-probe:optional -- [options]',
    '',
    'Bounded Phase-3 probe on the parity small_bug_fix fixture.',
    'Mock mode runs the offline parity fix cell; live mode runs babel deep with a timeout.',
    '',
    'Options:',
    '  --provider <mode>     mock | live (default: mock)',
    '  --task <id>           Parity corpus task id (default: small_bug_fix)',
    '  --timeout-ms <ms>     Live deep timeout (default: 600000)',
    '  --evidence-dir <path> Evidence root (default: runs/live-eval/<date>)',
    '  --json                Emit structured JSON only',
    '  --help                Show this help',
    '',
  ].join('\n'));
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    provider: 'mock',
    taskId: DEFAULT_TASK_ID,
    timeoutMs: DEFAULT_TIMEOUT_MS,
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
      if (provider !== 'mock' && provider !== 'live') {
        throw new Error('--provider must be mock or live');
      }
      options.provider = provider;
      continue;
    }
    if (arg === '--task') {
      options.taskId = readValue(argv, ++index, '--task');
      continue;
    }
    if (arg === '--timeout-ms') {
      const timeout = Number.parseInt(readValue(argv, ++index, '--timeout-ms'), 10);
      if (!Number.isFinite(timeout) || timeout <= 0) {
        throw new Error('--timeout-ms requires a positive integer');
      }
      options.timeoutMs = timeout;
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

function defaultEvidenceDir(): string {
  const date = new Date().toISOString().slice(0, 10);
  return join(BABEL_RUNS_DIR, 'live-eval', date);
}

function hasLiveProviderCredentials(): boolean {
  return Boolean(
    process.env['DEEPINFRA_API_KEY']?.trim() ||
    process.env['DEEPSEEK_API_KEY']?.trim(),
  );
}

async function runMockProbe(options: CliOptions, evidencePath: string): Promise<ProbeEvidence> {
  const started = performance.now();
  const evidenceDir = dirname(evidencePath);
  const result = await runParityBabelCell(options.taskId, {
    mode: 'fix',
    provider: 'mock',
    evidenceDir,
    cliEntry: resolveBabelCliEntry(),
  });
  const success = result.status === 'success' && result.verifier === 'pass';
  const evidence: ProbeEvidence = {
    schema_version: 1,
    report_type: 'babel_bounded_deep_probe',
    generated_at: new Date().toISOString(),
    provider: 'mock',
    task_id: options.taskId,
    probe_kind: 'mock_parity_fix',
    status: success ? 'success' : 'failure',
    latency_ms: Math.round(performance.now() - started),
    cli_exit_code: success ? 0 : 1,
    cli_status: success ? 'FIX_COMPLETE' : 'SMALL_FIX_FAILED',
    execution_mode: 'offline_demo',
    run_dir: null,
    evidence_path: evidencePath,
    notes: [
      'Bounded mock probe via parity corpus fix cell on small_bug_fix fixture.',
      `parity_status=${result.status}, verifier=${result.verifier}`,
      ...(result.evidence_path ? [`parity_evidence=${result.evidence_path}`] : []),
    ],
  };
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  return evidence;
}

async function runLiveDeepProbe(options: CliOptions, evidencePath: string): Promise<ProbeEvidence> {
  if (!hasLiveProviderCredentials()) {
    const evidence: ProbeEvidence = {
      schema_version: 1,
      report_type: 'babel_bounded_deep_probe',
      generated_at: new Date().toISOString(),
      provider: 'live',
      task_id: options.taskId,
      probe_kind: 'live_deep',
      status: 'skipped',
      latency_ms: 0,
      cli_exit_code: null,
      cli_status: null,
      execution_mode: null,
      run_dir: null,
      evidence_path: evidencePath,
      notes: ['skipped — set DEEPINFRA_API_KEY or DEEPSEEK_API_KEY for live deep probe'],
    };
    writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    return evidence;
  }

  const task = readParityCorpusTask(options.taskId);
  const projectRoot = mkdtempSync(join(tmpdir(), 'babel-bounded-deep-probe-'));
  const started = performance.now();
  try {
    writeParityCorpusRepo(projectRoot, task);
    const cli = runBabelCli([
      'deep',
      '--json',
      '--project-root',
      projectRoot,
      '--execution-profile',
      'dev_local',
      task.task,
    ], {
      projectRoot,
      cliEntry: resolveBabelCliEntry(),
      offlineDemo: false,
    });

    const payload = cli.payload;
    const cliStatus = typeof payload?.['status'] === 'string' ? payload['status'] : null;
    const executionMode = typeof payload?.['execution_mode'] === 'string' ? payload['execution_mode'] : null;
    const runDir = typeof payload?.['run_dir'] === 'string' ? payload['run_dir'] : null;
    const success = cli.exitCode === 0 && cliStatus === 'COMPLETE';
    const evidence: ProbeEvidence = {
      schema_version: 1,
      report_type: 'babel_bounded_deep_probe',
      generated_at: new Date().toISOString(),
      provider: 'live',
      task_id: options.taskId,
      probe_kind: 'live_deep',
      status: success ? 'success' : 'failure',
      latency_ms: Math.round(performance.now() - started),
      cli_exit_code: cli.exitCode,
      cli_status: cliStatus,
      execution_mode: executionMode,
      run_dir: runDir,
      evidence_path: evidencePath,
      notes: [
        `Bounded live deep probe with timeout_ms=${options.timeoutMs}.`,
        `exit=${cli.exitCode}, status=${String(cliStatus)}`,
      ],
    };
    writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    return evidence;
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const evidenceDir = resolve(options.evidenceDir ?? defaultEvidenceDir());
  mkdirSync(evidenceDir, { recursive: true });
  const evidencePath = join(evidenceDir, 'phase3-deep-probe.json');

  const evidence = options.provider === 'mock'
    ? await runMockProbe(options, evidencePath)
    : await runLiveDeepProbe(options, evidencePath);

  if (options.json) {
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  } else {
    process.stdout.write(
      `bounded-deep-probe: provider=${evidence.provider} status=${evidence.status} latency=${evidence.latency_ms}ms\n`,
    );
    process.stdout.write(`evidence: ${evidencePath}\n`);
  }

  if (evidence.status === 'failure') {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `[test:bounded-deep-probe:optional] failed — ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { BABEL_RUNS_DIR } from '../src/cli/constants.js';
import {
  buildParityFixtureFromResults,
  readParityCorpusManifest,
  resolveBabelCliEntry,
  runParityBabelCell,
  runParityBabelCorpus,
  type ParityCorpusRunMode,
} from '../src/services/parityCorpus.js';

interface CliOptions {
  task: string;
  mode: ParityCorpusRunMode;
  output?: string;
  evidenceDir?: string;
  json: boolean;
  help: boolean;
}

function printHelp(): void {
  process.stdout.write([
    'Usage: npm --prefix .\\babel-cli run parity:run-babel -- [options]',
    '',
    'Run repeatable Babel parity cells for Phase 12 tasks 1-2 (offline_demo fixture scope).',
    '',
    'Options:',
    '  --task <id|all>     small_bug_fix | failing_test_repair | all (default: all)',
    '  --mode <mode>       fix | worker-loop (default: fix)',
    '  --output <path>     Write parity --fixture compatible JSON',
    '  --evidence-dir <p>  Evidence directory (default: runs/parity-corpus)',
    '  --json              Emit structured JSON only',
    '  --help              Show this help',
    '',
    'Merge output with Codex/Claude cells, then:',
    '  node dist/index.js benchmark parity --fixture <merged.json> --json',
    '',
  ].join('\n'));
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    task: 'all',
    mode: 'fix',
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
      if (mode !== 'fix' && mode !== 'worker-loop') {
        throw new Error('--mode must be fix or worker-loop');
      }
      options.mode = mode;
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

  const manifest = readParityCorpusManifest();
  const taskIds = options.task === 'all' ? manifest.tasks : [options.task];
  for (const taskId of taskIds) {
    if (!manifest.tasks.includes(taskId)) {
      throw new Error(`Unknown parity task ${taskId}; expected one of: ${manifest.tasks.join(', ')}`);
    }
  }

  const evidenceDir = resolve(options.evidenceDir ?? join(BABEL_RUNS_DIR, 'parity-corpus'));
  mkdirSync(evidenceDir, { recursive: true });
  const cliEntry = resolveBabelCliEntry();

  const payload = taskIds.length === 1
    ? {
        task_id: taskIds[0],
        mode: options.mode,
        evidence_dir: evidenceDir,
        result: await runParityBabelCell(taskIds[0], {
          mode: options.mode,
          cliEntry,
          evidenceDir,
        }),
      }
    : {
        mode: options.mode,
        evidence_dir: evidenceDir,
        ...(await runParityBabelCorpus({
          taskIds,
          mode: options.mode,
          cliEntry,
          evidenceDir,
        })),
      };

  if (options.output) {
    const results = 'results' in payload
      ? payload.results
      : [payload.result];
    writeFileSync(
      resolve(options.output),
      `${JSON.stringify(buildParityFixtureFromResults(results), null, 2)}\n`,
      'utf8',
    );
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  const results = 'results' in payload ? payload.results : [payload.result];
  const lines = [
    'Babel Parity Corpus (Babel cells)',
    `Mode: ${options.mode}`,
    `Evidence: ${evidenceDir}`,
    ...(options.output ? [`Fixture: ${resolve(options.output)}`] : []),
    '',
    ...results.map(result => `${result.status.toUpperCase().padEnd(8)} ${result.task_id} verifier=${result.verifier} latency=${result.latency_ms ?? 'n/a'}ms`),
    '',
    'Next: merge Codex/Claude cells into the fixture, then run benchmark parity --fixture <path> --json',
  ];
  process.stdout.write(`${lines.join('\n')}\n`);

  if (results.some(result => result.status !== 'success')) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

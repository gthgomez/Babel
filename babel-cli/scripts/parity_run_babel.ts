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
  mode?: ParityCorpusRunMode;
  provider?: 'mock' | 'live';
  command?: 'daily' | 'plan' | 'deep';
  output?: string;
  evidenceDir?: string;
  json: boolean;
  help: boolean;
}

function printHelp(): void {
  process.stdout.write([
    'Usage: npm --prefix .\\babel-cli run parity:run-babel -- [options]',
    '',
    'Run repeatable Babel parity cells for Phase 12 tasks 1-8 (offline_demo fixture scope).',
    '',
    'Options:',
    '  --task <id|all>     parity corpus task id or all (default: all)',
    '  --mode <mode>       fix | ask | worker-loop (default: per-task; ask for read-only fixtures)',
    '  --command <c>      daily | plan | deep (default: daily)',
    '  --provider <p>      mock | live (default: mock; live requires API keys in .env)',
    '  --output <path>     Write parity --fixture compatible JSON',
    '  --evidence-dir <p>  Evidence directory (default: runs/parity-corpus)',
    '  --json              Emit structured JSON only',
    '  --help              Show this help',
    '',
    'Merge output with other measured cells, then:',
    '  npm --prefix .\\babel-cli run parity:merge-fixture -- <a.json> <b.json> --output <merged.json>',
    '  node dist/index.js benchmark parity --fixture <merged.json> --json',
    '',
  ].join('\n'));
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    task: 'all',
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
      if (provider !== 'mock' && provider !== 'live') {
        throw new Error('--provider must be mock or live');
      }
      options.provider = provider;
      continue;
    }
    if (arg === '--command') {
      const command = readValue(argv, ++index, '--command');
      if (command !== 'daily' && command !== 'plan' && command !== 'deep') {
        throw new Error('--command must be daily, plan, or deep');
      }
      options.command = command;
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

  const cellOptions = {
    ...(options.mode !== undefined ? { mode: options.mode } : {}),
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
    ...(options.command !== undefined ? { command: options.command } : {}),
    cliEntry,
    evidenceDir,
  };
  const payload = taskIds.length === 1
    ? {
        task_id: taskIds[0],
        mode: options.mode ?? 'per-task',
        evidence_dir: evidenceDir,
        result: await runParityBabelCell(taskIds[0], cellOptions),
      }
    : {
        mode: options.mode ?? 'per-task',
        evidence_dir: evidenceDir,
        ...(await runParityBabelCorpus({
          taskIds,
          ...cellOptions,
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
    `Mode: ${options.mode ?? 'per-task'}`,
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

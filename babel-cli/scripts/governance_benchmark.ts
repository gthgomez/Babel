import {
  listBenchmarkTasks,
  loadBenchmarkManifest,
  loadToolAdapters,
  runGovernanceBenchmark,
} from '../src/services/governanceBenchmark.js';

interface BenchmarkCliOptions {
  list: boolean;
  json: boolean;
  tool: string;
  caseId: string;
  runs: number;
  output: string;
  artifactDir?: string;
}

function parseArgs(argv: readonly string[]): BenchmarkCliOptions {
  const options: BenchmarkCliOptions = {
    list: false,
    json: false,
    tool: 'babel',
    caseId: '',
    runs: 1,
    output: 'babel-benchmark-results.jsonl',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    if (arg === '--list') {
      options.list = true;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--tool') {
      options.tool = readValue(argv, ++index, '--tool');
      continue;
    }
    if (arg === '--case') {
      options.caseId = readValue(argv, ++index, '--case');
      continue;
    }
    if (arg === '--runs') {
      options.runs = Number.parseInt(readValue(argv, ++index, '--runs'), 10);
      continue;
    }
    if (arg === '--output') {
      options.output = readValue(argv, ++index, '--output');
      continue;
    }
    if (arg === '--artifact-dir') {
      options.artifactDir = readValue(argv, ++index, '--artifact-dir');
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function readValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function printHelp(): void {
  process.stdout.write([
    'Usage: npm --prefix .\\babel-cli run benchmark -- [options]',
    '',
    'Options:',
    '  --help                  Show this help and exit',
    '  --list                  List benchmark task IDs and tool adapter status',
    '  --json                  Emit JSON for --list or run summary',
    '  --tool <id>             Tool adapter id (default: babel)',
    '  --case <task_id>        Benchmark task id to run',
    '  --runs <n>              Number of repeated runs (default: 1)',
    '  --output <path>         JSONL result output path',
    '  --artifact-dir <path>   Artifact directory for per-run trace files',
    '',
  ].join('\n'));
}

function printList(json: boolean): void {
  const manifest = loadBenchmarkManifest();
  const tasks = listBenchmarkTasks(manifest);
  const adapters = loadToolAdapters();
  if (json) {
    process.stdout.write(`${JSON.stringify({
      schema_version: 1,
      benchmark_id: manifest.benchmark_id,
      task_count: tasks.length,
      tasks,
      adapters,
    }, null, 2)}\n`);
    return;
  }

  process.stdout.write(`Benchmark: ${manifest.benchmark_id}\n`);
  process.stdout.write(`Tasks: ${tasks.length}\n\n`);
  for (const task of tasks) {
    process.stdout.write(`${task.task_id}\t${task.category}\t${task.fixture_repo_path}\n`);
  }
  process.stdout.write('\nAdapters:\n');
  for (const adapter of adapters) {
    process.stdout.write(`${adapter.id}\t${adapter.adapter_status}\t${adapter.availability}\n`);
  }
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.list) {
    printList(options.json);
    process.exit(0);
  }
  if (!options.caseId) {
    throw new Error('Missing --case <task_id>. Use --list to see available tasks.');
  }
  const summary = runGovernanceBenchmark({
    tool: options.tool,
    caseId: options.caseId,
    runs: options.runs,
    outputPath: options.output,
    ...(options.artifactDir !== undefined ? { artifactDir: options.artifactDir } : {}),
  });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    process.stdout.write(`Benchmark run complete: ${summary.result_count} result(s) -> ${summary.output_path}\n`);
  }
} catch (error: unknown) {
  process.stderr.write(`[benchmark] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

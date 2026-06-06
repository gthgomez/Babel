import { generateGovernanceBenchmarkReport } from '../src/services/governanceBenchmarkReport.js';

interface ReportCliOptions {
  input: string;
  output: string;
  json: boolean;
}

function parseArgs(argv: readonly string[]): ReportCliOptions {
  const options: ReportCliOptions = {
    input: '',
    output: '',
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--input') {
      options.input = readValue(argv, ++index, '--input');
      continue;
    }
    if (arg === '--output') {
      options.output = readValue(argv, ++index, '--output');
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.input) throw new Error('Missing --input <jsonl>');
  if (!options.output) throw new Error('Missing --output <markdown>');
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
    'Usage: npm --prefix .\\babel-cli run benchmark:report -- --input <results.jsonl> --output <report.md>',
    '',
    'Options:',
    '  --help            Show this help and exit',
    '  --json            Emit JSON summary',
    '  --input <path>    Benchmark JSONL result file',
    '  --output <path>   Markdown scorecard output path',
    '',
  ].join('\n'));
}

try {
  const options = parseArgs(process.argv.slice(2));
  const summary = generateGovernanceBenchmarkReport({
    inputPath: options.input,
    outputPath: options.output,
  });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    process.stdout.write(`Benchmark report written: ${summary.output_path}\n`);
  }
} catch (error: unknown) {
  process.stderr.write(`[benchmark:report] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

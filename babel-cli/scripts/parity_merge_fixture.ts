import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { mergeParityFixtureInputs } from '../src/services/parityBenchmark.js';

interface CliOptions {
  inputs: string[];
  output?: string;
  json: boolean;
  help: boolean;
}

function printHelp(): void {
  process.stdout.write([
    'Usage: npm --prefix .\\babel-cli run parity:merge-fixture -- <input.json> [more.json ...] [options]',
    '',
    'Merge parity --fixture JSON files with last-wins dedupe on task_id + tool.',
    '',
    'Options:',
    '  --output <path>   Write merged fixture JSON (required unless --json only)',
    '  --json            Emit merge summary and results as JSON on stdout',
    '  --help            Show this help',
    '',
    'Example:',
    '  npm --prefix .\\babel-cli run parity:merge-fixture -- .\\runs\\parity-corpus\\babel-offline.json .\\runs\\live-parity-corpus\\babel-live.json --output .\\runs\\parity-corpus\\merged-cells.json',
    '  node .\\babel-cli\\dist\\index.js benchmark parity --fixture .\\runs\\parity-corpus\\merged-cells.json --json',
    '',
  ].join('\n'));
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    inputs: [],
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
    if (arg === '--output') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('--output requires a value.');
      }
      options.output = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--')) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    options.inputs.push(arg);
  }

  return options;
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (options.inputs.length === 0) {
    throw new Error('At least one input fixture path is required.');
  }

  const resolvedInputs = options.inputs.map(path => resolve(path));
  const merged = mergeParityFixtureInputs(resolvedInputs);
  const fixture = { results: merged.results };

  if (options.output) {
    const outputPath = resolve(options.output);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify({
      summary: merged.summary,
      output: options.output ? resolve(options.output) : null,
      results: merged.results,
    }, null, 2)}\n`);
    return;
  }

  const lines = [
    'Babel Parity Fixture Merge',
    `Inputs: ${merged.summary.input_files} file(s), ${merged.summary.input_cells} cell(s)`,
    `Merged: ${merged.summary.merged_cells} unique cell(s)`,
    `Duplicates overwritten: ${merged.summary.duplicates_overwritten}`,
    ...(options.output ? [`Output: ${resolve(options.output)}`] : []),
    '',
    'Next: node .\\babel-cli\\dist\\index.js benchmark parity --fixture <merged.json> --json',
  ];
  process.stdout.write(`${lines.join('\n')}\n`);

  if (!options.output) {
    throw new Error('--output is required unless using --json.');
  }
}

main();
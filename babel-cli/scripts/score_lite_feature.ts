import {
  runLiteFeatureDimension,
  runLiteFeatureScorecard,
  type LiteFeatureDimension,
} from '../src/services/liteFeatureScorecard.js';

const DIMENSIONS: LiteFeatureDimension[] = [
  'plan_mode',
  'parallel_review',
  'checkpoint_ux',
  'verifier_discipline',
];

function parseArgs(argv: string[]): { dimension: LiteFeatureDimension | 'all'; json: boolean; help: boolean } {
  let dimension: LiteFeatureDimension | 'all' = 'all';
  let json = false;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--dimension') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) {
        throw new Error('--dimension requires a value.');
      }
      if (value !== 'all' && !DIMENSIONS.includes(value as LiteFeatureDimension)) {
        throw new Error(`Unknown dimension ${value}; expected one of: ${DIMENSIONS.join(', ')}, all`);
      }
      dimension = value as LiteFeatureDimension | 'all';
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { dimension, json, help };
}

function printHelp(): void {
  process.stdout.write([
    'Usage: tsx scripts/score_lite_feature.ts [options]',
    '',
    'Fixture-based internal scoring for Cursor-pattern Lite dimensions.',
    '',
    'Options:',
    '  --dimension <id|all>  plan_mode | parallel_review | checkpoint_ux | verifier_discipline | all',
    '  --json                Emit structured JSON only',
    '  --help                Show this help',
    '',
  ].join('\n'));
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  if (options.dimension === 'all') {
    const report = await runLiteFeatureScorecard();
    if (options.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write([
        'Lite feature scorecard',
        `Status: ${report.status}`,
        '',
        ...report.dimensions.map(score => `${score.status.toUpperCase().padEnd(5)} ${score.dimension} — ${score.detail}`),
      ].join('\n'));
      process.stdout.write('\n');
    }
    if (report.status !== 'pass') {
      process.exitCode = 1;
    }
    return;
  }

  const score = await runLiteFeatureDimension(options.dimension);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(score, null, 2)}\n`);
  } else {
    process.stdout.write(`${score.status.toUpperCase()} ${score.dimension}: ${score.detail}\n`);
  }
  if (score.status !== 'pass') {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

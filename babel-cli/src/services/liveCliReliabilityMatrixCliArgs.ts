import type { LiveCliReliabilityProfile } from './liveCliReliabilityMatrix.js';

export interface LiveCliReliabilityMatrixCliArgs {
  help: boolean;
  list: boolean;
  json: boolean;
  outputDir?: string;
  caseFilter: string[];
  timeoutMs?: number;
  timeoutMultiplier?: number;
  resumeDir?: string;
  onlyFailed: boolean;
  fromCase?: string;
  profile: LiveCliReliabilityProfile;
}

const VALUE_FLAGS = new Set([
  '--output',
  '--output-dir',
  '--artifact-dir',
  '--case',
  '--timeout-ms',
  '--timeout-multiplier',
  '--resume',
  '--from-case',
  '--profile',
]);

export function parseLiveCliReliabilityMatrixArgs(
  argv: readonly string[],
): LiveCliReliabilityMatrixCliArgs {
  const parsed: LiveCliReliabilityMatrixCliArgs = {
    help: false,
    list: false,
    json: false,
    caseFilter: [],
    onlyFailed: false,
    profile: 'full',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const rawArg = argv[index];
    if (!rawArg) continue;
    const [flag, inlineValue] = splitInlineFlagValue(rawArg);
    const value = inlineValue ?? (VALUE_FLAGS.has(flag) ? readValue(argv, index, flag) : undefined);

    if (inlineValue === undefined && VALUE_FLAGS.has(flag)) {
      index += 1;
    }

    if (flag === '--help' || flag === '-h') {
      parsed.help = true;
      continue;
    }
    if (flag === '--list') {
      parsed.list = true;
      continue;
    }
    if (flag === '--json') {
      parsed.json = true;
      continue;
    }
    if (flag === '--output-dir' || flag === '--output' || flag === '--artifact-dir') {
      parsed.outputDir = requireValue(value, flag);
      continue;
    }
    if (flag === '--case') {
      parsed.caseFilter.push(requireValue(value, flag));
      continue;
    }
    if (flag === '--timeout-ms') {
      const raw = requireValue(value, flag);
      const timeout = Number.parseInt(raw, 10);
      if (!Number.isFinite(timeout) || timeout <= 0) {
        throw new Error(`Invalid --timeout-ms value: ${raw}`);
      }
      parsed.timeoutMs = timeout;
      continue;
    }
    if (flag === '--timeout-multiplier') {
      const raw = requireValue(value, flag);
      const multiplier = Number.parseFloat(raw);
      if (!Number.isFinite(multiplier) || multiplier <= 0) {
        throw new Error(`Invalid --timeout-multiplier value: ${raw}`);
      }
      parsed.timeoutMultiplier = multiplier;
      continue;
    }
    if (flag === '--resume') {
      parsed.resumeDir = requireValue(value, flag);
      continue;
    }
    if (flag === '--only-failed') {
      parsed.onlyFailed = true;
      continue;
    }
    if (flag === '--from-case') {
      parsed.fromCase = requireValue(value, flag);
      continue;
    }
    if (flag === '--profile') {
      const profile = requireValue(value, flag);
      if (profile !== 'fast' && profile !== 'full') {
        throw new Error('--profile must be fast or full');
      }
      parsed.profile = profile;
      continue;
    }
    throw new Error(`Unknown argument: ${rawArg}`);
  }

  return parsed;
}

export function formatLiveCliReliabilityMatrixHelp(): string {
  return [
    'Babel Live CLI Reliability Matrix',
    '',
    'Usage:',
    '  npm run reliability:matrix -- [options]',
    '',
    'Options:',
    '  --help, -h                 Show this help and exit.',
    '  --list                     List stable reliability case IDs and exit.',
    '  --json                     Emit JSON instead of human text.',
    '  --case <id>                Run one case ID or name. Repeatable.',
    '  --output <path>            Write matrix artifacts under this output root.',
    '  --output-dir <path>        Alias for --output.',
    '  --artifact-dir <path>      Alias for --output.',
    '  --timeout-ms <ms>          Override per-case timeout.',
    '  --timeout-multiplier <n>   Multiply all timeouts by this factor (default 1.0).',
    '  --resume <matrix-root>     Resume an existing matrix root.',
    '  --only-failed              With --resume, rerun only non-passing cases.',
    '  --from-case <id>           Start at a stable case ID or name.',
    '  --profile <fast|full>      fast skips live_heavy cases; full runs the complete matrix.',
    '',
    'Examples:',
    '  npm run reliability:matrix -- --help',
    '  npm run reliability:matrix -- --list',
    '  npm run reliability:matrix -- --json --output runs/live-cli-reliability',
    '  npm run reliability:matrix -- --case autonomous_exact_file_create --json',
  ].join('\n');
}

function splitInlineFlagValue(arg: string): [string, string | undefined] {
  if (!arg.startsWith('--')) {
    return [arg, undefined];
  }
  const separatorIndex = arg.indexOf('=');
  if (separatorIndex < 0) {
    return [arg, undefined];
  }
  return [arg.slice(0, separatorIndex), arg.slice(separatorIndex + 1)];
}

function readValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function requireValue(value: string | undefined, flag: string): string {
  if (value === undefined || value.length === 0) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

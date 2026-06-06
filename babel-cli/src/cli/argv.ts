import { VALID_PROJECTS, type ValidProject } from './constants.js';

const KNOWN_TOP_LEVEL_COMMANDS = new Set([
  'setup',
  'mode',
  'doctor',
  'simplify',
  'docs',
  'skill',
  'codex',
  'shadow-diff',
  'dry',
  'permissions',
  'approvals',
  'jobs',
  'escalation',
  'diagnose',
  'models',
  'evidence',
  'prove',
  'learn',
  'tools',
  'session',
  'inspect',
  'checkpoint',
  'interactive',
  'app',
  'mcp',
  'context',
  'events',
  'stats',
  'plugins',
  'agents',
  'schedule',
  'ci',
  'git',
  'ship',
  'bench',
  'benchmark',
  'files',
  'verify',
  'diff',
  'repo-map',
  'onboard-project',
  'create',
  'lite',
  'l',
  'ask',
  'plan',
  'fix',
  'propose',
  'diff',
  'review',
  'undo',
  'do',
  'full',
  'run',
  'resolve',
  'continue',
  'resume',
  'apply',
  'smoke',
  'test',
  'advanced',
  'internals',
  'text-provider',
  'help',
]);

const VALUE_OPTIONS = new Set([
  '-p', '--project',
  '--mode',
  '-m', '--model',
  '--model-tier',
  '--output-format',
  '--session-id',
  '--session-start-path',
  '--local-learning-root',
  '--orchestrator',
  '--execution-profile',
  '--project-root',
  '--log-file',
  '--lock',
  '--allowed-tools',
  '--disallowed-tools',
]);

function isTopLevelMetaToken(token: string): boolean {
  return token === 'help' ||
    token === '-h' ||
    token === '--help' ||
    token === '-V' ||
    token === '--version';
}

function getCommandBasename(value: string | undefined): string {
  return String(value ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    ?.toLowerCase() ?? '';
}

function isLiteEntrypoint(argv: string[]): boolean {
  const commandName = getCommandBasename(argv[1]);
  return commandName === 'bl' ||
    commandName === 'bl.js' ||
    commandName === 'babel-lite' ||
    commandName === 'babel-lite.js';
}

function rewriteRunArgs(argsAfterRun: string[]): string[] {
  const passthrough: string[] = [];
  const taskParts: string[] = [];

  for (let i = 0; i < argsAfterRun.length; i++) {
    const token = argsAfterRun[i]!;

    if (VALUE_OPTIONS.has(token)) {
      passthrough.push(token);
      const value = argsAfterRun[i + 1];
      if (value !== undefined) {
        passthrough.push(value);
        i++;
      }
      continue;
    }

    if (token.startsWith('-')) {
      passthrough.push(token);
      continue;
    }

    taskParts.push(token);
  }

  if (taskParts.length === 0) {
    return ['run', ...argsAfterRun];
  }

  return ['run', ...passthrough, taskParts.join(' ')];
}

const LITE_SUBCOMMANDS = new Set([
  'ask',
  'plan',
  'fix',
  'patch',
  'propose',
  'diff',
  'review',
  'undo',
  'do',
  'continue',
  'resume',
  'help',
  '-h',
  '--help',
]);

function rewriteLiteArgs(argsAfterLite: string[]): string[] {
  if (argsAfterLite.length === 0) {
    return ['lite', '--help'];
  }

  const first = argsAfterLite[0]!;
  if (isTopLevelMetaToken(first)) {
    return ['lite', '--help'];
  }

  if (!LITE_SUBCOMMANDS.has(first) && !first.startsWith('-')) {
    return ['lite', 'do', ...argsAfterLite];
  }

  return ['lite', ...argsAfterLite];
}

function rewriteDefaultTaskArgs(args: string[]): string[] {
  const rewritten = rewriteRunArgs(args);
  return rewritten[0] === 'run' ? ['do', ...rewritten.slice(1)] : rewritten;
}

export function rewriteArgv(argv: string[]): string[] {
  const head = argv.slice(0, 2);
  const tail = argv.slice(2);

  if (tail.length === 0) {
    if (isLiteEntrypoint(argv)) {
      return [...head, ...rewriteLiteArgs([])];
    }
    return [...head, 'interactive'];
  }

  const first = tail[0]!;

  if (isLiteEntrypoint(argv)) {
    return [...head, ...rewriteLiteArgs(tail)];
  }

  if (first === 'run') {
    return [...head, ...rewriteRunArgs(tail.slice(1))];
  }

  if (isTopLevelMetaToken(first) || first.startsWith('-')) {
    return argv;
  }

  if (VALID_PROJECTS.includes(first as ValidProject)) {
    if (tail.length === 1) {
      return [...head, 'interactive', '--project', first];
    }
    return [...head, ...rewriteRunArgs(['--project', first, ...tail.slice(1)])];
  }

  if (!KNOWN_TOP_LEVEL_COMMANDS.has(first)) {
    return [...head, ...rewriteDefaultTaskArgs(tail)];
  }

  return argv;
}

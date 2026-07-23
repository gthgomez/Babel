import { resolveProjectRoot } from './helpers.js';
import { DEPRECATED_SURFACE_COMMANDS } from './deprecation.js';

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
  'plan',
  'deep',
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
  'undo',
  'review',
  ...DEPRECATED_SURFACE_COMMANDS,
]);

const VALUE_OPTIONS = new Set([
  '-p',
  '--project',
  '--mode',
  '-m',
  '--model',
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
  '--budget',
]);

function isTopLevelMetaToken(token: string): boolean {
  return (
    token === 'help' ||
    token === '-h' ||
    token === '--help' ||
    token === '-V' ||
    token === '--version'
  );
}

function rewriteRunArgs(argsAfterRun: string[]): string[] {
  const passthrough: string[] = [];
  const taskParts: string[] = [];
  let headlessFlag = false;
  let modeValue: string | null = null;

  for (let i = 0; i < argsAfterRun.length; i++) {
    const token = argsAfterRun[i]!;

    if (token === '--headless') {
      headlessFlag = true;
      continue;
    }

    if (VALUE_OPTIONS.has(token)) {
      passthrough.push(token);
      const value = argsAfterRun[i + 1];
      if (value !== undefined) {
        passthrough.push(value);
        if (token === '--mode') {
          modeValue = value.toLowerCase();
        }
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

  // Hybrid: --headless with chat (or default) upgrades to chat-headless mode.
  if (headlessFlag) {
    const effective = modeValue ?? 'chat';
    if (effective === 'chat' || effective === 'chat-headless') {
      const withoutMode: string[] = [];
      for (let i = 0; i < passthrough.length; i++) {
        if (passthrough[i] === '--mode') {
          i++; // skip value
          continue;
        }
        withoutMode.push(passthrough[i]!);
      }
      passthrough.length = 0;
      passthrough.push(...withoutMode, '--mode', 'chat-headless');
    } else {
      // Non-chat modes ignore --headless for mode identity (still set env later if desired)
      passthrough.push('--headless');
    }
  }

  if (taskParts.length === 0) {
    return ['run', ...passthrough];
  }

  return ['run', ...passthrough, taskParts.join(' ')];
}

function rewriteDefaultTaskArgs(args: string[]): string[] {
  const rewritten = rewriteRunArgs(args);
  // Route bare tasks to chat mode — the default fast capable agent
  return rewritten[0] === 'run' ? ['run', '--mode', 'chat', ...rewritten.slice(1)] : rewritten;
}

export function rewriteArgv(argv: string[]): string[] {
  const head = argv.slice(0, 2);
  const tail = argv.slice(2);

  if (tail.length === 0) {
    return [...head, 'interactive'];
  }

  const first = tail[0]!;

  if (first === 'chat' || first === 'chat-headless') {
    // Hybrid (product lock): chat-headless remains a stable mode alias.
    // Preferred long-term form: `babel chat --headless` → same as chat-headless.
    const rest = tail.slice(1);
    if (first === 'chat' && rest.includes('--headless')) {
      const filtered = rest.filter((a) => a !== '--headless');
      return [...head, 'run', '--mode', 'chat-headless', ...filtered];
    }
    return [...head, 'run', '--mode', first, ...rest];
  }

  if (first === 'run') {
    return [...head, ...rewriteRunArgs(tail.slice(1))];
  }

  if (isTopLevelMetaToken(first) || first.startsWith('-')) {
    return argv;
  }

  // Known commands take priority over project name detection
  if (KNOWN_TOP_LEVEL_COMMANDS.has(first)) {
    return argv;
  }

  // Dynamic project detection via workspace scanner
  if (resolveProjectRoot(first) !== null) {
    if (tail.length === 1) {
      return [...head, 'interactive', '--project', first];
    }
    return [...head, ...rewriteRunArgs(['--project', first, ...tail.slice(1)])];
  }

  return [...head, ...rewriteDefaultTaskArgs(tail)];
}

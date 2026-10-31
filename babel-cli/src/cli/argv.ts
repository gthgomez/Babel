import { resolveProjectRoot } from './helpers.js';
import { DEPRECATED_SURFACE_COMMANDS } from './deprecation.js';

const VALUE_OPTIONS = new Set([
  '--connection',
  '--review',
  '-p',
  '--project',
  '--mode',
  '-m',
  '--model',
  '--model-tier',
  '--output-format',
  '--session-id',
  '--resume-chat',
  '--session-start-path',
  '--local-learning-root',
  '--orchestrator',
  '--execution-profile',
  '--execution-scope',
  '--resume-chat',
  '--project-root',
  '--trusted-git-common-dir',
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

  if (headlessFlag) passthrough.push('--headless');

  if (taskParts.length === 0) {
    return ['run', ...passthrough];
  }

  return ['run', ...passthrough, taskParts.join(' ')];
}

function rewriteDefaultTaskArgs(args: string[]): string[] {
  return rewriteRunArgs(args);
}

export function rewriteArgv(argv: string[], registeredCommands: ReadonlySet<string> = new Set()): string[] {
  const head = argv.slice(0, 2);
  const tail = argv.slice(2);

  if (tail.length === 0) {
    return [...head, 'interactive'];
  }

  const first = tail[0]!;
  const prefixLength = first === '--connection' ? 2 : first.startsWith('--connection=') ? 1 : 0;
  if (prefixLength && tail.length >= prefixLength) {
    const nested = rewriteArgv([...head, ...tail.slice(prefixLength)], registeredCommands);
    return [...head, ...tail.slice(0, prefixLength), ...nested.slice(2)];
  }

  if (first === 'work' || first === 'chat' || first === 'chat-headless') {
    // The literal chat-headless compatibility lane retains its old semantics.
    // The preferred --headless flag changes presentation only.
    const reviewIndex = tail.indexOf('--review');
    const hasReview = first === 'work' && reviewIndex >= 0;
    const review = hasReview ? tail[reviewIndex + 1] : undefined;
    if (hasReview && !['standard', 'thorough'].includes(review ?? '')) throw new Error('Review must be standard or thorough.');
    const thorough = review === 'thorough';
    const rest = tail.slice(1).filter((_value, index) => !hasReview || (index !== reviewIndex - 1 && index !== reviewIndex));
    if (review === 'standard') rest.push('--review', 'standard');
    if (thorough) return [...head, ...rewriteRunArgs(['--mode', 'deep', ...rest])];
    return [...head, ...rewriteRunArgs(['--mode', first === 'work' ? 'chat' : first, ...rest])];
  }

  if (first === 'run' && tail[1] === 'resume') return [...head, 'continue', ...tail.slice(2)];

  if (first === 'run') {
    return [...head, ...rewriteRunArgs(tail.slice(1))];
  }

  if (isTopLevelMetaToken(first) || first.startsWith('-')) {
    return argv;
  }

  // Known commands take priority over project name detection
  if (registeredCommands.has(first) || DEPRECATED_SURFACE_COMMANDS.has(first)) {
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

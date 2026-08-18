/**
 * commandSpec.ts — shared execution-risk + effect-family classification.
 *
 * One registry for the authority decoder and SafeExecutor. Completeness:
 * every globally allowlisted base and every execution-profile command
 * addition must have a spec. Unclassified executable-capable commands fail
 * closed.
 */

import { resolve } from 'node:path';

export type ExecutionRisk = 'intrinsic' | 'project_code' | 'container_only' | 'forbidden';

export type EffectFamily =
  | 'none'
  | 'git'
  | 'network'
  | 'package_manager'
  | 'host_package_manager'
  | 'android_device'
  | 'android_sdk'
  | 'compiler_or_build';

export interface CommandSpec {
  executionRisk: ExecutionRisk;
  effectFamily: EffectFamily;
}

export interface ClassifiedInvocation extends CommandSpec {
  base: string;
  reason?: string;
}

const spec = (executionRisk: ExecutionRisk, effectFamily: EffectFamily): CommandSpec => ({
  executionRisk,
  effectFamily,
});

/** Normalized bases only (path and .exe/.cmd/.bat already stripped). */
export const COMMAND_SPECS: Readonly<Record<string, CommandSpec>> = {
  rg: spec('intrinsic', 'none'),
  grep: spec('intrinsic', 'none'),
  findstr: spec('intrinsic', 'none'),
  cat: spec('intrinsic', 'none'),
  type: spec('intrinsic', 'none'),
  echo: spec('intrinsic', 'none'),
  dir: spec('intrinsic', 'none'),
  ls: spec('intrinsic', 'none'),
  which: spec('intrinsic', 'none'),
  diff: spec('intrinsic', 'none'),
  env: spec('intrinsic', 'none'),
  ping: spec('intrinsic', 'none'),

  git: spec('intrinsic', 'git'),

  node: spec('project_code', 'compiler_or_build'),
  nodejs: spec('project_code', 'compiler_or_build'),
  python: spec('project_code', 'compiler_or_build'),
  python3: spec('project_code', 'compiler_or_build'),
  py: spec('project_code', 'compiler_or_build'),
  ruby: spec('project_code', 'compiler_or_build'),
  perl: spec('project_code', 'compiler_or_build'),
  deno: spec('project_code', 'compiler_or_build'),
  tsx: spec('project_code', 'compiler_or_build'),
  'ts-node': spec('project_code', 'compiler_or_build'),
  bun: spec('project_code', 'compiler_or_build'),
  java: spec('project_code', 'compiler_or_build'),
  gradle: spec('project_code', 'compiler_or_build'),
  gradlew: spec('project_code', 'compiler_or_build'),
  pytest: spec('project_code', 'compiler_or_build'),
  cargo: spec('project_code', 'compiler_or_build'),
  go: spec('project_code', 'compiler_or_build'),
  dotnet: spec('project_code', 'compiler_or_build'),
  mvn: spec('project_code', 'compiler_or_build'),
  make: spec('project_code', 'compiler_or_build'),
  cmake: spec('project_code', 'compiler_or_build'),
  gcc: spec('project_code', 'compiler_or_build'),
  'g++': spec('project_code', 'compiler_or_build'),
  bash: spec('project_code', 'compiler_or_build'),
  sh: spec('project_code', 'compiler_or_build'),

  npm: spec('project_code', 'package_manager'),
  pnpm: spec('project_code', 'package_manager'),
  yarn: spec('project_code', 'package_manager'),
  pip: spec('project_code', 'package_manager'),
  pip3: spec('project_code', 'package_manager'),
  uv: spec('project_code', 'package_manager'),
  uvx: spec('project_code', 'package_manager'),

  winget: spec('intrinsic', 'host_package_manager'),
  sdkmanager: spec('intrinsic', 'android_sdk'),
  adb: spec('intrinsic', 'android_device'),

  curl: spec('intrinsic', 'network'),

  cp: spec('container_only', 'none'),
  mv: spec('container_only', 'none'),
  chmod: spec('container_only', 'none'),
  tar: spec('container_only', 'none'),
  gzip: spec('container_only', 'none'),
  gunzip: spec('container_only', 'none'),
  sed: spec('container_only', 'none'),
};

const GIT_INSPECT_VERBS = new Set([
  'status',
  'diff',
  'log',
  'show',
  'cat-file',
  'ls-files',
  'show-ref',
]);

const GIT_ALLOWED_FLAGS_NO_ARG = new Set(['--no-pager']);

export function normalizeExecutionBase(raw: string): string {
  const trimmed = raw.trim().replace(/\\/g, '/');
  const base = trimmed.split('/').pop() ?? trimmed;
  return base.replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
}

export function isProjectRelativeExecutable(rawCommand: string): boolean {
  const normalized = rawCommand.trim().replace(/\\/g, '/');
  return (
    normalized.startsWith('./') ||
    normalized.startsWith('/project/') ||
    normalized.startsWith('/app/')
  );
}

function firstToken(command: string): string {
  return command.trim().split(/\s+/)[0] ?? '';
}

function splitTokens(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean);
}

function gitGlobalDenied(flag: string): boolean {
  const lower = flag.toLowerCase();
  return (
    lower === '-c' ||
    lower.startsWith('-c') ||
    lower === '--config-env' ||
    lower.startsWith('--config-env=') ||
    lower === '--exec-path' ||
    lower.startsWith('--exec-path=') ||
    lower === '--git-dir' ||
    lower.startsWith('--git-dir=') ||
    lower === '--work-tree' ||
    lower.startsWith('--work-tree=') ||
    lower === '--namespace' ||
    lower.startsWith('--namespace=')
  );
}

function consumeEqualsOrNext(tokens: string[], i: number): number {
  const tok = tokens[i] ?? '';
  if (tok.includes('=') && !tok.startsWith('-c')) return i;
  return i + 1;
}

export function classifyGitExecutionRisk(
  tokens: readonly string[],
  repoRoot?: string,
): ClassifiedInvocation {
  const base = 'git';
  let i = 1;
  while (i < tokens.length) {
    const tok = tokens[i]!;
    if (tok === '--') {
      i += 1;
      break;
    }
    if (!tok.startsWith('-')) break;
    if (tok === '--no-pager') {
      i += 1;
      continue;
    }
    if (tok === '-C' || tok.startsWith('-C')) {
      const pathTok = tok === '-C' ? tokens[i + 1] : tok.slice(2);
      if (!pathTok) {
        return { base, executionRisk: 'forbidden', effectFamily: 'git', reason: 'git_global_option_denied' };
      }
      if (!repoRoot) {
        return { base, executionRisk: 'forbidden', effectFamily: 'git', reason: 'git_c_requires_repo' };
      }
      const resolved = resolve(repoRoot, pathTok);
      const root = resolve(repoRoot);
      if (resolved !== root && !resolved.startsWith(`${root}\\`) && !resolved.startsWith(`${root}/`)) {
        return { base, executionRisk: 'forbidden', effectFamily: 'git', reason: 'git_c_outside_repo' };
      }
      i = tok === '-C' ? i + 2 : i + 1;
      continue;
    }
    if (gitGlobalDenied(tok)) {
      return { base, executionRisk: 'forbidden', effectFamily: 'git', reason: 'git_global_option_denied' };
    }
    if (tok.startsWith('-') && tok !== '--no-pager' && !tok.startsWith('--')) {
      // Short flags that are not -C / -c are still global-unknown (e.g. -p after skip).
      return { base, executionRisk: 'forbidden', effectFamily: 'git', reason: 'git_global_option_denied' };
    }
    if (tok.startsWith('--')) {
      return { base, executionRisk: 'forbidden', effectFamily: 'git', reason: 'git_global_option_denied' };
    }
    i = consumeEqualsOrNext(tokens as string[], i) + 1;
  }

  const verb = (tokens[i] ?? '').toLowerCase();
  if (!verb) {
    return { base, executionRisk: 'forbidden', effectFamily: 'git', reason: 'git_missing_verb' };
  }

  const args = tokens.slice(i + 1);
  if (verb === 'commit' && args.some((a) => a === '-S' || a === '--gpg-sign' || a.startsWith('--gpg-sign='))) {
    return { base, executionRisk: 'forbidden', effectFamily: 'git', reason: 'git_gpg_sign_denied' };
  }
  if (verb === 'pull') {
    return { base, executionRisk: 'project_code', effectFamily: 'git', reason: 'git_pull_requires_isolation' };
  }
  if (GIT_INSPECT_VERBS.has(verb)) {
    return { base, executionRisk: 'intrinsic', effectFamily: 'git' };
  }
  return { base, executionRisk: 'intrinsic', effectFamily: 'git' };
}

export function classifyExecutionRisk(
  command: string,
  opts: { repoRoot?: string } = {},
): ClassifiedInvocation {
  const trimmed = command.trim();
  if (!trimmed) {
    return { base: '', executionRisk: 'forbidden', effectFamily: 'none', reason: 'empty_command' };
  }
  if (isProjectRelativeExecutable(trimmed)) {
    return {
      base: normalizeExecutionBase(firstToken(trimmed)),
      executionRisk: 'project_code',
      effectFamily: 'compiler_or_build',
      reason: 'project_relative_executable',
    };
  }
  const tokens = splitTokens(trimmed);
  const base = normalizeExecutionBase(tokens[0] ?? '');
  if (base === 'git') return classifyGitExecutionRisk(tokens, opts.repoRoot);
  const found = COMMAND_SPECS[base];
  if (!found) {
    return { base, executionRisk: 'forbidden', effectFamily: 'none', reason: 'unclassified_executable' };
  }
  return { base, ...found };
}

export function requiresDockerIsolation(risk: ExecutionRisk): boolean {
  return risk === 'project_code' || risk === 'container_only';
}

export function registeredExecutionBases(): readonly string[] {
  return Object.keys(COMMAND_SPECS).sort((a, b) => a.localeCompare(b));
}

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';

import { BABEL_ROOT } from '../cli/constants.js';
import { SafeExecutor, type ToolResult } from '../sandbox.js';
import { analyzeProjectRoot, type ProjectOnboardingReport } from './projectOnboarding.js';

export interface ApprovedWorkspaceRoot {
  readonly path: string;
  readonly exists: boolean;
  readonly aliases: string[];
}

export interface WorkspacePolicyStatus {
  readonly status: 'ok';
  readonly approved_roots: ApprovedWorkspaceRoot[];
  readonly web_policy: 'denied_for_opencalw_manager';
  readonly dependency_install_policy: 'ask_first';
  readonly execution_profile: 'opencalw_manager';
}

export interface WorkspaceFileEntry {
  readonly path: string;
  readonly relative_path: string;
  readonly type: 'file' | 'directory';
  readonly size_bytes: number | null;
}

export interface WorkspaceFileList {
  readonly status: 'ok';
  readonly root: string;
  readonly entries: WorkspaceFileEntry[];
  readonly truncated: boolean;
  readonly approved_roots: string[];
}

export interface WorkspaceFileRead {
  readonly status: 'ok';
  readonly path: string;
  readonly size_bytes: number;
  readonly content: string;
  readonly approved_roots: string[];
}

export interface WorkspaceCommandResult {
  readonly command: string;
  readonly exit_code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly duration_ms: number;
}

export interface WorkspaceVerifyReport {
  readonly status: 'pass' | 'fail' | 'no_commands';
  readonly project_root: string;
  readonly execution_profile: 'opencalw_manager';
  readonly onboarding: ProjectOnboardingReport;
  readonly selected_commands: string[];
  readonly command_results: WorkspaceCommandResult[];
  readonly approved_roots: string[];
}

const DEFAULT_WORKSPACE_APPROVED_ROOTS_NOTE =
  'By default Babel trusts repos under the workspace root. Set BABEL_example_autonomous_agent_APPROVED_ROOTS to a semicolon-separated allowlist for a tighter boundary.';

function workspaceRoot(): string {
  return resolve(process.env['BABEL_WORKSPACE_ROOT']?.trim() || resolve(BABEL_ROOT, '..'));
}

function normalizeRoot(path: string): string {
  const resolved = resolve(path);
  return existsSync(resolved) ? realpathSync(resolved) : resolved;
}

function toPosixPath(path: string): string {
  return path.replace(/\\/g, '/');
}

function splitRoots(raw: string): string[] {
  return raw
    .split(/[;\n]+/)
    .map(value => value.trim())
    .filter(value => value.length > 0);
}

export function getexample_autonomous_agentApprovedRoots(): ApprovedWorkspaceRoot[] {
  const explicitRoots = process.env['BABEL_example_autonomous_agent_APPROVED_ROOTS']?.trim();
  const roots = explicitRoots && explicitRoots.length > 0
    ? splitRoots(explicitRoots)
    : [workspaceRoot()];

  return [...new Set(roots.map(normalizeRoot))]
    .map(path => ({ path, exists: existsSync(path), aliases: buildexample_autonomous_agentPathAliases(path) }));
}

export function getWorkspacePolicyStatus(): WorkspacePolicyStatus {
  return {
    status: 'ok',
    approved_roots: getexample_autonomous_agentApprovedRoots(),
    web_policy: 'denied_for_opencalw_manager',
    dependency_install_policy: 'ask_first',
    execution_profile: 'opencalw_manager',
  };
}

function isInside(root: string, candidate: string): boolean {
  const resolvedRoot = normalizeRoot(root);
  const resolvedCandidate = existsSync(candidate) ? realpathSync(candidate) : resolve(candidate);

  if (process.platform === 'win32') {
    const rootNorm = resolvedRoot.toLowerCase();
    const candidateNorm = resolvedCandidate.toLowerCase();
    return candidateNorm === rootNorm || candidateNorm.startsWith(`${rootNorm}${sep}`);
  }

  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${sep}`);
}

function buildexample_autonomous_agentPathAliases(root: string): string[] {
  const workspace = normalizeRoot(workspaceRoot());
  const relativeFromWorkspace = relative(workspace, root);
  if (
    relativeFromWorkspace === '' ||
    relativeFromWorkspace.startsWith('..') ||
    relativeFromWorkspace.startsWith(`..${sep}`)
  ) {
    return [];
  }

  const posixRelative = toPosixPath(relativeFromWorkspace);
  return [
    `/workspace/${posixRelative}`,
    `/workspace/repos/${posixRelative}`,
    `repos/${posixRelative}`,
  ];
}

function mapSandboxRelativePath(pathArg: string): string[] {
  const trimmed = pathArg.trim();
  if (!trimmed) {
    return [];
  }

  const normalized = toPosixPath(trimmed).replace(/^\/+/, '');
  const candidates: string[] = [];

  const addWorkspaceRelative = (relativePath: string): void => {
    const cleaned = relativePath.replace(/^\/+/, '');
    if (!cleaned || cleaned.startsWith('context/')) {
      return;
    }
    const withoutWorkspace = cleaned.startsWith('workspace/')
      ? cleaned.slice('workspace/'.length)
      : cleaned;
    const withoutRepos = withoutWorkspace.startsWith('repos/')
      ? withoutWorkspace.slice('repos/'.length)
      : withoutWorkspace;
    if (withoutRepos && !withoutRepos.startsWith('context/')) {
      candidates.push(resolve(workspaceRoot(), withoutRepos));
    }
  };

  if (normalized.startsWith('workspace/')) {
    addWorkspaceRelative(normalized);
  }
  if (normalized.startsWith('repos/')) {
    addWorkspaceRelative(normalized);
  }

  const lower = toPosixPath(trimmed).toLowerCase();
  const sandboxRoot = process.env['BABEL_example_autonomous_agent_SANDBOX_ROOT']?.trim();
  if (sandboxRoot) {
    const normalizedSandboxRoot = toPosixPath(resolve(sandboxRoot)).replace(/\/+$/, '');
    const normalizedInput = toPosixPath(resolve(trimmed));
    if (normalizedInput.toLowerCase().startsWith(`${normalizedSandboxRoot.toLowerCase()}/`)) {
      addWorkspaceRelative(normalizedInput.slice(normalizedSandboxRoot.length + 1));
    }
  }

  const sandboxMarker = '/sandboxes/';
  const sandboxIndex = lower.indexOf(sandboxMarker);
  if (sandboxIndex >= 0) {
    const afterSandbox = toPosixPath(trimmed).slice(sandboxIndex + sandboxMarker.length);
    const firstSlash = afterSandbox.indexOf('/');
    if (firstSlash >= 0) {
      addWorkspaceRelative(afterSandbox.slice(firstSlash + 1));
    }
  }

  return candidates;
}

function candidateWorkspacePaths(pathArg: string): string[] {
  const candidates = [
    ...mapSandboxRelativePath(pathArg),
    resolve(pathArg),
  ];
  return [...new Set(candidates.map(candidate => resolve(candidate)))];
}

export function resolveApprovedWorkspacePath(pathArg: string): { path: string; approvedRoots: string[] } {
  const approvedRoots = getexample_autonomous_agentApprovedRoots().map(root => root.path);
  const targetPath = candidateWorkspacePaths(pathArg)
    .find(candidate => approvedRoots.some(root => isInside(root, candidate)));

  if (!targetPath) {
    const resolvedPath = resolve(pathArg);
    throw new Error(
      `Path is outside example_autonomous_agent approved workspace roots: ${resolvedPath}. ` +
      `Approved roots: ${approvedRoots.join('; ')}. ${DEFAULT_WORKSPACE_APPROVED_ROOTS_NOTE}`,
    );
  }

  return {
    path: existsSync(targetPath) ? realpathSync(targetPath) : targetPath,
    approvedRoots,
  };
}

function shouldSkipEntry(name: string): boolean {
  return name === '.git' ||
    name === 'node_modules' ||
    name === '.venv' ||
    name === 'dist' ||
    name === 'build' ||
    name === '.pytest_cache';
}

export function listWorkspaceFiles(
  pathArg: string,
  options: { recursive?: boolean; maxEntries?: number } = {},
): WorkspaceFileList {
  const resolved = resolveApprovedWorkspacePath(pathArg);
  if (!existsSync(resolved.path) || !statSync(resolved.path).isDirectory()) {
    throw new Error(`Workspace list target is not a directory: ${resolved.path}`);
  }

  const maxEntries = Math.max(1, options.maxEntries ?? 200);
  const entries: WorkspaceFileEntry[] = [];
  const visit = (dir: string): void => {
    if (entries.length >= maxEntries) {
      return;
    }

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entries.length >= maxEntries) {
        return;
      }
      if (shouldSkipEntry(entry.name)) {
        continue;
      }

      const fullPath = resolve(dir, entry.name);
      const stats = statSync(fullPath);
      const item: WorkspaceFileEntry = {
        path: fullPath,
        relative_path: relative(resolved.path, fullPath).replace(/\\/g, '/'),
        type: entry.isDirectory() ? 'directory' : 'file',
        size_bytes: entry.isFile() ? stats.size : null,
      };
      entries.push(item);

      if (options.recursive === true && entry.isDirectory()) {
        visit(fullPath);
      }
    }
  };

  visit(resolved.path);
  return {
    status: 'ok',
    root: resolved.path,
    entries,
    truncated: entries.length >= maxEntries,
    approved_roots: resolved.approvedRoots,
  };
}

export function readWorkspaceFile(
  pathArg: string,
  options: { maxBytes?: number } = {},
): WorkspaceFileRead {
  const resolved = resolveApprovedWorkspacePath(pathArg);
  if (!existsSync(resolved.path) || !statSync(resolved.path).isFile()) {
    throw new Error(`Workspace read target is not a file: ${resolved.path}`);
  }

  const size = statSync(resolved.path).size;
  const maxBytes = Math.max(1, options.maxBytes ?? 200_000);
  if (size > maxBytes) {
    throw new Error(`Workspace read target is too large: ${size} bytes exceeds ${maxBytes} byte limit.`);
  }

  return {
    status: 'ok',
    path: resolved.path,
    size_bytes: size,
    content: readFileSync(resolved.path, 'utf-8'),
    approved_roots: resolved.approvedRoots,
  };
}

function defaultVerifyCommands(report: ProjectOnboardingReport): string[] {
  return [
    ...report.recommended_commands.test,
    ...report.recommended_commands.build,
    ...report.recommended_commands.lint,
  ];
}

function withManagerEnv<T>(projectRoot: string, approvedRoots: string[], fn: () => T): T {
  const previousProfile = process.env['BABEL_EXECUTION_PROFILE'];
  const previousProjectRoot = process.env['BABEL_PROJECT_ROOT'];
  const previousAllowedRoots = process.env['BABEL_ALLOWED_ROOTS'];

  process.env['BABEL_EXECUTION_PROFILE'] = 'opencalw_manager';
  process.env['BABEL_PROJECT_ROOT'] = projectRoot;
  process.env['BABEL_ALLOWED_ROOTS'] = approvedRoots.join(',');

  try {
    return fn();
  } finally {
    if (previousProfile === undefined) {
      delete process.env['BABEL_EXECUTION_PROFILE'];
    } else {
      process.env['BABEL_EXECUTION_PROFILE'] = previousProfile;
    }

    if (previousProjectRoot === undefined) {
      delete process.env['BABEL_PROJECT_ROOT'];
    } else {
      process.env['BABEL_PROJECT_ROOT'] = previousProjectRoot;
    }

    if (previousAllowedRoots === undefined) {
      delete process.env['BABEL_ALLOWED_ROOTS'];
    } else {
      process.env['BABEL_ALLOWED_ROOTS'] = previousAllowedRoots;
    }
  }
}

export function verifyWorkspaceProject(
  pathArg: string,
  options: { commands?: string[]; timeoutSeconds?: number } = {},
): WorkspaceVerifyReport {
  const resolved = resolveApprovedWorkspacePath(pathArg);
  if (!existsSync(resolved.path) || !statSync(resolved.path).isDirectory()) {
    throw new Error(`Workspace verify target is not a directory: ${resolved.path}`);
  }

  const onboarding = analyzeProjectRoot(resolved.path);
  const selectedCommands = (options.commands && options.commands.length > 0
    ? options.commands
    : defaultVerifyCommands(onboarding))
    .map(command => command.trim())
    .filter(command => command.length > 0);

  const commandResults = withManagerEnv(resolved.path, resolved.approvedRoots, () => {
    const executor = new SafeExecutor(resolved.path);
    return selectedCommands.map(command => {
      const startedAt = Date.now();
      const result: ToolResult = executor.testRun(
        command,
        '.',
        Math.max(1, options.timeoutSeconds ?? 300) * 1000,
      );
      return {
        command,
        exit_code: result.exit_code,
        stdout: result.stdout,
        stderr: result.stderr,
        duration_ms: Date.now() - startedAt,
      };
    });
  });

  const status = selectedCommands.length === 0
    ? 'no_commands'
    : commandResults.every(result => result.exit_code === 0)
      ? 'pass'
      : 'fail';

  return {
    status,
    project_root: resolved.path,
    execution_profile: 'opencalw_manager',
    onboarding,
    selected_commands: selectedCommands,
    command_results: commandResults,
    approved_roots: resolved.approvedRoots,
  };
}

export function formatWorkspacePolicyHuman(status: WorkspacePolicyStatus): string {
  return [
    'example_autonomous_agent workspace manager policy:',
    `  Execution profile: ${status.execution_profile}`,
    `  Web: ${status.web_policy}`,
    `  Dependency installs: ${status.dependency_install_policy}`,
    '  Approved roots:',
    ...status.approved_roots.map(root => `    - ${root.path}${root.exists ? '' : ' (missing)'}`),
    `  Note: ${DEFAULT_WORKSPACE_APPROVED_ROOTS_NOTE}`,
  ].join('\n');
}

export function formatWorkspaceFileListHuman(list: WorkspaceFileList): string {
  return [
    `Workspace files: ${list.root}`,
    ...list.entries.map(entry =>
      `  ${entry.type === 'directory' ? 'dir ' : 'file'} ${entry.relative_path}${entry.size_bytes === null ? '' : ` (${entry.size_bytes} bytes)`}`,
    ),
    ...(list.truncated ? ['  ... truncated'] : []),
  ].join('\n');
}

export function formatWorkspaceVerifyHuman(report: WorkspaceVerifyReport): string {
  return [
    `Workspace verify: ${report.project_root}`,
    `Status: ${report.status}`,
    `Execution profile: ${report.execution_profile}`,
    `Commands: ${report.selected_commands.length > 0 ? report.selected_commands.join('; ') : '(none detected)'}`,
    ...report.command_results.map(result =>
      `  [${result.exit_code === 0 ? 'pass' : 'fail'}] ${result.command} (${result.duration_ms}ms)`,
    ),
  ].join('\n');
}

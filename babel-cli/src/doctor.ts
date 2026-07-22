import { spawnSync } from 'node:child_process';
import { type Dirent, existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';

import { loadEnterprisePolicy } from './config/enterprisePolicy.js';

export type DoctorStatus = 'pass' | 'warn' | 'fail' | 'skip';
export type DoctorOverallStatus = 'pass' | 'warn' | 'fail';
export type DoctorScope = 'all' | 'canonical' | 'release' | 'env' | 'workspace' | 'repos' | 'export' | 'enterprise';
export type DoctorMode = 'standard' | 'strict' | 'strict-enterprise';
export type DoctorDiagnosticCode =
  | 'ENV_SHELL_UNAVAILABLE'
  | 'POWERSHELL_UNAVAILABLE'
  | 'POWERSHELL_INCOMPATIBLE'
  | 'REPO_MISSING'
  | 'EXTERNAL_PREREQUISITE_MISSING'
  | 'DIST_MISSING'
  | 'PROVIDER_ENV_MISSING'
  | 'CATALOG_INVALID'
  | 'RESOLVER_INVALID';

export interface DoctorCheckResult {
  id: string;
  section: string;
  title: string;
  status: DoctorStatus;
  message: string;
  diagnostic_code?: DoctorDiagnosticCode;
  details?: string[];
  fixHint?: string;
}

export interface DoctorRunResult {
  status: DoctorOverallStatus;
  workspaceRoot: string;
  mode: DoctorMode;
  scope: DoctorScope;
  checks: DoctorCheckResult[];
  summary: {
    pass: number;
    warn: number;
    fail: number;
    skip: number;
  };
}

export interface DoctorOptions {
  babelRoot: string;
  strict: boolean;
  strictEnterprise?: boolean;
  verbose: boolean;
  scope: DoctorScope;
  env?: NodeJS.ProcessEnv;
  shellProbe?: ShellProbeRunner;
  powerShellProbe?: ShellProbeRunner;
  powerShellRunner?: PowerShellScriptRunner;
}

export interface ShellProbeResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
  diagnostic_code?: DoctorDiagnosticCode;
}

export type ShellProbeRunner = () => ShellProbeResult;

export interface PowerShellScriptResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
  diagnostic_code?: DoctorDiagnosticCode;
  shell?: string;
}

export type PowerShellScriptRunner = (scriptPath: string, args: string[]) => PowerShellScriptResult;

interface RepoResolutionCase {
  key: string;
  project: string;
  taskCategory: string;
}

interface RepoMapResult {
  checks: DoctorCheckResult[];
  repoMap: Record<string, string> | null;
  externalPrerequisites: Set<string>;
}

interface ExternalRepoPrerequisite {
  label: string;
  reason: string;
  fixHint: string;
}

const REQUIRED_REPO_KEYS = [
  'babel_private',
  'babel_public',
  'example_saas_backend',
  'example_llm_router',
  'example_web_audit',
  'example_mobile_suite',
  'example_game_workspace',
  'example_game_suite',
  'example_autonomous_agent',
  'example_mobile_reference',
] as const;

const CORE_REPO_CASES: RepoResolutionCase[] = [
  { key: 'example_saas_backend', project: 'example_saas_backend', taskCategory: 'frontend' },
  { key: 'example_llm_router', project: 'example_llm_router', taskCategory: 'frontend' },
  { key: 'example_web_audit', project: 'example_web_audit', taskCategory: 'backend' },
  { key: 'example_mobile_suite', project: 'example_mobile_suite', taskCategory: 'mobile' },
  { key: 'example_game_workspace', project: 'example_game_workspace', taskCategory: 'game' },
  { key: 'example_game_suite', project: 'example_game_suite', taskCategory: 'game' },
  { key: 'example_autonomous_agent', project: 'example_autonomous_agent', taskCategory: 'research' },
  { key: 'example_mobile_reference', project: 'example_mobile_reference', taskCategory: 'research' },
];

const DOCUMENTED_EXTERNAL_REPO_PREREQUISITES: Record<string, ExternalRepoPrerequisite> = {
  example_game_suite: {
    label: 'ExampleGameProject sample game repo',
    reason: 'Optional external game workspace used by game-routing demos, not required for Babel CLI release readiness.',
    fixHint: 'Clone or restore example_game_workspace\\ExampleGameProject when game demo coverage is required, or keep this warning as an accepted external prerequisite.',
  },
};

// Configurable via BABEL_LEGACY_PATHS env var (comma-separated path fragments to detect).
// Defaults to empty so developer-local paths are not embedded in packaged builds.
const LEGACY_PATTERNS: string[] = (process.env['BABEL_LEGACY_PATHS'] ?? '')
  .split(',')
  .map((p) => p.trim())
  .filter((p) => p.length > 0);

const PLACEHOLDER_PROJECT_PATTERNS = [
  '<YOUR_PROJECT_ROOT>',
  '<YOUR_WORKSPACE_ROOT>',
  '\\u003cYOUR_PROJECT_ROOT\\u003e',
  '\\u003cYOUR_WORKSPACE_ROOT\\u003e',
];

const TEXT_EXTENSIONS = new Set([
  '.md',
  '.yaml',
  '.yml',
  '.json',
  '.jsonl',
  '.ps1',
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.txt',
  '.d.ts',
]);

const RUNTIME_SURFACES = [
  'babel-cli',
  'tools',
  'package.json',
  'prompt_catalog.yaml',
  'PROJECT_CONTEXT.md',
];

function createCheck(
  section: string,
  id: string,
  title: string,
  status: DoctorStatus,
  message: string,
  details?: string[],
  fixHint?: string,
  diagnosticCode?: DoctorDiagnosticCode,
): DoctorCheckResult {
  return {
    id,
    section,
    title,
    status,
    message,
    ...(diagnosticCode ? { diagnostic_code: diagnosticCode } : {}),
    ...(details && details.length > 0 ? { details } : {}),
    ...(fixHint ? { fixHint } : {}),
  };
}

function shouldRunSection(scope: DoctorScope, section: string): boolean {
  if (scope === 'all') return section === 'Runtime';
  if (scope === 'canonical') return section === 'Runtime';
  if (scope === 'release' || scope === 'export') return section === 'Release';
  if (scope === 'env') {
    return section === 'Environment';
  }
  if (scope === 'workspace') {
    return section === 'Workspace' || section === 'Runtime' || section === 'Legacy Path Drift';
  }
  if (scope === 'repos') {
    return section === 'Repo Map' || section === 'Resolution';
  }
  if (scope === 'enterprise') {
    return section === 'Enterprise Policy';
  }
  return false;
}

function summarizeChecks(checks: DoctorCheckResult[]): DoctorRunResult['summary'] {
  return checks.reduce<DoctorRunResult['summary']>((acc, check) => {
    acc[check.status] += 1;
    return acc;
  }, { pass: 0, warn: 0, fail: 0, skip: 0 });
}

function determineOverallStatus(checks: DoctorCheckResult[], strict: boolean): DoctorOverallStatus {
  if (checks.some((check) => check.status === 'fail')) {
    return 'fail';
  }
  if (strict && checks.some((check) => check.status === 'warn')) {
    return 'fail';
  }
  if (checks.some((check) => check.status === 'warn')) {
    return 'warn';
  }
  return 'pass';
}

function getWorkspaceRoot(babelRoot: string): string {
  return dirname(resolve(babelRoot));
}

function getRepoMapPath(workspaceRoot: string): string {
  return process.env['BABEL_REPO_MAP_PATH'] ?? join(workspaceRoot, 'config', 'repo-map.json');
}

function getDocumentedExternalPrerequisite(key: string): ExternalRepoPrerequisite | undefined {
  return DOCUMENTED_EXTERNAL_REPO_PREREQUISITES[key];
}

function parseRepoMapExternalPrerequisites(parsed: unknown): Set<string> {
  const externalPrerequisites = new Set<string>();
  if (!Array.isArray((parsed as { external_prerequisites?: unknown }).external_prerequisites)) {
    return externalPrerequisites;
  }

  for (const item of (parsed as { external_prerequisites?: unknown[] }).external_prerequisites!) {
    if (typeof item !== 'string') continue;
    const value = item.trim();
    if (value.length > 0) {
      externalPrerequisites.add(value);
    }
  }
  return externalPrerequisites;
}

function getPreferredPowerShellShells(): string[] {
  return process.platform === 'win32' ? ['pwsh', 'powershell'] : ['pwsh'];
}

function runPowerShellScript(scriptPath: string, args: string[]): PowerShellScriptResult {
  const preferredShells = process.platform === 'win32' ? ['pwsh', 'powershell'] : ['pwsh'];
  const spawnErrors: string[] = [];
  let blockedByEnvironment = false;

  for (const shell of preferredShells) {
    const result = spawnSync(
      shell,
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args],
      { encoding: 'utf8' },
    );

    if (result.error) {
      const error = result.error as NodeJS.ErrnoException;
      blockedByEnvironment = blockedByEnvironment || error.code === 'EPERM' || error.code === 'EACCES';
      spawnErrors.push(`${shell}: ${error.code ?? error.name}: ${error.message}`);
      continue;
    }

    return {
      exitCode: result.status ?? 1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      shell,
    };
  }

  return {
    exitCode: 1,
    stdout: '',
    stderr: spawnErrors.join('\n'),
    error: blockedByEnvironment
      ? 'Environment shell is unavailable or blocked while probing PowerShell.'
      : 'No compatible PowerShell runtime found.',
    diagnostic_code: blockedByEnvironment ? 'ENV_SHELL_UNAVAILABLE' : 'POWERSHELL_UNAVAILABLE',
  };
}

function runEnvironmentChecks(
  env: NodeJS.ProcessEnv,
  verbose: boolean,
  shellProbe: ShellProbeRunner = probeEnvironmentShell,
  powerShellProbe: ShellProbeRunner = probePowerShellRuntime,
): DoctorCheckResult[] {
  const checks: DoctorCheckResult[] = [];
  const shell = shellProbe();
  checks.push(createCheck(
    'Environment',
    'env.shell.available',
    'Environment shell can spawn commands',
    shell.exitCode === 0 ? 'pass' : 'fail',
    shell.exitCode === 0 ? 'Environment shell probe passed' : (shell.error ?? 'Environment shell probe failed'),
    verbose ? [shell.stdout.trim(), shell.stderr.trim()].filter((line) => line.length > 0) : undefined,
    shell.exitCode === 0 ? undefined : 'Check shell availability and process-spawn restrictions before diagnosing repo failures.',
    shell.exitCode === 0 ? undefined : (shell.diagnostic_code ?? 'ENV_SHELL_UNAVAILABLE'),
  ));

  const powerShell = powerShellProbe();
  checks.push(createCheck(
    'Environment',
    'env.powershell.available',
    'PowerShell runtime available',
    powerShell.exitCode === 0 ? 'pass' : 'fail',
    powerShell.exitCode === 0
      ? `PowerShell probe passed${powerShell.stdout.trim() ? ` (${powerShell.stdout.trim()})` : ''}`
      : (powerShell.error ?? 'PowerShell probe failed'),
    verbose ? [powerShell.stdout.trim(), powerShell.stderr.trim()].filter((line) => line.length > 0) : undefined,
    powerShell.exitCode === 0 ? undefined : 'Install PowerShell 7+ (`pwsh`) or Windows PowerShell, then rerun doctor.',
    powerShell.exitCode === 0 ? undefined : (powerShell.diagnostic_code ?? 'POWERSHELL_UNAVAILABLE'),
  ));

  const providerKeys = [
    ['DEEPINFRA_API_KEY', env['DEEPINFRA_API_KEY']],
    ['ANTHROPIC_API_KEY', env['ANTHROPIC_API_KEY']],
    ['GROQ_API_KEY', env['GROQ_API_KEY']],
    ['OPENAI_API_KEY', env['OPENAI_API_KEY']],
  ] as const;
  const presentProviders = providerKeys.filter(([, value]) => typeof value === 'string' && value.trim().length > 0);
  checks.push(createCheck(
    'Environment',
    'env.provider.any_key_present',
    'Provider environment key present',
    presentProviders.length > 0 ? 'pass' : 'warn',
    presentProviders.length > 0
      ? `Provider env key(s) present: ${presentProviders.map(([key]) => key).join(', ')}`
      : 'No provider API key detected; live provider-backed governance tests will be unavailable.',
    verbose ? providerKeys.map(([key, value]) => `${key}=${typeof value === 'string' && value.trim().length > 0 ? '<set>' : '<missing>'}`) : undefined,
    presentProviders.length > 0 ? undefined : 'Set a provider API key or use recorded-provider replay fixtures for governance proof.',
    presentProviders.length > 0 ? undefined : 'PROVIDER_ENV_MISSING',
  ));

  return checks;
}

function probeEnvironmentShell(): ShellProbeResult {
  const command = process.platform === 'win32'
    ? (process.env['ComSpec'] ?? 'cmd.exe')
    : '/bin/sh';
  const args = process.platform === 'win32'
    ? ['/d', '/s', '/c', 'echo babel-doctor-shell-ok']
    : ['-c', 'echo babel-doctor-shell-ok'];
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 15_000,
  });
  if (result.error) {
    const error = result.error as NodeJS.ErrnoException;
    return {
      exitCode: 1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      error: `${error.code ?? error.name}: ${error.message}`,
      diagnostic_code: 'ENV_SHELL_UNAVAILABLE',
    };
  }
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ...(result.status === 0 ? {} : {
      error: `Shell exited with code ${result.status ?? 1}`,
      diagnostic_code: 'ENV_SHELL_UNAVAILABLE' as const,
    }),
  };
}

function probePowerShellRuntime(): ShellProbeResult {
  const errors: string[] = [];
  let incompatible = false;
  let blockedByEnvironment = false;
  for (const shell of getPreferredPowerShellShells()) {
    const result = spawnSync(
      shell,
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', '$PSVersionTable.PSVersion.ToString()'],
      { encoding: 'utf8', timeout: 15_000 },
    );
    if (result.error) {
      const error = result.error as NodeJS.ErrnoException;
      blockedByEnvironment = blockedByEnvironment || error.code === 'EPERM' || error.code === 'EACCES';
      errors.push(`${shell}: ${error.code ?? error.name}: ${error.message}`);
      continue;
    }
    if (result.status === 0) {
      return {
        exitCode: 0,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
      };
    }
    incompatible = true;
    errors.push(`${shell}: exit=${result.status ?? 1}; stderr=${(result.stderr ?? '').trim()}`);
  }

  const diagnosticCode: DoctorDiagnosticCode = blockedByEnvironment
    ? 'ENV_SHELL_UNAVAILABLE'
    : incompatible ? 'POWERSHELL_INCOMPATIBLE' : 'POWERSHELL_UNAVAILABLE';
  return {
    exitCode: 1,
    stdout: '',
    stderr: errors.join('\n'),
    error: diagnosticCode === 'ENV_SHELL_UNAVAILABLE'
      ? 'Environment blocked PowerShell process creation.'
      : diagnosticCode === 'POWERSHELL_INCOMPATIBLE'
        ? 'PowerShell was found but did not run a compatibility probe successfully.'
        : 'No compatible PowerShell runtime found.',
    diagnostic_code: diagnosticCode,
  };
}

function runWorkspaceChecks(babelRoot: string, workspaceRoot: string, repoMapPath: string, verbose: boolean): DoctorCheckResult[] {
  const checks: DoctorCheckResult[] = [];
  const workspaceFile = join(workspaceRoot, 'Workspace.code-workspace');
  const catalogPath = join(babelRoot, 'prompt_catalog.yaml');
  const babelPublicPath = [
    join(workspaceRoot, 'Project_Public', 'Babel-public'),
    join(workspaceRoot, 'Babel-public'),
  ].find((candidate) => existsSync(candidate)) ?? join(workspaceRoot, 'Project_Public', 'Babel-public');

  checks.push(createCheck(
    'Workspace',
    'workspace.root.exists',
    'Workspace root exists',
    existsSync(workspaceRoot) ? 'pass' : 'fail',
    existsSync(workspaceRoot) ? `Workspace root exists at ${workspaceRoot}` : `Workspace root missing: ${workspaceRoot}`,
    verbose ? [workspaceRoot] : undefined,
  ));

  for (const [id, title, path] of [
    ['workspace.babel_private.exists', 'private source repo exists', join(workspaceRoot, 'private source repo')],
    ['workspace.babel_public.exists', 'Babel-public exists', babelPublicPath],
    ['workspace.repo_map.exists', 'Repo map exists', repoMapPath],
  ] as const) {
    checks.push(createCheck(
      'Workspace',
      id,
      title,
      existsSync(path) ? 'pass' : 'fail',
      existsSync(path) ? title : `Missing required path: ${path}`,
      verbose ? [path] : undefined,
    ));
  }

  let catalogMessage = 'prompt_catalog.yaml has required version and entries keys';
  let catalogStatus: DoctorStatus = 'pass';
  let catalogDetails: string[] | undefined = verbose ? [catalogPath] : undefined;
  if (!existsSync(catalogPath)) {
    catalogStatus = 'fail';
    catalogMessage = `prompt_catalog.yaml missing at ${catalogPath}`;
  } else {
    const content = readFileSync(catalogPath, 'utf8');
    const missingKeys = [
      /^version:\s*\S+/m.test(content) ? null : 'version',
      /^entries:\s*$/m.test(content) ? null : 'entries',
    ].filter((value): value is string => value !== null);
    if (missingKeys.length > 0) {
      catalogStatus = 'fail';
      catalogMessage = `prompt_catalog.yaml is missing required key(s): ${missingKeys.join(', ')}`;
      catalogDetails = verbose ? [catalogPath, ...missingKeys] : undefined;
    }
  }

  checks.push(createCheck(
    'Workspace',
    'catalog.prompt_catalog.valid',
    'Prompt catalog has minimal valid shape',
    catalogStatus,
    catalogMessage,
    catalogDetails,
    catalogStatus === 'pass' ? undefined : 'Run tools/validate-catalog.ps1 and repair prompt_catalog.yaml.',
    catalogStatus === 'pass' ? undefined : 'CATALOG_INVALID',
  ));

  checks.push(createCheck(
    'Workspace',
    'workspace.code_workspace.exists',
    'Workspace file presence',
    existsSync(workspaceFile) ? 'pass' : 'warn',
    existsSync(workspaceFile) ? 'Workspace.code-workspace found' : 'Workspace.code-workspace not found',
    verbose ? [workspaceFile] : undefined,
  ));

  return checks;
}

function runRepoMapChecks(workspaceRoot: string, repoMapPath: string, verbose: boolean): RepoMapResult {
  const checks: DoctorCheckResult[] = [];
  const emptyResult: RepoMapResult = { checks, repoMap: null, externalPrerequisites: new Set<string>() };

  if (!existsSync(repoMapPath)) {
    checks.push(createCheck(
      'Repo Map',
      'repo_map.parse',
      'repo-map.json parsed successfully',
      'fail',
      `repo-map.json missing at ${repoMapPath}`,
      verbose ? [repoMapPath] : undefined,
    ));
    return emptyResult;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(repoMapPath, 'utf8'));
    checks.push(createCheck(
      'Repo Map',
      'repo_map.parse',
      'repo-map.json parsed successfully',
      'pass',
      'repo-map.json parsed successfully',
      verbose ? [repoMapPath] : undefined,
    ));
  } catch (error: unknown) {
    checks.push(createCheck(
      'Repo Map',
      'repo_map.parse',
      'repo-map.json parsed successfully',
      'fail',
      `repo-map.json is malformed: ${error instanceof Error ? error.message : String(error)}`,
      verbose ? [repoMapPath] : undefined,
    ));
    return emptyResult;
  }

  const repoMap = (parsed as { repos?: Record<string, unknown> }).repos;
  if (!repoMap || typeof repoMap !== 'object') {
    checks.push(createCheck(
      'Repo Map',
      'repo_map.shape',
      'repo-map.json has repos object',
      'fail',
      'repo-map.json must contain a top-level "repos" object',
    ));
    return emptyResult;
  }

  const configuredExternalPrerequisites = parseRepoMapExternalPrerequisites(parsed);
  const missingExternalPrerequisites = new Set<string>();

  const missingKeys = REQUIRED_REPO_KEYS.filter((key) => typeof repoMap[key] !== 'string');
  checks.push(createCheck(
    'Repo Map',
    'repo_map.required_keys',
    'Required keys present',
    missingKeys.length === 0 ? 'pass' : 'fail',
    missingKeys.length === 0
      ? 'Required repo-map keys are present'
      : `Missing required repo-map keys: ${missingKeys.join(', ')}`,
    verbose && missingKeys.length > 0 ? missingKeys : undefined,
  ));

  const missingPaths: string[] = [];
  const externalMissingPaths: string[] = [];
  const outsideWorkspace: string[] = [];
  const normalized: Record<string, string> = {};

  for (const [key, value] of Object.entries(repoMap)) {
    if (typeof value !== 'string') continue;
    normalized[key] = value;
    if (!existsSync(value)) {
      if (configuredExternalPrerequisites.has(key) || getDocumentedExternalPrerequisite(key)) {
        missingExternalPrerequisites.add(key);
        externalMissingPaths.push(`${key} -> ${value}`);
      } else {
        missingPaths.push(`${key} -> ${value}`);
      }
      continue;
    }

    const resolvedPath = resolve(value);
    const relativePath = relative(workspaceRoot, resolvedPath);
    if (relativePath.startsWith('..') || relativePath.includes(`..${sep}`)) {
      outsideWorkspace.push(`${key} -> ${resolvedPath}`);
    }
  }

  checks.push(createCheck(
    'Repo Map',
    'repo_map.paths_exist',
    'All mapped paths exist',
    missingPaths.length === 0 && externalMissingPaths.length === 0
      ? 'pass'
      : externalMissingPaths.length > 0 && missingPaths.length === 0
        ? 'warn'
        : 'fail',
    missingPaths.length === 0 && externalMissingPaths.length === 0
      ? 'All mapped repo paths exist'
      : missingPaths.length > 0
        ? `Missing mapped repo paths: ${missingPaths.join('; ')}`
        : `Missing mapped repo paths are documented as external prerequisites: ${externalMissingPaths.join('; ')}`,
    verbose
      ? [
        ...missingPaths,
        ...externalMissingPaths.map((value) => `external prerequisite: ${value}`),
      ].filter((value) => value.length > 0)
      : undefined,
    externalMissingPaths.length > 0 && missingPaths.length === 0
      ? 'These repo-map entries are documented external prerequisites; restore if you need local resolver coverage.'
      : missingPaths.length > 0
        ? 'Repair config/repo-map.json or restore the missing repo path.'
        : undefined,
    missingPaths.length > 0
      ? 'REPO_MISSING'
      : externalMissingPaths.length > 0 ? 'EXTERNAL_PREREQUISITE_MISSING' : undefined,
  ));

  const knownExternalPrerequisites = new Set([
    ...configuredExternalPrerequisites,
    ...missingExternalPrerequisites,
  ]);

  checks.push(createCheck(
    'Repo Map',
    'repo_map.external_prerequisites',
    'External prerequisites are documented',
    'pass',
    knownExternalPrerequisites.size === 0
      ? 'No repo-map external prerequisites are configured'
      : `Known repo-map external prerequisites: ${[...knownExternalPrerequisites].join(', ')}`,
    verbose && knownExternalPrerequisites.size > 0
      ? [...knownExternalPrerequisites].map((key) => {
        const prerequisite = getDocumentedExternalPrerequisite(key);
        return prerequisite ? `${key}: ${prerequisite.reason}` : key;
      })
      : undefined,
  ));

  checks.push(createCheck(
    'Repo Map',
    'repo_map.workspace_consistency',
    'Mapped paths stay inside workspace root',
    outsideWorkspace.length === 0 ? 'pass' : 'warn',
    outsideWorkspace.length === 0
      ? 'All mapped paths resolve inside the workspace root'
      : 'Some mapped paths resolve outside the workspace root',
    verbose && outsideWorkspace.length > 0 ? outsideWorkspace : undefined,
  ));

  return { checks, repoMap: normalized, externalPrerequisites: missingExternalPrerequisites };
}

function runRuntimeChecks(babelRoot: string, verbose: boolean): DoctorCheckResult[] {
  const checks: DoctorCheckResult[] = [];
  const runtimeTargets = [
    ['runtime.package_json', 'CLI package.json found', join(babelRoot, 'babel-cli', 'package.json')],
    ['runtime.cli_entrypoint', 'CLI entrypoint found', join(babelRoot, 'babel-cli', 'dist', 'index.js')],
    ['runtime.resolver_script', 'Resolver script found', join(babelRoot, 'tools', 'resolve-local-stack.ps1')],
    ['runtime.content_policy', 'Public content policy found', join(babelRoot, 'tools', 'check-public-content-policy.ps1')],
    ['runtime.canonical_policy', 'Canonical independence policy found', join(babelRoot, 'tools', 'check-canonical-independence.ps1')],
  ] as const;

  for (const [id, title, targetPath] of runtimeTargets) {
    const exists = existsSync(targetPath);
    const diagnosticCode = !exists && id === 'runtime.cli_entrypoint' ? 'DIST_MISSING' : undefined;
    checks.push(createCheck(
      'Runtime',
      id,
      title,
      exists ? 'pass' : 'fail',
      exists ? title : `Missing required runtime surface: ${targetPath}`,
      verbose ? [targetPath] : undefined,
      diagnosticCode ? 'Run npm --prefix .\\babel-cli run build before invoking dist-first CLI checks.' : undefined,
      diagnosticCode,
    ));
  }

  return checks;
}

function runResolutionChecks(
  babelRoot: string,
  verbose: boolean,
  repoMap: Record<string, string> | null,
  externalPrerequisites: Set<string> = new Set<string>(),
  powerShellRunner: PowerShellScriptRunner = runPowerShellScript,
): DoctorCheckResult[] {
  const checks: DoctorCheckResult[] = [];
  const resolverPath = join(babelRoot, 'tools', 'resolve-local-stack.ps1');

  if (!existsSync(resolverPath)) {
    return [
      createCheck(
        'Resolution',
        'resolution.resolver_present',
        'Resolver script available',
        'fail',
        `Resolver script missing: ${resolverPath}`,
        verbose ? [resolverPath] : undefined,
        'Restore tools/resolve-local-stack.ps1 before diagnosing repo routing.',
        'RESOLVER_INVALID',
      ),
    ];
  }

  for (const repo of CORE_REPO_CASES) {
    if (externalPrerequisites.has(repo.key)) {
      checks.push(createCheck(
        'Resolution',
        `resolution.${repo.key}`,
        `Resolved ${repo.key}`,
        'warn',
        `Resolver validation is skipped for documented external prerequisite: ${repo.key}`,
        verbose ? [`Mapped path is documented as external prerequisite in repo-map.json`] : undefined,
        'Resolver is intentionally skipped while this repository remains external in this workspace.',
        'EXTERNAL_PREREQUISITE_MISSING',
      ));
      continue;
    }

    const mappedPath = repoMap?.[repo.key];
    const resolverArgs = [
      '-TaskCategory', repo.taskCategory,
      '-Project', repo.project,
      '-Model', 'codex',
      '-PipelineMode', 'verified',
      '-Format', 'json',
      '-Root', babelRoot,
    ];
    if (mappedPath) {
      resolverArgs.push('-ProjectPath', mappedPath);
    }
    const result = powerShellRunner(resolverPath, resolverArgs);

    if (result.error) {
      if (result.diagnostic_code === 'ENV_SHELL_UNAVAILABLE' ||
        result.diagnostic_code === 'POWERSHELL_UNAVAILABLE' ||
        result.diagnostic_code === 'POWERSHELL_INCOMPATIBLE') {
        checks.push(createCheck(
          'Resolution',
          'resolution.environment_powershell',
          'PowerShell runtime available for resolver',
          'fail',
          result.error,
          verbose ? [result.stderr.trim()].filter((line) => line.length > 0) : undefined,
          'Resolve the environment shell/PowerShell failure before treating repo resolution as broken.',
          result.diagnostic_code,
        ));
        return checks;
      }
      checks.push(createCheck(
        'Resolution',
        `resolution.${repo.key}`,
        `Resolved ${repo.key}`,
        'fail',
        result.error,
        verbose ? [result.stderr.trim()].filter((line) => line.length > 0) : undefined,
        undefined,
        'RESOLVER_INVALID',
      ));
      continue;
    }

    if (result.exitCode !== 0) {
      const details = verbose
        ? [result.stdout.trim(), result.stderr.trim()].filter((line) => line.length > 0)
        : undefined;
      checks.push(createCheck(
        'Resolution',
        `resolution.${repo.key}`,
        `Resolved ${repo.key}`,
        'fail',
        `Resolver failed for ${repo.project}`,
        details,
        undefined,
        'RESOLVER_INVALID',
      ));
      continue;
    }

    try {
      const parsed = JSON.parse(result.stdout) as { ProjectPath?: string };
      const resolvedProjectPath = parsed.ProjectPath;
      if (resolvedProjectPath === '<external-project-root>' ||
        (typeof resolvedProjectPath === 'string' && existsSync(resolvedProjectPath))) {
        checks.push(createCheck(
          'Resolution',
          `resolution.${repo.key}`,
          `Resolved ${repo.key}`,
          'pass',
          `Resolved ${repo.key}`,
          verbose ? [resolvedProjectPath] : undefined,
        ));
      } else {
        checks.push(createCheck(
          'Resolution',
          `resolution.${repo.key}`,
          `Resolved ${repo.key}`,
          'fail',
          `Resolver returned no usable ProjectPath for ${repo.project}`,
          verbose ? [result.stdout.trim()] : undefined,
          undefined,
          'RESOLVER_INVALID',
        ));
      }
    } catch (error: unknown) {
      checks.push(createCheck(
        'Resolution',
        `resolution.${repo.key}`,
        `Resolved ${repo.key}`,
        'fail',
        `Resolver output was not valid JSON for ${repo.project}`,
        verbose ? [result.stdout.trim(), String(error)] : undefined,
        undefined,
        'RESOLVER_INVALID',
      ));
    }
  }

  return checks;
}

function collectTextFiles(rootPath: string, includeRuns = false): string[] {
  if (!existsSync(rootPath)) return [];
  const stats = lstatSync(rootPath);
  if (stats.isFile()) {
    return TEXT_EXTENSIONS.has(extname(rootPath).toLowerCase()) ? [rootPath] : [];
  }

  const files: string[] = [];
  const stack = [rootPath];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    let entries: Dirent<string>[];
    try {
      entries = readdirSync(current, { withFileTypes: true, encoding: 'utf8' }) as Dirent<string>[];
    } catch {
      continue;
    }

    for (const entry of entries) {
      const nextPath = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === 'node_modules' || (!includeRuns && entry.name === 'runs')) {
          continue;
        }
        stack.push(nextPath);
        continue;
      }

      if (!entry.isFile()) continue;
      if (TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        files.push(nextPath);
      }
    }
  }

  return files;
}

interface LiveRunManifestCollection {
  manifestFiles: string[];
  pointerWarnings: string[];
}

function collectLiveRunManifestFiles(runsRoot: string, babelRoot: string): LiveRunManifestCollection {
  if (!existsSync(runsRoot)) return { manifestFiles: [], pointerWarnings: [] };

  let entries: Dirent<string>[];
  try {
    entries = readdirSync(runsRoot, { withFileTypes: true, encoding: 'utf8' }) as Dirent<string>[];
  } catch {
    return { manifestFiles: [], pointerWarnings: [] };
  }

  const manifests = new Set<string>();
  const pointerWarnings: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith('.latest') || !entry.name.endsWith('.json')) {
      continue;
    }

    const pointerPath = join(runsRoot, entry.name);
    let pointer: { run_dir?: unknown };
    try {
      pointer = JSON.parse(readFileSync(pointerPath, 'utf8')) as { run_dir?: unknown };
    } catch (error) {
      pointerWarnings.push(`${relative(babelRoot, pointerPath)} :: invalid JSON${error instanceof Error ? ` (${error.message})` : ''}`);
      continue;
    }

    if (typeof pointer.run_dir !== 'string' || pointer.run_dir.trim().length === 0) {
      pointerWarnings.push(`${relative(babelRoot, pointerPath)} :: missing or invalid run_dir`);
      continue;
    }

    const manifestPath = join(resolve(pointer.run_dir), '01_manifest.json');
    if (existsSync(manifestPath)) {
      manifests.add(manifestPath);
    }
  }

  return { manifestFiles: [...manifests], pointerWarnings };
}

function hasPlaceholderProjectPathValue(value: unknown): value is string {
  return typeof value === 'string' && PLACEHOLDER_PROJECT_PATTERNS.some((pattern) => value.includes(pattern));
}

function runPlaceholderPathChecks(babelRoot: string, verbose: boolean): DoctorCheckResult[] {
  const runsRoot = join(babelRoot, 'runs');
  const hits: string[] = [];
  const liveRuns = collectLiveRunManifestFiles(runsRoot, babelRoot);

  for (const filePath of liveRuns.manifestFiles) {
    let manifest: { target_project_path?: unknown };
    try {
      manifest = JSON.parse(readFileSync(filePath, 'utf8')) as { target_project_path?: unknown };
    } catch {
      continue;
    }

    if (!hasPlaceholderProjectPathValue(manifest.target_project_path)) continue;

    hits.push(`${relative(babelRoot, filePath)} :: target_project_path=${manifest.target_project_path}`);
  }

  return [
    createCheck(
      'Runtime',
      'runtime.latest_run_pointers',
      'Latest run pointers are parseable',
      liveRuns.pointerWarnings.length === 0 ? 'pass' : 'warn',
      liveRuns.pointerWarnings.length === 0
        ? 'All latest run pointers are parseable'
        : `Found ${liveRuns.pointerWarnings.length} malformed latest run pointer(s)`,
      verbose && liveRuns.pointerWarnings.length > 0 ? liveRuns.pointerWarnings : undefined,
    ),
    createCheck(
      'Runtime',
      'runtime.placeholder_project_paths',
      'Live run manifests avoid placeholder project paths',
      hits.length === 0 ? 'pass' : 'warn',
      hits.length === 0
        ? 'No placeholder project paths found in live run manifests'
        : `Found ${hits.length} live run manifest(s) with placeholder target_project_path values`,
      verbose && hits.length > 0 ? hits : undefined,
    ),
  ];
}

function runLegacyPathChecks(babelRoot: string, verbose: boolean): DoctorCheckResult[] {
  const runtimeHits: string[] = [];
  const artifactHits: string[] = [];

  for (const surface of RUNTIME_SURFACES) {
    const surfacePath = join(babelRoot, surface);
    for (const filePath of collectTextFiles(surfacePath)) {
      let content = '';
      try {
        content = readFileSync(filePath, 'utf8');
      } catch {
        continue;
      }

      const matchedPatterns = LEGACY_PATTERNS.filter((pattern) => content.includes(pattern));
      if (matchedPatterns.length === 0) continue;

      const relativePath = relative(babelRoot, filePath);
      const isArtifactPath = relativePath.startsWith(`tools${sep}reports${sep}`) || relativePath.startsWith(`tools${sep}test-`);
      const detail = `${relativePath} :: ${matchedPatterns.join(', ')}`;
      if (isArtifactPath) {
        artifactHits.push(detail);
      } else {
        runtimeHits.push(detail);
      }
    }
  }

  const checks: DoctorCheckResult[] = [];

  checks.push(createCheck(
    'Legacy Path Drift',
    'legacy_paths.runtime',
    'No legacy Desktop paths found in runtime surfaces',
    runtimeHits.length === 0 ? 'pass' : 'fail',
    runtimeHits.length === 0
      ? 'No legacy Desktop paths found in active runtime surfaces'
      : `Found ${runtimeHits.length} legacy Desktop path reference(s) in active runtime surfaces`,
    verbose && runtimeHits.length > 0 ? runtimeHits : undefined,
  ));

  checks.push(createCheck(
    'Legacy Path Drift',
    'legacy_paths.artifacts',
    'Legacy Desktop path references in report artifacts',
    artifactHits.length === 0 ? 'pass' : 'warn',
    artifactHits.length === 0
      ? 'No legacy Desktop paths found in report artifacts'
      : 'Legacy Desktop path references found in report artifacts only',
    verbose && artifactHits.length > 0 ? artifactHits : undefined,
  ));

  return checks;
}

function runReleaseChecks(
  babelRoot: string,
  verbose: boolean,
  powerShellRunner: PowerShellScriptRunner = runPowerShellScript,
): DoctorCheckResult[] {
  const validatorPath = join(babelRoot, 'tools', 'validate-public-release.ps1');
  if (!existsSync(validatorPath)) {
    return [createCheck(
      'Release',
      'release.validator.exists',
      'Release validator available',
      'fail',
      `Missing release validator: ${validatorPath}`,
    )];
  }
  const result = powerShellRunner(validatorPath, ['-Root', babelRoot]);
  const details = verbose
    ? [result.stdout.trim(), result.stderr.trim()].filter((line) => line.length > 0)
    : undefined;
  return [createCheck(
    'Release',
    'release.validation',
    'Canonical release validation passed',
    result.exitCode === 0 && !result.error ? 'pass' : 'fail',
    result.exitCode === 0 && !result.error
      ? 'Canonical release validation passed'
      : result.error ?? 'Canonical release validation failed',
    details,
    result.diagnostic_code ? 'Resolve the PowerShell environment failure before diagnosing release validation.' : undefined,
    result.diagnostic_code,
  )];
}

function runEnterprisePolicyChecks(babelRoot: string, strictEnterprise: boolean, verbose: boolean): DoctorCheckResult[] {
  const result = loadEnterprisePolicy(babelRoot);
  const checks: DoctorCheckResult[] = [];
  const loadedSources = result.sources.filter((source) => source.loaded);
  const existingSources = result.sources.filter((source) => source.exists);
  const hasStrictPolicy = !strictEnterprise || loadedSources.length > 0;

  checks.push(createCheck(
    'Enterprise Policy',
    'enterprise_policy.parse',
    'Enterprise policy files parse successfully',
    result.errors.length === 0 ? 'pass' : 'fail',
    result.errors.length === 0
      ? loadedSources.length > 0
        ? `Loaded ${loadedSources.length} enterprise policy file(s)`
        : 'No enterprise policy files found; permissive defaults are active'
      : `Found ${result.errors.length} enterprise policy parse error(s)`,
    verbose ? result.sources.map((source) => {
      const state = source.loaded ? 'loaded' : source.exists ? 'exists' : 'missing';
      return `${source.label}: ${state} :: ${source.path}${source.error ? ` :: ${source.error}` : ''}`;
    }) : undefined,
  ));

  checks.push(createCheck(
    'Enterprise Policy',
    'enterprise_policy.present_for_strict',
    'Strict enterprise policy is present',
    hasStrictPolicy ? 'pass' : 'fail',
    hasStrictPolicy
      ? 'Strict enterprise mode has at least one managed policy source or is not requested'
      : 'Strict enterprise mode requires at least one enterprise policy file',
    verbose ? existingSources.map((source) => source.path) : undefined,
    hasStrictPolicy ? undefined : 'Create config/enterprise-policy.json or set BABEL_ENTERPRISE_POLICY_PATH.',
  ));

  checks.push(createCheck(
    'Enterprise Policy',
    'enterprise_policy.tool_controls',
    'Tool allow/deny controls configured',
    result.policy.allowed_tools.length > 0 || result.policy.disallowed_tools.length > 0
      ? 'pass'
      : strictEnterprise ? 'warn' : 'skip',
    result.policy.allowed_tools.length > 0 || result.policy.disallowed_tools.length > 0
      ? `Tool controls active (${result.policy.allowed_tools.length} allowed, ${result.policy.disallowed_tools.length} disallowed)`
      : 'No enterprise tool allow/deny controls configured',
    verbose ? [
      `allowed_tools=${result.policy.allowed_tools.join(', ') || '<none>'}`,
      `disallowed_tools=${result.policy.disallowed_tools.join(', ') || '<none>'}`,
    ] : undefined,
  ));

  checks.push(createCheck(
    'Enterprise Policy',
    'enterprise_policy.mcp_controls',
    'MCP server controls configured',
    result.policy.allowed_mcp_servers.length > 0 || result.policy.disallowed_mcp_servers.length > 0
      ? 'pass'
      : strictEnterprise ? 'warn' : 'skip',
    result.policy.allowed_mcp_servers.length > 0 || result.policy.disallowed_mcp_servers.length > 0
      ? `MCP controls active (${result.policy.allowed_mcp_servers.length} allowed, ${result.policy.disallowed_mcp_servers.length} disallowed)`
      : 'No enterprise MCP server allow/deny controls configured',
    verbose ? [
      `allowed_mcp_servers=${result.policy.allowed_mcp_servers.join(', ') || '<none>'}`,
      `disallowed_mcp_servers=${result.policy.disallowed_mcp_servers.join(', ') || '<none>'}`,
    ] : undefined,
  ));

  checks.push(createCheck(
    'Enterprise Policy',
    'enterprise_policy.network_controls',
    'Network allowlist configured',
    result.policy.network_allowlist.length > 0 ? 'pass' : strictEnterprise ? 'warn' : 'skip',
    result.policy.network_allowlist.length > 0
      ? `Network allowlist active (${result.policy.network_allowlist.length} host rule(s))`
      : 'No enterprise network allowlist configured',
    verbose ? result.policy.network_allowlist : undefined,
  ));

  checks.push(createCheck(
    'Enterprise Policy',
    'enterprise_policy.model_controls',
    'Model backend controls configured',
    result.policy.model_policy.allowed_backends.length > 0 ||
      result.policy.model_policy.disallowed_backends.length > 0 ||
      result.policy.model_policy.require_explicit_opt_in.length > 0
      ? 'pass'
      : strictEnterprise ? 'warn' : 'skip',
    result.policy.model_policy.allowed_backends.length > 0 ||
      result.policy.model_policy.disallowed_backends.length > 0 ||
      result.policy.model_policy.require_explicit_opt_in.length > 0
      ? `Model controls active (${result.policy.model_policy.allowed_backends.length} allowed, ${result.policy.model_policy.disallowed_backends.length} disallowed, ${result.policy.model_policy.require_explicit_opt_in.length} opt-in)`
      : 'No enterprise model backend controls configured',
    verbose ? [
      `allowed_backends=${result.policy.model_policy.allowed_backends.join(', ') || '<none>'}`,
      `disallowed_backends=${result.policy.model_policy.disallowed_backends.join(', ') || '<none>'}`,
      `require_explicit_opt_in=${result.policy.model_policy.require_explicit_opt_in.join(', ') || '<none>'}`,
    ] : undefined,
  ));

  checks.push(createCheck(
    'Enterprise Policy',
    'enterprise_policy.plugin_controls',
    'Plugin controls configured',
    result.policy.plugin_policy.allowed_plugins.length > 0 ||
      result.policy.plugin_policy.disallowed_plugins.length > 0 ||
      result.policy.plugin_policy.max_trust_level !== undefined
      ? 'pass'
      : strictEnterprise ? 'warn' : 'skip',
    result.policy.plugin_policy.allowed_plugins.length > 0 ||
      result.policy.plugin_policy.disallowed_plugins.length > 0 ||
      result.policy.plugin_policy.max_trust_level !== undefined
      ? `Plugin controls active (${result.policy.plugin_policy.allowed_plugins.length} allowed, ${result.policy.plugin_policy.disallowed_plugins.length} disallowed, max trust ${result.policy.plugin_policy.max_trust_level ?? '<none>'})`
      : 'No enterprise plugin controls configured',
    verbose ? [
      `allowed_plugins=${result.policy.plugin_policy.allowed_plugins.join(', ') || '<none>'}`,
      `disallowed_plugins=${result.policy.plugin_policy.disallowed_plugins.join(', ') || '<none>'}`,
      `max_trust_level=${result.policy.plugin_policy.max_trust_level ?? '<none>'}`,
    ] : undefined,
  ));

  checks.push(createCheck(
    'Enterprise Policy',
    'enterprise_policy.telemetry_opt_in',
    'Telemetry opt-in is explicit',
    typeof result.policy.telemetry.opt_in === 'boolean' ? 'pass' : strictEnterprise ? 'warn' : 'skip',
    typeof result.policy.telemetry.opt_in === 'boolean'
      ? `Telemetry opt-in explicitly set to ${result.policy.telemetry.opt_in}`
      : 'Enterprise telemetry opt-in is not explicit',
    verbose ? [`telemetry.opt_in=${String(result.policy.telemetry.opt_in)}`] : undefined,
  ));

  checks.push(createCheck(
    'Enterprise Policy',
    'enterprise_policy.redaction',
    'Evidence redaction enabled',
    result.policy.redaction.enabled ? 'pass' : 'fail',
    result.policy.redaction.enabled
      ? `Evidence redaction enabled (${result.policy.redaction.extra_patterns.length} extra pattern(s))`
      : 'Evidence redaction is disabled',
    verbose ? result.policy.redaction.extra_patterns : undefined,
  ));

  return checks;
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorRunResult> {
  const babelRoot = resolve(options.babelRoot);
  const workspaceRoot = getWorkspaceRoot(babelRoot);
  const repoMapPath = getRepoMapPath(workspaceRoot);
  const checks: DoctorCheckResult[] = [];
  const env = options.env ?? process.env;
  const repoMapResult = shouldRunSection(options.scope, 'Repo Map')
    ? runRepoMapChecks(workspaceRoot, repoMapPath, options.verbose)
    : { checks: [], repoMap: null, externalPrerequisites: new Set<string>() };

  if (shouldRunSection(options.scope, 'Environment')) {
    checks.push(...runEnvironmentChecks(env, options.verbose, options.shellProbe, options.powerShellProbe));
  }

  if (shouldRunSection(options.scope, 'Workspace')) {
    checks.push(...runWorkspaceChecks(babelRoot, workspaceRoot, repoMapPath, options.verbose));
  }

  if (shouldRunSection(options.scope, 'Repo Map')) {
    checks.push(...repoMapResult.checks);
  }

  if (shouldRunSection(options.scope, 'Runtime')) {
    checks.push(...runRuntimeChecks(babelRoot, options.verbose));
    checks.push(...runPlaceholderPathChecks(babelRoot, options.verbose));
  }

  if (shouldRunSection(options.scope, 'Resolution')) {
    checks.push(...runResolutionChecks(
      babelRoot,
      options.verbose,
      repoMapResult.repoMap,
      repoMapResult.externalPrerequisites,
      options.powerShellRunner,
    ));
  }

  if (shouldRunSection(options.scope, 'Legacy Path Drift')) {
    checks.push(...runLegacyPathChecks(babelRoot, options.verbose));
  }

  if (shouldRunSection(options.scope, 'Release')) {
    checks.push(...runReleaseChecks(babelRoot, options.verbose, options.powerShellRunner));
  }

  if (shouldRunSection(options.scope, 'Enterprise Policy') || options.strictEnterprise === true) {
    checks.push(...runEnterprisePolicyChecks(babelRoot, options.strictEnterprise === true, options.verbose));
  }

  const summary = summarizeChecks(checks);
  const status = determineOverallStatus(checks, options.strict || options.strictEnterprise === true);

  return {
    status,
    workspaceRoot,
    mode: options.strictEnterprise === true ? 'strict-enterprise' : options.strict ? 'strict' : 'standard',
    scope: options.scope,
    checks,
    summary,
  };
}

export function formatDoctorHuman(result: DoctorRunResult, verbose: boolean): string {
  const lines: string[] = [];
  lines.push('Babel Doctor');
  lines.push(`Workspace: ${result.workspaceRoot}`);
  lines.push(`Mode: ${result.mode}`);
  lines.push(`Scope: ${result.scope}`);
  lines.push('');

  const sectionOrder = ['Environment', 'Workspace', 'Repo Map', 'Runtime', 'Resolution', 'Legacy Path Drift', 'Export', 'Enterprise Policy'];
  for (const section of sectionOrder) {
    const sectionChecks = result.checks.filter((check) => check.section === section);
    if (sectionChecks.length === 0) continue;
    lines.push(`[${section}]`);
    for (const check of sectionChecks) {
      lines.push(`${check.status.toUpperCase().padEnd(5)} ${check.title} — ${check.message}`);
      if (verbose) {
        for (const detail of check.details ?? []) {
          lines.push(`      ${detail}`);
        }
        if (check.diagnostic_code) {
          lines.push(`      Code: ${check.diagnostic_code}`);
        }
        if (check.fixHint) {
          lines.push(`      Hint: ${check.fixHint}`);
        }
      }
    }
    lines.push('');
  }

  lines.push(`Overall: ${result.status.toUpperCase()}`);
  return lines.join('\n');
}

import { spawnSync } from 'node:child_process';
import { basename, relative, resolve } from 'node:path';

export interface BenchmarkContainerCommandOptions {
  dockerImage: string;
  projectRoot: string;
  cwd: string;
  command: string;
}

export interface BenchmarkContainerCommand {
  executable: 'docker';
  args: string[];
}

export interface BenchmarkRuntimeCommandStatus {
  command: string;
  available: boolean;
  resolvedPath: string | null;
}

export interface BenchmarkRuntimeInventory {
  dockerImage: string;
  status: 'available' | 'unavailable';
  commands: BenchmarkRuntimeCommandStatus[];
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface BenchmarkRuntimeCommandUsability {
  status: 'usable' | 'missing' | 'not_executor_allowed' | 'project_executable' | 'unknown';
  commandBase: string | null;
  message: string;
}

export const BENCHMARK_RUNTIME_INVENTORY_COMMANDS = [
  'python',
  'python3',
  'py',
  'pip',
  'pip3',
  'pytest',
  'uv',
  'uvx',
  'node',
  'npm',
  'npx',
  'deno',
  'gcc',
  'g++',
  'make',
  'cmake',
  'git',
  'bash',
  'sh',
  'cat',
  'diff',
  'grep',
  'sed',
  'gzip',
  'gunzip',
  'tar',
  'chmod',
  'cp',
  'mv',
  'ls',
  'which',
  'env',
  'curl',
  'apt-get',
] as const;

const CONTAINER_SHELL_SYNTAX_RE = /[;&|><`$(){}!\\\r\n]/;
const runtimeInventoryCache = new Map<string, BenchmarkRuntimeInventory>();

function splitCommand(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean);
}

function dockerPath(path: string): string {
  return resolve(path).replace(/\\/g, '/');
}

function normalizeContainerExecutable(rawCommand: string, projectRoot: string): string {
  const normalized = rawCommand.replace(/\\/g, '/');
  if (normalized.startsWith('/project/')) {
    return `/app/${normalized.slice('/project/'.length)}`;
  }
  if (normalized === '/project') {
    return '/app';
  }
  if (normalized.startsWith('/app/')) {
    return normalized;
  }
  if (/^[A-Za-z]:\//.test(normalized)) {
    const relativeToProject = relative(projectRoot, resolve(rawCommand)).replace(/\\/g, '/');
    if (relativeToProject && !relativeToProject.startsWith('..')) {
      return `/app/${relativeToProject}`;
    }
  }
  return normalized;
}

function normalizeContainerShellCommand(command: string): string {
  return command
    .replace(/\\/g, '/')
    .replace(/(^|[\s'"`])\/project(?=\/|\s|$)/g, '$1/app');
}

function containerWorkingDirectory(projectRoot: string, cwd: string): string {
  const relativeToProject = relative(projectRoot, resolve(cwd)).replace(/\\/g, '/');
  if (!relativeToProject || relativeToProject === '.') {
    return '/app';
  }
  if (relativeToProject.startsWith('..')) {
    return '/app';
  }
  return `/app/${relativeToProject}`;
}

export function shouldUseBenchmarkContainerExecution(
  executionProfile: string | null | undefined,
  dockerImage: string | null | undefined,
): boolean {
  return String(executionProfile ?? '').trim() === 'benchmark_container' &&
    String(dockerImage ?? '').trim().length > 0;
}

export function buildBenchmarkContainerCommand(
  options: BenchmarkContainerCommandOptions,
): BenchmarkContainerCommand {
  if (CONTAINER_SHELL_SYNTAX_RE.test(options.command)) {
    return {
      executable: 'docker',
      args: [
        'run',
        '--rm',
        '-v',
        `${dockerPath(options.projectRoot)}:/app`,
        '-w',
        containerWorkingDirectory(options.projectRoot, options.cwd),
        options.dockerImage,
        '/bin/sh',
        '-lc',
        normalizeContainerShellCommand(options.command),
      ],
    };
  }

  const argv = splitCommand(options.command);
  if (argv.length === 0) {
    throw new Error('Cannot build benchmark container command for an empty command.');
  }

  const [rawExecutable, ...rawArgs] = argv;
  const executable = normalizeContainerExecutable(rawExecutable!, options.projectRoot);
  return {
    executable: 'docker',
    args: [
      'run',
      '--rm',
      '-v',
      `${dockerPath(options.projectRoot)}:/app`,
      '-w',
      containerWorkingDirectory(options.projectRoot, options.cwd),
      options.dockerImage,
      executable,
      ...rawArgs,
    ],
  };
}

export function isBenchmarkProjectExecutableCommand(rawCommand: string): boolean {
  const normalized = rawCommand.trim().replace(/\\/g, '/');
  return normalized.startsWith('./') ||
    normalized.startsWith('/project/') ||
    normalized.startsWith('/app/');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function inventoryCacheKey(dockerImage: string, commands: readonly string[]): string {
  return `${dockerImage}\n${commands.join('\0')}`;
}

export function parseBenchmarkRuntimeInventoryOutput(
  dockerImage: string,
  stdout: string,
  stderr = '',
  exitCode: number | null = 0,
  commands: readonly string[] = BENCHMARK_RUNTIME_INVENTORY_COMMANDS,
): BenchmarkRuntimeInventory {
  const byCommand = new Map<string, BenchmarkRuntimeCommandStatus>();
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const [command, state, resolvedPath = ''] = trimmed.split('\t');
    if (!command || (state !== 'available' && state !== 'missing')) {
      continue;
    }
    byCommand.set(command, {
      command,
      available: state === 'available',
      resolvedPath: state === 'available' && resolvedPath.trim() ? resolvedPath.trim() : null,
    });
  }

  return {
    dockerImage,
    status: exitCode === 0 ? 'available' : 'unavailable',
    commands: commands.map(command => byCommand.get(command) ?? {
      command,
      available: false,
      resolvedPath: null,
    }),
    stdout,
    stderr,
    exitCode,
  };
}

export function inspectBenchmarkContainerRuntime(
  dockerImage: string,
  commands: readonly string[] = BENCHMARK_RUNTIME_INVENTORY_COMMANDS,
): BenchmarkRuntimeInventory {
  const image = dockerImage.trim();
  if (!image) {
    return {
      dockerImage: image,
      status: 'unavailable',
      commands: commands.map(command => ({ command, available: false, resolvedPath: null })),
      stdout: '',
      stderr: 'No benchmark Docker image was provided.',
      exitCode: null,
    };
  }

  const cacheKey = inventoryCacheKey(image, commands);
  const cached = runtimeInventoryCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const commandList = commands.map(shellQuote).join(' ');
  const script = [
    `for c in ${commandList}; do`,
    'if command -v "$c" >/dev/null 2>&1; then',
    'p=$(command -v "$c" 2>/dev/null);',
    'printf "%s\\tavailable\\t%s\\n" "$c" "$p";',
    'else',
    'printf "%s\\tmissing\\t\\n" "$c";',
    'fi;',
    'done',
  ].join(' ');

  const result = spawnSync('docker', ['run', '--rm', image, '/bin/sh', '-lc', script], {
    encoding: 'utf-8',
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  });

  const inventory = result.status === 0
    ? parseBenchmarkRuntimeInventoryOutput(
        image,
        result.stdout ?? '',
        result.stderr ?? '',
        result.status,
        commands,
      )
    : {
        dockerImage: image,
        status: 'unavailable' as const,
        commands: commands.map(command => ({ command, available: false, resolvedPath: null })),
        stdout: result.stdout ?? '',
        stderr: result.error?.message ?? result.stderr ?? 'Benchmark runtime inventory command failed.',
        exitCode: result.status,
      };
  runtimeInventoryCache.set(cacheKey, inventory);
  return inventory;
}

export function getCachedBenchmarkContainerRuntimeInventory(
  dockerImage: string,
  commands: readonly string[] = BENCHMARK_RUNTIME_INVENTORY_COMMANDS,
): BenchmarkRuntimeInventory | null {
  return runtimeInventoryCache.get(inventoryCacheKey(dockerImage.trim(), commands)) ?? null;
}

export function getBenchmarkCommandBase(rawCommand: string): string | null {
  const rawBase = rawCommand.trim().split(/\s+/).find(Boolean);
  if (!rawBase) {
    return null;
  }
  return basename(rawBase.replace(/\\/g, '/')).replace(/\.(cmd|exe|bat)$/i, '').toLowerCase();
}

export function getBenchmarkRuntimeCommandUsability(
  inventory: BenchmarkRuntimeInventory | null,
  allowedCommandBases: readonly string[],
  rawCommand: string,
): BenchmarkRuntimeCommandUsability {
  const rawBase = rawCommand.trim().split(/\s+/).find(Boolean) ?? '';
  if (isBenchmarkProjectExecutableCommand(rawBase)) {
    return {
      status: 'project_executable',
      commandBase: rawBase,
      message: `Project executable "${rawBase}" is allowed when it resolves inside /app.`,
    };
  }

  const commandBase = getBenchmarkCommandBase(rawCommand);
  if (!commandBase || !inventory || inventory.status !== 'available') {
    return {
      status: 'unknown',
      commandBase,
      message: 'Benchmark runtime command inventory is unavailable.',
    };
  }

  const entry = inventory.commands.find(candidate => candidate.command === commandBase);
  if (!entry) {
    return {
      status: 'unknown',
      commandBase,
      message: `Command "${commandBase}" was not part of the benchmark runtime inventory.`,
    };
  }

  if (!entry.available) {
    return {
      status: 'missing',
      commandBase,
      message: `Command "${commandBase}" is missing from benchmark container image "${inventory.dockerImage}".`,
    };
  }

  if (!allowedCommandBases.includes(commandBase)) {
    return {
      status: 'not_executor_allowed',
      commandBase,
      message: `Command "${commandBase}" exists in the container but is not executor-allowlisted for benchmark_container.`,
    };
  }

  return {
    status: 'usable',
    commandBase,
    message: `Command "${commandBase}" is available and executor-allowlisted.`,
  };
}

export function formatBenchmarkRuntimeInventoryPromptLines(
  inventory: BenchmarkRuntimeInventory,
  allowedCommandBases: readonly string[],
): string[] {
  if (inventory.status !== 'available') {
    return [
      `Benchmark runtime inventory: unavailable for image ${inventory.dockerImage || '<none>'}.`,
      `Inventory error: ${(inventory.stderr || 'unknown failure').trim().slice(0, 240)}`,
      'Do not assume optional runtime tools exist. Prefer source-only/file_write solutions and use executor errors as evidence if a command fails.',
    ];
  }

  const allowed = new Set(allowedCommandBases);
  const usable = inventory.commands
    .filter(entry => entry.available && allowed.has(entry.command))
    .map(entry => entry.command);
  const missing = inventory.commands
    .filter(entry => !entry.available)
    .map(entry => entry.command);
  const blocked = inventory.commands
    .filter(entry => entry.available && !allowed.has(entry.command))
    .map(entry => entry.command);

  return [
    `Benchmark runtime inventory for Docker image ${inventory.dockerImage}:`,
    `  - usable command bases: ${usable.length > 0 ? usable.join(', ') : '(none)'}`,
    `  - missing in container: ${missing.length > 0 ? missing.join(', ') : '(none)'}`,
    `  - present but not executor-allowlisted: ${blocked.length > 0 ? blocked.join(', ') : '(none)'}`,
    'Planning rule: do not plan shell_exec/test_run steps with command bases listed as missing or not executor-allowlisted.',
    'Planning rule: do not spend executor turns probing tool availability with which, command -v, or env unless the inventory is unavailable or stale.',
    'Dependency rule: do not use apt-get as an automatic recovery path. Prefer existing container capabilities and source-only solutions; use pip/npm installs only when the command is usable and the task truly requires dependencies.',
  ];
}

/** Resolve and pin the executable identity used for host process dispatch. */
import { accessSync, constants, existsSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, relative, resolve, sep, win32 } from 'node:path';
import { classifyExecutionRisk, normalizeExecutionBase, type ClassifiedInvocation } from './commandSpec.js';

export interface ResolvedCommandExecutable {
  path: string;
  base: string;
  trusted: boolean;
  identity?: string;
}

export interface CommandResolverOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  trustedRoots?: string[];
  isFile?: (path: string) => boolean;
  realpath?: (path: string) => string;
  fileIdentity?: (path: string) => string | undefined;
  isWritableByCurrentUser?: (path: string) => boolean;
}

export interface ResolvedCommandPolicy {
  executable: ResolvedCommandExecutable | null;
  classification: ClassifiedInvocation;
}

function pathApi(platform: NodeJS.Platform) {
  return platform === 'win32' ? win32 : { basename, resolve, dirname, extname, isAbsolute, relative, sep };
}

function defaultTrustedRoots(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === 'win32') {
    const systemRoot = env['SystemRoot'] ?? env['SYSTEMROOT'] ?? 'C:\\Windows';
    const roots = [
      `${systemRoot}\\System32`,
      `${systemRoot}\\SysWOW64`,
      `${env['ProgramFiles'] ?? 'C:\\Program Files'}\\Git\\cmd`,
      `${env['ProgramFiles'] ?? 'C:\\Program Files'}\\Git\\bin`,
    ];
    return roots.map((root) => platform === process.platform ? canonicalPath(root) : root);
  }
  const roots = [
    '/bin',
    '/usr/bin',
    '/usr/local/bin',
    '/usr/local/sbin',
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/opt/local/bin',
    '/opt/local/sbin',
  ];
  return roots.map((root) => platform === process.platform ? canonicalPath(root) : root);
}

function defaultTrustedExecutables(platform: NodeJS.Platform): string[] {
  return platform === process.platform ? [canonicalPath(process.execPath)] : [];
}

function canonicalPath(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

function isInsideRoot(root: string, target: string, platform: NodeJS.Platform): boolean {
  const api = pathApi(platform);
  const rel = api.relative(root, target);
  const normalized = platform === 'win32' ? rel.toLowerCase() : rel;
  const parent = platform === 'win32' ? '..\\' : `..${sep}`;
  return normalized === '' || (normalized !== '..' && !normalized.startsWith(parent) && !api.isAbsolute(rel));
}

function isPosixPathOwnedByCurrentUser(path: string): boolean {
  try {
    const stats = statSync(path);
    const effectiveUid = process.geteuid?.();
    return effectiveUid === undefined || effectiveUid === 0 || stats.uid === effectiveUid;
  } catch {
    return true;
  }
}

function isPosixPathWritableByCurrentUser(path: string): boolean {
  try {
    const stats = statSync(path);
    const effectiveUid = process.geteuid?.();
    const effectiveGid = process.getegid?.();
    if (effectiveUid === undefined || effectiveGid === undefined || !process.getgroups) return true;
    const groups = new Set([effectiveGid, ...process.getgroups()]);
    if (groups.has(stats.gid)) return (stats.mode & 0o020) !== 0;
    if ((stats.mode & 0o002) !== 0) return true;
    try { accessSync(path, constants.W_OK); return true; } catch { return false; }
  } catch {
    return true;
  }
}

function isPathChainWritable(
  path: string,
  platform: NodeJS.Platform,
  isWritableByCurrentUser: (path: string) => boolean,
): boolean {
  const api = pathApi(platform);
  let current = path;
  while (true) {
    if (isWritableByCurrentUser(current)) return true;
    const parent = api.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function hasPathSeparator(command: string): boolean {
  return /[\\/]/.test(command) || /^[A-Za-z]:/.test(command);
}

/** Resolve using the child PATH and Windows cwd/PATHEXT rules, then canonicalize. */
export function resolveCommandExecutable(
  command: string,
  options: CommandResolverOptions,
): ResolvedCommandExecutable | null {
  const platform = options.platform ?? process.platform;
  const api = pathApi(platform);
  const sepChar = platform === 'win32' ? ';' : ':';
  const pathValue = options.env['PATH'] ?? '';
  const extensions = platform === 'win32'
    ? (options.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  const commandHasExtension = Boolean(api.extname(command));
  const names = extensions.length === 1 && extensions[0] === '' || commandHasExtension
    ? [command]
    : extensions.map((extension) => `${command}${extension}`);
  const candidates: string[] = [];
  if (hasPathSeparator(command)) {
    for (const name of names) candidates.push(api.resolve(options.cwd, name));
  } else {
    if (platform === 'win32') {
      for (const name of names) candidates.push(api.resolve(options.cwd, name));
    }
    for (const directory of pathValue.split(sepChar)) {
      const searchDirectory = directory || options.cwd;
      for (const name of names) candidates.push(api.resolve(options.cwd, searchDirectory, name));
    }
  }

  const isFile = options.isFile ?? ((path: string) => {
    try {
      if (!statSync(path).isFile()) return false;
      if (platform !== 'win32') accessSync(path, constants.X_OK);
      return true;
    } catch { return false; }
  });
  const realpath = options.realpath ?? ((path: string) => realpathSync(path));
  const fileIdentity = options.fileIdentity ?? ((path: string) => {
    try {
      const stats = statSync(path);
      return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}`;
    } catch { return undefined; }
  });
  const isWritableByCurrentUser = options.isWritableByCurrentUser ?? ((path: string) => {
    if (platform === 'win32') {
      try { accessSync(path, constants.W_OK); return true; } catch { return false; }
    }
    return isPosixPathWritableByCurrentUser(path);
  });
  const isProtectedPathWritableByCurrentUser = (path: string): boolean => {
    if (platform !== 'win32' && isPosixPathOwnedByCurrentUser(path)) return true;
    return isWritableByCurrentUser(path);
  };
  const roots = options.trustedRoots ?? defaultTrustedRoots(platform, options.env);
  const canonicalRoots = roots.map((root) => {
    try { return (options.realpath ?? canonicalPath)(root); } catch { return api.resolve(options.cwd, root); }
  });

  for (const candidate of candidates) {
    if (!isFile(candidate)) continue;
    let canonical: string;
    try { canonical = realpath(candidate); } catch { continue; }
    const trustedRoot = canonicalRoots.find((root) => isInsideRoot(root, canonical, platform));
    const protectedPath = !isPathChainWritable(
      canonical,
      platform,
      isProtectedPathWritableByCurrentUser,
    );
    const trusted = protectedPath && (
      trustedRoot !== undefined ||
      (options.trustedRoots === undefined && defaultTrustedExecutables(platform).includes(canonical))
    );
    const identity = fileIdentity(canonical);
    return {
      path: canonical,
      base: normalizeExecutionBase(api.basename(canonical)),
      trusted,
      ...(identity !== undefined ? { identity } : {}),
    };
  }
  return null;
}

/** Recheck canonical path and file identity immediately before process creation. */
export function isResolvedCommandCurrent(
  executable: ResolvedCommandExecutable,
  options: { realpath?: (path: string) => string; fileIdentity?: (path: string) => string | undefined } = {},
): boolean {
  try {
    const realpath = options.realpath ?? ((path: string) => realpathSync(path));
    if (realpath(executable.path) !== executable.path) return false;
    if (executable.identity === undefined) return true;
    const fileIdentity = options.fileIdentity ?? ((path: string) => {
      const stats = statSync(path);
      return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}`;
    });
    return fileIdentity(executable.path) === executable.identity;
  } catch { return false; }
}

/** Apply the shared command policy to the canonical executable that will run. */
export function classifyResolvedCommand(
  executable: ResolvedCommandExecutable,
  args: readonly string[],
  options: { repoRoot?: string } = {},
): ClassifiedInvocation {
  if (!executable.trusted) {
    return {
      base: executable.base,
      executionRisk: 'project_code',
      effectFamily: 'compiler_or_build',
      reason: 'untrusted_executable_identity',
    };
  }
  // `env` and similar launchers resolve another executable internally. Their
  // nested dispatch cannot be pinned by replacing only the outer executable.
  if (executable.base === 'env') {
    return {
      base: executable.base,
      executionRisk: 'project_code',
      effectFamily: 'compiler_or_build',
      reason: 'indirect_executable_dispatch',
    };
  }
  const quote = (value: string): string => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const invocation = [executable.base, ...args].map(quote).join(' ');
  return classifyExecutionRisk(invocation, options);
}

/** Resolve and classify one direct invocation using the child search context. */
export function resolveAndClassifyCommand(
  command: string,
  args: readonly string[],
  options: CommandResolverOptions & { repoRoot?: string },
): ResolvedCommandPolicy {
  const executable = resolveCommandExecutable(command, options);
  if (!executable) {
    return {
      executable: null,
      classification: {
        base: normalizeExecutionBase(command),
        executionRisk: 'project_code',
        effectFamily: 'compiler_or_build',
        reason: 'executable_resolution_failed',
      },
    };
  }
  return {
    executable,
    classification: classifyResolvedCommand(executable, args, options.repoRoot === undefined ? {} : { repoRoot: options.repoRoot }),
  };
}

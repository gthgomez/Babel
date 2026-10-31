/** Resolve and pin the executable identity used for host process dispatch. */
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { join, posix, resolve, win32 } from 'node:path';
import { classifyExecutionRisk, COMMAND_SPECS, normalizeExecutionBase, type ClassifiedInvocation } from './commandSpec.js';

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
  /** Host-configured PATH captured by the trusted caller, never a model command override. */
  hostPath?: string;
  /** Host-configured Windows extension search order, paired with hostPath. */
  hostPathExt?: string;
  /** Test seam for canonical host System32 identity; production uses startup-captured host state. */
  hostWindowsSystem32?: string;
  /** Test seam for the expected host owner when running a privileged fixture. */
  hostPathOwnerUid?: number;
  /** Repository/shadow/task-controlled roots that can contain mutable lookalikes. */
  controlledRoots?: string[];
  isFile?: (path: string) => boolean;
  realpath?: (path: string) => string;
  fileIdentity?: (path: string) => string | undefined;
  isWritableByCurrentUser?: (path: string) => boolean;
  /** Test seam for shared-path trust checks; production inspects POSIX mode bits. */
  isWritableByOtherPrincipal?: (path: string) => boolean;
  /** Test seam for deterministic ownership checks; SafeExecutor uses the OS default. */
  isOwnedByCurrentUser?: (path: string) => boolean;
  /** Test seam for privileged-runtime policy fixtures; SafeExecutor uses process identity. */
  effectiveUid?: number;
  /** Test seam for deterministic owner fixtures; SafeExecutor reads stat ownership. */
  ownerUid?: (path: string) => number | undefined;
}

export interface ResolvedCommandPolicy {
  executable: ResolvedCommandExecutable | null;
  classification: ClassifiedInvocation;
}

/** Build repository/shadow roots that must never be treated as external tools. */
export function commandControlledRoots(projectRoot?: string, shadowRoot?: string): string[] {
  return [projectRoot, shadowRoot].filter((root): root is string => Boolean(root));
}

function pathApi(platform: NodeJS.Platform) {
  return platform === 'win32' ? win32 : posix;
}

function canonicalPathKey(path: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? win32.resolve(path).toLowerCase() : path;
}

function envValue(env: NodeJS.ProcessEnv, key: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== 'win32') return env[key];
  const normalizedKey = key.toLowerCase();
  const matchingValues = Object.entries(env)
    .filter(([name]) => name.toLowerCase() === normalizedKey)
    .map(([, value]) => value);
  if (matchingValues.length === 0) return undefined;
  if (!matchingValues.every((value) => value === matchingValues[0])) return undefined;
  return matchingValues[0];
}

// Freeze the operator's startup search path before any request-specific or
// test fixture environment can modify process.env.
const HOST_CONFIGURED_PATH = envValue(process.env, 'PATH', process.platform);
const HOST_CONFIGURED_PATHEXT = envValue(process.env, 'PATHEXT', process.platform);
const HOST_SYSTEM_ROOT = process.platform === 'win32'
  ? envValue(process.env, 'SystemRoot', 'win32') ?? envValue(process.env, 'WINDIR', 'win32')
  : undefined;
const HOST_PROGRAM_FILES = process.platform === 'win32' ? envValue(process.env, 'ProgramFiles', 'win32') : undefined;
const HOST_WINDOWS_SYSTEM32 = HOST_SYSTEM_ROOT ? canonicalPath(join(HOST_SYSTEM_ROOT, 'System32')) : undefined;

// Explicitly approved package-manager entry-point aliases. Do not infer that
// an arbitrary startup-PATH file is the tool named by its symlink/spelling.
const HOST_EXECUTABLE_ALIASES: Readonly<Record<string, ReadonlySet<string>>> = {
  npm: new Set(['npm-cli.js']),
  npx: new Set(['npx-cli.js']),
};

function hostExecutableNameMatches(invokedBase: string, canonicalBase: string): boolean {
  const invoked = normalizeExecutionBase(invokedBase);
  const canonical = normalizeExecutionBase(canonicalBase);
  return canonical === invoked || HOST_EXECUTABLE_ALIASES[invoked]?.has(canonical) === true;
}

/** Exact canonical cmd.exe identity under the independently captured host System32 directory. */
export function isCanonicalWindowsSystemShell(path: string, system32: string): boolean {
  const normalizedPath = win32.resolve(path).toLowerCase();
  const normalizedShell = win32.resolve(system32, 'cmd.exe').toLowerCase();
  return normalizedPath === normalizedShell;
}

/** Captured host System32 directory used by Windows shell dispatch. */
export function hostWindowsSystem32Directory(): string | undefined {
  return HOST_WINDOWS_SYSTEM32;
}
function defaultTrustedRoots(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === 'win32') {
    const useStartupHost = platform === process.platform && HOST_WINDOWS_SYSTEM32 !== undefined;
    const systemRoot = useStartupHost
      ? HOST_SYSTEM_ROOT!
      : platform === process.platform
        ? undefined
        : envValue(env, 'SystemRoot', platform) ?? 'C:\\Windows';
    const programFiles = platform === process.platform
      ? HOST_PROGRAM_FILES ?? 'C:\\Program Files'
      : envValue(env, 'ProgramFiles', platform) ?? 'C:\\Program Files';
    const roots = [
      useStartupHost ? HOST_WINDOWS_SYSTEM32 : systemRoot ? `${systemRoot}\\System32` : undefined,
      systemRoot ? `${systemRoot}\\SysWOW64` : undefined,
      `${programFiles}\\Git\\cmd`,
      `${programFiles}\\Git\\bin`,
    ].filter((root): root is string => root !== undefined);
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
  const parent = platform === 'win32' ? '..\\' : `..${posix.sep}`;
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

function isWritableByOtherPrincipal(path: string, platform: NodeJS.Platform): boolean {
  if (platform === 'win32') return false;
  try {
    return (statSync(path).mode & 0o022) !== 0;
  } catch {
    return true;
  }
}

function isPathChainWritableByOtherPrincipal(
  path: string,
  platform: NodeJS.Platform,
  check: (path: string) => boolean,
): boolean {
  const api = pathApi(platform);
  let current = path;
  while (true) {
    if (check(current)) return true;
    const parent = api.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function hostPathOwnerUid(): number | undefined {
  const effectiveUid = process.geteuid?.();
  if (effectiveUid !== 0) return effectiveUid;
  const sudoUid = Number(process.env['SUDO_UID']);
  if (Number.isInteger(sudoUid) && sudoUid > 0) return sudoUid;
  const home = process.env['HOME'];
  if (home) {
    try {
      const owner = statSync(home).uid;
      if (owner > 0) return owner;
    } catch { /* missing host home cannot establish a non-root owner */ }
  }
  return undefined;
}

const HOST_PATH_OWNER_UID = hostPathOwnerUid();

function isPathChainOwnedByTrustedHostPrincipal(
  path: string,
  platform: NodeJS.Platform,
  check: (path: string) => boolean,
): boolean {
  const api = pathApi(platform);
  let current = path;
  while (true) {
    if (!check(current)) return false;
    const parent = api.dirname(current);
    if (parent === current) return true;
    current = parent;
  }
}

function isPathChainOwnedByUid(
  path: string,
  platform: NodeJS.Platform,
  expectedUid: number,
  ownerUid: (path: string) => number | undefined = (candidate) => {
    try { return statSync(candidate).uid; } catch { return undefined; }
  },
): boolean {
  if (platform === 'win32') return false;
  return isPathChainOwnedByTrustedHostPrincipal(path, platform, (candidate) => {
    return ownerUid(candidate) === expectedUid;
  });
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
  const pathValue = envValue(options.env, 'PATH', platform) ?? '';
  const trustedHostPath = options.hostPath ?? (platform === process.platform
    ? HOST_CONFIGURED_PATH ?? ''
    : pathValue);
  const extensions = platform === 'win32'
    ? (envValue(options.env, 'PATHEXT', platform) ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  const hostExtensions = platform === 'win32'
    ? (options.hostPathExt ?? (platform === process.platform ? HOST_CONFIGURED_PATHEXT : envValue(options.env, 'PATHEXT', platform)) ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  const commandHasExtension = Boolean(api.extname(command));
  const names = extensions.length === 1 && extensions[0] === '' || commandHasExtension
    ? [command]
    : extensions.map((extension) => `${command}${extension}`);
  const candidates: string[] = [];
  const hostPathCandidates: string[] = [];
  const hostPathNames = hasPathSeparator(command)
    ? (api.extname(command) ? [api.basename(command)] : hostExtensions.map((extension) => `${api.basename(command)}${extension}`))
    : (platform === 'win32' && !commandHasExtension
      ? hostExtensions.map((extension) => `${command}${extension}`)
      : names);
  const appendPathCandidates = (target: string[], searchPath: string): void => {
    for (const directory of searchPath.split(sepChar)) {
      const searchDirectory = directory || options.cwd;
      for (const name of hostPathNames) target.push(api.resolve(options.cwd, searchDirectory, name));
    }
  };
  if (hasPathSeparator(command)) {
    for (const name of names) candidates.push(api.resolve(options.cwd, name));
    appendPathCandidates(hostPathCandidates, trustedHostPath);
  } else {
    if (platform === 'win32') {
      for (const name of names) candidates.push(api.resolve(options.cwd, name));
    }
    for (const directory of pathValue.split(sepChar)) {
      const searchDirectory = directory || options.cwd;
      for (const name of names) candidates.push(api.resolve(options.cwd, searchDirectory, name));
    }
    appendPathCandidates(hostPathCandidates, trustedHostPath);
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
    const isOwnedByCurrentUser = options.isOwnedByCurrentUser ?? isPosixPathOwnedByCurrentUser;
    if (platform !== 'win32' && isOwnedByCurrentUser(path)) return true;
    return isWritableByCurrentUser(path);
  };
  const roots = options.trustedRoots ?? defaultTrustedRoots(platform, options.env);
  const canonicalRoots = roots.map((root) => {
    try { return (options.realpath ?? canonicalPath)(root); } catch { return api.resolve(options.cwd, root); }
  });
  const resolvedControlledRoots = (options.controlledRoots ?? []).map((root) => api.resolve(options.cwd, root));
  const canonicalControlledRoots = (options.controlledRoots ?? []).map((root) => {
    try { return (options.realpath ?? canonicalPath)(root); } catch { return api.resolve(options.cwd, root); }
  });
  const canonicalHostCandidates = new Set(hostPathCandidates.flatMap((candidate) => {
    try { return [canonicalPathKey((options.realpath ?? realpathSync)(candidate), platform)]; } catch { return []; }
  }));

  for (const candidate of candidates) {
    if (!isFile(candidate)) continue;
    let canonical: string;
    try { canonical = realpath(candidate); } catch { continue; }
    const trustedRoot = canonicalRoots.find((root) => isInsideRoot(root, canonical, platform));
    const isHostPathIdentity = canonicalHostCandidates.has(canonicalPathKey(canonical, platform));
    const isControlled = canonicalControlledRoots.some((root) => isInsideRoot(root, canonical, platform)) ||
      resolvedControlledRoots.some((root) => isInsideRoot(root, candidate, platform));
    const sharedWritablePath = isPathChainWritableByOtherPrincipal(
      canonical,
      platform,
      options.isWritableByOtherPrincipal ?? ((path) => isWritableByOtherPrincipal(path, platform)),
    );
    const expectedHostOwnerUid = options.hostPathOwnerUid ?? HOST_PATH_OWNER_UID ??
      (platform !== 'win32' && process.geteuid?.() === 0
        ? options.controlledRoots?.map((root) => {
          try { return statSync(root).uid; } catch { return undefined; }
        }).find((uid): uid is number => uid !== undefined && uid > 0)
        : undefined);
    const ownerUid = options.ownerUid ?? ((path: string): number | undefined => {
      try { return statSync(path).uid; } catch { return undefined; }
    });
    const trustedHostOwnership = platform !== 'win32' && isPathChainOwnedByTrustedHostPrincipal(
      canonical,
      platform,
      (path) => {
        const uid = ownerUid(path);
        const effectiveUid = options.effectiveUid ?? process.geteuid?.();
        if (uid === 0 || uid === effectiveUid) return true;
        return effectiveUid === 0 && expectedHostOwnerUid !== undefined && uid === expectedHostOwnerUid;
      },
    );
    const protectedPath = !isPathChainWritable(
      canonical,
      platform,
      isProtectedPathWritableByCurrentUser,
    );
    const rootOwnedSystemPath = platform !== 'win32' && (options.effectiveUid ?? process.geteuid?.()) === 0 &&
      trustedRoot !== undefined && isPathChainOwnedByUid(canonical, platform, 0, ownerUid) && !sharedWritablePath;
    const invokedBase = normalizeExecutionBase(command);
    const compatibleHostIdentity = hostExecutableNameMatches(invokedBase, api.basename(canonical));
    // The already-running interpreter has a stronger identity source than a
    // PATH name: its canonical process.execPath is captured by this process.
    // It remains project-code risk, so this only lets semantic parsing retain
    // intent; it never makes scripts intrinsic or bypasses isolation.
    const activeHostExecutable = defaultTrustedExecutables(platform).includes(canonical);
    const trustedSystemIdentity = compatibleHostIdentity && !isControlled && (
      activeHostExecutable ||
      ((protectedPath || rootOwnedSystemPath) && trustedRoot !== undefined)
    );
    const hostSystem32 = options.hostWindowsSystem32 ?? (platform === process.platform ? HOST_WINDOWS_SYSTEM32 : undefined);
    const identity = fileIdentity(canonical);
    const trustedWindowsSystemShell = invokedBase === 'cmd' && platform === 'win32' && hostSystem32 !== undefined
      && isCanonicalWindowsSystemShell(canonical, hostSystem32) && !isControlled && identity !== undefined;
    // Trust is tied to the invoked command name plus a compatible canonical
    // executable identity. Explicit host aliases are enumerated above.
    const knownCommand = COMMAND_SPECS[invokedBase] !== undefined;
    // Host PATH is an operator-selected source of tools, including user-installed
    // toolchains. Pin the canonical file identity; never infer trust from a name
    // alone, and never trust a project/shadow lookalike even if it is on PATH.
    const trustedHostPathIdentity = knownCommand && compatibleHostIdentity &&
      (platform === 'win32' || trustedRoot === undefined) && isHostPathIdentity &&
      (platform === 'win32' || trustedHostOwnership) &&
      !isControlled && !sharedWritablePath && identity !== undefined;
    const trusted = identity !== undefined && (trustedWindowsSystemShell || trustedSystemIdentity || trustedHostPathIdentity);
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
  options: { realpath?: (path: string) => string; fileIdentity?: (path: string) => string | undefined; platform?: NodeJS.Platform } = {},
): boolean {
  try {
    const realpath = options.realpath ?? ((path: string) => realpathSync(path));
    const platform = options.platform ?? process.platform;
    if (canonicalPathKey(realpath(executable.path), platform) !== canonicalPathKey(executable.path, platform)) return false;
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
  options: { repoRoot?: string; invokedBase?: string } = {},
): ClassifiedInvocation {
  const base = normalizeExecutionBase(options.invokedBase ?? executable.base);
  if (!executable.trusted) {
    return {
      base,
      executionRisk: 'project_code',
      effectFamily: 'compiler_or_build',
      reason: 'untrusted_executable_identity',
    };
  }
  // `env` and similar launchers resolve another executable internally. Their
  // nested dispatch cannot be pinned by replacing only the outer executable.
  if (base === 'env') {
    return {
      base,
      executionRisk: 'project_code',
      effectFamily: 'compiler_or_build',
      reason: 'indirect_executable_dispatch',
    };
  }
  const quote = (value: string): string => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const invocation = [base, ...args].map(quote).join(' ');
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
    classification: classifyResolvedCommand(executable, args, {
      ...(options.repoRoot !== undefined ? { repoRoot: options.repoRoot } : {}),
      invokedBase: command,
    }),
  };
}

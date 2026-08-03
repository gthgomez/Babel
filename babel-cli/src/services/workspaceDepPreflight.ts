/**
 * Workspace dependency preflight (C2).
 *
 * Campaign/product path to reduce multi-minute explore thrash when the host
 * clone is not importable (ImportError / conftest load).
 *
 * - **Detect** install markers (pyproject/setup/requirements/package.json)
 * - **Probe** whether a package hint is importable
 * - **Optional install** into a workspace-local `.babel-venv` (campaign only)
 * - **Honest block** when still not ready after install attempt
 *
 * No network assumptions beyond what `pip`/`npm` need when install=true.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const BABEL_WORKSPACE_VENV = '.babel-venv';

/** Default minimum CPython for SWE-Pro / modern packages (`typing.Required` needs 3.11+). */
export const DEFAULT_MIN_PYTHON = { major: 3, minor: 11 } as const;

export interface PythonVersion {
  major: number;
  minor: number;
  patch: number;
}

export interface ResolvedSystemPython {
  /** Absolute interpreter path when available; otherwise a bare command name. */
  bin: string;
  version: string;
  major: number;
  minor: number;
  patch: number;
  /** How the interpreter was selected (for notes/telemetry). */
  source: string;
}

export type DepInstallKind =
  | 'python_editable'
  | 'python_requirements'
  | 'node_npm'
  | 'none';

export interface WorkspaceDepPlan {
  kind: DepInstallKind;
  markers: string[];
  packageHint: string | null;
  requirementFiles: string[];
  hasPyproject: boolean;
  hasSetupPy: boolean;
  hasPackageJson: boolean;
}

export interface WorkspaceDepPreflightResult {
  plan: WorkspaceDepPlan;
  ready: boolean;
  installed: boolean;
  blocked: boolean;
  reason: string | null;
  venvPath: string | null;
  /** Directory to prepend to PATH for the agent process. */
  pathPrefix: string | null;
  pythonBin: string | null;
  /** True only after the selected interpreter executes `--version`. */
  pythonExecutableValid?: boolean;
  commands: string[];
  probeDetail: string | null;
  durationMs: number;
  /** Soft-deps install attempted after collect soft-fail (W1 A). */
  softDepsAttempted?: boolean;
  softDepsInstalled?: string[];
}

const DEFAULT_INSTALL_TIMEOUT_MS = 8 * 60 * 1000;
const DEFAULT_PROBE_TIMEOUT_MS = 45_000;

/** Repo slug → importable package hint (`internetarchive/openlibrary` → `openlibrary`). */
export function packageHintFromRepo(repo: string | null | undefined): string | null {
  if (!repo?.trim()) return null;
  const leaf = repo.trim().split('/').pop() ?? repo.trim();
  const base = leaf.replace(/\.git$/i, '');
  if (!base) return null;
  // Common Python packaging: hyphens → underscores for import names.
  return base.replace(/-/g, '_');
}

function fileExists(root: string, name: string): boolean {
  return existsSync(join(root, name));
}

function listRequirementFiles(root: string): string[] {
  const candidates = [
    'requirements.txt',
    'requirements-dev.txt',
    'requirements_dev.txt',
    'test-requirements.txt',
    'requirements-test.txt',
    'dev-requirements.txt',
    // Common nested layouts (e.g. qutebrowser / misc packages)
    'requirements/tests.txt',
    'requirements/requirements.txt',
    'misc/requirements/requirements-tests.txt',
    'misc/requirements/requirements.txt',
  ];
  return candidates.filter((c) => fileExists(root, c));
}

/**
 * Read a best-effort package name from pyproject.toml (name = "…").
 * Pure string parse — no TOML dependency.
 */
export function packageNameFromPyproject(text: string): string | null {
  // Prefer [project] name = "foo" over tool tables.
  const projectBlock = text.match(/\[project\]([\s\S]*?)(?=\n\[|$)/i);
  const slice = projectBlock?.[1] ?? text;
  const m = slice.match(/^\s*name\s*=\s*["']([^"']+)["']/m);
  if (!m?.[1]) return null;
  return m[1].replace(/-/g, '_');
}

export function detectWorkspaceDepPlan(
  workspaceRoot: string,
  packageHint?: string | null,
): WorkspaceDepPlan {
  const hasPyproject = fileExists(workspaceRoot, 'pyproject.toml');
  const hasSetupPy =
    fileExists(workspaceRoot, 'setup.py') || fileExists(workspaceRoot, 'setup.cfg');
  const hasPackageJson = fileExists(workspaceRoot, 'package.json');
  const requirementFiles = listRequirementFiles(workspaceRoot);
  const markers: string[] = [];
  if (hasPyproject) markers.push('pyproject.toml');
  if (fileExists(workspaceRoot, 'setup.py')) markers.push('setup.py');
  if (fileExists(workspaceRoot, 'setup.cfg')) markers.push('setup.cfg');
  for (const r of requirementFiles) markers.push(r);
  if (hasPackageJson) markers.push('package.json');

  let hint = packageHint?.trim() || null;
  if (!hint && hasPyproject) {
    try {
      const text = readFileSync(join(workspaceRoot, 'pyproject.toml'), 'utf8');
      hint = packageNameFromPyproject(text);
    } catch {
      // ignore
    }
  }
  if (!hint) {
    // Top-level package dir that is not tests/docs/common noise
    try {
      const skip = new Set([
        'tests',
        'test',
        'docs',
        'doc',
        'scripts',
        'tools',
        'ci',
        '.git',
        'node_modules',
        'dist',
        'build',
        'examples',
        'benchmarks',
      ]);
      const dirs = readdirSync(workspaceRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !skip.has(d.name))
        .map((d) => d.name);
      for (const d of dirs) {
        if (
          existsSync(join(workspaceRoot, d, '__init__.py')) ||
          existsSync(join(workspaceRoot, d, 'py.typed'))
        ) {
          hint = d;
          break;
        }
      }
    } catch {
      // ignore
    }
  }

  if (hasPyproject || hasSetupPy) {
    return {
      kind: 'python_editable',
      markers,
      packageHint: hint,
      requirementFiles,
      hasPyproject,
      hasSetupPy,
      hasPackageJson,
    };
  }
  if (requirementFiles.length > 0) {
    return {
      kind: 'python_requirements',
      markers,
      packageHint: hint,
      requirementFiles,
      hasPyproject,
      hasSetupPy,
      hasPackageJson,
    };
  }
  if (hasPackageJson) {
    return {
      kind: 'node_npm',
      markers,
      packageHint: hint,
      requirementFiles,
      hasPyproject,
      hasSetupPy,
      hasPackageJson,
    };
  }
  return {
    kind: 'none',
    markers,
    packageHint: hint,
    requirementFiles,
    hasPyproject,
    hasSetupPy,
    hasPackageJson,
  };
}

/**
 * Parse `Python X.Y.Z` or bare `X.Y.Z` from interpreter output.
 */
export function parsePythonVersion(text: string): PythonVersion | null {
  const m = text.match(/(?:Python\s+)?(\d+)\.(\d+)(?:\.(\d+))?/i);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3] ?? 0),
  };
}

export function pythonVersionMeetsMin(
  version: PythonVersion,
  min: { major: number; minor: number },
): boolean {
  if (version.major !== min.major) return version.major > min.major;
  return version.minor >= min.minor;
}

function probePythonInvocation(
  bin: string,
  prefixArgs: string[] = [],
): ResolvedSystemPython | null {
  // Prefer sys.executable so venvs are created with a real path, not `py -3.11`.
  const r = spawnSync(
    bin,
    [
      ...prefixArgs,
      '-c',
      'import sys; print("%d.%d.%d" % sys.version_info[:3]); print(sys.executable)',
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
    },
  );
  if (r.status !== 0) return null;
  const lines = `${r.stdout ?? ''}`
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const versionLine = lines[0] ?? '';
  const executable = lines[1]?.trim() || bin;
  const parsed = parsePythonVersion(versionLine);
  if (!parsed) return null;
  // Reject MSYS/MinGW python on Windows when a native alternative exists later
  // in the candidate list; caller ranks native first.
  return {
    bin: executable,
    version: `${parsed.major}.${parsed.minor}.${parsed.patch}`,
    major: parsed.major,
    minor: parsed.minor,
    patch: parsed.patch,
    source: prefixArgs.length ? `${bin} ${prefixArgs.join(' ')}` : bin,
  };
}

function isMsysPath(bin: string): boolean {
  const n = bin.replace(/\\/g, '/').toLowerCase();
  return n.includes('/msys') || n.includes('/mingw');
}

/**
 * Resolve a host Python interpreter.
 *
 * Preference order:
 * 1. `BABEL_WORKSPACE_PYTHON` / `BABEL_PYTHON` env (if executable)
 * 2. Versioned launchers (`py -3.12`, `py -3.11`, `python3.12`, `python3.11`, …)
 * 3. Generic `python` / `python3` / `py` only when they meet min version
 *
 * On Windows, native installers are preferred over MSYS/MinGW paths so venvs
 * get `Scripts/` + MSVC wheels instead of broken `bin/` layouts.
 */
export function resolveSystemPython(options?: {
  /** Preferred / required minimum major (default 3). */
  minMajor?: number;
  /** Preferred / required minimum minor (default 11). */
  minMinor?: number;
  /**
   * When true, fail if no interpreter meets min.
   * When false, prefer min+ but fall back to any working CPython.
   */
  requireMin?: boolean;
  env?: NodeJS.ProcessEnv;
}): { ok: true; python: ResolvedSystemPython } | { ok: false; reason: string; tried: string[] } {
  const env = options?.env ?? process.env;
  const preferMin = {
    major: options?.minMajor ?? DEFAULT_MIN_PYTHON.major,
    minor: options?.minMinor ?? DEFAULT_MIN_PYTHON.minor,
  };
  const requireMin = options?.requireMin === true;
  const tried: string[] = [];

  const probeLabeled = (
    label: string,
    bin: string,
    prefixArgs: string[] = [],
  ): ResolvedSystemPython | null => {
    tried.push(label);
    const probed = probePythonInvocation(bin, prefixArgs);
    if (!probed) return null;
    return { ...probed, source: label };
  };

  const allHits: ResolvedSystemPython[] = [];

  const envOverride =
    env['BABEL_WORKSPACE_PYTHON']?.trim() || env['BABEL_PYTHON']?.trim() || '';
  if (envOverride) {
    const hit = probeLabeled(`env:${envOverride}`, envOverride);
    if (hit) allHits.push(hit);
  }

  type Cand = { label: string; bin: string; args?: string[] };
  const versioned: Cand[] =
    process.platform === 'win32'
      ? [
          { label: 'py -3.13', bin: 'py', args: ['-3.13'] },
          { label: 'py -3.12', bin: 'py', args: ['-3.12'] },
          { label: 'py -3.11', bin: 'py', args: ['-3.11'] },
          { label: 'python3.13', bin: 'python3.13' },
          { label: 'python3.12', bin: 'python3.12' },
          { label: 'python3.11', bin: 'python3.11' },
        ]
      : [
          { label: 'python3.13', bin: 'python3.13' },
          { label: 'python3.12', bin: 'python3.12' },
          { label: 'python3.11', bin: 'python3.11' },
        ];

  const generic: Cand[] =
    process.platform === 'win32'
      ? [
          { label: 'python', bin: 'python' },
          { label: 'py -3', bin: 'py', args: ['-3'] },
          { label: 'py', bin: 'py' },
          { label: 'python3', bin: 'python3' },
        ]
      : [
          { label: 'python3', bin: 'python3' },
          { label: 'python', bin: 'python' },
        ];

  for (const c of [...versioned, ...generic]) {
    const hit = probeLabeled(c.label, c.bin, c.args ?? []);
    if (hit) allHits.push(hit);
  }

  // Deduplicate by resolved executable path.
  const unique = new Map<string, ResolvedSystemPython>();
  for (const hit of allHits) {
    const key = hit.bin.replace(/\\/g, '/').toLowerCase();
    if (!unique.has(key)) unique.set(key, hit);
  }
  const hits = [...unique.values()];

  const rank = (list: ResolvedSystemPython[]): ResolvedSystemPython[] =>
    [...list].sort((a, b) => {
      const aMsys = isMsysPath(a.bin) ? 1 : 0;
      const bMsys = isMsysPath(b.bin) ? 1 : 0;
      if (aMsys !== bMsys) return aMsys - bMsys;
      if (a.major !== b.major) return b.major - a.major;
      if (a.minor !== b.minor) return b.minor - a.minor;
      return b.patch - a.patch;
    });

  const meetingMin = rank(hits.filter((h) => pythonVersionMeetsMin(h, preferMin)));
  const any = rank(hits);

  if (meetingMin.length > 0) {
    return { ok: true, python: meetingMin[0]! };
  }
  if (!requireMin && any.length > 0) {
    return { ok: true, python: any[0]! };
  }

  return {
    ok: false,
    reason: `no Python >= ${preferMin.major}.${preferMin.minor} found (need typing.Required / modern packaging). Tried: ${tried.join(', ') || 'none'}. Set BABEL_WORKSPACE_PYTHON to a 3.11+ interpreter or install Python ${preferMin.major}.${preferMin.minor}+.`,
    tried,
  };
}

/** Resolve a string path/command for probes; prefers 3.11+ when present. */
function resolveSystemPythonBin(min?: { major: number; minor: number }): string {
  const resolved = resolveSystemPython({
    minMajor: min?.major ?? DEFAULT_MIN_PYTHON.major,
    minMinor: min?.minor ?? DEFAULT_MIN_PYTHON.minor,
    requireMin: false,
  });
  if (resolved.ok) return resolved.python.bin;
  return process.platform === 'win32' ? 'python' : 'python3';
}

/**
 * Resolve venv interpreter. Windows stdlib uses `Scripts/`; MSYS2/MinGW and
 * Unix use `bin/` (observed on this host with C:\\msys64\\mingw64 python).
 */
export function resolveVenvPython(workspaceRoot: string): string | null {
  const base = join(workspaceRoot, BABEL_WORKSPACE_VENV);
  const candidates = [
    join(base, 'Scripts', 'python.exe'),
    join(base, 'Scripts', 'python'),
    join(base, 'bin', 'python.exe'),
    join(base, 'bin', 'python3.exe'),
    join(base, 'bin', 'python'),
    join(base, 'bin', 'python3'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Validate that a resolved interpreter is executable, not merely present on
 * disk. This matters on Windows/MSYS layouts where a stale `bin/python.exe`
 * placeholder can win path resolution but cannot run pytest.
 */
export function validatePythonExecutable(input: {
  pythonBin: string;
  cwd?: string;
  timeoutMs?: number;
}): { ok: boolean; detail: string } {
  const r = spawnSync(input.pythonBin, ['--version'], {
    cwd: input.cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: input.timeoutMs ?? 10_000,
  });
  const blob = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim();
  if (r.status === 0 && /python\s+\d/i.test(blob)) {
    return { ok: true, detail: blob.slice(0, 160) };
  }
  return {
    ok: false,
    detail: (blob || (r.error ? r.error.message : `exit ${r.status ?? 'null'}`)).slice(0, 500),
  };
}

function venvPython(workspaceRoot: string): string {
  return (
    resolveVenvPython(workspaceRoot) ??
    (process.platform === 'win32'
      ? join(workspaceRoot, BABEL_WORKSPACE_VENV, 'Scripts', 'python.exe')
      : join(workspaceRoot, BABEL_WORKSPACE_VENV, 'bin', 'python'))
  );
}

export function probePythonImport(input: {
  packageName: string;
  cwd: string;
  pythonBin?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}): { ok: boolean; detail: string } {
  const py = input.pythonBin ?? resolveSystemPythonBin();
  const code = `import importlib; importlib.import_module(${JSON.stringify(input.packageName)}); print("ok")`;
  const r = spawnSync(py, ['-c', code], {
    cwd: input.cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: input.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
    env: input.env ?? process.env,
  });
  const blob = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim();
  if (r.status === 0 && /\bok\b/.test(blob)) {
    return { ok: true, detail: blob.slice(0, 200) };
  }
  const err =
    blob ||
    (r.error ? String(r.error.message) : `exit ${r.status ?? 'null'}`);
  return { ok: false, detail: err.slice(0, 500) };
}

/**
 * Truncate probe text but keep the tail when long Windows paths push the real
 * `No module named X` past a head-only slice (blocks multi-round soft-deps).
 */
export function truncateProbeDetail(blob: string, max = 900): string {
  if (blob.length <= max) return blob;
  // Prefer keeping ModuleNotFound / No module named lines when present.
  const missingHit = blob.search(/No module named|ModuleNotFoundError/i);
  if (missingHit >= 0) {
    const start = Math.max(0, missingHit - 120);
    const slice = blob.slice(start, start + max);
    return start > 0 ? `…${slice}` : slice;
  }
  // Default: tail (pytest prints the root cause last)
  return `…${blob.slice(-max)}`;
}

/**
 * Light verify readiness: `python -m pytest --collect-only -q` (optionally one path).
 * Catches ImportError-while-loading-conftest that bare package import misses.
 */
export function probePytestCollect(input: {
  cwd: string;
  pythonBin?: string;
  testPath?: string | null;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}): { ok: boolean; detail: string } {
  const py = input.pythonBin ?? resolveSystemPythonBin();
  const args = ['-m', 'pytest', '--collect-only', '-q'];
  if (input.testPath?.trim()) {
    args.push(input.testPath.trim());
  }
  const r = spawnSync(py, args, {
    cwd: input.cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: input.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
    env: input.env ?? process.env,
  });
  const blob = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim();
  // Collection can exit 2/5 for "no tests" while still proving imports work.
  // Treat import/conftest failures as not ready; empty suite is still ready.
  const lower = blob.toLowerCase();
  if (
    /\bimporterror\b/.test(lower) ||
    /\bmodulenotfounderror\b/.test(lower) ||
    /\bwhile loading conftest\b/.test(lower) ||
    /\bno module named\b/.test(lower)
  ) {
    return { ok: false, detail: truncateProbeDetail(blob) };
  }
  if (r.error) {
    return { ok: false, detail: r.error.message.slice(0, 500) };
  }
  // pytest missing
  if (/no module named pytest|No module named pytest/i.test(blob)) {
    return { ok: false, detail: truncateProbeDetail(blob) };
  }
  if (r.status === 0 || /no tests collected/i.test(blob)) {
    return { ok: true, detail: blob.slice(0, 200) || 'collect_ok' };
  }
  // Other non-zero: still blocked if looks like env, else soft-ok when package imported
  if (r.status !== 0 && r.status != null) {
    return {
      ok: false,
      detail: truncateProbeDetail(blob) || `pytest collect exit ${r.status}`,
    };
  }
  return { ok: true, detail: blob.slice(0, 200) };
}

/**
 * Parse missing import names from pytest/collect/ImportError text.
 * Pure — used for soft-deps install after collect soft-fail (W1 A / 4a5d).
 */
export function parseMissingModulesFromProbe(detail: string | null | undefined): string[] {
  if (!detail?.trim()) return [];
  const out: string[] = [];
  const re = /No module named ['"]([^'"]+)['"]/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(detail)) !== null) {
    const raw = (m[1] ?? '').trim();
    if (!raw) continue;
    // top-level package only (web.utils → web)
    const top = raw.split('.')[0]!;
    if (top && !out.includes(top)) out.push(top);
  }
  // ModuleNotFoundError: No module named web (unquoted rare form)
  const re2 = /ModuleNotFoundError:\s*No module named\s+([A-Za-z_][\w]*)/gi;
  while ((m = re2.exec(detail)) !== null) {
    const top = (m[1] ?? '').trim();
    if (top && !out.includes(top)) out.push(top);
  }
  return out.slice(0, 12);
}

/**
 * Parse `ERROR: Missing required plugins: pytest-bdd, pytest-qt, …` from collect.
 * Pip distribution names match the plugin names for the common pytest-* set.
 */
export function parseMissingPytestPluginsFromProbe(
  detail: string | null | undefined,
): string[] {
  if (!detail?.trim()) return [];
  const out: string[] = [];
  const m = detail.match(/Missing required plugins:\s*([^\n\r]+)/i);
  if (!m?.[1]) return out;
  for (const part of m[1].split(/[,]+/)) {
    const name = part.trim().replace(/\s+/g, '');
    if (!name) continue;
    if (!/^pytest[\w.-]*$/i.test(name) && !/^[\w.-]+$/.test(name)) continue;
    const pipName = name.toLowerCase();
    if (!out.includes(pipName)) out.push(pipName);
  }
  return out.slice(0, 16);
}

/**
 * Detect collect failures caused by host pytest being too new for the project
 * (qutebrowser conftest still uses pytest_ignore_collect(path), removed in pytest 8).
 */
export function parsePytestVersionPinFromProbe(
  detail: string | null | undefined,
): string | null {
  if (!detail?.trim()) return null;
  if (
    /PluginValidationError/i.test(detail) &&
    /pytest_ignore_collect/i.test(detail) &&
    /\bpath\b/.test(detail)
  ) {
    return 'pytest>=7,<8';
  }
  return null;
}

/**
 * Read `required_plugins` from pytest.ini (qutebrowser-style multi-line list).
 */
export function parseRequiredPluginsFromPytestIni(text: string): string[] {
  const out: string[] = [];
  const lines = text.split(/\r?\n/);
  let inRequired = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^required_plugins\s*=/.test(trimmed)) {
      inRequired = true;
      const same = trimmed.replace(/^required_plugins\s*=\s*/, '').trim();
      if (same) {
        for (const p of same.split(/[,\s]+/)) {
          if (p && !out.includes(p)) out.push(p);
        }
      }
      continue;
    }
    if (inRequired) {
      if (!trimmed || trimmed.startsWith('#')) continue;
      if (/^\w+\s*=/.test(trimmed) || trimmed.startsWith('[')) break;
      const name = trimmed.replace(/[,]/g, '').trim();
      if (name && !out.includes(name)) out.push(name);
    }
  }
  return out.slice(0, 16);
}

function readWorkspacePytestRequiredPlugins(workspaceRoot: string): string[] {
  for (const rel of ['pytest.ini', 'pytest.cfg']) {
    const path = join(workspaceRoot, rel);
    if (!existsSync(path)) continue;
    try {
      return parseRequiredPluginsFromPytestIni(readFileSync(path, 'utf8'));
    } catch {
      // ignore
    }
  }
  return [];
}

/**
 * Known host soft-deps when collect fails but package import works.
 * Prefer requirements.txt lines when present; these are fallbacks.
 */
export const SOFT_DEP_PIP_FALLBACK: Readonly<Record<string, readonly string[]>> = {
  web: ['web.py'],
  /** PyPI name for `import multipart` (OpenLibrary requirements pin multipart==0.2.4). */
  multipart: ['multipart'],
  /** Common transitive imports surfaced by legacy OpenLibrary/infogami collection. */
  requests: ['requests'],
  simplejson: ['simplejson'],
  /**
   * OpenLibrary vendors infogami as a git submodule (often empty on shallow clones).
   * Prefer git URL over bare `pip install infogami` (not a reliable PyPI package).
   */
  infogami: ['git+https://github.com/internetarchive/infogami.git'],
  eventer: ['eventer'],
  psycopg2: ['psycopg2-binary'],
  /** qutebrowser / pytest-qt GUI collect needs a Qt binding on the host. */
  PyQt5: ['PyQt5'],
  PyQt6: ['PyQt6'],
  sip: ['PyQt5'],
};

/**
 * Max soft-dep re-probe rounds after collect soft-fail.
 *
 * Legacy conftest imports often reveal one missing transitive module per
 * probe (web → multipart → infogami → simplejson → requests → project
 * utilities). Keep the remediation finite while allowing the full observed
 * chain to settle.
 */
export const SOFT_DEP_MAX_ROUNDS = 16;

/**
 * Find a requirements line that likely satisfies a missing module.
 * Handles git+ pins (webpy) and simple package names.
 */
export function findRequirementLineForModule(
  requirementsText: string,
  moduleName: string,
): string | null {
  const mod = moduleName.trim().toLowerCase();
  if (!mod) return null;
  const aliases = new Set<string>([mod]);
  // Python import names commonly use underscores while pip distributions use
  // hyphens (for example paapi5_python_sdk vs paapi5-python-sdk).
  aliases.add(mod.replace(/_/g, '-'));
  if (mod === 'web') {
    aliases.add('web.py');
    aliases.add('webpy');
    aliases.add('web-py');
  }
  for (const line of requirementsText.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const lower = t.toLowerCase();
    for (const a of aliases) {
      if (lower.includes(a)) return t;
    }
  }
  return null;
}

/**
 * Install soft-deps for modules missing from collect soft-fail.
 * Best-effort; does not throw. Returns pip specs that were attempted successfully.
 */
/**
 * Resolve a pip install spec for a missing import, including vendored paths
 * (OpenLibrary `vendor/infogami` / root `infogami`).
 */
export function resolveSoftDepSpecForModule(
  workspaceRoot: string,
  moduleName: string,
  requirementBodies: string[],
): string | null {
  const mod = moduleName.trim();
  if (!mod) return null;
  // Source psycopg2 frequently cannot build on Windows; the binary wheel is
  // the intentional host-safe substitute even when requirements pin psycopg2.
  if (mod.toLowerCase() === 'psycopg2') return SOFT_DEP_PIP_FALLBACK.psycopg2?.[0] ?? null;
  for (const body of requirementBodies) {
    const found = findRequirementLineForModule(body, mod);
    if (found) return found;
  }
  // Vendored infogami (OpenLibrary) — only when submodule is actually populated
  if (mod === 'infogami') {
    for (const rel of ['vendor/infogami', 'infogami']) {
      const abs = join(workspaceRoot, rel);
      try {
        // Skip empty submodule placeholders / gitlinks (no real package tree).
        const hasSetup =
          existsSync(join(abs, 'setup.py')) || existsSync(join(abs, 'pyproject.toml'));
        const hasPkg =
          existsSync(join(abs, '__init__.py')) ||
          existsSync(join(abs, 'infobase')) ||
          existsSync(join(abs, 'infogami', '__init__.py'));
        if (hasSetup || hasPkg) {
          return `-e ${rel}`;
        }
      } catch {
        // ignore
      }
    }
  }
  const fallback = SOFT_DEP_PIP_FALLBACK[mod];
  if (fallback?.[0]) return fallback[0];
  return null;
}

export function installSoftDepsForCollectFail(input: {
  workspaceRoot: string;
  pythonBin: string;
  probeDetail: string;
  requirementFiles?: string[];
  timeoutMs?: number;
  commands?: string[];
  /** Specs already installed this preflight — skip re-pip. */
  alreadyInstalled?: string[];
  /** Extra pip specs to attempt (e.g. pytest.ini required_plugins). */
  extraSpecs?: string[];
}): { installed: string[]; attempted: boolean; detail: string } {
  const workspaceRoot = resolve(input.workspaceRoot);
  const missingMods = parseMissingModulesFromProbe(input.probeDetail);
  const missingPlugins = parseMissingPytestPluginsFromProbe(input.probeDetail);
  const pytestPin = parsePytestVersionPinFromProbe(input.probeDetail);
  const missing = [...missingMods, ...missingPlugins];
  if (missing.length === 0 && !(input.extraSpecs?.length) && !pytestPin) {
    return { installed: [], attempted: false, detail: 'no_missing_modules' };
  }
  const timeout = input.timeoutMs ?? Math.min(DEFAULT_INSTALL_TIMEOUT_MS, 4 * 60 * 1000);
  const commands = input.commands ?? [];
  const installed: string[] = [];
  const details: string[] = [];
  const already = new Set(
    (input.alreadyInstalled ?? []).map((s) => s.trim()).filter(Boolean),
  );

  // Load requirement files once
  const reqBodies: string[] = [];
  for (const rel of input.requirementFiles ?? []) {
    try {
      reqBodies.push(readFileSync(join(workspaceRoot, rel), 'utf8'));
    } catch {
      // ignore
    }
  }

  const specs: string[] = [...(input.extraSpecs ?? [])];
  if (pytestPin) specs.push(pytestPin);
  for (const mod of missing) {
    // pytest-* plugins: pip name is usually the plugin name itself.
    if (/^pytest[\w.-]*$/i.test(mod)) {
      specs.push(mod);
      continue;
    }
    const found = resolveSoftDepSpecForModule(workspaceRoot, mod, reqBodies);
    if (found) {
      specs.push(found);
      continue;
    }
    // Last resort for capitalised Qt bindings (import PyQt5 → pip PyQt5).
    if (/^PyQt\d$/i.test(mod) || /^PySide\d$/i.test(mod)) {
      specs.push(mod);
    }
  }
  // Dedupe specs; skip already installed this session
  const uniqueSpecs = [
    ...new Set(specs.map((s) => s.trim()).filter((s) => s && !already.has(s))),
  ].slice(0, 12);
  if (uniqueSpecs.length === 0) {
    return {
      installed: [],
      attempted: true,
      detail: `missing=${missing.join(',')} no_new_specs`,
    };
  }

  for (const spec of uniqueSpecs) {
    // git+ URL / path / -e editable: pass tokens carefully
    const isUrlOrVcs = /^(git\+|https?:|file:)/i.test(spec) || spec.includes('://');
    const isEditable = /^\s*-e\s+/i.test(spec);
    const args = isUrlOrVcs
      ? ['-m', 'pip', 'install', spec]
      : isEditable
        ? ['-m', 'pip', 'install', ...spec.split(/\s+/).filter(Boolean)]
        : ['-m', 'pip', 'install', ...spec.split(/\s+/).filter(Boolean)];
    commands.push(`${input.pythonBin} -m pip install ${spec}`);
    const r = runCmd(input.pythonBin, args, {
      cwd: workspaceRoot,
      timeoutMs: timeout,
    });
    details.push(`${spec}:${r.ok ? 'ok' : 'fail'}`);
    if (r.ok) installed.push(spec);
  }
  return {
    installed,
    attempted: true,
    detail: `missing=${missing.join(',') || 'plugins'} ${details.join(' ')}`.slice(0, 500),
  };
}

/**
 * Format a short model/operator note when the workspace package is not importable.
 * Pure — no I/O.
 */
export function formatWorkspaceDepUnreadyNote(input: {
  packageHint: string | null;
  probeDetail?: string | null;
}): string {
  const pkg = input.packageHint ?? 'the project package';
  const signal = input.probeDetail
    ? input.probeDetail.replace(/\s+/g, ' ').trim().slice(0, 160)
    : 'not importable on host Python';
  return [
    `- Workspace env: \`${pkg}\` is not importable (${signal}).`,
    '  Install project deps (`pip install -e .` or requirements) before long explore,',
    '  or apply the patch and report ENV_BLOCKED after one failed verify — do not thrash.',
  ].join('\n');
}

function runCmd(
  cmd: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv },
): { ok: boolean; detail: string } {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: opts.timeoutMs,
    env: opts.env ?? process.env,
    shell: process.platform === 'win32' && cmd === 'npm',
  });
  const blob = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim();
  if (r.status === 0) return { ok: true, detail: blob.slice(0, 400) };
  return {
    ok: false,
    detail: (blob || (r.error ? r.error.message : `exit ${r.status}`)).slice(0, 600),
  };
}

/**
 * Run workspace dep preflight.
 *
 * When `install` is true (campaign default), creates `.babel-venv` and installs
 * editable/requirements/npm deps. When install is false (product guidance path),
 * only probes and reports readiness.
 */
/**
 * Optional hard minimum from env (`BABEL_MIN_PYTHON=3.11`).
 * When unset, preflight *prefers* 3.11+ but does not fail solely on 3.10.
 */
export function parseMinPythonEnv(
  env: NodeJS.ProcessEnv = process.env,
): { major: number; minor: number } | null {
  const raw = env['BABEL_MIN_PYTHON']?.trim() || env['BABEL_REQUIRE_PYTHON_MIN']?.trim();
  if (raw) {
    const m = raw.match(/^(\d+)\.(\d+)/);
    if (m) return { major: Number(m[1]), minor: Number(m[2]) };
  }
  return null;
}

export function runWorkspaceDepPreflight(input: {
  workspaceRoot: string;
  packageHint?: string | null;
  /** Optional test path for pytest --collect-only probe. */
  testPath?: string | null;
  /** Attempt local install (default true). */
  install?: boolean;
  installTimeoutMs?: number;
  probeTimeoutMs?: number;
  /**
   * Hard minimum CPython for venv creation. When set (or via BABEL_MIN_PYTHON),
   * preflight refuses <min instead of creating a doomed 3.10 venv.
   * SWE-Pro campaigns should pass 3.11.
   */
  minPython?: { major: number; minor: number };
  /** When true, enforce DEFAULT_MIN_PYTHON (3.11) even if env unset. */
  requireMinPython?: boolean;
}): WorkspaceDepPreflightResult {
  const started = performance.now();
  const workspaceRoot = resolve(input.workspaceRoot);
  const commands: string[] = [];
  const plan = detectWorkspaceDepPlan(workspaceRoot, input.packageHint);
  const install = input.install !== false;
  const installTimeout = input.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS;
  const probeTimeout = input.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const minPython =
    input.minPython ??
    parseMinPythonEnv() ??
    (input.requireMinPython
      ? { major: DEFAULT_MIN_PYTHON.major, minor: DEFAULT_MIN_PYTHON.minor }
      : null);
  const preferMin = minPython ?? {
    major: DEFAULT_MIN_PYTHON.major,
    minor: DEFAULT_MIN_PYTHON.minor,
  };
  const requireMin = minPython != null;

  if (plan.kind === 'none') {
    return {
      plan,
      ready: true,
      installed: false,
      blocked: false,
      reason: null,
      venvPath: null,
      pathPrefix: null,
      pythonBin: null,
      commands,
      probeDetail: 'no_install_markers',
      durationMs: Math.round(performance.now() - started),
    };
  }

  // Node path: optional npm install when node_modules missing
  if (plan.kind === 'node_npm') {
    const hasModules = existsSync(join(workspaceRoot, 'node_modules'));
    if (hasModules) {
      return {
        plan,
        ready: true,
        installed: false,
        blocked: false,
        reason: null,
        venvPath: null,
        pathPrefix: null,
        pythonBin: null,
        commands,
        probeDetail: 'node_modules_present',
        durationMs: Math.round(performance.now() - started),
      };
    }
    if (!install) {
      return {
        plan,
        ready: false,
        installed: false,
        blocked: true,
        reason: 'node_modules missing; npm install not run (install=false)',
        venvPath: null,
        pathPrefix: null,
        pythonBin: null,
        commands,
        probeDetail: 'node_modules_missing',
        durationMs: Math.round(performance.now() - started),
      };
    }
    commands.push('npm install');
    const npm = runCmd('npm', ['install', '--no-fund', '--no-audit'], {
      cwd: workspaceRoot,
      timeoutMs: installTimeout,
    });
    if (!npm.ok) {
      return {
        plan,
        ready: false,
        installed: false,
        blocked: true,
        reason: `npm install failed: ${npm.detail}`,
        venvPath: null,
        pathPrefix: null,
        pythonBin: null,
        commands,
        probeDetail: npm.detail,
        durationMs: Math.round(performance.now() - started),
      };
    }
    return {
      plan,
      ready: true,
      installed: true,
      blocked: false,
      reason: null,
      venvPath: null,
      pathPrefix: null,
      pythonBin: null,
      commands,
      probeDetail: 'npm_install_ok',
      durationMs: Math.round(performance.now() - started),
    };
  }

  // Python paths — prefer 3.11+; hard-require when minPython / BABEL_MIN_PYTHON set.
  const systemResolved = resolveSystemPython({
    minMajor: preferMin.major,
    minMinor: preferMin.minor,
    requireMin,
  });
  if (!systemResolved.ok) {
    return {
      plan,
      ready: false,
      installed: false,
      blocked: true,
      reason: systemResolved.reason,
      venvPath: null,
      pathPrefix: null,
      pythonBin: null,
      pythonExecutableValid: false,
      commands,
      probeDetail: `python_resolve_failed tried=${systemResolved.tried.join('|')}`,
      durationMs: Math.round(performance.now() - started),
    };
  }
  const systemPy = systemResolved.python.bin;
  commands.push(
    `# system_python=${systemPy} version=${systemResolved.python.version} source=${systemResolved.python.source} prefer=${preferMin.major}.${preferMin.minor} requireMin=${requireMin}`,
  );
  let pythonBin = systemPy;
  let venvPath: string | null = null;
  let pathPrefix: string | null = null;
  let installed = false;

  /**
   * Ready enough to start the agent: package importable, pytest present, and
   * the selected verifier target collects successfully. Collection is a hard
   * readiness boundary when a test path is supplied; otherwise the package
   * and pytest probes are sufficient.
   */
  const probePythonReady = (bin: string): {
    ok: boolean;
    collectOk: boolean;
    detail: string;
  } => {
    const parts: string[] = [];
    if (plan.packageHint) {
      const pkg = probePythonImport({
        packageName: plan.packageHint,
        cwd: workspaceRoot,
        pythonBin: bin,
        timeoutMs: probeTimeout,
      });
      parts.push(`import:${pkg.detail}`);
      if (!pkg.ok) return { ok: false, collectOk: false, detail: parts.join(' | ') };
    }
    const pytestMod = probePythonImport({
      packageName: 'pytest',
      cwd: workspaceRoot,
      pythonBin: bin,
      timeoutMs: probeTimeout,
    });
    parts.push(`pytest_mod:${pytestMod.detail}`);
    if (!pytestMod.ok) return { ok: false, collectOk: false, detail: parts.join(' | ') };
    let collectOk = true;
    if (input.testPath?.trim()) {
      const collect = probePytestCollect({
        cwd: workspaceRoot,
        pythonBin: bin,
        testPath: input.testPath,
        timeoutMs: Math.min(probeTimeout, 20_000),
      });
      parts.push(`collect_${collect.ok ? 'ok' : 'soft_fail'}:${collect.detail}`);
      collectOk = collect.ok;
    }
    return { ok: true, collectOk, detail: parts.join(' | ') };
  };

  const first = probePythonReady(pythonBin);
  if (first.ok && first.collectOk) {
    return {
      plan,
      ready: true,
      installed: false,
      blocked: false,
      reason: null,
      venvPath: null,
      pathPrefix: null,
      pythonBin,
      pythonExecutableValid: true,
      commands,
      probeDetail: first.detail,
      durationMs: Math.round(performance.now() - started),
    };
  }

  if (!install) {
    return {
      plan,
      ready: false,
      installed: false,
      blocked: true,
      reason: `workspace not verify-ready (install=false): ${first.detail}`,
      venvPath: null,
      pathPrefix: null,
      pythonBin,
      commands,
      probeDetail: first.detail,
      durationMs: Math.round(performance.now() - started),
    };
  }

  // Create venv + install
  venvPath = join(workspaceRoot, BABEL_WORKSPACE_VENV);

  const venvMeetsMin = (bin: string): boolean => {
    if (!requireMin) return true;
    const probed = probePythonInvocation(bin);
    return Boolean(probed && pythonVersionMeetsMin(probed, preferMin));
  };

  let existingVenv = resolveVenvPython(workspaceRoot);
  if (existingVenv && requireMin && !venvMeetsMin(existingVenv)) {
    commands.push(
      `# recreate_venv: existing interpreter below min ${preferMin.major}.${preferMin.minor}`,
    );
    try {
      rmSync(venvPath, { recursive: true, force: true });
    } catch {
      // best-effort; create will fail clearly if stale dir blocks
    }
    existingVenv = null;
  }

  if (!existingVenv) {
    commands.push(`${systemPy} -m venv ${BABEL_WORKSPACE_VENV}`);
    mkdirSync(workspaceRoot, { recursive: true });
    const venv = runCmd(systemPy, ['-m', 'venv', BABEL_WORKSPACE_VENV], {
      cwd: workspaceRoot,
      timeoutMs: Math.min(installTimeout, 120_000),
    });
    // Success = interpreter exists (MSYS venvs may non-zero-exit with useful stdout).
    const resolvedAfter = resolveVenvPython(workspaceRoot);
    if (!resolvedAfter) {
      return {
        plan,
        ready: false,
        installed: false,
        blocked: true,
        reason: `venv create failed with ${systemPy} (${systemResolved.python.version}): ${venv.detail}`,
        venvPath,
        pathPrefix: null,
        pythonBin: systemPy,
        pythonExecutableValid: true,
        commands,
        probeDetail: venv.detail,
        durationMs: Math.round(performance.now() - started),
      };
    }
    if (requireMin && !venvMeetsMin(resolvedAfter)) {
      return {
        plan,
        ready: false,
        installed: false,
        blocked: true,
        reason: `venv python is below min ${preferMin.major}.${preferMin.minor} after create with ${systemPy}`,
        venvPath,
        pathPrefix: null,
        pythonBin: resolvedAfter,
        pythonExecutableValid: true,
        commands,
        probeDetail: `venv_version_below_min system=${systemResolved.python.version}`,
        durationMs: Math.round(performance.now() - started),
      };
    }
  }
  pythonBin = venvPython(workspaceRoot);
  const executable = validatePythonExecutable({
    pythonBin,
    cwd: workspaceRoot,
  });
  if (!executable.ok) {
    return {
      plan,
      ready: false,
      installed: false,
      blocked: true,
      reason: `venv interpreter is not executable: ${executable.detail}`,
      venvPath,
      pathPrefix: null,
      pythonBin,
      pythonExecutableValid: false,
      commands,
      probeDetail: executable.detail,
    durationMs: Math.round(performance.now() - started),
    };
  }
  pathPrefix = dirname(pythonBin);

  // Upgrade pip quietly (best-effort)
  commands.push(`${pythonBin} -m pip install -U pip`);
  runCmd(pythonBin, ['-m', 'pip', 'install', '-U', 'pip', 'setuptools', 'wheel'], {
    cwd: workspaceRoot,
    timeoutMs: Math.min(installTimeout, 180_000),
  });

  // Minimal path first: editable + pytest. Full requirements only if still unready
  // (openlibrary-scale requirements often fail on host Windows while package+unit tests work).
  let lastInstallDetail = '';
  if (plan.kind === 'python_editable' || plan.hasPyproject || plan.hasSetupPy) {
    commands.push(`${pythonBin} -m pip install -e .`);
    const editable = runCmd(pythonBin, ['-m', 'pip', 'install', '-e', '.'], {
      cwd: workspaceRoot,
      timeoutMs: installTimeout,
    });
    lastInstallDetail = editable.detail;
    if (editable.ok) installed = true;
  }

  // pytest is commonly needed for Pro verify even when not a declared runtime dep
  commands.push(`${pythonBin} -m pip install pytest`);
  const pytestInstall = runCmd(pythonBin, ['-m', 'pip', 'install', 'pytest'], {
    cwd: workspaceRoot,
    timeoutMs: Math.min(installTimeout, 180_000),
  });
  if (pytestInstall.ok) installed = true;
  else lastInstallDetail = pytestInstall.detail || lastInstallDetail;

  // Proactively install pytest.ini required_plugins (qutebrowser) before collect.
  const requiredPlugins = readWorkspacePytestRequiredPlugins(workspaceRoot);
  if (requiredPlugins.length > 0) {
    commands.push(`# pytest_required_plugins=${requiredPlugins.join(',')}`);
    const pluginInstall = runCmd(
      pythonBin,
      ['-m', 'pip', 'install', ...requiredPlugins],
      {
        cwd: workspaceRoot,
        timeoutMs: Math.min(installTimeout, 5 * 60 * 1000),
      },
    );
    lastInstallDetail = pluginInstall.detail || lastInstallDetail;
    if (pluginInstall.ok) installed = true;
  }

  let probe = probePythonReady(pythonBin);
  if ((!probe.ok || !probe.collectOk) && plan.requirementFiles.length > 0) {
    for (const req of plan.requirementFiles) {
      commands.push(`${pythonBin} -m pip install -r ${req}`);
      const reqInstall = runCmd(pythonBin, ['-m', 'pip', 'install', '-r', req], {
        cwd: workspaceRoot,
        timeoutMs: installTimeout,
      });
      lastInstallDetail = reqInstall.detail || lastInstallDetail;
      if (reqInstall.ok) installed = true;
    }
    // Re-probe after requirements attempt (success or partial)
    probe = probePythonReady(pythonBin);
  }

  // W1 A + multi-round: package import ok but collect soft-fail → soft-deps.
  // After web installs, next collect often surfaces multipart then infogami —
  // re-probe up to SOFT_DEP_MAX_ROUNDS instead of a single install wave.
  // Also remediates Missing required plugins: pytest-* (qutebrowser).
  // Full -r requirements often fails on Windows hosts; targeted install is enough for many cells.
  let softDepsAttempted = false;
  let softDepsInstalled: string[] = [];
  let softRound = 0;
  while (probe.ok && !probe.collectOk && softRound < SOFT_DEP_MAX_ROUNDS) {
    softRound += 1;
    const missingMods = parseMissingModulesFromProbe(probe.detail);
    const missingPlugins = parseMissingPytestPluginsFromProbe(probe.detail);
    const pytestPin = parsePytestVersionPinFromProbe(probe.detail);
    // Round 1 may force pytest.ini plugins even if collect text is truncated.
    const forcePlugins = softRound === 1 ? requiredPlugins : [];
    if (
      missingMods.length === 0 &&
      missingPlugins.length === 0 &&
      forcePlugins.length === 0 &&
      !pytestPin
    ) {
      break;
    }
    const soft = installSoftDepsForCollectFail({
      workspaceRoot,
      pythonBin,
      probeDetail: probe.detail,
      requirementFiles: plan.requirementFiles,
      timeoutMs: Math.min(installTimeout, 5 * 60 * 1000),
      commands,
      alreadyInstalled: softDepsInstalled,
      extraSpecs: forcePlugins,
    });
    softDepsAttempted = softDepsAttempted || soft.attempted;
    for (const s of soft.installed) {
      if (!softDepsInstalled.includes(s)) softDepsInstalled.push(s);
    }
    if (soft.installed.length > 0) installed = true;
    lastInstallDetail = soft.detail || lastInstallDetail;
    // No progress this round → stop (avoid infinite loop on unmappable modules)
    if (soft.installed.length === 0) break;
    probe = probePythonReady(pythonBin);
  }

  // If still unready but package import alone works (pytest missing is rarer),
  // leave probe as-is — final block below uses it.
  try {
    writeFileSync(
      join(workspaceRoot, '.babel-dep-preflight.json'),
      JSON.stringify(
        {
          ready: probe.ok && probe.collectOk,
          packageHint: plan.packageHint,
          installed,
          venv: BABEL_WORKSPACE_VENV,
          detail: probe.detail,
          softDepsAttempted,
          softDepsInstalled,
          commands,
        },
        null,
        2,
      ),
      'utf8',
    );
  } catch {
    // ignore
  }
  if (!probe.ok || !probe.collectOk) {
    const installHint = lastInstallDetail
      ? ` last_install=${lastInstallDetail.slice(0, 200)}`
      : '';
    return {
      plan,
      ready: false,
      installed,
      blocked: true,
      reason: `workspace still not verify-ready after install: ${probe.detail}${installHint}`,
      venvPath,
      pathPrefix,
      pythonBin,
      pythonExecutableValid: true,
      commands,
      probeDetail: probe.detail,
      softDepsAttempted,
      softDepsInstalled,
      durationMs: Math.round(performance.now() - started),
    };
  }
  return {
    plan,
    ready: true,
    installed,
    blocked: false,
    reason: null,
    venvPath,
    pathPrefix,
    pythonBin,
    pythonExecutableValid: true,
    commands,
    probeDetail: probe.detail,
    softDepsAttempted,
    softDepsInstalled,
    durationMs: Math.round(performance.now() - started),
  };
}

/** Merge venv PATH + VIRTUAL_ENV into an env object for the agent CLI. */
export function applyDepPreflightEnv(
  base: NodeJS.ProcessEnv,
  preflight: WorkspaceDepPreflightResult,
): NodeJS.ProcessEnv {
  if (!preflight.pathPrefix && !preflight.venvPath) return base;
  const env: NodeJS.ProcessEnv = { ...base };
  if (preflight.venvPath) {
    env['VIRTUAL_ENV'] = preflight.venvPath;
  }
  if (preflight.pathPrefix) {
    const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
    // Windows often uses Path; Node normalizes but set both for safety.
    const current = env['PATH'] ?? env['Path'] ?? '';
    const merged = `${preflight.pathPrefix}${process.platform === 'win32' ? ';' : ':'}${current}`;
    env['PATH'] = merged;
    env['Path'] = merged;
    void pathKey;
  }
  env['BABEL_WORKSPACE_DEP_PREFLIGHT'] = preflight.ready ? 'ready' : 'blocked';
  // W1 B: host fail_to_pass and agent should share the same interpreter when known.
  if (preflight.pythonBin?.trim()) {
    env['BABEL_WORKSPACE_PYTHON'] = preflight.pythonBin.trim();
  }
  return env;
}

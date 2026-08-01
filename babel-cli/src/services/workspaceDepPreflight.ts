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
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const BABEL_WORKSPACE_VENV = '.babel-venv';

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
  commands: string[];
  probeDetail: string | null;
  durationMs: number;
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

function resolveSystemPython(): string {
  // Prefer python3 then python (Windows often only has python).
  for (const bin of ['python3', 'python']) {
    const r = spawnSync(bin, ['--version'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
    });
    if (r.status === 0) return bin;
  }
  return 'python';
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

function venvPython(workspaceRoot: string): string {
  return (
    resolveVenvPython(workspaceRoot) ??
    (process.platform === 'win32'
      ? join(workspaceRoot, BABEL_WORKSPACE_VENV, 'Scripts', 'python.exe')
      : join(workspaceRoot, BABEL_WORKSPACE_VENV, 'bin', 'python'))
  );
}

function venvScriptsDir(workspaceRoot: string): string {
  const base = join(workspaceRoot, BABEL_WORKSPACE_VENV);
  if (existsSync(join(base, 'Scripts'))) return join(base, 'Scripts');
  if (existsSync(join(base, 'bin'))) return join(base, 'bin');
  return process.platform === 'win32' ? join(base, 'Scripts') : join(base, 'bin');
}

export function probePythonImport(input: {
  packageName: string;
  cwd: string;
  pythonBin?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}): { ok: boolean; detail: string } {
  const py = input.pythonBin ?? resolveSystemPython();
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
  const py = input.pythonBin ?? resolveSystemPython();
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
    return { ok: false, detail: blob.slice(0, 500) };
  }
  if (r.error) {
    return { ok: false, detail: r.error.message.slice(0, 500) };
  }
  // pytest missing
  if (/no module named pytest|No module named pytest/i.test(blob)) {
    return { ok: false, detail: blob.slice(0, 500) };
  }
  if (r.status === 0 || /no tests collected/i.test(blob)) {
    return { ok: true, detail: blob.slice(0, 200) || 'collect_ok' };
  }
  // Other non-zero: still blocked if looks like env, else soft-ok when package imported
  if (r.status !== 0 && r.status != null) {
    return { ok: false, detail: blob.slice(0, 500) || `pytest collect exit ${r.status}` };
  }
  return { ok: true, detail: blob.slice(0, 200) };
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
export function runWorkspaceDepPreflight(input: {
  workspaceRoot: string;
  packageHint?: string | null;
  /** Optional test path for pytest --collect-only probe. */
  testPath?: string | null;
  /** Attempt local install (default true). */
  install?: boolean;
  installTimeoutMs?: number;
  probeTimeoutMs?: number;
}): WorkspaceDepPreflightResult {
  const started = performance.now();
  const commands: string[] = [];
  const plan = detectWorkspaceDepPlan(input.workspaceRoot, input.packageHint);
  const install = input.install !== false;
  const installTimeout = input.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS;
  const probeTimeout = input.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

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
    const hasModules = existsSync(join(input.workspaceRoot, 'node_modules'));
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
      cwd: input.workspaceRoot,
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

  // Python paths
  const systemPy = resolveSystemPython();
  let pythonBin = systemPy;
  let venvPath: string | null = null;
  let pathPrefix: string | null = null;
  let installed = false;

  /**
   * Ready enough to start the agent: package importable + pytest present.
   * Full conftest collect often needs heavy host deps (openlibrary) that still
   * block verify — agent may mutate first; runtime ENV_BLOCKED handles verify.
   * Collect is recorded as a soft signal only.
   */
  const probePythonReady = (bin: string): { ok: boolean; detail: string } => {
    const parts: string[] = [];
    if (plan.packageHint) {
      const pkg = probePythonImport({
        packageName: plan.packageHint,
        cwd: input.workspaceRoot,
        pythonBin: bin,
        timeoutMs: probeTimeout,
      });
      parts.push(`import:${pkg.detail}`);
      if (!pkg.ok) return { ok: false, detail: parts.join(' | ') };
    }
    const pytestMod = probePythonImport({
      packageName: 'pytest',
      cwd: input.workspaceRoot,
      pythonBin: bin,
      timeoutMs: probeTimeout,
    });
    parts.push(`pytest_mod:${pytestMod.detail}`);
    if (!pytestMod.ok) return { ok: false, detail: parts.join(' | ') };
    // Soft: focused collect when path known (does not fail preflight).
    if (input.testPath?.trim()) {
      const collect = probePytestCollect({
        cwd: input.workspaceRoot,
        pythonBin: bin,
        testPath: input.testPath,
        timeoutMs: Math.min(probeTimeout, 20_000),
      });
      parts.push(`collect_${collect.ok ? 'ok' : 'soft_fail'}:${collect.detail}`);
    }
    return { ok: true, detail: parts.join(' | ') };
  };

  const first = probePythonReady(pythonBin);
  if (first.ok) {
    return {
      plan,
      ready: true,
      installed: false,
      blocked: false,
      reason: null,
      venvPath: null,
      pathPrefix: null,
      pythonBin,
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
      reason: `workspace package not ready (install=false): ${first.detail}`,
      venvPath: null,
      pathPrefix: null,
      pythonBin,
      commands,
      probeDetail: first.detail,
      durationMs: Math.round(performance.now() - started),
    };
  }

  // Create venv + install
  venvPath = join(input.workspaceRoot, BABEL_WORKSPACE_VENV);

  if (!resolveVenvPython(input.workspaceRoot)) {
    commands.push(`${systemPy} -m venv ${BABEL_WORKSPACE_VENV}`);
    mkdirSync(input.workspaceRoot, { recursive: true });
    const venv = runCmd(systemPy, ['-m', 'venv', BABEL_WORKSPACE_VENV], {
      cwd: input.workspaceRoot,
      timeoutMs: Math.min(installTimeout, 120_000),
    });
    // Success = interpreter exists (MSYS venvs may non-zero-exit with useful stdout).
    const resolvedAfter = resolveVenvPython(input.workspaceRoot);
    if (!resolvedAfter) {
      return {
        plan,
        ready: false,
        installed: false,
        blocked: true,
        reason: `venv create failed: ${venv.detail}`,
        venvPath,
        pathPrefix: null,
        pythonBin: systemPy,
        commands,
        probeDetail: venv.detail,
        durationMs: Math.round(performance.now() - started),
      };
    }
  }
  pythonBin = venvPython(input.workspaceRoot);
  pathPrefix = venvScriptsDir(input.workspaceRoot);

  // Upgrade pip quietly (best-effort)
  commands.push(`${pythonBin} -m pip install -U pip`);
  runCmd(pythonBin, ['-m', 'pip', 'install', '-U', 'pip', 'setuptools', 'wheel'], {
    cwd: input.workspaceRoot,
    timeoutMs: Math.min(installTimeout, 180_000),
  });

  // Minimal path first: editable + pytest. Full requirements only if still unready
  // (openlibrary-scale requirements often fail on host Windows while package+unit tests work).
  let lastInstallDetail = '';
  if (plan.kind === 'python_editable' || plan.hasPyproject || plan.hasSetupPy) {
    commands.push(`${pythonBin} -m pip install -e .`);
    const editable = runCmd(pythonBin, ['-m', 'pip', 'install', '-e', '.'], {
      cwd: input.workspaceRoot,
      timeoutMs: installTimeout,
    });
    lastInstallDetail = editable.detail;
    if (editable.ok) installed = true;
  }

  // pytest is commonly needed for Pro verify even when not a declared runtime dep
  commands.push(`${pythonBin} -m pip install pytest`);
  const pytestInstall = runCmd(pythonBin, ['-m', 'pip', 'install', 'pytest'], {
    cwd: input.workspaceRoot,
    timeoutMs: Math.min(installTimeout, 180_000),
  });
  if (pytestInstall.ok) installed = true;
  else lastInstallDetail = pytestInstall.detail || lastInstallDetail;

  let probe = probePythonReady(pythonBin);
  if (!probe.ok && plan.requirementFiles.length > 0) {
    for (const req of plan.requirementFiles) {
      commands.push(`${pythonBin} -m pip install -r ${req}`);
      const reqInstall = runCmd(pythonBin, ['-m', 'pip', 'install', '-r', req], {
        cwd: input.workspaceRoot,
        timeoutMs: installTimeout,
      });
      lastInstallDetail = reqInstall.detail || lastInstallDetail;
      if (reqInstall.ok) installed = true;
    }
    // Re-probe after requirements attempt (success or partial)
    probe = probePythonReady(pythonBin);
  }

  // If still unready but package import alone works (pytest missing is rarer),
  // leave probe as-is — final block below uses it.
  try {
    writeFileSync(
      join(input.workspaceRoot, '.babel-dep-preflight.json'),
      JSON.stringify(
        {
          ready: probe.ok,
          packageHint: plan.packageHint,
          installed,
          venv: BABEL_WORKSPACE_VENV,
          detail: probe.detail,
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
  if (!probe.ok) {
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
      commands,
      probeDetail: probe.detail,
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
    commands,
    probeDetail: probe.detail,
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
  return env;
}

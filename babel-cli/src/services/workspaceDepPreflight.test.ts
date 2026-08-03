/**
 * Unit tests for workspace dep preflight (C2) — no network installs.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  applyDepPreflightEnv,
  detectWorkspaceDepPlan,
  findRequirementLineForModule,
  formatWorkspaceDepUnreadyNote,
  packageHintFromRepo,
  packageNameFromPyproject,
  parseMissingModulesFromProbe,
  parseMissingPytestPluginsFromProbe,
  parsePythonVersion,
  parseRequiredPluginsFromPytestIni,
  pythonVersionMeetsMin,
  resolveSoftDepSpecForModule,
  resolveSystemPython,
  resolveVenvPython,
  runWorkspaceDepPreflight,
  SOFT_DEP_MAX_ROUNDS,
  truncateProbeDetail,
  validatePythonExecutable,
} from './workspaceDepPreflight.js';

describe('workspaceDepPreflight', () => {
  test('parseMissingPytestPluginsFromProbe and pytest.ini required_plugins', () => {
    const plugins = parseMissingPytestPluginsFromProbe(
      'ERROR: Missing required plugins: pytest-bdd, pytest-benchmark, pytest-qt',
    );
    assert.deepEqual(plugins, ['pytest-bdd', 'pytest-benchmark', 'pytest-qt']);
    const fromIni = parseRequiredPluginsFromPytestIni(`
[pytest]
required_plugins =
    pytest-bdd
    pytest-benchmark
    pytest-instafail
markers =
    gui: tests
`);
    assert.deepEqual(fromIni, [
      'pytest-bdd',
      'pytest-benchmark',
      'pytest-instafail',
    ]);
  });

  test('W1 A: parseMissingModulesFromProbe extracts import names', () => {
    const detail = `
ImportError while loading conftest 'openlibrary/conftest.py'.
openlibrary\\conftest.py:5: in <module>
    import web
E   ModuleNotFoundError: No module named 'web'
`;
    assert.deepEqual(parseMissingModulesFromProbe(detail), ['web']);
    assert.deepEqual(
      parseMissingModulesFromProbe("ModuleNotFoundError: No module named 'infogami.utils'"),
      ['infogami'],
    );
    assert.deepEqual(parseMissingModulesFromProbe('all good'), []);
  });

  test('W1 A: findRequirementLineForModule matches webpy git pin', () => {
    const req = [
      'pytest',
      'git+https://github.com/webpy/webpy.git@d3649322b85777b291ac2b7b3699fb6fc839e382',
      'requests',
    ].join('\n');
    const line = findRequirementLineForModule(req, 'web');
    assert.ok(line);
    assert.match(line!, /webpy/);
    assert.equal(findRequirementLineForModule(req, 'definitely_missing_xyz'), null);
  });

  test('W1 multi-round: resolveSoftDepSpec prefers requirements then vendor infogami', () => {
    assert.equal(SOFT_DEP_MAX_ROUNDS, 16);
    const req = [
      'git+https://github.com/webpy/webpy.git@d3649322b85777b291ac2b7b3699fb6fc839e382',
      'multipart==0.2.4',
    ].join('\n');
    assert.match(
      resolveSoftDepSpecForModule('/tmp/ws', 'web', [req]) ?? '',
      /webpy/,
    );
    assert.equal(resolveSoftDepSpecForModule('/tmp/ws', 'multipart', [req]), 'multipart==0.2.4');
    assert.equal(resolveSoftDepSpecForModule('/tmp/ws', 'multipart', []), 'multipart');
    assert.equal(resolveSoftDepSpecForModule('/tmp/ws', 'requests', []), 'requests');
    assert.equal(resolveSoftDepSpecForModule('/tmp/ws', 'simplejson', []), 'simplejson');
    assert.equal(
      resolveSoftDepSpecForModule('/tmp/ws', 'paapi5_python_sdk', [
        'amightygirl.paapi5-python-sdk==1.0.0',
      ]),
      'amightygirl.paapi5-python-sdk==1.0.0',
    );
    assert.equal(
      resolveSoftDepSpecForModule('/tmp/ws', 'psycopg2', ['psycopg2==2.9.9']),
      'psycopg2-binary',
    );

    const dir = mkdtempSync(join(tmpdir(), 'dep-infogami-'));
    mkdirSync(join(dir, 'vendor', 'infogami'), { recursive: true });
    writeFileSync(join(dir, 'vendor', 'infogami', 'setup.py'), 'from setuptools import setup\nsetup(name="infogami")\n');
    assert.equal(
      resolveSoftDepSpecForModule(dir, 'infogami', []),
      '-e vendor/infogami',
    );
    // Empty submodule dir (OpenLibrary shallow clone) → git URL fallback
    const empty = mkdtempSync(join(tmpdir(), 'dep-infogami-empty-'));
    mkdirSync(join(empty, 'vendor', 'infogami'), { recursive: true });
    assert.match(
      resolveSoftDepSpecForModule(empty, 'infogami', []) ?? '',
      /github\.com\/internetarchive\/infogami/,
    );
  });

  test('W1 multi-round: truncateProbeDetail keeps No module named on long paths', () => {
    const longPath = 'C:\\\\' + 'x'.repeat(400) + '\\\\openlibrary\\\\conftest.py';
    const blob = [
      `ImportError while loading conftest '${longPath}'.`,
      'openlibrary\\conftest.py:5: in <module>',
      '    import web',
      '.babel-venv\\lib\\python3.10\\site-packages\\web\\__init__.py:4: in <module>',
      '    from . import (  # noqa: F401',
      '.babel-venv\\lib\\python3.10\\site-packages\\web\\debugerror.py:19: in <module>',
      '    from . import webapi as web',
      '.babel-venv\\lib\\python3.10\\site-packages\\web\\webapi.py:12: in <module>',
      '    import multipart',
      "E   ModuleNotFoundError: No module named 'multipart'",
    ].join('\n');
    // Head-only slice(0,500) would drop the missing module name on Windows paths.
    assert.equal(parseMissingModulesFromProbe(blob.slice(0, 500)).includes('multipart'), false);
    const kept = truncateProbeDetail(blob, 500);
    assert.ok(kept.includes('multipart') || kept.includes("No module named"));
    assert.deepEqual(parseMissingModulesFromProbe(kept), ['multipart']);
  });

  test('packageHintFromRepo maps repo leaf and hyphens', () => {
    assert.equal(packageHintFromRepo('internetarchive/openlibrary'), 'openlibrary');
    assert.equal(packageHintFromRepo('qutebrowser/qutebrowser'), 'qutebrowser');
    assert.equal(packageHintFromRepo('org/my-cool-pkg'), 'my_cool_pkg');
    assert.equal(packageHintFromRepo(null), null);
  });

  test('packageNameFromPyproject reads [project] name', () => {
    const text = `
[build-system]
requires = ["setuptools"]
[project]
name = "open-library"
version = "0.1.0"
`;
    assert.equal(packageNameFromPyproject(text), 'open_library');
  });

  test('detectWorkspaceDepPlan finds python editable markers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dep-plan-'));
    writeFileSync(join(dir, 'pyproject.toml'), '[project]\nname = "demo_pkg"\n');
    mkdirSync(join(dir, 'demo_pkg'));
    writeFileSync(join(dir, 'demo_pkg', '__init__.py'), '');
    const plan = detectWorkspaceDepPlan(dir);
    assert.equal(plan.kind, 'python_editable');
    assert.ok(plan.markers.includes('pyproject.toml'));
    assert.equal(plan.packageHint, 'demo_pkg');
  });

  test('detectWorkspaceDepPlan finds requirements-only and node', () => {
    const reqDir = mkdtempSync(join(tmpdir(), 'dep-req-'));
    writeFileSync(join(reqDir, 'requirements.txt'), 'pytest\n');
    assert.equal(detectWorkspaceDepPlan(reqDir).kind, 'python_requirements');

    const nodeDir = mkdtempSync(join(tmpdir(), 'dep-node-'));
    writeFileSync(join(nodeDir, 'package.json'), '{"name":"x"}');
    assert.equal(detectWorkspaceDepPlan(nodeDir).kind, 'node_npm');
  });

  test('W1 B: applyDepPreflightEnv sets BABEL_WORKSPACE_PYTHON', () => {
    const env = applyDepPreflightEnv(
      { PATH: '/usr/bin' },
      {
        plan: {
          kind: 'python_editable',
          markers: [],
          packageHint: 'x',
          requirementFiles: [],
          hasPyproject: true,
          hasSetupPy: false,
          hasPackageJson: false,
        },
        ready: true,
        installed: true,
        blocked: false,
        reason: null,
        venvPath: 'C:/ws/.babel-venv',
        pathPrefix: 'C:/ws/.babel-venv/bin',
        pythonBin: 'C:/ws/.babel-venv/bin/python.exe',
        commands: [],
        probeDetail: 'ok',
        durationMs: 1,
      },
    );
    assert.equal(env['BABEL_WORKSPACE_PYTHON'], 'C:/ws/.babel-venv/bin/python.exe');
    assert.match(env['PATH'] ?? '', /\.babel-venv/);
  });

  test('runWorkspaceDepPreflight install=false blocks unready python package', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dep-block-'));
    writeFileSync(join(dir, 'pyproject.toml'), '[project]\nname = "not_installed_xyz_pkg"\n');
    mkdirSync(join(dir, 'not_installed_xyz_pkg'));
    writeFileSync(join(dir, 'not_installed_xyz_pkg', '__init__.py'), 'x = 1\n');
    // packageHint that is not on sys.path as installed dist — use a nonsense name
    // so import fails even though a local dir exists (import may still work via cwd).
    // Use a package name with no local dir to force ModuleNotFoundError.
    writeFileSync(join(dir, 'setup.py'), 'from setuptools import setup; setup(name="other")\n');
    const result = runWorkspaceDepPreflight({
      workspaceRoot: dir,
      packageHint: 'definitely_missing_pkg_c2_zzzz',
      install: false,
      probeTimeoutMs: 15_000,
    });
    assert.equal(result.ready, false);
    assert.equal(result.blocked, true);
    assert.equal(result.installed, false);
    assert.ok(result.reason);
  });

  test('runWorkspaceDepPreflight kind=none is ready without install', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dep-none-'));
    writeFileSync(join(dir, 'README.md'), 'hello');
    const result = runWorkspaceDepPreflight({
      workspaceRoot: dir,
      install: true,
    });
    assert.equal(result.plan.kind, 'none');
    assert.equal(result.ready, true);
    assert.equal(result.blocked, false);
  });

  test('formatWorkspaceDepUnreadyNote is operator-facing', () => {
    const note = formatWorkspaceDepUnreadyNote({
      packageHint: 'qutebrowser',
      probeDetail: "ModuleNotFoundError: No module named 'qutebrowser'",
    });
    assert.match(note, /qutebrowser/);
    assert.match(note, /ENV_BLOCKED/);
    assert.match(note, /do not thrash/i);
  });

  test('resolveVenvPython finds MSYS-style bin/python.exe on Windows layouts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dep-msys-venv-'));
    mkdirSync(join(dir, '.babel-venv', 'bin'), { recursive: true });
    writeFileSync(join(dir, '.babel-venv', 'bin', 'python.exe'), '');
    assert.equal(
      resolveVenvPython(dir)?.replace(/\\/g, '/').endsWith('.babel-venv/bin/python.exe'),
      true,
    );
  });

  test('validatePythonExecutable rejects a present but non-executable venv placeholder', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dep-invalid-python-'));
    const python = join(dir, '.babel-venv', 'bin', 'python.exe');
    mkdirSync(join(dir, '.babel-venv', 'bin'), { recursive: true });
    writeFileSync(python, 'not an executable');
    const result = validatePythonExecutable({ pythonBin: python, cwd: dir });
    assert.equal(result.ok, false);
    assert.ok(result.detail);
  });

  test('parsePythonVersion and pythonVersionMeetsMin handle Required-era cuts', () => {
    assert.deepEqual(parsePythonVersion('Python 3.10.1'), {
      major: 3,
      minor: 10,
      patch: 1,
    });
    assert.deepEqual(parsePythonVersion('3.11.15'), {
      major: 3,
      minor: 11,
      patch: 15,
    });
    assert.equal(
      pythonVersionMeetsMin({ major: 3, minor: 11, patch: 0 }, { major: 3, minor: 11 }),
      true,
    );
    assert.equal(
      pythonVersionMeetsMin({ major: 3, minor: 10, patch: 1 }, { major: 3, minor: 11 }),
      false,
    );
  });

  test('resolveSystemPython prefers env override when executable', () => {
    const host = resolveSystemPython({ requireMin: false });
    if (!host.ok) return; // nothing to probe on exotic hosts
    const resolved = resolveSystemPython({
      requireMin: false,
      env: { ...process.env, BABEL_WORKSPACE_PYTHON: host.python.bin },
    });
    assert.equal(resolved.ok, true);
    if (resolved.ok) {
      assert.equal(resolved.python.bin, host.python.bin);
      assert.match(resolved.python.source, /^env:/);
    }
  });

  test('resolveSystemPython requireMin 3.11 fails closed when only older available', () => {
    // Force a doomed override path then require 99.0 so selection cannot succeed.
    const resolved = resolveSystemPython({
      minMajor: 99,
      minMinor: 0,
      requireMin: true,
      env: { ...process.env, BABEL_WORKSPACE_PYTHON: '', BABEL_PYTHON: '' },
    });
    // Hosts with real 99.x do not exist; expect failure.
    assert.equal(resolved.ok, false);
    if (!resolved.ok) {
      assert.match(resolved.reason, /no Python >= 99\.0/i);
    }
  });

  test('applyDepPreflightEnv prepends pathPrefix and VIRTUAL_ENV', () => {
    const env = applyDepPreflightEnv(
      { PATH: '/usr/bin', FOO: '1' },
      {
        plan: {
          kind: 'python_editable',
          markers: [],
          packageHint: 'x',
          requirementFiles: [],
          hasPyproject: true,
          hasSetupPy: false,
          hasPackageJson: false,
        },
        ready: true,
        installed: true,
        blocked: false,
        reason: null,
        venvPath: '/tmp/ws/.babel-venv',
        pathPrefix: '/tmp/ws/.babel-venv/bin',
        pythonBin: '/tmp/ws/.babel-venv/bin/python',
        commands: [],
        probeDetail: 'ok',
        durationMs: 1,
      },
    );
    assert.equal(env['VIRTUAL_ENV'], '/tmp/ws/.babel-venv');
    assert.ok(String(env['PATH']).startsWith('/tmp/ws/.babel-venv/bin'));
    assert.equal(env['BABEL_WORKSPACE_DEP_PREFLIGHT'], 'ready');
    assert.equal(env['FOO'], '1');
  });
});

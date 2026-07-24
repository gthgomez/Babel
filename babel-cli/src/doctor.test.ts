import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runDoctor } from './doctor.js';

test('doctor --strict-enterprise fails when no enterprise policy exists', async () => {
  const previousPolicyPath = process.env['BABEL_ENTERPRISE_POLICY_PATH'];
  const previousUserPolicyPath = process.env['BABEL_ENTERPRISE_POLICY_USER_PATH'];
  const previousAdminPolicyPath = process.env['BABEL_ENTERPRISE_POLICY_ADMIN_PATH'];
  const root = mkdtempSync(join(tmpdir(), 'babel-doctor-enterprise-'));

  delete process.env['BABEL_ENTERPRISE_POLICY_PATH'];
  process.env['BABEL_ENTERPRISE_POLICY_USER_PATH'] = join(root, 'missing-user-policy.json');
  delete process.env['BABEL_ENTERPRISE_POLICY_ADMIN_PATH'];

  try {
    const result = await runDoctor({
      babelRoot: root,
      strict: true,
      strictEnterprise: true,
      verbose: false,
      scope: 'enterprise',
    });

    assert.equal(result.status, 'fail');
    assert.equal(result.mode, 'strict-enterprise');
    assert.equal(
      result.checks.some(
        (check) => check.id === 'enterprise_policy.present_for_strict' && check.status === 'fail',
      ),
      true,
    );
  } finally {
    if (previousPolicyPath === undefined) delete process.env['BABEL_ENTERPRISE_POLICY_PATH'];
    else process.env['BABEL_ENTERPRISE_POLICY_PATH'] = previousPolicyPath;
    if (previousUserPolicyPath === undefined)
      delete process.env['BABEL_ENTERPRISE_POLICY_USER_PATH'];
    else process.env['BABEL_ENTERPRISE_POLICY_USER_PATH'] = previousUserPolicyPath;
    if (previousAdminPolicyPath === undefined)
      delete process.env['BABEL_ENTERPRISE_POLICY_ADMIN_PATH'];
    else process.env['BABEL_ENTERPRISE_POLICY_ADMIN_PATH'] = previousAdminPolicyPath;
  }
});

test('doctor enterprise scope passes with strict controls configured', async () => {
  const previousPolicyPath = process.env['BABEL_ENTERPRISE_POLICY_PATH'];
  const previousUserPolicyPath = process.env['BABEL_ENTERPRISE_POLICY_USER_PATH'];
  const previousAdminPolicyPath = process.env['BABEL_ENTERPRISE_POLICY_ADMIN_PATH'];
  const root = mkdtempSync(join(tmpdir(), 'babel-doctor-enterprise-'));
  const configDir = join(root, 'config');
  mkdirSync(configDir, { recursive: true });
  const policyPath = join(configDir, 'enterprise-policy.json');
  writeFileSync(
    policyPath,
    JSON.stringify({
      schema_version: 1,
      allowed_tools: ['file_read', 'directory_list', 'web_fetch'],
      allowed_mcp_servers: ['github'],
      network_allowlist: ['example.com'],
      model_policy: {
        allowed_backends: ['deepinfra'],
      },
      plugin_policy: {
        max_trust_level: 'read_only',
      },
      redaction: {
        enabled: true,
      },
      telemetry: {
        opt_in: false,
      },
    }),
    'utf8',
  );

  delete process.env['BABEL_ENTERPRISE_POLICY_PATH'];
  process.env['BABEL_ENTERPRISE_POLICY_USER_PATH'] = join(root, 'missing-user-policy.json');
  delete process.env['BABEL_ENTERPRISE_POLICY_ADMIN_PATH'];

  try {
    const result = await runDoctor({
      babelRoot: root,
      strict: true,
      strictEnterprise: true,
      verbose: false,
      scope: 'enterprise',
    });

    assert.equal(result.status, 'pass');
    assert.equal(result.mode, 'strict-enterprise');
  } finally {
    if (previousPolicyPath === undefined) delete process.env['BABEL_ENTERPRISE_POLICY_PATH'];
    else process.env['BABEL_ENTERPRISE_POLICY_PATH'] = previousPolicyPath;
    if (previousUserPolicyPath === undefined)
      delete process.env['BABEL_ENTERPRISE_POLICY_USER_PATH'];
    else process.env['BABEL_ENTERPRISE_POLICY_USER_PATH'] = previousUserPolicyPath;
    if (previousAdminPolicyPath === undefined)
      delete process.env['BABEL_ENTERPRISE_POLICY_ADMIN_PATH'];
    else process.env['BABEL_ENTERPRISE_POLICY_ADMIN_PATH'] = previousAdminPolicyPath;
  }
});

test('doctor placeholder project path check inspects run manifests structurally', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-doctor-runtime-'));
  const contextOnlyRun = join(root, 'runs', '20260424_120000_context-only');
  const manifestRun = join(root, 'runs', '20260424_121500_manifest-placeholder');
  mkdirSync(contextOnlyRun, { recursive: true });
  mkdirSync(manifestRun, { recursive: true });

  writeFileSync(
    join(contextOnlyRun, '00_ctx_orchestrator.md'),
    'Archived prompt text may mention <YOUR_PROJECT_ROOT> without making the run manifest unsafe.',
    'utf8',
  );
  writeFileSync(
    join(contextOnlyRun, '01_manifest.json'),
    JSON.stringify({
      target_project: 'global',
      target_project_path: '<BABEL_REPO_ROOT>',
    }),
    'utf8',
  );
  writeFileSync(
    join(manifestRun, '01_manifest.json'),
    JSON.stringify({
      target_project: 'example_mobile_suite',
      target_project_path: '<YOUR_PROJECT_ROOT>/example_mobile_suite',
    }),
    'utf8',
  );
  writeFileSync(
    join(root, 'runs', '.latest.example_mobile_suite.json'),
    JSON.stringify({ run_dir: manifestRun, project: 'example_mobile_suite' }),
    'utf8',
  );

  const result = await runDoctor({
    babelRoot: root,
    strict: false,
    verbose: true,
    scope: 'workspace',
  });

  const placeholderCheck = result.checks.find(
    (check) => check.id === 'runtime.placeholder_project_paths',
  );
  assert.equal(placeholderCheck?.status, 'warn');
  assert.equal(
    placeholderCheck?.message,
    'Found 1 live run manifest(s) with placeholder target_project_path values',
  );
  assert.deepEqual(placeholderCheck?.details, [
    `${join('runs', '20260424_121500_manifest-placeholder', '01_manifest.json')} :: target_project_path=<YOUR_PROJECT_ROOT>/example_mobile_suite`,
  ]);
});

test('doctor placeholder project path check ignores archived context-only placeholders', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-doctor-runtime-'));
  const runDir = join(root, 'runs', '20260424_120000_context-only');
  mkdirSync(runDir, { recursive: true });

  writeFileSync(
    join(runDir, '00_ctx_orchestrator.md'),
    'Archived prompt text may mention <YOUR_PROJECT_ROOT> without making the run manifest unsafe.',
    'utf8',
  );
  writeFileSync(
    join(runDir, '01_manifest.json'),
    JSON.stringify({
      target_project: 'global',
      target_project_path: '<BABEL_REPO_ROOT>',
    }),
    'utf8',
  );
  writeFileSync(
    join(root, 'runs', '.latest.global.json'),
    JSON.stringify({ run_dir: runDir, project: 'global' }),
    'utf8',
  );

  const result = await runDoctor({
    babelRoot: root,
    strict: false,
    verbose: false,
    scope: 'workspace',
  });

  const placeholderCheck = result.checks.find(
    (check) => check.id === 'runtime.placeholder_project_paths',
  );
  assert.equal(placeholderCheck?.status, 'pass');
  assert.equal(
    placeholderCheck?.message,
    'No placeholder project paths found in live run manifests',
  );
});

test('doctor latest run pointer check warns on malformed pointer JSON', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-doctor-runtime-'));
  const runsRoot = join(root, 'runs');
  mkdirSync(runsRoot, { recursive: true });
  writeFileSync(
    join(runsRoot, '.latest.Openclaw.json'),
    '{\n  "run_dir": "/tmp/\\Babel\\\\runs\\\\bad"\n}\n',
    'utf8',
  );

  const result = await runDoctor({
    babelRoot: root,
    strict: false,
    verbose: true,
    scope: 'workspace',
  });

  const pointerCheck = result.checks.find((check) => check.id === 'runtime.latest_run_pointers');
  assert.equal(pointerCheck?.status, 'warn');
  assert.equal(pointerCheck?.message, 'Found 1 malformed latest run pointer(s)');
  assert.match(
    pointerCheck?.details?.[0] ?? '',
    /^runs[\\/]\.latest\.Openclaw\.json :: invalid JSON/,
  );
});

test('doctor env scope reports shell, PowerShell, and provider taxonomy', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-doctor-env-'));

  const result = await runDoctor({
    babelRoot: root,
    strict: false,
    verbose: true,
    scope: 'env',
    env: {},
    shellProbe: () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'spawn EPERM',
      error: 'EPERM: spawn blocked',
      diagnostic_code: 'ENV_SHELL_UNAVAILABLE',
    }),
    powerShellProbe: () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'pwsh ENOENT',
      error: 'No compatible PowerShell runtime found.',
      diagnostic_code: 'POWERSHELL_UNAVAILABLE',
    }),
  });

  assert.equal(result.scope, 'env');
  assert.equal(result.status, 'fail');
  assert.equal(
    result.checks.every((check) => check.section === 'Environment'),
    true,
  );
  assert.equal(
    result.checks.some(
      (check) =>
        check.id === 'env.shell.available' && check.diagnostic_code === 'ENV_SHELL_UNAVAILABLE',
    ),
    true,
  );
  assert.equal(
    result.checks.some(
      (check) =>
        check.id === 'env.powershell.available' &&
        check.diagnostic_code === 'POWERSHELL_UNAVAILABLE',
    ),
    true,
  );
  assert.equal(
    result.checks.some(
      (check) =>
        check.id === 'env.provider.any_key_present' &&
        check.diagnostic_code === 'PROVIDER_ENV_MISSING',
    ),
    true,
  );
});

test('doctor repos scope classifies PowerShell unavailability separately from repo failures', async () => {
  const { root } = makeDoctorWorkspace({ validCatalog: true, dist: true });

  const result = await runDoctor({
    babelRoot: root,
    strict: false,
    verbose: true,
    scope: 'repos',
    powerShellRunner: () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'pwsh: ENOENT',
      error: 'No compatible PowerShell runtime found.',
      diagnostic_code: 'POWERSHELL_UNAVAILABLE',
    }),
  });

  assert.equal(
    result.checks.some((check) => check.id === 'repo_map.paths_exist' && check.status === 'pass'),
    true,
  );
  assert.equal(
    result.checks.some(
      (check) =>
        check.id === 'resolution.environment_powershell' &&
        check.diagnostic_code === 'POWERSHELL_UNAVAILABLE',
    ),
    true,
  );
  assert.equal(
    result.checks.some((check) => check.id === 'resolution.example_saas_backend'),
    false,
  );
});

test('doctor workspace scope exposes catalog and dist diagnostics', async () => {
  const { root } = makeDoctorWorkspace({ validCatalog: false, dist: false });

  const result = await runDoctor({
    babelRoot: root,
    strict: false,
    verbose: true,
    scope: 'workspace',
  });

  assert.equal(
    result.checks.some(
      (check) =>
        check.id === 'catalog.prompt_catalog.valid' && check.diagnostic_code === 'CATALOG_INVALID',
    ),
    true,
  );
  assert.equal(
    result.checks.some(
      (check) => check.id === 'runtime.cli_entrypoint' && check.diagnostic_code === 'DIST_MISSING',
    ),
    true,
  );
  const distCheck = result.checks.find((check) => check.id === 'runtime.cli_entrypoint');
  assert.ok(distCheck);
  assert.equal(
    distCheck?.fixHint,
    'Run npm --prefix .\\babel-cli run build before invoking dist-first CLI checks.',
  );
});

test('doctor repo map distinguishes missing mapped repo paths', async () => {
  const { root, workspace } = makeDoctorWorkspace({ validCatalog: true, dist: true });
  writeFileSync(
    join(workspace, 'config', 'repo-map.json'),
    JSON.stringify({
      repos: {
        babel_core: root,
        babel_public: join(workspace, 'missing-babel-public'),
        example_saas_backend: join(workspace, 'repos', 'example_saas_backend'),
        prismatix: join(workspace, 'repos', 'prismatix'),
        auditguard: join(workspace, 'repos', 'auditguard'),
        project_android: join(workspace, 'repos', 'project_android'),
        project_games: join(workspace, 'repos', 'project_games'),
        godot_td: join(workspace, 'repos', 'godot_td'),
        app_test_babel: join(workspace, 'repos', 'app_test_babel'),
      },
    }),
    'utf8',
  );
  mkdirSync(join(workspace, 'Project_Public', 'Babel-public'), { recursive: true });
  writeFileSync(join(root, 'tools', 'validate-public-release.ps1'), 'exit 0\n', 'utf8');

  const result = await runDoctor({
    babelRoot: root,
    strict: false,
    verbose: true,
    scope: 'repos',
    powerShellRunner: () => ({
      exitCode: 1,
      stdout: '',
      stderr: '',
      error: 'resolver skipped for repo-map test',
      diagnostic_code: 'POWERSHELL_UNAVAILABLE',
    }),
  });

  assert.equal(
    result.checks.some(
      (check) => check.id === 'repo_map.paths_exist' && check.diagnostic_code === 'REPO_MISSING',
    ),
    true,
  );
});

test('doctor scope all allows documented external repo-map prerequisite to remain missing without fail', async () => {
  const { root, workspace } = makeDoctorWorkspace({ validCatalog: true, dist: true });
  const externalGodotPath = join(workspace, 'missing', 'example_game_suite', 'TowerDefenseGodot');
  const expectedRepoPaths = {
    babel_core: root,
    babel_public: join(workspace, 'repos', 'babel_public'),
    example_saas_backend: join(workspace, 'repos', 'example_saas_backend'),
    prismatix: join(workspace, 'repos', 'prismatix'),
    auditguard: join(workspace, 'repos', 'auditguard'),
    project_android: join(workspace, 'repos', 'project_android'),
    project_games: join(workspace, 'repos', 'project_games'),
    godot_td: externalGodotPath,
    app_test_babel: join(workspace, 'repos', 'app_test_babel'),
  };
  writeFileSync(
    join(workspace, 'config', 'repo-map.json'),
    JSON.stringify({
      external_prerequisites: ['godot_td'],
      repos: expectedRepoPaths,
    }),
    'utf8',
  );
  mkdirSync(join(workspace, 'Project_Public', 'Babel-public'), { recursive: true });
  writeFileSync(join(root, 'tools', 'export-babel-public.ps1'), 'Write-Output "{}"\\n', 'utf8');

  const result = await runDoctor({
    babelRoot: root,
    strict: false,
    verbose: true,
    scope: 'all',
    powerShellRunner: (path, args) => {
      if (path.endsWith('export-babel-public.ps1')) {
        const destinationRoot = args[args.indexOf('-DestinationRoot') + 1];
        if (destinationRoot) {
          mkdirSync(join(destinationRoot, 'tools'), { recursive: true });
          writeFileSync(
            join(destinationRoot, 'tools', 'check-public-scrub.ps1'),
            'Write-Output \"{}\"\\n',
            'utf8',
          );
        }
        return {
          exitCode: 0,
          stdout: '',
          stderr: '',
        };
      }
      if (path.endsWith('check-public-scrub.ps1')) {
        return {
          exitCode: 0,
          stdout: '',
          stderr: '',
        };
      }
      const projectIndex = args.indexOf('-Project');
      const project = projectIndex >= 0 ? args[projectIndex + 1] : undefined;
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          ProjectPath:
            project && project in expectedRepoPaths
              ? expectedRepoPaths[project as keyof typeof expectedRepoPaths]
              : root,
        }),
        stderr: '',
      };
    },
  });
  assert.equal(result.status, 'warn');
  assert.equal(result.summary.fail, 0);
  assert.equal(
    result.checks.some(
      (check) =>
        check.id === 'repo_map.paths_exist' &&
        check.status === 'warn' &&
        check.diagnostic_code === 'EXTERNAL_PREREQUISITE_MISSING',
    ),
    true,
  );
  assert.equal(
    result.checks.some(
      (check) => check.id === 'repo_map.paths_exist' && check.diagnostic_code === 'REPO_MISSING',
    ),
    false,
  );
  assert.equal(
    result.checks.some(
      (check) =>
        check.id === 'repo_map.external_prerequisites' &&
        check.status === 'pass' &&
        check.message?.includes('godot_td'),
    ),
    true,
  );
  const godotResolution = result.checks.find((check) => check.id === 'resolution.godot_td');
  assert.equal(godotResolution?.status, 'warn');
  assert.equal(godotResolution?.diagnostic_code, 'EXTERNAL_PREREQUISITE_MISSING');
});

test('doctor workspace warns when latest pointer targets incomplete evidence', async () => {
  const { root } = makeDoctorWorkspace({ validCatalog: true, dist: true });
  const runsDir = join(root, 'runs');
  const runDir = join(runsDir, '20260606_150154_y');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runsDir, '.latest.json'),
    JSON.stringify({
      run_dir: runDir,
      project: 'example_game_suite',
      created_at: new Date().toISOString(),
      evidence_complete: false,
    }),
    'utf8',
  );

  const result = await runDoctor({
    babelRoot: root,
    strict: false,
    verbose: true,
    scope: 'workspace',
  });

  const check = result.checks.find((entry) => entry.id === 'runtime.latest_run_evidence');
  assert.equal(check?.status, 'warn');
  assert.match(check?.message ?? '', /stale or point at incomplete evidence/);
});

test('doctor workspace warns when interactive transcript target differs from manifest target', async () => {
  const { root, workspace } = makeDoctorWorkspace({ validCatalog: true, dist: true });
  const runsDir = join(root, 'runs');
  const runDir = join(runsDir, '20260606_145627_bl-plan-a-fix');
  const sessionDir = join(runsDir, 'interactive-sessions', 'interactive_2026-06-06_195508');
  const transcriptTarget = join(workspace, 'example_game_suite', 'relicRun');
  const manifestTarget = join(workspace, 'example_game_suite');
  mkdirSync(runDir, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(runDir, 'terminal_status_summary.json'), '{}\n', 'utf8');
  writeFileSync(
    join(runDir, '01_manifest.json'),
    JSON.stringify({
      target_project: 'example_game_suite',
      target_project_path: manifestTarget,
    }),
    'utf8',
  );
  writeFileSync(
    join(sessionDir, 'transcript.jsonl'),
    `${JSON.stringify({
      role: 'assistant',
      run_dir: runDir,
      target_root: transcriptTarget,
    })}\n`,
    'utf8',
  );

  const result = await runDoctor({
    babelRoot: root,
    strict: false,
    verbose: true,
    scope: 'workspace',
  });

  const check = result.checks.find(
    (entry) => entry.id === 'runtime.interactive_target_consistency',
  );
  assert.equal(check?.status, 'warn');
  assert.match(check?.message ?? '', /target drift/);
});

function makeDoctorWorkspace(options: { validCatalog: boolean; dist: boolean }): {
  workspace: string;
  root: string;
} {
  const workspace = mkdtempSync(join(tmpdir(), 'babel-doctor-workspace-'));
  const root = join(workspace, 'Babel');
  mkdirSync(join(root, 'tools'), { recursive: true });
  mkdirSync(join(root, 'tools', 'public-export'), { recursive: true });
  mkdirSync(join(workspace, 'config'), { recursive: true });
  writeFileSync(join(root, 'tools', 'resolve-local-stack.ps1'), 'Write-Output "{}"\n', 'utf8');
  writeFileSync(join(root, 'package.json'), '{}\n', 'utf8');
  writeFileSync(join(root, 'tools', 'public-export', 'manifest.json'), '{}\n', 'utf8');
  if (options.validCatalog) {
    writeFileSync(join(root, 'prompt_catalog.yaml'), 'version: 1\nentries:\n  test: {}\n', 'utf8');
  } else {
    writeFileSync(join(root, 'prompt_catalog.yaml'), 'version: 1\n', 'utf8');
  }
  if (options.dist) {
    mkdirSync(join(root, 'babel-cli', 'dist'), { recursive: true });
    writeFileSync(join(root, 'babel-cli', 'dist', 'index.js'), 'console.log("ok");\n', 'utf8');
  }

  const repos: Record<string, string> = {
    babel_core: root,
    babel_public: join(workspace, 'repos', 'babel_public'),
    example_saas_backend: join(workspace, 'repos', 'example_saas_backend'),
    prismatix: join(workspace, 'repos', 'prismatix'),
    auditguard: join(workspace, 'repos', 'auditguard'),
    project_android: join(workspace, 'repos', 'project_android'),
    project_games: join(workspace, 'repos', 'project_games'),
    godot_td: join(workspace, 'repos', 'godot_td'),
    app_test_babel: join(workspace, 'repos', 'app_test_babel'),
  };
  for (const repoPath of Object.values(repos)) {
    mkdirSync(repoPath, { recursive: true });
  }
  writeFileSync(join(workspace, 'config', 'repo-map.json'), JSON.stringify({ repos }), 'utf8');
  return { workspace, root };
}

test('doctor repairPointers removes stale latest run pointers before evidence checks', async () => {
  const { root } = makeDoctorWorkspace({ dist: true, validCatalog: true });
  const runsDir = join(root, 'runs');
  const completeRun = join(runsDir, 'complete-run');
  const incompleteRun = join(runsDir, 'incomplete-run');
  mkdirSync(completeRun, { recursive: true });
  mkdirSync(incompleteRun, { recursive: true });
  writeFileSync(join(completeRun, 'terminal_status_summary.json'), '{}\n', 'utf8');
  writeFileSync(join(incompleteRun, '01_manifest.json'), '{}\n', 'utf8');
  writeFileSync(
    join(runsDir, '.latest.good.json'),
    `${JSON.stringify(
      {
        run_dir: completeRun,
        project: 'good',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  writeFileSync(
    join(runsDir, '.latest.bad.json'),
    `${JSON.stringify(
      {
        run_dir: incompleteRun,
        project: 'bad',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const result = await runDoctor({
    babelRoot: root,
    strict: false,
    verbose: false,
    scope: 'all',
    repairPointers: true,
    shellProbe: () => ({ exitCode: 0, stdout: 'ok', stderr: '' }),
    powerShellProbe: () => ({ exitCode: 0, stdout: '7.5.5', stderr: '' }),
    powerShellRunner: () => ({ exitCode: 0, stdout: 'ok', stderr: '' }),
  });

  const evidenceCheck = result.checks.find((check) => check.id === 'runtime.latest_run_evidence');
  assert.equal(evidenceCheck?.status, 'pass');
  assert.equal(
    result.checks.some((check) => check.id === 'runtime.latest_run_pointer_repair'),
    true,
  );
  assert.equal(existsSync(join(runsDir, '.latest.good.json')), true);
  assert.equal(existsSync(join(runsDir, '.latest.bad.json')), false);
});

// License: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';

const sha = 'a'.repeat(40);

function evidence(overrides = {}) {
  return {
    passed: 4,
    failure: null,
    identity: {
      executablePresent: true,
      build: {sourceSha: sha},
      ipc: {engineReadinessReady: true, executionReady: true},
    },
    journeys: {
      readOnlyTask: {status: 'executed', deniedEdit: true, baseline: {clean: true}},
      repair: {status: 'executed', independent: {testExit: 0, diff: {path: 'parser.mjs', additions: 1, deletions: 1}}},
      cleanup: {state: 'terminated'},
    },
    ...overrides,
  };
}

test('packaged acceptance evidence fails closed without installed readiness and repair proof', async () => {
  const root = await mkdtemp(join(tmpdir(), 'babel-acceptance-evidence-'));
  try {
    const script = fileURLToPath(new URL('./acceptance-evidence.ps1', import.meta.url));
    const report = join(root, 'packaged-electron-acceptance.json');
    const env = {};
    for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT']) {
      const key = Object.keys(process.env).find(candidate => candidate.toUpperCase() === name.toUpperCase());
      if (key && process.env[key]) env[name] = process.env[key];
    }
    Object.assign(env, {HOME: root, USERPROFILE: root, TEMP: root, TMP: root,
      XDG_CONFIG_HOME: root, XDG_CACHE_HOME: root, XDG_DATA_HOME: root,
      BABEL_FIXTURE_SCRIPT: script, BABEL_FIXTURE_REPORT: report, BABEL_FIXTURE_SHA: sha});
    const check = async (value, expectedSha = sha) => {
      if (value === undefined) {
        // Leave the report absent.
      } else {
        await writeFile(report, typeof value === 'string' ? value : JSON.stringify(value));
      }
      const result = spawnSync('pwsh', ['-NoProfile', '-Command',
        `$ok = . $env:BABEL_FIXTURE_SCRIPT; if (Test-PackagedAcceptanceEvidence -ReportPath $env:BABEL_FIXTURE_REPORT -ExpectedSourceSha '${expectedSha}') { 'True' } else { 'False' }`],
      {env, encoding: 'utf8', windowsHide: true});
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    assert.equal(await check(undefined), 'False');
    assert.equal(await check('{bad json'), 'False');
    assert.equal(await check(evidence()), 'True');
    assert.equal(await check(evidence(), 'b'.repeat(40)), 'False');
    assert.equal(await check(evidence({passed: 0})), 'False');
    assert.equal(await check(evidence({failure: {stage: 'render'}})), 'False');
    const unreadiness = evidence();
    unreadiness.identity.ipc.engineReadinessReady = false;
    assert.equal(await check(unreadiness), 'False');
    const broadDiff = evidence();
    broadDiff.journeys.repair.independent.diff.additions = 2;
    assert.equal(await check(broadDiff), 'False');
    const mutated = evidence();
    mutated.journeys.readOnlyTask.baseline.clean = false;
    assert.equal(await check(mutated), 'False');
  } finally { await rm(root, {recursive: true, force: true}); }
});

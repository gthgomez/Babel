// License: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';

test('lifecycle cleanup accepts only a confirmed GUI process-tree termination receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'babel-cleanup-receipt-'));
  try {
    const script = fileURLToPath(new URL('./cleanup-receipt.ps1', import.meta.url));
    const report = join(root, 'acceptance.json');
    const env = {};
    for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT']) {
      const key = Object.keys(process.env).find(candidate => candidate.toUpperCase() === name.toUpperCase());
      if (key && process.env[key]) env[name] = process.env[key];
    }
    Object.assign(env, {HOME: root, USERPROFILE: root, TEMP: root, TMP: root,
      XDG_CONFIG_HOME: root, XDG_CACHE_HOME: root, XDG_DATA_HOME: root,
      BABEL_FIXTURE_SCRIPT: script, BABEL_FIXTURE_REPORT: report});
    const inspect = () => {
      const result = spawnSync('pwsh', ['-NoProfile', '-Command', '. $env:BABEL_FIXTURE_SCRIPT; Get-PackagedCleanupState -ReportPath $env:BABEL_FIXTURE_REPORT'],
        {env, encoding: 'utf8', windowsHide: true});
      assert.equal(result.status, 0);
      return result.stdout.trim();
    };
    const allowed = attempted => {
      const result = spawnSync('pwsh', ['-NoProfile', '-Command',
        `. $env:BABEL_FIXTURE_SCRIPT; Test-PackagedCleanupAllowed -GuiAttempted $${attempted ? 'true' : 'false'} -ReportPath $env:BABEL_FIXTURE_REPORT`],
      {env, encoding: 'utf8', windowsHide: true});
      assert.equal(result.status, 0);
      return result.stdout.trim();
    };
    assert.equal(inspect(), 'unknown');
    assert.equal(allowed(false), 'True');
    assert.equal(allowed(true), 'False');
    await writeFile(report, '{bad json');
    assert.equal(inspect(), 'unknown');
    await writeFile(report, JSON.stringify({journeys: {cleanup: {state: 'unresolved'}}}));
    assert.equal(inspect(), 'unresolved');
    assert.equal(allowed(true), 'False');
    await writeFile(report, JSON.stringify({journeys: {cleanup: {state: 'terminated'}}}));
    assert.equal(inspect(), 'terminated');
    assert.equal(allowed(true), 'True');
    await writeFile(report, JSON.stringify({passed: 1, journeys: {}}));
    assert.equal(inspect(), 'unknown');
  } finally { await rm(root, {recursive: true, force: true}); }
});

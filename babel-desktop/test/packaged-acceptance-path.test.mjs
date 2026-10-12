// License: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

test('Windows packaged acceptance entrypoints exist for CI installer-lifecycle', () => {
  const lifecycle = join(desktopRoot, 'test/installer-lifecycle/run-lifecycle.ps1');
  const bootstrap = join(desktopRoot, 'test/installer-bootstrap-control/run-bootstrap-control.ps1');
  const probes = join(desktopRoot, 'test/installer-bootstrap-control/build-probes.mjs');
  const packagedGui = join(desktopRoot, 'test/packaged-electron-acceptance/packaged_gui_acceptance.py');
  const packagedRunner = join(desktopRoot, 'test/packaged-electron-acceptance/run-packaged-gui.ps1');
  assert.equal(existsSync(lifecycle), true);
  assert.equal(existsSync(bootstrap), true);
  assert.equal(existsSync(probes), true);
  assert.equal(existsSync(packagedGui), true);
  assert.equal(existsSync(packagedRunner), true);
  const lifecycleScript = readFileSync(lifecycle, 'utf8');
  assert.match(lifecycleScript, /packaged-electron-acceptance\/run-packaged-gui\.ps1/);
  const workflow = readFileSync(join(desktopRoot, '..', '.github/workflows/typecheck.yml'), 'utf8');
  assert.match(workflow, /installer-lifecycle/, 'hosted CI must retain installer-lifecycle job');
});

test('NSIS contract preserves silent success auto-close without a new completion dialog gate', () => {
  const setupTest = readFileSync(join(desktopRoot, 'test/package-windows-setup.test.mjs'), 'utf8');
  assert.match(setupTest, /AutoCloseWindow true/);
  assert.doesNotMatch(setupTest, /completion dialog requirement/i);
});

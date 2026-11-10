// License: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {waitForDesktopRendererReady} from './lib/electron-renderer-readiness.mjs';

test('renderer readiness helper is exported for Electron fixtures (regression contract)', () => {
  assert.equal(typeof waitForDesktopRendererReady, 'function');
  assert.match(waitForDesktopRendererReady.toString(), /main-status/);
  assert.match(waitForDesktopRendererReady.toString(), /Connecting/);
  assert.match(waitForDesktopRendererReady.toString(), /Ready/);
});

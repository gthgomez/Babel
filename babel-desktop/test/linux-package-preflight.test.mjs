import test from 'node:test';
import assert from 'node:assert/strict';
import {assertLinuxPackagingTools} from '../scripts/lib/linux-package-preflight.mjs';

test('linux packaging preflight names a missing file command and how to install it', () => {
  assert.doesNotThrow(() => assertLinuxPackagingTools({platform: 'win32', which: () => false}));
  assert.throws(() => assertLinuxPackagingTools({platform: 'linux', which: name => name !== 'file'}), /Missing required tool: file/);
  assert.throws(() => assertLinuxPackagingTools({platform: 'linux', which: name => name !== 'file'}), /apt-get install file/);
  assert.doesNotThrow(() => assertLinuxPackagingTools({platform: 'linux', which: () => true}));
});

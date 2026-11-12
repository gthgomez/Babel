// License: Apache-2.0 — see LICENSE
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  isolatedCredentialHomeEnvironment,
  nodeChildSpawnEnvironment,
} from '../native/spawn-env-floor.mjs';

test('isolatedCredentialHomeEnvironment overrides runner profile paths for bridge children', () => {
  const home = mkdtempSync(join(tmpdir(), 'babel-spawn-home-'));
  const env = isolatedCredentialHomeEnvironment(home, { BABEL_CONFIG_DIR: join(home, 'cfg') });
  assert.equal(env.HOME, home);
  assert.equal(env.USERPROFILE, home);
  assert.equal(env.BABEL_CONFIG_DIR, join(home, 'cfg'));
  const floorOnly = nodeChildSpawnEnvironment();
  if (typeof process.env.USERPROFILE === 'string' && process.env.USERPROFILE.length > 0) {
    assert.notEqual(floorOnly.USERPROFILE, home, 'floor alone must not isolate credential home');
  }
});

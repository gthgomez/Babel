import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assertLoopbackBind,
  assertRemoteListenConfig,
  PublicBindError,
} from './bindGuard.js';
import { assertAllowedProjectRoot, WorkspaceBoundError } from './workspaceBound.js';

describe('bindGuard', () => {
  it('allows loopback and refuses 0.0.0.0', () => {
    assert.doesNotThrow(() => assertLoopbackBind('127.0.0.1'));
    assert.throws(() => assertLoopbackBind('0.0.0.0'), PublicBindError);
    assert.throws(() => assertLoopbackBind('::'), PublicBindError);
  });

  it('refuses public listen env and funnel flags', () => {
    assert.throws(
      () => assertRemoteListenConfig({ BABEL_BRIDGE_HOST: '0.0.0.0' }),
      PublicBindError,
    );
    assert.throws(
      () => assertRemoteListenConfig({ TAILSCALE_FUNNEL: '1' }),
      PublicBindError,
    );
    assert.equal(assertRemoteListenConfig({}), '127.0.0.1');
  });
});

describe('workspaceBound', () => {
  it('rejects path traversal outside the registered root', () => {
    const root = process.cwd();
    assert.doesNotThrow(() => assertAllowedProjectRoot(root, root));
    assert.throws(
      () => assertAllowedProjectRoot('..', root),
      WorkspaceBoundError,
    );
  });
});

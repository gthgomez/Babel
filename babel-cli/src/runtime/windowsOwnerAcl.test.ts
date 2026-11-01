import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { enforceOwnerOnlyWindowsAcl } from './windowsOwnerAcl.js';

describe('Windows owner ACL helper', () => {
  it('fails closed if the trusted Windows system root cannot be resolved', () => {
    const systemRoot = process.env.SystemRoot;
    const windir = process.env.WINDIR;
    try {
      delete process.env.SystemRoot;
      delete process.env.WINDIR;
      assert.deepEqual(enforceOwnerOnlyWindowsAcl('/fixture/credential', false), {
        ok: false,
        code: 'missing_system_root',
      });
    } finally {
      if (systemRoot === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = systemRoot;
      if (windir === undefined) delete process.env.WINDIR;
      else process.env.WINDIR = windir;
    }
  });
});

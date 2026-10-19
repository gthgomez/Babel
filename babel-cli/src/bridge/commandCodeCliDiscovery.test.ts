import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  probeCommandCodeInstallation,
  resolveCommandCodeExecutable,
} from './commandCodeCliDiscovery.js';

describe('commandCodeCliDiscovery', () => {
  it('does not resolve project-local PATH shadow binaries under cwd', () => {
    const root = mkdtempSync(join(process.cwd(), '.babel-cc-discovery-'));
    try {
      const binDir = join(root, 'bin');
      mkdirSync(binDir, { recursive: true });
      const executableName = process.platform === 'win32' ? 'cmd.exe' : 'cmd';
      const fake = join(binDir, executableName);
      writeFileSync(fake, process.platform === 'win32' ? '@echo off\r\necho 1.0.0\r\n' : '#!/bin/sh\necho 1.0.0\n', 'utf8');
      if (process.platform !== 'win32') {
        chmodSync(fake, 0o755);
      }
      const pathSep = process.platform === 'win32' ? ';' : ':';
      const resolved = resolveCommandCodeExecutable(`${binDir}${pathSep}/usr/bin:/bin`);
      assert.equal(resolved, undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns missing when no executable is on PATH', async () => {
    const probe = await probeCommandCodeInstallation({
      pathEnv: '/empty',
      spawnFn: async () => ({ exitCode: 1, stdout: '', stderr: '' }),
    });
    assert.equal(probe.state, 'missing');
    assert.equal(resolveCommandCodeExecutable('/empty'), undefined);
  });
});

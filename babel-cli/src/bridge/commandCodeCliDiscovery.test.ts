import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  probeCommandCodeInstallation,
  resolveCommandCodeExecutable,
} from './commandCodeCliDiscovery.js';

describe('commandCodeCliDiscovery', () => {
  it('does not resolve project-local PATH shadow binaries under cwd', () => {
    const root = mkdtempSync(join(process.cwd(), '.babel-cc-discovery-'));
    const binDir = join(root, 'bin');
    const fake = join(binDir, 'cmd');
    writeFileSync(fake, '#!/bin/sh\necho 1.0.0\n', 'utf8');
    chmodSync(fake, 0o755);
    const resolved = resolveCommandCodeExecutable(`${binDir}:/usr/bin:/bin`);
    assert.equal(resolved, undefined);
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

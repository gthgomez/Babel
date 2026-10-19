import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  probeCommandCodeInstallation,
  resolveCommandCodeExecutable,
} from './commandCodeCliDiscovery.js';

describe('commandCodeCliDiscovery', () => {
  it('returns missing when no executable is on PATH', async () => {
    const probe = await probeCommandCodeInstallation({
      pathEnv: '/empty',
      spawnFn: async () => ({ exitCode: 1, stdout: '', stderr: '' }),
    });
    assert.equal(probe.state, 'missing');
    assert.equal(resolveCommandCodeExecutable('/empty'), undefined);
  });

});

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

  it('treats fixture ACP command env as verified without version spawn', async () => {
    const prev = process.env['BABEL_COMMAND_CODE_ACP_COMMAND'];
    process.env['BABEL_COMMAND_CODE_ACP_COMMAND'] = '/bin/false';
    try {
      const probe = await probeCommandCodeInstallation();
      assert.equal(probe.state, 'verified');
      assert.equal(probe.executable, '/bin/false');
    } finally {
      if (prev === undefined) delete process.env['BABEL_COMMAND_CODE_ACP_COMMAND'];
      else process.env['BABEL_COMMAND_CODE_ACP_COMMAND'] = prev;
    }
  });
});

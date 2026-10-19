import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { probeCommandCodeInstallation } from './commandCodeCliDiscovery.js';

const fixtureCli = fileURLToPath(
  new URL('../../test/fixtures/command-code-version.mjs', import.meta.url),
);

function fixturePathEnv(): string {
  const dir = mkdtempSync(join(tmpdir(), 'babel-command-code-bin-'));
  const binary = join(dir, 'command-code');
  copyFileSync(fixtureCli, binary);
  chmodSync(binary, 0o755);
  return dir;
}

describe('commandCodeCliDiscovery', () => {
  it('reports missing when the executable is absent from PATH', async () => {
    const probe = await probeCommandCodeInstallation({ pathEnv: '/usr/bin' });
    assert.equal(probe.state, 'missing');
  });

  it('parses a semver from a fixture binary without live provider calls', async () => {
    const probe = await probeCommandCodeInstallation({
      pathEnv: fixturePathEnv(),
      spawnFn: async (_executable, args) => {
        const { spawnSync } = await import('node:child_process');
        const result = spawnSync(process.execPath, [fixtureCli, ...args], {
          encoding: 'utf8',
          windowsHide: true,
        });
        return {
          exitCode: result.status ?? 1,
          stdout: result.stdout ?? '',
          stderr: result.stderr ?? '',
        };
      },
    });
    assert.equal(probe.state, 'verified');
    assert.equal(probe.version, '0.4.2-beta.1');
  });

  it('marks unverified when version output is not parseable', async () => {
    const probe = await probeCommandCodeInstallation({
      pathEnv: fixturePathEnv(),
      spawnFn: async () => ({
        exitCode: 0,
        stdout: 'ok\n',
        stderr: '',
      }),
    });
    assert.equal(probe.state, 'unverified');
    assert.equal(probe.rawVersion, 'ok');
  });
});

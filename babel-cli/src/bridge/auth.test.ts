import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function withIsolatedHome(run: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), 'babel-bridge-auth-'));
  try {
    run(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function runFixture(home: string, script: string): void {
  const temp = tmpdir();
  const env: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'] ?? '',
    HOME: home,
    USERPROFILE: home,
    APPDATA: home,
    LOCALAPPDATA: home,
    TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
    ...(process.env['SystemRoot'] ? { SystemRoot: process.env['SystemRoot'] } : {}),
  };
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: cliRoot,
    env,
    encoding: 'utf8',
  });
  assert.equal(child.status, 0, `isolated auth fixture failed: ${child.stderr}`);
  assert.equal(child.stdout, '');
}

describe('bridge credential persistence', () => {
  it('creates private directory and file despite umask 022 and repairs file mode before loading', (context) => {
    if (process.platform === 'win32') return context.skip('Windows ACL privacy is not asserted by POSIX mode tests');
    withIsolatedHome((home) => runFixture(home, `
      import assert from 'node:assert/strict';
      import { chmodSync, statSync } from 'node:fs';
      import { join } from 'node:path';
      import { generateToken, loadBridgeConfig, persistBridgeConfig } from './src/bridge/auth.ts';
      process.umask(0o022);
      const config = { authToken: generateToken(), port: 4545 };
      persistBridgeConfig(config);
      const dir = join(process.env.HOME, '.babel');
      const path = join(dir, 'bridge.json');
      if ((statSync(dir).mode & 0o777) !== 0o700) throw new Error('directory mode was not restricted');
      if ((statSync(path).mode & 0o777) !== 0o600) throw new Error('file mode was not restricted');
      chmodSync(path, 0o644);
      const loaded = loadBridgeConfig();
      if (loaded.authToken !== config.authToken) throw new Error('existing config was not loaded after repair');
      if ((statSync(path).mode & 0o777) !== 0o600) throw new Error('existing file mode was not repaired');
    `));
  });

  it('rejects a bridge config symlink without following it', (context) => {
    if (process.platform === 'win32') return context.skip('Windows symlink creation requires platform-specific privileges');
    withIsolatedHome((home) => runFixture(home, `
      import assert from 'node:assert/strict';
      import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { generateToken, persistBridgeConfig } from './src/bridge/auth.ts';
      const dir = join(process.env.HOME, '.babel');
      mkdirSync(dir, { mode: 0o700 });
      const outside = join(process.env.HOME, 'outside.json');
      writeFileSync(outside, JSON.stringify({ authToken: generateToken(), port: 4545 }));
      symlinkSync(outside, join(dir, 'bridge.json'));
      assert.throws(() => persistBridgeConfig({ authToken: generateToken(), port: 4545 }), /symlink/i);
      rmSync(join(dir, 'bridge.json'));
      rmSync(dir, { recursive: true });
      const outsideDir = join(process.env.HOME, 'outside-dir');
      mkdirSync(outsideDir, { mode: 0o700 });
      symlinkSync(outsideDir, dir, 'dir');
      assert.throws(() => persistBridgeConfig({ authToken: generateToken(), port: 4545 }), /symlink/i);
    `));
  });

  it('surfaces config path write failures', () => {
    withIsolatedHome((home) => runFixture(home, `
      import assert from 'node:assert/strict';
      import { mkdirSync } from 'node:fs';
      import { join } from 'node:path';
      import { generateToken, persistBridgeConfig } from './src/bridge/auth.ts';
      const dir = join(process.env.HOME, '.babel');
      mkdirSync(dir, { mode: 0o700 });
      mkdirSync(join(dir, 'bridge.json'));
      assert.throws(() => persistBridgeConfig({ authToken: generateToken(), port: 4545 }));
    `));
  });

  it('fails closed at startup when credential persistence is blocked', (context) => {
    if (process.platform === 'win32') return context.skip('Windows symlink creation requires platform-specific privileges');
    withIsolatedHome((home) => runFixture(home, `
      import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { BridgeServer } from './src/bridge/sessionServer.ts';
      import { generateToken } from './src/bridge/auth.ts';
      const dir = join(process.env.HOME, '.babel');
      mkdirSync(dir, { mode: 0o700 });
      const outside = join(process.env.HOME, 'outside.json');
      writeFileSync(outside, '{}');
      symlinkSync(outside, join(dir, 'bridge.json'));
      let reportedListening = false;
      const server = new BridgeServer({
        port: 0,
        authToken: generateToken(),
        onListening: () => { reportedListening = true; },
      });
      let failed = false;
      try { await server.start(); } catch { failed = true; }
      if (!failed) {
        await server.stop();
        throw new Error('bridge startup did not fail on persistence error');
      }
      if (reportedListening) throw new Error('bridge reported listening after persistence failed');
    `));
  });
});

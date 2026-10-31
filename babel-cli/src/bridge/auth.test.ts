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

  it('verifies temp ACL before writing token bytes and preserves existing config on ACL failure', () => {
    withIsolatedHome((home) => runFixture(home, `
      import assert from 'node:assert/strict';
      import { readdirSync, readFileSync, statSync } from 'node:fs';
      import { join } from 'node:path';
      import { generateToken, loadBridgeConfig, persistBridgeConfig } from './src/bridge/auth.ts';
      const original = { authToken: generateToken(), port: 4545 };
      persistBridgeConfig(original);
      const dir = join(process.env.HOME, '.babel');
      const path = join(dir, 'bridge.json');
      const events = [];
      const replacement = { authToken: generateToken(), port: 4546 };
      assert.throws(() => persistBridgeConfig(replacement, {
        enforceAcl(target, directory) {
          events.push({ target, directory });
          if (target.endsWith('.tmp')) {
            if (statSync(target).size !== 0) throw new Error('token bytes written before temp ACL verification');
            return { ok: false, code: 'fixture_acl_denied' };
          }
          return { ok: true, code: 'ok' };
        },
      }), /ACL could not be verified/);
      assert.equal(events.some((event) => event.target === dir && event.directory), true);
      assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), original);
      assert.deepEqual(readdirSync(dir).sort(), ['bridge.json']);
      assert.throws(() => loadBridgeConfig({ enforceAcl: () => ({ ok: false, code: 'fixture_acl_denied' }) }), /ACL could not be verified/);
      assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), original);
    `));
  });

  it('restores the prior config if final ACL verification fails after replacement', () => {
    withIsolatedHome((home) => runFixture(home, `
      import assert from 'node:assert/strict';
      import { readdirSync, readFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { generateToken, persistBridgeConfig } from './src/bridge/auth.ts';
      const original = { authToken: generateToken(), port: 4545 };
      persistBridgeConfig(original);
      const dir = join(process.env.HOME, '.babel');
      const path = join(dir, 'bridge.json');
      let finalChecks = 0;
      assert.throws(() => persistBridgeConfig({ authToken: generateToken(), port: 4546 }, {
        enforceAcl(target) {
          if (target === path && ++finalChecks === 2) return { ok: false, code: 'fixture_final_acl_denied' };
          return { ok: true, code: 'ok' };
        },
      }), /ACL could not be verified/);
      assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), original);
      assert.deepEqual(readdirSync(dir), ['bridge.json']);
    `));
  });

  it('persists bridge credentials with a verified owner-only DACL on native Windows', (context) => {
    if (process.platform !== 'win32') return context.skip('native Windows DACL acceptance check');
    withIsolatedHome((home) => runFixture(home, `
      import assert from 'node:assert/strict';
      import { spawnSync } from 'node:child_process';
      import { join } from 'node:path';
      import { generateToken, persistBridgeConfig } from './src/bridge/auth.ts';
      const config = { authToken: generateToken(), port: 4545 };
      persistBridgeConfig(config);
      const script = [
        '$ErrorActionPreference = \'Stop\'',
        '$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
        '$sections = [System.Security.AccessControl.AccessControlSections]::Access',
        '$dir = Join-Path $env:USERPROFILE \'.babel\'',
        '$file = Join-Path $dir \'bridge.json\'',
        'foreach ($item in @(@($dir, $true), @($file, $false))) {',
        '  if ($item[1]) { $acl = [System.Security.AccessControl.DirectorySecurity]::new($item[0], $sections) } else { $acl = [System.Security.AccessControl.FileSecurity]::new($item[0], $sections) }',
        '  $rules = @($acl.Access)',
        '  if (-not $acl.AreAccessRulesProtected -or $rules.Count -ne 1) { throw \'unprotected or extra DACL entries\' }',
        '  $rule = $rules[0]',
        '  if ($rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -ne $sid) { throw \'wrong DACL owner\' }',
        '  if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or $rule.FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl -or $rule.IsInherited) { throw \'DACL is not owner-only full control\' }',
        '  if ($item[1] -and $rule.InheritanceFlags -ne ([System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit)) { throw \'directory inheritance flags are invalid\' }',
        '  if (-not $item[1] -and $rule.InheritanceFlags -ne [System.Security.AccessControl.InheritanceFlags]::None) { throw \'file inheritance flags are invalid\' }',
        '}',
      ].join('; ');
      const powershell = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
      assert.equal(result.status, 0, result.stderr);
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

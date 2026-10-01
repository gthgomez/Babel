import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

for (const args of [
  ['serve', '--port', '0'],
  ['ui-benchmark', '--port', '-1'],
  ['ui-benchmark', '--scenario', 'missing-scenario'],
]) test(`remote ${args.join(' ')} reports failure without terminating its host`, () => {
  const source = `import { Command } from 'commander';
import { registerRemoteCommands } from './src/commands/remoteCommands.ts';
const command = new Command(); registerRemoteCommands(command);
await command.parseAsync(['node', 'babel', 'remote', ...${JSON.stringify(args)}]);
process.stdout.write('HOST_RETURNED\\n');`;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, BABEL_BRIDGE_HOST: '127.0.0.1', BABEL_REMOTE_LISTEN: '127.0.0.1', BABEL_REMOTE_ALLOW_FUNNEL: '0', TAILSCALE_FUNNEL: '0' },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Invalid --port|Unknown --scenario/);
  assert.match(result.stdout, /HOST_RETURNED/);
  assert.doesNotMatch(result.stdout, /listening/i);
});

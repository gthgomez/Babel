import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { buildIntegrationChildEnv } from './integrationChildEnv.js';
import { CommandCodeAcpTransport } from './commandCodeAcpTransport.js';

const CONTROLLER_KEY = /^(BABEL_BRIDGE_|HAPPIER_|HAPPY_|TAILSCALE_)/i;

describe('buildIntegrationChildEnv', () => {
  it('removes controller authority while preserving approved runtime variables', () => {
    const childEnv = buildIntegrationChildEnv({
      BABEL_BRIDGE_DESKTOP_PROOF_KEY: 'fixture-proof-canary',
      BABEL_BRIDGE_INSTANCE: 'fixture-instance',
      BABEL_DESKTOP_PROOF_KEY: 'fixture-desktop-proof',
      BABEL_DESKTOP_CLIENT_ID: 'fixture-desktop-client',
      HAPPIER_ACCESS_TOKEN: 'fixture-happier-token',
      happier_lowercase_canary: 'fixture-happier-lowercase',
      HAPPY_ENCRYPTION_KEY: 'fixture-happy-key',
      TAILSCALE_AUTH_KEY: 'fixture-tailscale-key',
      BABEL_REMOTE_AUTH_TOKEN: 'fixture-remote-token',
      PATH: '/usr/bin',
      OPENAI_API_KEY: 'fixture-provider-key',
      BABEL_DESKTOP_PROVIDER: 'openai',
    });

    assert.deepEqual(
      Object.keys(childEnv).filter((name) =>
        CONTROLLER_KEY.test(name) ||
        ['BABEL_DESKTOP_PROOF_KEY', 'BABEL_DESKTOP_CLIENT_ID', 'BABEL_REMOTE_AUTH_TOKEN'].includes(name),
      ),
      [],
    );
    assert.equal(childEnv['PATH'], '/usr/bin');
    assert.equal(childEnv['OPENAI_API_KEY'], 'fixture-provider-key');
    assert.equal(childEnv['BABEL_DESKTOP_PROVIDER'], 'openai');
  });

  it('keeps controller variables absent from the spawned ACP child and its nested child', async () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-acp-child-env-'));
    const childPath = join(root, 'acp-child.mjs');
    writeFileSync(
      childPath,
      [
        "import { spawnSync } from 'node:child_process';",
        "import { createInterface } from 'node:readline';",
        "const hasControllerKey = () => Object.keys(process.env).some((name) => /^(BABEL_BRIDGE_|HAPPIER_|HAPPY_|TAILSCALE_)/i.test(name) || ['BABEL_DESKTOP_PROOF_KEY', 'BABEL_DESKTOP_CLIENT_ID', 'BABEL_REMOTE_TOKEN', 'BABEL_REMOTE_AUTH_TOKEN'].includes(name.toUpperCase()));",
        "const nested = spawnSync(process.execPath, ['-e', \"const leaked = Object.keys(process.env).some((name) => /^(BABEL_BRIDGE_|HAPPIER_|HAPPY_|TAILSCALE_)/i.test(name) || ['BABEL_DESKTOP_PROOF_KEY', 'BABEL_DESKTOP_CLIENT_ID', 'BABEL_REMOTE_TOKEN', 'BABEL_REMOTE_AUTH_TOKEN'].includes(name.toUpperCase())); process.stdout.write(JSON.stringify({ leaked, providerPresent: process.env.OPENAI_API_KEY === 'fixture-provider-key' }));\"], { encoding: 'utf8', timeout: 4000 });",
        "const nestedResult = nested.status === 0 ? JSON.parse(nested.stdout) : { leaked: true, providerPresent: false };",
        "const directClean = !hasControllerKey() && process.env.OPENAI_API_KEY === 'fixture-provider-key';",
        "createInterface({ input: process.stdin }).on('line', (line) => { const request = JSON.parse(line); if (request.method === 'initialize') { const name = directClean && !nestedResult.leaked && nestedResult.providerPresent ? 'child-env-clean' : 'child-env-leaked'; process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: 1, agentInfo: { name } } }) + '\\n'); } });",
      ].join('\n'),
    );
    const transport = new CommandCodeAcpTransport(
      {
        command: process.execPath,
        args: [childPath],
        cwd: root,
        env: {
          PATH: process.env['PATH'] ?? '',
          HOME: root,
          BABEL_BRIDGE_DESKTOP_PROOF_KEY: 'fixture-proof-canary',
          BABEL_BRIDGE_HOST_EMERGENCY_TOKEN: 'fixture-emergency-token',
          HAPPIER_ACCESS_TOKEN: 'fixture-happier-token',
          TAILSCALE_AUTH_KEY: 'fixture-tailscale-key',
          OPENAI_API_KEY: 'fixture-provider-key',
        },
      },
      1,
    );
    try {
      const codec = await transport.start();
      assert.equal(codec.agentInfo?.name, 'child-env-clean');
    } finally {
      await transport.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

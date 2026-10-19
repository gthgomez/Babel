import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import {
  mintDesktopControllerClientId,
  mintDesktopControllerProofKey,
} from './desktopControllerAuth.js';
import { createDeterministicBridgeEngineFactory } from './deterministicBridgeEngine.js';
import { BridgeServer } from './sessionServer.js';

const TOKEN = 'host-run-entry-token';
const cliEntry = fileURLToPath(new URL('../../dist/index.js', import.meta.url));

describe('remote host-run CLI entry lifecycle', () => {
  let server: BridgeServer;
  let tmp: string;
  let port = 0;
  const desktopId = mintDesktopControllerClientId();
  const desktopProofKey = mintDesktopControllerProofKey();

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'babel-host-run-entry-'));
    server = new BridgeServer({
      authToken: TOKEN,
      allowedWorkspaceRoot: tmp,
      allowedOrigins: ['http://127.0.0.1:*', 'http://localhost:*'],
      enforceControlLease: true,
      desktopControllerClientId: desktopId,
      desktopControllerProofKey: desktopProofKey,
      engineFactory: createDeterministicBridgeEngineFactory(),
    });
    await server.start(0);
    port = server.port;
  });

  after(async () => {
    await server.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('exits via exitCode with parent stdin pipe held open', async () => {
    const child = spawn(
      process.execPath,
      ['--experimental-wasm-modules', cliEntry, 'remote', 'host-run', '--project-root', tmp, '--run-id', 'cli-entry-1', '--', 'hello host-run entry'],
      {
        cwd: tmp,
        env: {
          ...process.env,
          BABEL_BRIDGE_PORT: String(port),
          BABEL_BRIDGE_DESKTOP_CLIENT_ID: desktopId,
          BABEL_BRIDGE_DESKTOP_PROOF_KEY: desktopProofKey,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    let stdout = '';
    let stdinOpenDuringRun = false;
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      if (child.stdin && !child.stdin.destroyed) stdinOpenDuringRun = true;
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    assert.equal(code, 0);
    assert.match(stdout, /"type":"run_complete"/);
    assert.equal(stdinOpenDuringRun, true, 'host-run must finish while parent stdin pipe remains open');
    child.stdin?.end();
  });
});

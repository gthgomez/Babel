import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { BridgeServer } from './sessionServer.js';
import { createDeterministicBridgeEngineFactory } from './deterministicBridgeEngine.js';

describe('ordinary remote serve production boundary', () => {
  it('does not expose acceptance fixture metadata on /health when env flags are set', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'babel-serve-health-'));
    const prev = process.env['BABEL_BRIDGE_DETERMINISTIC_ENGINE'];
    process.env['BABEL_BRIDGE_DETERMINISTIC_ENGINE'] = '1';
    const server = new BridgeServer({
      authToken: 'serve-health-token',
      allowedWorkspaceRoot: tmp,
      allowedOrigins: ['http://127.0.0.1:*'],
    });
    await server.start(0);
    const port = server.port;
    try {
      const body = await httpGet(`http://127.0.0.1:${port}/health`);
      const json = JSON.parse(body) as { acceptance_fixture?: unknown };
      assert.equal(json.acceptance_fixture, undefined);
    } finally {
      await server.stop();
      rmSync(tmp, { recursive: true, force: true });
      if (prev === undefined) delete process.env['BABEL_BRIDGE_DETERMINISTIC_ENGINE'];
      else process.env['BABEL_BRIDGE_DETERMINISTIC_ENGINE'] = prev;
    }
  });

  it('acceptance bridge health reports fixture execution metadata', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'babel-acceptance-health-'));
    const prev = process.env['BABEL_TEST_ACCEPTANCE_DETERMINISTIC_BRIDGE'];
    process.env['BABEL_TEST_ACCEPTANCE_DETERMINISTIC_BRIDGE'] = '1';
    const server = new BridgeServer({
      authToken: 'acceptance-health-token',
      allowedWorkspaceRoot: tmp,
      allowedOrigins: ['http://127.0.0.1:*'],
      engineFactory: createDeterministicBridgeEngineFactory(),
      acceptanceFixture: { kind: 'acceptance-deterministic-bridge-v1', label: 'test' },
    });
    await server.start(0);
    const port = server.port;
    try {
      const body = await httpGet(`http://127.0.0.1:${port}/health`);
      const json = JSON.parse(body) as {
        acceptance_fixture?: { fixture_execution?: boolean; kind?: string };
      };
      assert.equal(json.acceptance_fixture?.fixture_execution, true);
      assert.equal(json.acceptance_fixture?.kind, 'acceptance-deterministic-bridge-v1');
    } finally {
      await server.stop();
      rmSync(tmp, { recursive: true, force: true });
      if (prev === undefined) delete process.env['BABEL_TEST_ACCEPTANCE_DETERMINISTIC_BRIDGE'];
      else process.env['BABEL_TEST_ACCEPTANCE_DETERMINISTIC_BRIDGE'] = prev;
    }
  });
});

function httpGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = request(
      { hostname: parsed.hostname, port: parsed.port, path: parsed.pathname, method: 'GET' },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk.toString('utf8');
        });
        res.on('end', () => resolve(data));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

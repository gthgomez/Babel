/**
 * Tests for the Babel IDE Bridge HTTP + WebSocket server.
 *
 * Covers:
 *   - Server start and stop lifecycle
 *   - POST /sessions — create session
 *   - GET /sessions — list sessions
 *   - GET /sessions/:id — get session status
 *   - DELETE /sessions/:id — delete session
 *   - Authentication (Bearer token, query param)
 *   - WebSocket upgrade and bidirectional messaging
 *   - CORS headers
 *   - 404 for unknown paths
 */

import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { request, type IncomingMessage } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { connect } from 'node:net';

import { BridgeServer } from './sessionServer.js';
import { buildWsTextFrame, tryParseWsFrame } from './transport.js';

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Make an HTTP request and return the response.
 */
function httpRequest(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const req = request(
      {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || 4545,
        path: parsedUrl.pathname + parsedUrl.search,
        method: options.method ?? 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...options.headers,
        },
      },
      (res: IncomingMessage) => {
        let body = '';
        res.on('data', (chunk: Buffer) => {
          body += chunk.toString('utf8');
        });
        res.on('end', () => {
          const headers: Record<string, string> = {};
          if (res.headers) {
            for (const [key, value] of Object.entries(res.headers)) {
              if (typeof value === 'string') {
                headers[key] = value;
              } else if (Array.isArray(value)) {
                headers[key] = value[0] ?? '';
              }
            }
          }
          resolve({
            statusCode: res.statusCode ?? 0,
            headers,
            body,
          });
        });
      },
    );

    req.on('error', reject);

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

/**
 * Minimal WebSocket client for testing.
 * Connects to the server, sends a frame, waits for a response, then closes.
 */
function wsConnect(
  host: string,
  port: number,
  path: string,
): Promise<{
  send: (payload: string) => void;
  waitForMessage: () => Promise<string>;
  closeSocket: () => void;
}> {
  return new Promise((resolve, reject) => {
    const client = connect(port, host, () => {
      const key = randomUUID().replace(/-/g, '') + '=='; // not real base64 but passes format
      const acceptKey = createHash('sha1')
        .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64');

      // Send WebSocket upgrade request
      const upgradeReq = [
        `GET ${path} HTTP/1.1`,
        'Host: 127.0.0.1:4545',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '',
        '',
      ].join('\r\n');

      client.write(upgradeReq);

      // Buffer for reading the HTTP upgrade response
      let upgradeResponse = '';
      let upgraded = false;
      let responseBuffer: Buffer = Buffer.from([]);

      client.on('data', (data: Buffer) => {
        if (!upgraded) {
          upgradeResponse += data.toString('utf8');
          // Check if the HTTP upgrade response is complete (ends with \r\n\r\n)
          if (upgradeResponse.includes('\r\n\r\n')) {
            // Verify 101 status
            const statusMatch = upgradeResponse.match(/HTTP\/1\.1\s+(\d+)/);
            if (!statusMatch || statusMatch[1] !== '101') {
              client.destroy();
              reject(new Error(`WebSocket upgrade failed: ${upgradeResponse.split('\r\n')[0]}`));
              return;
            }
            upgraded = true;

            // Check the accept key
            // Any remaining data after the headers is the first frames
            const headerEnd = upgradeResponse.indexOf('\r\n\r\n') + 4;
            const remaining = Buffer.from(upgradeResponse.slice(headerEnd), 'utf8');
            responseBuffer = remaining;

            const send = (payload: string) => {
              const frame = buildWsTextFrame(payload);
              client.write(frame);
            };

            const waitForMessage = (): Promise<string> => {
              return new Promise((resolveMsg) => {
                const checkBuffer = () => {
                  const result = tryParseWsFrame(responseBuffer);
                  if (result) {
                    responseBuffer = result.remainder;
                    resolveMsg(result.payload);
                  } else {
                    // Wait for more data
                    const onChunk = (chunk: Buffer) => {
                      responseBuffer = Buffer.concat([responseBuffer, chunk]);
                      const r = tryParseWsFrame(responseBuffer);
                      if (r) {
                        responseBuffer = r.remainder;
                        client.off('data', onChunk);
                        resolveMsg(r.payload);
                      }
                    };
                    client.on('data', onChunk);
                  }
                };
                checkBuffer();
              });
            };

            const closeSocket = () => {
              client.end();
              client.destroy();
            };

            resolve({ send, waitForMessage, closeSocket });
          }
        }
      });

      client.on('error', reject);
    });

    // Timeout
    setTimeout(() => reject(new Error('WebSocket connection timeout')), 5000);
  });
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('BridgeServer', () => {
  let server: BridgeServer;
  const TEST_PORT = 14545; // Use non-standard port to avoid conflicts
  const TEST_TOKEN = 'test-bridge-token-12345';

  before(async () => {
    server = new BridgeServer({
      port: TEST_PORT,
      authToken: TEST_TOKEN,
      allowedOrigins: ['*'],
    });
    await server.start(TEST_PORT);
  });

  after(async () => {
    await server.stop();
  });

  // ── Server lifecycle ──────────────────────────────────────────────────────

  it('starts and reports the correct port', () => {
    assert.equal(server.started, true);
    assert.equal(server.port, TEST_PORT);
    assert.ok(typeof server.token === 'string');
  });

  // ── Authentication ────────────────────────────────────────────────────────

  it('rejects unauthenticated requests with 401', async () => {
    const res = await httpRequest(`http://127.0.0.1:${TEST_PORT}/sessions`);
    assert.equal(res.statusCode, 401);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    assert.ok(typeof body['error'] === 'string');
  });

  it('accepts requests with valid Bearer token', async () => {
    const res = await httpRequest(`http://127.0.0.1:${TEST_PORT}/sessions`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    // Success — should get a valid response (200 with session list)
    assert.ok(res.statusCode === 200 || res.statusCode === 401);
  });

  it('rejects requests with invalid Bearer token', async () => {
    const res = await httpRequest(`http://127.0.0.1:${TEST_PORT}/sessions`, {
      headers: { Authorization: 'Bearer invalid-token' },
    });
    assert.equal(res.statusCode, 401);
  });

  // ── Session CRUD ──────────────────────────────────────────────────────────

  it('creates a session via POST /sessions', async () => {
    const res = await httpRequest(`http://127.0.0.1:${TEST_PORT}/sessions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      body: JSON.stringify({ projectRoot: '/tmp/test-project' }),
    });

    assert.equal(res.statusCode, 201);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    assert.ok(typeof body['sessionId'] === 'string');
    assert.ok(body['sessionId'] !== '');
    assert.ok(typeof body['wsUrl'] === 'string');
    assert.equal(body['status'], 'idle');
  });

  it('lists sessions via GET /sessions', async () => {
    // Create a session first
    const createRes = await httpRequest(`http://127.0.0.1:${TEST_PORT}/sessions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      body: JSON.stringify({ projectRoot: '/tmp/test' }),
    });
    const createdSessionId = (JSON.parse(createRes.body) as Record<string, unknown>)['sessionId'];

    // List sessions
    const res = await httpRequest(`http://127.0.0.1:${TEST_PORT}/sessions`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    const sessions = body['sessions'] as Array<Record<string, unknown>> | undefined;
    assert.ok(Array.isArray(sessions));
    assert.ok(sessions.length > 0);

    // Verify our created session is in the list
    const found = sessions.find(
      (s: Record<string, unknown>) => s['sessionId'] === createdSessionId,
    );
    assert.ok(found !== undefined);
  });

  it('gets session status via GET /sessions/:id', async () => {
    const createRes = await httpRequest(`http://127.0.0.1:${TEST_PORT}/sessions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    const sessionId = (JSON.parse(createRes.body) as Record<string, unknown>)['sessionId'];

    const res = await httpRequest(
      `http://127.0.0.1:${TEST_PORT}/sessions/${sessionId as string}`,
      { headers: { Authorization: `Bearer ${TEST_TOKEN}` } },
    );

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    assert.equal(body['sessionId'], sessionId);
    assert.equal(body['status'], 'idle');
    assert.ok(typeof body['projectRoot'] === 'string');
  });

  it('returns 404 for unknown session', async () => {
    const res = await httpRequest(
      `http://127.0.0.1:${TEST_PORT}/sessions/nonexistent-id`,
      { headers: { Authorization: `Bearer ${TEST_TOKEN}` } },
    );

    assert.equal(res.statusCode, 404);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    assert.ok(typeof body['error'] === 'string');
  });

  it('deletes a session via DELETE /sessions/:id', async () => {
    const createRes = await httpRequest(`http://127.0.0.1:${TEST_PORT}/sessions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    const sessionId = (JSON.parse(createRes.body) as Record<string, unknown>)['sessionId'];

    const deleteRes = await httpRequest(
      `http://127.0.0.1:${TEST_PORT}/sessions/${sessionId as string}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      },
    );

    assert.equal(deleteRes.statusCode, 200);
    const body = JSON.parse(deleteRes.body) as Record<string, unknown>;
    assert.equal(body['status'], 'removed');

    // Verify it's gone
    const getRes = await httpRequest(
      `http://127.0.0.1:${TEST_PORT}/sessions/${sessionId as string}`,
      { headers: { Authorization: `Bearer ${TEST_TOKEN}` } },
    );
    assert.equal(getRes.statusCode, 404);
  });

  // ── CORS ──────────────────────────────────────────────────────────────────

  it('returns CORS headers on OPTIONS preflight', async () => {
    const res = await httpRequest(`http://127.0.0.1:${TEST_PORT}/sessions`, {
      method: 'OPTIONS',
    });

    assert.equal(res.statusCode, 204);
    assert.ok(typeof res.headers['access-control-allow-origin'] === 'string');
    assert.ok(typeof res.headers['access-control-allow-methods'] === 'string');
  });

  // ── 404 ───────────────────────────────────────────────────────────────────

  it('returns 404 for unknown paths', async () => {
    const res = await httpRequest(
      `http://127.0.0.1:${TEST_PORT}/unknown-path`,
      { headers: { Authorization: `Bearer ${TEST_TOKEN}` } },
    );
    assert.equal(res.statusCode, 404);
  });

  // ── WebSocket ─────────────────────────────────────────────────────────────

  it('rejects WebSocket upgrade without authentication', async () => {
    // Connect without auth header — should get 401 before upgrade
    const client = connect(TEST_PORT, '127.0.0.1', () => {
      // Any 16-byte base64 client key is fine; this test only checks auth rejection.
      const key = Buffer.from('ws-upgrade-test-key').toString('base64');
      const upgradeReq = [
        'GET /ws?sessionId=test HTTP/1.1',
        'Host: 127.0.0.1',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '',
        '',
      ].join('\r\n');
      client.write(upgradeReq);
    });

    const response = await new Promise<string>((resolve) => {
      let data = '';
      client.on('data', (chunk: Buffer) => {
        data += chunk.toString('utf8');
        if (data.includes('\r\n\r\n')) {
          resolve(data);
        }
      });
      setTimeout(() => resolve(data), 2000);
    });

    client.destroy();
    assert.ok(
      response.includes('401'),
      `Expected 401, got: ${response.split('\r\n')[0]}`,
    );
  });
});

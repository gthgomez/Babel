/**
 * daemon/ipc.test.ts — IPC transport layer tests
 *
 * Tests DaemonIpcServer: ping, error handling, concurrent connections,
 * socket cleanup, and uptime tracking. Uses TCP localhost for reliability
 * across Windows/Unix CI runners.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { connect } from 'node:net';

import { DaemonIpcServer } from './ipc.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

let nextPort = 10000 + Math.floor(Math.random() * 50000);
function getPort(): number {
  return nextPort++;
}

function ipcRequestTcp(
  host: string,
  port: number,
  method: string,
  params?: Record<string, unknown>,
  timeoutMs = 5000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    let buffer = '';
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(`IPC request timed out: ${method}`));
    }, timeoutMs);

    socket.on('connect', () => {
      const request: Record<string, unknown> = { id: Date.now(), method };
      if (params !== undefined) request['params'] = params;
      socket.write(JSON.stringify(request) + '\n');
    });

    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf-8');
      const nl = buffer.indexOf('\n');
      if (nl === -1) return;
      if (settled) return;
      settled = true;
      clearTimeout(timeout);

      const line = buffer.slice(0, nl).trim();
      const response = JSON.parse(line);
      if (response.error) {
        reject(new Error(response.error.message));
      } else {
        resolve(response.result);
      }
      socket.end();
    });

    socket.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(err);
    });
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('DaemonIpcServer responds to ping via TCP', async () => {
  const port = getPort();
  const server = new DaemonIpcServer();

  try {
    await server.listen({ host: '127.0.0.1', port });
    const result = (await ipcRequestTcp('127.0.0.1', port, 'ping')) as any;
    assert.equal(result.alive, true);
    assert.equal(result.pid, process.pid);
    assert.ok(typeof result.uptime === 'number');
    assert.ok(result.uptime >= 0);
  } finally {
    await server.close();
  }
});

test('DaemonIpcServer returns error for unknown method', async () => {
  const port = getPort();
  const server = new DaemonIpcServer();

  try {
    await server.listen({ host: '127.0.0.1', port });
    await assert.rejects(
      () => ipcRequestTcp('127.0.0.1', port, 'nonexistent_method'),
      /Method not found/,
    );
  } finally {
    await server.close();
  }
});

test('DaemonIpcServer dispatches to registered handlers', async () => {
  const port = getPort();
  const server = new DaemonIpcServer();

  server.on('echo', async (params: any) => {
    return { echoed: params };
  });

  try {
    await server.listen({ host: '127.0.0.1', port });
    const result = (await ipcRequestTcp('127.0.0.1', port, 'echo', { hello: 'world' })) as any;
    assert.deepEqual(result, { echoed: { hello: 'world' } });
  } finally {
    await server.close();
  }
});

test('DaemonIpcServer returns error when handler throws', async () => {
  const port = getPort();
  const server = new DaemonIpcServer();

  server.on('failing', async () => {
    throw new Error('intentional test error');
  });

  try {
    await server.listen({ host: '127.0.0.1', port });
    await assert.rejects(
      () => ipcRequestTcp('127.0.0.1', port, 'failing'),
      /intentional test error/,
    );
  } finally {
    await server.close();
  }
});

test('DaemonIpcServer handles multiple concurrent connections', async () => {
  const port = getPort();
  const server = new DaemonIpcServer();

  server.on('slow', async (params: any) => {
    const delay = params.delay ?? 10;
    await new Promise((r) => setTimeout(r, delay));
    return { delayed: delay };
  });

  try {
    await server.listen({ host: '127.0.0.1', port });

    const results = await Promise.all([
      ipcRequestTcp('127.0.0.1', port, 'ping'),
      ipcRequestTcp('127.0.0.1', port, 'slow', { delay: 20 }),
      ipcRequestTcp('127.0.0.1', port, 'ping'),
    ]);

    assert.equal((results[0] as any).alive, true);
    assert.deepEqual(results[1], { delayed: 20 });
    assert.equal((results[2] as any).alive, true);
  } finally {
    await server.close();
  }
});

test('DaemonIpcServer close stops accepting connections', async () => {
  const port = getPort();
  const server = new DaemonIpcServer();

  await server.listen({ host: '127.0.0.1', port });
  assert.equal(server.isListening, true);

  await server.close();
  assert.equal(server.isListening, false);

  // New connections should be refused after close
  await assert.rejects(
    () => ipcRequestTcp('127.0.0.1', port, 'ping', undefined, 1000),
    /ECONNREFUSED|connect/,
  );
});

test('DaemonIpcServer uptimeSeconds returns elapsed time', async () => {
  const port = getPort();
  const server = new DaemonIpcServer();

  try {
    await server.listen({ host: '127.0.0.1', port });
    assert.ok(server.uptimeSeconds >= 0);

    await new Promise((r) => setTimeout(r, 1100));
    assert.ok(server.uptimeSeconds >= 1);
  } finally {
    await server.close();
  }
});

test('DaemonIpcServer supports streaming and JIT approval tunneling', async () => {
  const port = getPort();
  const server = new DaemonIpcServer();

  const pendingApprovals = new Map<string, (approved: boolean) => void>();

  server.onStreaming('pipeline.run_mock', async (params: any, socket) => {
    const id = 'test-jit-1';
    const approvedPromise = new Promise<boolean>((resolve) => {
      pendingApprovals.set(id, resolve);
    });
    socket.write(JSON.stringify({ type: 'jit_approval_required', id, req: { tool: 'file_write' } }) + '\n');
    const approved = await approvedPromise;
    socket.write(JSON.stringify({ type: 'pipeline_result', result: { approved } }) + '\n');
    socket.end();
  });

  server.on('pipeline.jit_response_mock', async (params: any) => {
    const resolve = pendingApprovals.get(params.id);
    if (resolve) {
      resolve(params.approved === true);
      return { success: true };
    }
    return { success: false };
  });

  try {
    await server.listen({ host: '127.0.0.1', port });

    // Connect client 1 (streaming)
    const socket1 = connect({ host: '127.0.0.1', port });
    let buffer = '';
    const events: any[] = [];

    await new Promise<void>((resolvePromise) => {
      socket1.on('connect', () => {
        socket1.write(JSON.stringify({ id: 1, method: 'pipeline.run_mock' }) + '\n');
      });

      socket1.on('data', (chunk) => {
        buffer += chunk.toString('utf-8');
        let nl: number;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          const msg = JSON.parse(line);
          events.push(msg);

          if (msg.type === 'jit_approval_required') {
            // Simulate client sending JIT response on connection 2
            const socket2 = connect({ host: '127.0.0.1', port });
            socket2.on('connect', () => {
              socket2.write(JSON.stringify({
                id: 2,
                method: 'pipeline.jit_response_mock',
                params: { id: msg.id, approved: true }
              }) + '\n');
            });
            socket2.on('data', () => {
              socket2.end();
            });
          } else if (msg.type === 'pipeline_result') {
            resolvePromise();
          }
        }
      });
    });

    assert.equal(events.length, 2);
    assert.equal(events[0].type, 'jit_approval_required');
    assert.equal(events[1].type, 'pipeline_result');
    assert.equal(events[1].result.approved, true);

  } finally {
    await server.close();
  }
});


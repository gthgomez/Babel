/**
 * daemon/ipc.ts — NDJSON transport layer over node:net
 *
 * Pure transport: creates a net.Server on the platform IPC path,
 * accepts per-request connections (one JSON line in, one JSON line out,
 * then disconnect), and dispatches to registered method handlers.
 *
 * Protocol: NDJSON (newline-delimited JSON) with minimal JSON-RPC 2.0 shape.
 * Each request: { "id": <string|number>, "method": "<string>", "params": {} }
 * Each response: { "id": <same>, "result": {}, "error": { "code": <int>, "message": "<string>" } }
 */

import { createServer, type Socket, type Server } from 'node:net';
import { existsSync, unlinkSync } from 'node:fs';
import { DAEMON_IPC_PATH, DAEMON_IPC_PORT, DAEMON_IPC_HOST, DAEMON_PROTOCOL_VERSION, DAEMON_SOCKET_TIMEOUT_MS } from './constants.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface IpcRequest {
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface IpcResponse {
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type IpcHandler = (params: unknown) => Promise<unknown>;
export type StreamingIpcHandler = (params: any, socket: Socket) => Promise<void>;

// ── Server ───────────────────────────────────────────────────────────────────

export class DaemonIpcServer {
  private server: Server | null = null;
  private handlers = new Map<string, IpcHandler>();
  private streamingHandlers = new Map<string, StreamingIpcHandler>();
  private _startedAt: number | null = null;

  /** Register a method handler. Call before listen(). */
  on(method: string, handler: IpcHandler): void {
    this.handlers.set(method, handler);
  }

  /** Register a streaming method handler. Call before listen(). */
  onStreaming(method: string, handler: StreamingIpcHandler): void {
    this.streamingHandlers.set(method, handler);
  }

  /** Start listening on the platform IPC path, or a TCP port for testing. */
  async listen(target?: { host: string; port: number }): Promise<void> {
    // Clean up stale socket file on Unix
    if (!target && process.platform !== 'win32' && existsSync(DAEMON_IPC_PATH)) {
      try {
        unlinkSync(DAEMON_IPC_PATH);
      } catch {
        /* best effort */
      }
    }

    return new Promise((resolve, reject) => {
      this.server = createServer((socket) => {
        this.handleConnection(socket);
      });

      this.server.on('error', (err: NodeJS.ErrnoException) => {
        reject(err);
      });

      if (target) {
        this.server.listen(target.port, target.host, () => {
          this._startedAt = Date.now();
          resolve();
        });
      } else if (process.platform === 'win32') {
        this.server.listen(DAEMON_IPC_PORT, DAEMON_IPC_HOST, () => {
          this._startedAt = Date.now();
          resolve();
        });
      } else {
        this.server.listen(DAEMON_IPC_PATH, () => {
          this._startedAt = Date.now();
          resolve();
        });
      }
    });
  }

  /** Gracefully close the server. */
  async close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => {
        // Clean up socket file on Unix
        if (process.platform !== 'win32' && existsSync(DAEMON_IPC_PATH)) {
          try {
            unlinkSync(DAEMON_IPC_PATH);
          } catch {
            /* best effort */
          }
        }
        resolve();
      });
    });
  }

  /** Uptime in seconds since listen() resolved. */
  get uptimeSeconds(): number {
    if (!this._startedAt) return 0;
    return Math.floor((Date.now() - this._startedAt) / 1000);
  }

  /** Whether the server is currently listening. */
  get isListening(): boolean {
    return this.server?.listening ?? false;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private handleConnection(socket: Socket): void {
    socket.setTimeout(DAEMON_SOCKET_TIMEOUT_MS);
    socket.setKeepAlive(true, 5000);
    let buffer = '';

    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf-8');

      // Process complete lines
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);

        if (!line) continue; // skip empty lines

        // Fire-and-forget: process the request and respond
        this.processRequest(line, socket).catch(() => {
          // Best-effort error response already sent in processRequest
        });
      }
    });

    socket.on('timeout', () => {
      socket.destroy();
    });

    socket.on('error', () => {
      // Connection errors are expected (client disconnects, etc.)
      socket.destroy();
    });
  }

  private async processRequest(line: string, socket: Socket): Promise<void> {
    let request: IpcRequest;

    try {
      request = JSON.parse(line);
    } catch {
      this.writeResponse(socket, {
        id: 0,
        error: { code: -32700, message: 'Parse error: invalid JSON' },
      });
      return;
    }

    if (typeof request.method !== 'string') {
      this.writeResponse(socket, {
        id: request.id ?? 0,
        error: { code: -32600, message: 'Invalid Request: missing method' },
      });
      return;
    }

    // Special: ping is always available (health check)
    if (request.method === 'ping') {
      this.writeResponse(socket, {
        id: request.id,
        result: {
          alive: true,
          version: DAEMON_PROTOCOL_VERSION,
          uptime: this.uptimeSeconds,
          pid: process.pid,
        },
      });
      return;
    }

    const handler = this.handlers.get(request.method);
    if (!handler) {
      const streamingHandler = this.streamingHandlers.get(request.method);
      if (streamingHandler) {
        socket.setTimeout(0);
        socket.setKeepAlive(true, 5000);
        try {
          await streamingHandler(request.params ?? {}, socket);
        } catch (err: any) {
          try {
            socket.write(
              JSON.stringify({
                id: request.id,
                error: {
                  code: err.code ?? -32000,
                  message: err.message ?? 'Internal streaming error',
                  data: err.data,
                },
              }) + '\n'
            );
          } catch {
            /* ignore */
          }
          socket.end();
        }
        return;
      }

      this.writeResponse(socket, {
        id: request.id,
        error: { code: -32601, message: `Method not found: ${request.method}` },
      });
      return;
    }

    try {
      const result = await handler(request.params ?? {});
      this.writeResponse(socket, { id: request.id, result });
    } catch (err: any) {
      this.writeResponse(socket, {
        id: request.id,
        error: {
          code: err.code ?? -32000,
          message: err.message ?? 'Internal error',
          data: err.data,
        },
      });
    }
  }

  private writeResponse(socket: Socket, response: IpcResponse): void {
    try {
      socket.write(JSON.stringify(response) + '\n');
    } catch {
      /* socket may already be closed */
    }
    // Per-request connection: close after response
    socket.end();
  }
}

// ── Client helpers ───────────────────────────────────────────────────────────

import { connect } from 'node:net';

export interface IpcClientOptions {
  /** Timeout in ms for the entire request-response cycle. Default 5000. */
  timeoutMs?: number;
}

/**
 * Connect to the daemon, send a single request, read the response,
 * and disconnect. Pure per-request client.
 */
export function ipcRequest(
  method: string,
  params?: Record<string, unknown>,
  options: IpcClientOptions = {},
): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? 5000;

  return new Promise((resolve, reject) => {
    const socket = process.platform === 'win32'
      ? connect(DAEMON_IPC_PORT, DAEMON_IPC_HOST)
      : connect(DAEMON_IPC_PATH);
    let buffer = '';
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(`IPC request timed out after ${timeoutMs}ms: ${method}`));
    }, timeoutMs);

    socket.on('connect', () => {
      const request: Record<string, unknown> = {
        id: Date.now(),
        method,
      };
      if (params !== undefined) {
        request['params'] = params;
      }
      socket.write(JSON.stringify(request) + '\n');
    });

    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf-8');
      const newlineIdx = buffer.indexOf('\n');
      if (newlineIdx === -1) return; // wait for complete line

      if (settled) return;
      settled = true;
      clearTimeout(timeout);

      const line = buffer.slice(0, newlineIdx).trim();
      try {
        const response = JSON.parse(line) as IpcResponse;
        if (response.error) {
          reject(new Error(response.error.message));
        } else {
          resolve(response.result);
        }
      } catch {
        reject(new Error('Invalid IPC response'));
      }
      socket.end();
    });

    socket.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`IPC connection failed: ${err.message}`));
    });

    socket.on('timeout', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      reject(new Error('IPC socket timeout'));
    });
  });
}

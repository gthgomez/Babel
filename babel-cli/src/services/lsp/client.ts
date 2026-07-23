/**
 * LSP Client — JSON-RPC 2.0 over stdio with Content-Length header framing.
 *
 * Manages communication with an LSP server process via spawn + stdin/stdout.
 * Reuses Content-Length framing patterns from ../tools/mcpTransport.ts.
 *
 * Each server process gets one LspClient instance. The client handles:
 *   - Process lifecycle (spawn, kill)
 *   - Content-Length framed message I/O
 *   - JSON-RPC 2.0 request/response matching by id
 *   - Notifications (fire-and-forget)
 *   - Error recovery and crash detection
 */

import { spawn, type ChildProcess } from 'node:child_process';

import { frameJsonRpcMessage, parseFramedMessages } from '../../tools/mcpTransport.js';
import type { InitializeParams, InitializeResult } from './types.js';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Default timeout for LSP server startup (initialize handshake). */
const DEFAULT_INIT_TIMEOUT_MS = 30_000;

/** Default timeout for LSP request round-trips. */
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

// ─── Client Interface ────────────────────────────────────────────────────────

export interface LspClient {
  /** Whether the server has completed the initialize handshake. */
  readonly isInitialized: boolean;

  /** Start the server process and prepare the I/O streams. */
  start(
    command: string,
    args: string[],
    options?: { env?: Record<string, string>; cwd?: string },
  ): Promise<void>;

  /** Perform the LSP initialize handshake and wait for initialized. */
  initialize(params: InitializeParams): Promise<InitializeResult>;

  /** Send a typed LSP request and await the response. */
  sendRequest<TResult>(method: string, params: unknown): Promise<TResult>;

  /** Send a fire-and-forget notification. */
  sendNotification(method: string, params: unknown): Promise<void>;

  /** Register a handler for server-to-client notifications. */
  onNotification(method: string, handler: (params: unknown) => void): void;

  /** Register a handler for server-to-client requests. */
  onRequest<TParams, TResult>(
    method: string,
    handler: (params: TParams) => TResult | Promise<TResult>,
  ): void;

  /** Gracefully shut down the server (shutdown + exit + kill). */
  stop(): Promise<void>;
}

// ─── Internal Helpers ────────────────────────────────────────────────────────

function generateRequestId(): number {
  return Date.now() + Math.floor(Math.random() * 100_000);
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createLspClient(
  serverName: string,
  onCrash?: (error: Error) => void,
): LspClient {
  // ─── Closure state ──────────────────────────────────────────────────────────

  let childProcess: ChildProcess | undefined;
  let isInitialized = false;
  let isStopping = false;
  let startFailed = false;
  let startError: Error | undefined;

  /** Buffer for partially received stdout data. */
  let readBuffer = Buffer.alloc(0);

  /** Pending request resolvers: Map<id, { resolve, reject, timer }>. */
  const pendingRequests = new Map<
    number | string,
    { resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();

  /** Notification handlers registered before the server starts (lazy init support). */
  const pendingNotificationHandlers: Array<{ method: string; handler: (params: unknown) => void }> = [];

  /** Request handlers registered before the server starts. */
  const pendingRequestHandlers: Array<{
    method: string;
    handler: (params: unknown) => unknown | Promise<unknown>;
  }> = [];

  /** Active notification handlers. */
  const notificationHandlers = new Map<string, Array<(params: unknown) => void>>();

  /** Active request handlers. */
  const requestHandlers = new Map<string, Array<(params: unknown) => unknown | Promise<unknown>>>();

  // ─── Internal helpers ───────────────────────────────────────────────────────

  function checkStartFailed(): void {
    if (startFailed) {
      throw startError ?? new Error(`LSP server "${serverName}" failed to start`);
    }
  }

  function drainPendingRequests(error: Error): void {
    for (const [id, pending] of pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(error);
      pendingRequests.delete(id);
    }
  }

  function handleStdoutData(chunk: Buffer): void {
    readBuffer = Buffer.concat([readBuffer, chunk]);

    try {
      const { messages, remainder } = parseFramedMessages(readBuffer);
      readBuffer = Buffer.from(remainder);

      for (const message of messages) {
        const msg = message as Record<string, unknown>;
        const id = msg['id'] as string | number | undefined | null;
        const method = msg['method'] as string | undefined;
        const hasId = id !== undefined && id !== null;
        const hasMethod = method !== undefined && typeof method === 'string';

        if (hasMethod) {
          if (hasId) {
            // Server-to-client request (JSON-RPC 2.0: has both id and method)
            const handlers = requestHandlers.get(method);
            if (handlers && handlers.length > 0) {
              handlers[0]!(msg['params']);
            }
            // Note: we don't send a response back since server-initiated
            // request handling is simplified in this implementation.
          } else {
            // Notification (JSON-RPC 2.0: method but no id)
            const handlers = notificationHandlers.get(method);
            if (handlers) {
              for (const handler of handlers) {
                try {
                  handler(msg['params']);
                } catch {
                  // Swallow handler errors in notifications
                }
              }
            }
          }
        } else if (hasId) {
          // Response to a pending client request (JSON-RPC 2.0: id but no method)
          const pending = pendingRequests.get(id);
          if (pending) {
            clearTimeout(pending.timer);
            pendingRequests.delete(id);

            if ('error' in msg && msg['error'] !== null) {
              const errMsg = (msg['error'] as Record<string, unknown>)?.message ?? 'Unknown LSP error';
              const errCode = (msg['error'] as Record<string, unknown>)?.code ?? -1;
              const error = new Error(`LSP error (${String(errCode)}): ${errMsg}`);
              (error as { code?: number }).code = errCode as number;
              pending.reject(error);
            } else {
              pending.resolve(msg['result']);
            }
          }
        }
      }
    } catch {
      // Parsing errors are logged but don't crash the client
    }
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  return {
    get isInitialized(): boolean {
      return isInitialized;
    },

    async start(
      command: string,
      args: string[],
      options?: { env?: Record<string, string>; cwd?: string },
    ): Promise<void> {
      try {
        childProcess = spawn(command, args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, ...options?.env },
          cwd: options?.cwd,
          windowsHide: true,
        });

        if (!childProcess.stdout || !childProcess.stdin) {
          throw new Error('LSP server process stdio not available');
        }

        // Wait for successful spawn (handles ENOENT)
        const spawnedProcess = childProcess;
        await new Promise<void>((resolve, reject) => {
          const onSpawn = (): void => {
            cleanup();
            resolve();
          };
          const onError = (err: Error): void => {
            cleanup();
            reject(err);
          };
          const cleanup = (): void => {
            spawnedProcess.removeListener('spawn', onSpawn);
            spawnedProcess.removeListener('error', onError);
          };
          spawnedProcess.once('spawn', onSpawn);
          spawnedProcess.once('error', onError);
        });

        // Capture stderr for diagnostics
        if (childProcess.stderr) {
          childProcess.stderr.on('data', (data: Buffer) => {
            const output = data.toString().trim();
            if (output) {
              // stderr is logged but not treated as error — many LSP servers
              // log diagnostic info to stderr during normal operation
            }
          });
        }

        // Process error handling
        childProcess.on('error', (error: Error) => {
          if (!isStopping) {
            startFailed = true;
            startError = error;
          }
        });

        childProcess.on('exit', (code, _signal) => {
          if (code !== 0 && code !== null && !isStopping) {
            isInitialized = false;
            startFailed = false;
            startError = undefined;
            const crashError = new Error(
              `LSP server "${serverName}" exited with code ${String(code)}`,
            );
            drainPendingRequests(crashError);
            onCrash?.(crashError);
          }
        });

        // Handle stdin errors gracefully
        childProcess.stdin.on('error', () => {
          // Swallow stdin errors — the connection error handler covers this
        });

        // Start reading stdout
        childProcess.stdout.on('data', handleStdoutData);
      } catch (error) {
        startFailed = true;
        startError = error instanceof Error ? error : new Error(String(error));
        throw error;
      }
    },

    async initialize(params: InitializeParams): Promise<InitializeResult> {
      checkStartFailed();

      return new Promise<InitializeResult>((resolve, reject) => {
        const id = generateRequestId();

        const timer = setTimeout(() => {
          pendingRequests.delete(id);
          reject(new Error(`LSP initialize timed out for "${serverName}"`));
        }, DEFAULT_INIT_TIMEOUT_MS);

        pendingRequests.set(id, {
          resolve: (value: unknown) => {
            isInitialized = true;
            resolve(value as InitializeResult);
          },
          reject,
          timer,
        });

        const body = JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'initialize',
          params,
        });

        if (childProcess?.stdin) {
          childProcess.stdin.write(frameJsonRpcMessage(body), (err?: Error | null) => {
            if (err) {
              clearTimeout(timer);
              pendingRequests.delete(id);
              reject(new Error(`Failed to write initialize request: ${err.message}`));
            }
          });
        } else {
          clearTimeout(timer);
          pendingRequests.delete(id);
          reject(new Error('LSP server not started'));
        }
      }).then(async (result) => {
        // Send initialized notification after successful initialize
        await this.sendNotification('initialized', {});
        return result;
      });
    },

    async sendRequest<TResult>(method: string, params: unknown): Promise<TResult> {
      checkStartFailed();

      if (!isInitialized) {
        throw new Error(`LSP server "${serverName}" not initialized`);
      }

      return new Promise<TResult>((resolve, reject) => {
        const id = generateRequestId();

        const timer = setTimeout(() => {
          pendingRequests.delete(id);
          reject(new Error(`LSP request "${method}" timed out for "${serverName}"`));
        }, DEFAULT_REQUEST_TIMEOUT_MS);

        pendingRequests.set(id, {
          resolve: (value: unknown) => resolve(value as TResult),
          reject,
          timer,
        });

        const body = JSON.stringify({
          jsonrpc: '2.0',
          id,
          method,
          params,
        });

        if (childProcess?.stdin) {
          childProcess.stdin.write(frameJsonRpcMessage(body), (err?: Error | null) => {
            if (err) {
              clearTimeout(timer);
              pendingRequests.delete(id);
              reject(new Error(`Failed to write request "${method}": ${err.message}`));
            }
          });
        } else {
          clearTimeout(timer);
          pendingRequests.delete(id);
          reject(new Error('LSP server not started'));
        }
      });
    },

    async sendNotification(method: string, params: unknown): Promise<void> {
      checkStartFailed();

      const body = JSON.stringify({
        jsonrpc: '2.0',
        method,
        params,
      });

      return new Promise<void>((resolve, reject) => {
        if (childProcess?.stdin) {
          childProcess.stdin.write(frameJsonRpcMessage(body), (err?: Error | null) => {
            if (err) {
              reject(new Error(`Failed to write notification "${method}": ${err.message}`));
            } else {
              resolve();
            }
          });
        } else {
          reject(new Error('LSP server not started'));
        }
      });
    },

    onNotification(method: string, handler: (params: unknown) => void): void {
      if (!childProcess) {
        pendingNotificationHandlers.push({ method, handler });
        return;
      }

      const handlers = notificationHandlers.get(method);
      if (handlers) {
        handlers.push(handler);
      } else {
        notificationHandlers.set(method, [handler]);
      }
    },

    onRequest<TParams, TResult>(
      method: string,
      handler: (params: TParams) => TResult | Promise<TResult>,
    ): void {
      if (!childProcess) {
        pendingRequestHandlers.push({
          method,
          handler: handler as (params: unknown) => unknown | Promise<unknown>,
        });
        return;
      }

      const handlers = requestHandlers.get(method);
      if (handlers) {
        handlers.push(handler as (params: unknown) => unknown | Promise<unknown>);
      } else {
        requestHandlers.set(method, [handler as (params: unknown) => unknown | Promise<unknown>]);
      }
    },

    async stop(): Promise<void> {
      let shutdownError: Error | undefined;

      isStopping = true;

      try {
        // Send shutdown request
        if (isInitialized) {
          await this.sendRequest('shutdown', {}).catch(() => {});
          await this.sendNotification('exit', {}).catch(() => {});
        }
      } catch (error) {
        shutdownError = error instanceof Error ? error : new Error(String(error));
      } finally {
        // Clear pending requests
        drainPendingRequests(
          new Error(`LSP server "${serverName}" shutting down`),
        );

        // Kill the process
        if (childProcess) {
          childProcess.removeAllListeners('error');
          childProcess.removeAllListeners('exit');
          if (childProcess.stdin) {
            childProcess.stdin.removeAllListeners('error');
          }
          if (childProcess.stdout) {
            childProcess.stdout.removeAllListeners('data');
          }
          if (childProcess.stderr) {
            childProcess.stderr.removeAllListeners('data');
          }

          try {
            childProcess.kill();
          } catch {
            // Process may already be dead
          }
          childProcess = undefined;
        }

        isInitialized = false;
        isStopping = false;
      }

      if (shutdownError) {
        throw shutdownError;
      }
    },
  };
}

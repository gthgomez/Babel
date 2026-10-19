import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';

import {
  buildInitializeParams,
  parseInitializeResult,
  type AcpNegotiatedCodec,
} from './commandCodeAcpNegotiation.js';
import {
  isCommandCodeNotification,
  isCommandCodeRequest,
  parseCommandCodeLine,
  serializeCommandCodeLine,
  type CommandCodeWireMessage,
} from './commandCodeProtocol.js';

export interface CommandCodeAcpSpawnOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  maxLineBytes?: number;
  rpcTimeoutMs?: number;
}

export type CommandCodePermissionHandler = (input: {
  sessionId: string;
  requestId: string | number;
  params: Record<string, unknown>;
}) => Promise<{ outcome: 'selected'; optionId: string } | { outcome: 'cancelled' }>;

export type CommandCodeSessionUpdateHandler = (update: {
  sessionId: string;
  update: Record<string, unknown>;
}) => void;

export type CommandCodeProcessExitHandler = (detail: { code: number | null; signal: NodeJS.Signals | null }) => void;

export class CommandCodeAcpTransport {
  private child: ChildProcessWithoutNullStreams | null = null;
  private reader: Interface | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    string | number,
    { resolve: (msg: CommandCodeWireMessage) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
  >();
  private readonly runtimeInstanceId: number;
  private closed = false;
  private initialized = false;
  private codec: AcpNegotiatedCodec | null = null;
  private stdoutRemainder = '';
  private onProcessExit: CommandCodeProcessExitHandler | null = null;

  constructor(
    private readonly options: CommandCodeAcpSpawnOptions,
    runtimeInstanceId: number,
    private readonly onSessionUpdate?: CommandCodeSessionUpdateHandler,
    private readonly onPermissionRequest?: CommandCodePermissionHandler,
  ) {
    this.runtimeInstanceId = runtimeInstanceId;
  }

  get processRuntimeInstanceId(): number {
    return this.runtimeInstanceId;
  }

  negotiatedCodec(): AcpNegotiatedCodec | null {
    return this.codec;
  }

  setProcessExitHandler(handler: CommandCodeProcessExitHandler | null): void {
    this.onProcessExit = handler;
  }

  async start(): Promise<AcpNegotiatedCodec> {
    if (this.codec) return this.codec;
    const child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: this.options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    child.on('error', (error) => {
      this.closed = true;
      for (const [id, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(error instanceof Error ? error : new Error(String(error)));
        this.pending.delete(id);
      }
      this.onProcessExit?.({ code: null, signal: null });
    });
    child.stdout.on('data', (chunk: Buffer) => {
      this.ingestStdout(chunk.toString('utf8'));
    });
    child.stderr.on('data', () => {
      /* vendor diagnostics only */
    });
    child.once('exit', (code, signal) => {
      this.closed = true;
      for (const [id, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error(`COMMAND_CODE_ACP_PROCESS_EXIT:${id}`));
        this.pending.delete(id);
      }
      this.onProcessExit?.({ code, signal });
    });
    let negotiated: AcpNegotiatedCodec | null = null;
    try {
      const result = await this.call('initialize', buildInitializeParams(1));
      negotiated = parseInitializeResult(result);
    } catch {
      negotiated = null;
    }
    if (!negotiated) {
      await this.stop();
      throw new Error('ACP_INITIALIZE_FAILED');
    }
    this.codec = negotiated;
    this.initialized = true;
    return negotiated;
  }

  private ingestStdout(chunk: string): void {
    const maxBytes = this.options.maxLineBytes ?? 512_000;
    this.stdoutRemainder += chunk;
    if (Buffer.byteLength(this.stdoutRemainder, 'utf8') > maxBytes) {
      void this.stop();
      return;
    }
    for (;;) {
      const newline = this.stdoutRemainder.indexOf('\n');
      if (newline < 0) break;
      const line = this.stdoutRemainder.slice(0, newline);
      this.stdoutRemainder = this.stdoutRemainder.slice(newline + 1);
      void this.handleLine(line);
    }
  }

  async stop(): Promise<void> {
    this.closed = true;
    if (this.reader) {
      this.reader.close();
      this.reader = null;
    }
    if (this.child) {
      const child = this.child;
      this.child = null;
      if (!child.killed) {
        child.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            try {
              child.kill('SIGKILL');
            } catch {
              /* ignore */
            }
            resolve();
          }, 2_000);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    }
  }

  async call(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.closed) throw new Error('COMMAND_CODE_ACP_TRANSPORT_CLOSED');
    if (!this.child?.stdin.writable) throw new Error('COMMAND_CODE_ACP_STDIN_UNAVAILABLE');
    const id = this.nextId++;
    const message: CommandCodeWireMessage = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params ? { params } : {}),
    };
    const line = serializeCommandCodeLine(message);
    if (Buffer.byteLength(line, 'utf8') > (this.options.maxLineBytes ?? 512_000)) {
      throw new Error('COMMAND_CODE_ACP_REQUEST_TOO_LARGE');
    }
    const requestId: string | number = id;
    const response = await new Promise<CommandCodeWireMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        if (method === 'session/prompt') {
          void this.stop();
        }
        reject(new Error(`COMMAND_CODE_ACP_RPC_TIMEOUT:${method}`));
      }, method === 'session/prompt' ? 600_000 : this.options.rpcTimeoutMs ?? 30_000);
      this.pending.set(requestId, { resolve, reject, timer });
      this.child!.stdin.write(line);
    });
    if (response.error) {
      const data = response.error.data;
      throw new Error(
        `COMMAND_CODE_ACP_ERROR:${response.error.code}:${response.error.message}:${JSON.stringify(data ?? null)}`,
      );
    }
    return response.result ?? {};
  }

  notify(method: string, params?: Record<string, unknown>): void {
    if (this.closed) throw new Error('COMMAND_CODE_ACP_TRANSPORT_CLOSED');
    if (!this.child?.stdin.writable) throw new Error('COMMAND_CODE_ACP_STDIN_UNAVAILABLE');
    const message: CommandCodeWireMessage = {
      jsonrpc: '2.0',
      method,
      ...(params ? { params } : {}),
    };
    const line = serializeCommandCodeLine(message);
    this.child.stdin.write(line);
  }

  private async handleLine(line: string): Promise<void> {
    if (this.closed) return;
    const maxBytes = this.options.maxLineBytes ?? 512_000;
    if (Buffer.byteLength(line, 'utf8') > maxBytes) {
      await this.stop();
      return;
    }
    let message: CommandCodeWireMessage;
    try {
      message = parseCommandCodeLine(line);
    } catch {
      await this.stop();
      return;
    }

    if (message.id !== undefined && message.id !== null && (message.result !== undefined || message.error)) {
      const pending = this.pending.get(message.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        pending.resolve(message);
      }
      return;
    }

    if (isCommandCodeRequest(message) && message.method === 'session/request_permission') {
      const handler = this.onPermissionRequest;
      if (!handler || message.id === undefined || message.id === null) return;
      const params = message.params ?? {};
      const sessionId = String(params.sessionId ?? '');
      const requestId = message.id;
      try {
        const decision = await handler({ sessionId, requestId, params });
        const response: CommandCodeWireMessage = {
          jsonrpc: '2.0',
          id: message.id,
          result: {
            outcome:
              decision.outcome === 'cancelled'
                ? { outcome: 'cancelled' }
                : { outcome: 'selected', optionId: decision.optionId },
          },
        };
        this.child?.stdin.write(serializeCommandCodeLine(response));
      } catch {
        const response: CommandCodeWireMessage = {
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32603, message: 'permission handler failed' },
        };
        this.child?.stdin.write(serializeCommandCodeLine(response));
      }
      return;
    }

    if (isCommandCodeNotification(message) && message.method === 'session/update') {
      const params = message.params ?? {};
      const sessionId = String(params.sessionId ?? '');
      const update = params.update;
      if (sessionId && update && typeof update === 'object') {
        this.onSessionUpdate?.({ sessionId, update: update as Record<string, unknown> });
      }
    }
  }

  isInitialized(): boolean {
    return this.initialized;
  }
}

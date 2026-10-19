import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';

import {
  COMMAND_CODE_ACP_PROTOCOL_VERSION,
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

export class CommandCodeAcpTransport {
  private child: ChildProcessWithoutNullStreams | null = null;
  private reader: Interface | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    string | number,
    { resolve: (msg: CommandCodeWireMessage) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
  >();
  private generation = 0;
  private closed = false;
  private initialized = false;
  private negotiatedProtocolVersion: number | null = null;

  constructor(
    private readonly options: CommandCodeAcpSpawnOptions,
    private readonly onSessionUpdate?: CommandCodeSessionUpdateHandler,
    private readonly onPermissionRequest?: CommandCodePermissionHandler,
  ) {}

  get processGeneration(): number {
    return this.generation;
  }

  async start(): Promise<void> {
    if (this.child) return;
    this.generation += 1;
    const child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: this.options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    this.reader = createInterface({ input: child.stdout });
    this.reader.on('line', (line) => {
      void this.handleLine(line);
    });
    child.stderr.on('data', () => {
      /* diagnostics only; never treat as protocol */
    });
    child.once('exit', () => {
      this.closed = true;
      for (const [id, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error(`COMMAND_CODE_ACP_PROCESS_EXIT:${id}`));
        this.pending.delete(id);
      }
    });
    await this.call('initialize', {
      protocolVersion: COMMAND_CODE_ACP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'babel-protocol-host', version: '1' },
    });
    this.initialized = true;
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
        reject(new Error(`COMMAND_CODE_ACP_RPC_TIMEOUT:${method}`));
      }, this.options.rpcTimeoutMs ?? 30_000);
      this.pending.set(requestId, { resolve, reject, timer });
      this.child!.stdin.write(line);
    });
    if (response.error) {
      throw new Error(`COMMAND_CODE_ACP_ERROR:${response.error.code}:${response.error.message}`);
    }
    if (method === 'initialize' && response.result) {
      const version = response.result.protocolVersion;
      if (typeof version === 'number') this.negotiatedProtocolVersion = version;
    }
    return response.result ?? {};
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
        const decision = await handler({
          sessionId,
          requestId,
          params,
        });
        const response: CommandCodeWireMessage = {
          jsonrpc: '2.0',
          id: message.id,
          result: {
            outcome:
              decision.outcome === 'cancelled'
                ? { type: 'cancelled' }
                : { type: 'selected', optionId: decision.optionId },
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

  negotiatedVersion(): number | null {
    return this.negotiatedProtocolVersion;
  }

  isInitialized(): boolean {
    return this.initialized;
  }
}

export function resolveCommandCodeAcpLaunch(): { command: string; args: string[] } {
  const command =
    process.env['BABEL_COMMAND_CODE_ACP_COMMAND']?.trim() ??
    process.env['BABEL_COMMAND_CODE_CLI_EXECUTABLE']?.trim();
  if (command) {
    const rawArgs = process.env['BABEL_COMMAND_CODE_ACP_ARGS']?.trim();
    if (rawArgs) {
      const parsed = JSON.parse(rawArgs) as string[];
      return { command, args: parsed };
    }
    return { command, args: ['acp'] };
  }
  const executable = process.env['BABEL_COMMAND_CODE_CLI_EXECUTABLE']?.trim();
  if (executable) return { command: executable, args: ['acp'] };
  return { command: 'cmd', args: ['acp'] };
}

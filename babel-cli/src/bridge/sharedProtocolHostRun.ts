/**
 * Canonical CLI execution path for Desktop/PWA shared protocol-host chat turns.
 * Emits stream-json events on the provided writer (same vocabulary as `babel run`).
 */

import { readFileSync } from 'node:fs';
import { createInterface, type Interface } from 'node:readline';
import { join } from 'node:path';

import {
  computeDesktopControllerProof,
  DESKTOP_CLIENT_ID_HEADER,
  DESKTOP_PROOF_HEADER,
} from './desktopControllerAuth.js';
import { HttpProtocolClient } from './httpProtocolClient.js';

export interface SharedProtocolHostRunOptions {
  port: number;
  projectRoot: string;
  task: string;
  runId: string;
  resumeThreadId?: string;
  model?: string;
  provider?: string;
  desktopClientId: string;
  desktopProofKey: string;
  commandId?: string;
  fetchImpl?: typeof fetch;
  WebSocketImpl?: typeof WebSocket;
  signal?: AbortSignal;
  stdin?: NodeJS.ReadableStream;
}

type NdjsonWriter = (event: Record<string, unknown>) => void;

function desktopHeaders(clientId: string, proofKey: string): Record<string, string> {
  return {
    [DESKTOP_CLIENT_ID_HEADER]: clientId,
    [DESKTOP_PROOF_HEADER]: computeDesktopControllerProof(proofKey, clientId),
  };
}

function loadHostEmergencyBearerToken(): string | undefined {
  const fromEnv = process.env['BABEL_BRIDGE_HOST_EMERGENCY_TOKEN']?.trim();
  if (fromEnv) return fromEnv;
  const configDir = process.env['BABEL_CONFIG_DIR']?.trim();
  if (!configDir) return undefined;
  try {
    const raw = readFileSync(join(configDir, 'bridge.json'), 'utf8');
    const parsed = JSON.parse(raw) as { authToken?: string };
    return typeof parsed.authToken === 'string' && parsed.authToken ? parsed.authToken : undefined;
  } catch {
    return undefined;
  }
}

async function cancelTurnDesktop(
  client: HttpProtocolClient,
  threadId: string,
  controlEpoch: number,
): Promise<void> {
  await client.call('turn.cancel', {
    thread_id: threadId,
    control_epoch: controlEpoch,
  });
}

/** Distinct local-admin emergency stop — never invoked from ordinary cancel. */
async function emergencyAdminStopTurn(
  port: number,
  threadId: string,
  hostEmergencyToken: string,
  fetchImpl?: typeof fetch,
): Promise<void> {
  const emergency = new HttpProtocolClient({
    baseUrl: `http://127.0.0.1:${port}`,
    bearerToken: hostEmergencyToken,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  await emergency.call('control.acquire', { thread_id: threadId, force: true });
  await emergency.call('turn.cancel', { thread_id: threadId });
}

function mapTurnEventToStream(
  event: Record<string, unknown>,
  threadId: string,
): Record<string, unknown> | null {
  switch (event.type) {
    case 'answer_chunk':
      return { type: 'assistant_chunk', chunk: event.text ?? '' };
    case 'thought':
    case 'thinking':
      return { type: 'thought', line: event.text ?? '' };
    case 'tool_start':
      return {
        type: 'tool.started',
        item: { id: event.toolCallId ?? event.tool, tool: event.tool, target: event.target },
      };
    case 'tool_complete':
    case 'tool_failed':
      return {
        type: event.type === 'tool_failed' ? 'tool.failed' : 'tool.completed',
        item: {
          id: event.toolCallId ?? event.tool,
          tool: event.tool,
          target: event.target,
          detail: event.detail,
          exit_code: event.exitCode,
        },
      };
    case 'file_changed':
      return {
        type: 'file.changed',
        item: { path: event.path, additions: event.additions, deletions: event.deletions },
      };
    case 'done':
      return {
        type: 'run_complete',
        result: {
          session_id: threadId,
          answer: event.answer,
          usage: event.usage,
          terminal_outcome: event.outcome ?? 'COMPLETED',
          user_status: event.status ?? 'completed',
        },
      };
    case 'failed':
      return { type: 'run_error', error: event.error ?? 'Turn failed' };
    case 'cancelled':
      return { type: 'cancelled' };
    default:
      return null;
  }
}

/** Map real `permission.request` broker frames (flat params) to Desktop stream-json. */
export function mapPermissionRequest(
  params: Record<string, unknown>,
  runId: string,
): Record<string, unknown> | null {
  const approvalId = typeof params.approval_id === 'string' ? params.approval_id : '';
  const operationDigest =
    typeof params.operation_digest === 'string' ? params.operation_digest : '';
  const expiresAt = typeof params.expires_at === 'string' ? params.expires_at : '';
  const threadId = typeof params.thread_id === 'string' ? params.thread_id : '';
  const turnId = typeof params.turn_id === 'string' ? params.turn_id : '';
  if (!approvalId || !operationDigest || !expiresAt || !threadId || !turnId) return null;
  const command =
    typeof params.command === 'string'
      ? params.command
      : typeof params.action_type === 'string'
        ? params.action_type
        : typeof params.permission === 'string'
          ? params.permission
          : undefined;
  return {
    type: 'approval.required',
    message: 'Babel is waiting for approval.',
    item: {
      command,
      cwd: params.cwd,
      details: params.reason,
      approval: {
        schemaVersion: 2,
        request_id: approvalId,
        thread_id: threadId,
        turn_id: turnId,
        operation_digest: operationDigest,
        run_id: runId,
        expires_at: expiresAt,
      },
    },
  };
}

/** Run one shared-host chat turn to completion. Returns process exit code. */
export async function executeSharedProtocolHostRun(
  options: SharedProtocolHostRunOptions,
  write: NdjsonWriter,
): Promise<number> {
  const baseUrl = `http://127.0.0.1:${options.port}`;
  const client = new HttpProtocolClient({
    baseUrl,
    desktopClientId: options.desktopClientId,
    desktopProofKey: options.desktopProofKey,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  const headers = desktopHeaders(options.desktopClientId, options.desktopProofKey);
  const WebSocketCtor = options.WebSocketImpl ?? globalThis.WebSocket;
  if (!WebSocketCtor) throw new Error('WebSocket is unavailable');

  let threadId = options.resumeThreadId ?? '';
  let turnSettled = false;
  let transportClosedUnexpectedly = false;
  let ws: WebSocket | null = null;
  let cancelRequested = false;
  let pendingApproval: Record<string, unknown> | null = null;
  let activeThreadId = threadId;
  let controlEpoch = 0;
  let stdinInterface: Interface | null = null;

  const abort = () => options.signal?.aborted === true || cancelRequested;

  const closeStdinInterface = () => {
    if (!stdinInterface) return;
    try {
      stdinInterface.close();
    } catch {
      /* ignore */
    }
    stdinInterface = null;
  };

  write({ type: 'run_start' });
  if (abort()) {
    write({ type: 'cancelled' });
    return 0;
  }

  try {
    if (
      threadId &&
      (options.model !== undefined || options.provider !== undefined)
    ) {
      throw new Error(
        'Resumed shared threads keep their existing route; change the model in Settings only when starting a new conversation.',
      );
    }

    const transportSessionId = await client.createTransportSession(options.projectRoot);
    if (threadId) {
      await client.call('thread.resume', { thread_id: threadId, session_id: transportSessionId });
    } else {
      const provider =
        options.provider ?? process.env['BABEL_DESKTOP_PROVIDER'] ?? process.env['BABEL_PROVIDER'];
      const model =
        options.model ??
        process.env['BABEL_DESKTOP_MODEL_ROUTE'] ??
        process.env['BABEL_MODEL'];
      const created = await client.call<
        'thread.create',
        Record<string, unknown>,
        { thread_id: string }
      >('thread.create', {
        project_root: options.projectRoot,
        session_id: transportSessionId,
        task: options.task,
        mode: 'chat',
        ...(model ? { model } : {}),
        ...(provider ? { provider } : {}),
      });
      threadId = created.thread_id;
    }
    activeThreadId = threadId;

    const lease = await client.call<
      'control.acquire',
      { thread_id: string; force: boolean },
      { epoch: number }
    >('control.acquire', { thread_id: threadId, force: false });
    controlEpoch = lease.epoch;

    if (options.stdin?.readable) {
      stdinInterface = createInterface({ input: options.stdin });
      stdinInterface.on('line', (line) => {
        void (async () => {
          try {
            const msg = JSON.parse(line) as {
              decision?: string;
              approval?: Record<string, unknown>;
              host_emergency_token?: string;
            };
            if (msg.decision === 'emergency_admin_stop') {
              const token =
                typeof msg.host_emergency_token === 'string'
                  ? msg.host_emergency_token.trim()
                  : '';
              const expected = loadHostEmergencyBearerToken();
              if (!expected || token !== expected) {
                write({
                  type: 'run_error',
                  error: 'Host emergency stop was rejected (invalid admin token)',
                });
                return;
              }
              try {
                await emergencyAdminStopTurn(
                  options.port,
                  activeThreadId,
                  token,
                  options.fetchImpl,
                );
                write({ type: 'emergency_stop' });
              } catch (error) {
                write({
                  type: 'run_error',
                  error:
                    error instanceof Error
                      ? error.message
                      : 'Host emergency stop failed',
                });
              }
              return;
            }
            if (msg.decision === 'cancel') {
              cancelRequested = true;
              try {
                await cancelTurnDesktop(client, activeThreadId, controlEpoch);
                write({ type: 'cancelled' });
              } catch (error) {
                write({
                  type: 'run_error',
                  error:
                    error instanceof Error
                      ? error.message
                      : 'Cancel was rejected by the shared protocol host',
                });
              }
              return;
            }
            if (msg.decision && msg.approval && pendingApproval) {
              const binding = msg.approval;
              const expected = pendingApproval;
              const matches =
                binding.request_id === expected.request_id &&
                binding.thread_id === expected.thread_id &&
                binding.turn_id === expected.turn_id &&
                binding.operation_digest === expected.operation_digest &&
                binding.run_id === expected.run_id;
              if (!matches) {
                write({
                  type: 'run_error',
                  error: 'Approval decision did not match the pending request',
                });
                return;
              }
              try {
                await client.call('approval.decide', {
                  approval_id: String(expected.request_id),
                  decision: msg.decision,
                  thread_id: String(expected.thread_id),
                  turn_id: String(expected.turn_id),
                  operation_digest: String(expected.operation_digest),
                  control_epoch: controlEpoch,
                });
                pendingApproval = null;
              } catch (error) {
                write({
                  type: 'run_error',
                  error:
                    error instanceof Error
                      ? error.message
                      : 'Approval decision was rejected by the shared protocol host',
                });
              }
            }
          } catch {
            /* ignore non-json stdin */
          }
        })();
      });
    }

    if (abort()) {
      try {
        await cancelTurnDesktop(client, threadId, controlEpoch);
        write({ type: 'cancelled' });
        return 0;
      } catch (error) {
        write({
          type: 'run_error',
          error: error instanceof Error ? error.message : 'Cancel was rejected',
        });
        return 1;
      }
    }

    const ticketRes = await (options.fetchImpl ?? fetch)(`${baseUrl}/ws/ticket`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: transportSessionId, thread_id: threadId }),
    });
    const ticketBody = (await ticketRes.json()) as { ticket?: string };
    if (!ticketRes.ok || !ticketBody.ticket) {
      throw new Error('Failed to mint WebSocket ticket');
    }

    ws = new WebSocketCtor(
      `ws://127.0.0.1:${options.port}/ws?sessionId=${encodeURIComponent(transportSessionId)}&ticket=${encodeURIComponent(ticketBody.ticket)}`,
    );
    await new Promise<void>((resolve, reject) => {
      ws!.addEventListener('open', () => resolve());
      ws!.addEventListener('error', () => reject(new Error('WebSocket connection failed')));
    });

    const turnDone = new Promise<void>((resolve, reject) => {
      const onMessage = (event: MessageEvent) => {
        try {
          const message = JSON.parse(String(event.data)) as Record<string, unknown>;
          if (message.method === 'turn.event') {
            const params = message.params as Record<string, unknown> | undefined;
            const ev = params?.event as Record<string, unknown> | undefined;
            if (ev) {
              const mapped = mapTurnEventToStream(ev, threadId);
              if (mapped) write(mapped);
              if (['done', 'failed', 'cancelled'].includes(String(ev.type))) {
                turnSettled = true;
                resolve();
              }
            }
          } else if (message.method === 'permission.request') {
            const params = message.params as Record<string, unknown>;
            const mapped = mapPermissionRequest(params, options.runId);
            if (mapped?.item && typeof mapped.item === 'object') {
              const item = mapped.item as { approval?: Record<string, unknown> };
              if (item.approval) pendingApproval = item.approval;
            }
            if (mapped) write(mapped);
          }
        } catch {
          /* ignore malformed frames */
        }
      };
      const onClose = () => {
        if (!turnSettled) {
          transportClosedUnexpectedly = true;
          reject(new Error('Transport closed before turn settled'));
        }
      };
      ws!.addEventListener('message', onMessage as EventListener);
      ws!.addEventListener('close', onClose as EventListener);
    });

    if (abort()) {
      try {
        await cancelTurnDesktop(client, threadId, controlEpoch);
        write({ type: 'cancelled' });
        return 0;
      } catch (error) {
        write({
          type: 'run_error',
          error: error instanceof Error ? error.message : 'Cancel was rejected',
        });
        return 1;
      }
    }

    await client.call('turn.submit', {
      thread_id: threadId,
      message: options.task,
      control_epoch: lease.epoch,
      ...(options.commandId ? { command_id: options.commandId } : {}),
    });

    await turnDone;
    if (transportClosedUnexpectedly) {
      if (pendingApproval) {
        write({
          type: 'approval.pending',
          message: 'Approval is still pending after transport loss; reconnect before deciding.',
          item: { approval: pendingApproval },
        });
      }
      write({ type: 'run_error', error: 'Shared protocol transport lost before turn settled' });
      return 1;
    }
    return 0;
  } catch (err) {
    if (!turnSettled) {
      write({
        type: 'run_error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return 1;
  } finally {
    closeStdinInterface();
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
  }
}

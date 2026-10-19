/**
 * Canonical CLI execution path for Desktop/PWA shared protocol-host chat turns.
 * Emits stream-json events on the provided writer (same vocabulary as `babel run`).
 */

import { createInterface } from 'node:readline';

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

function mapPermissionRequest(params: Record<string, unknown>): Record<string, unknown> | null {
  const permission = params.permission as Record<string, unknown> | undefined;
  if (!permission) return null;
  return {
    type: 'approval.required',
    message: 'Babel is waiting for approval.',
    item: {
      command: permission.action_type,
      cwd: permission.cwd,
      details: permission.detail,
      approval: {
        schemaVersion: 2,
        request_id: permission.approval_id,
        thread_id: params.thread_id,
        turn_id: params.turn_id,
        operation_digest: permission.operation_digest,
        run_id: params.run_id ?? 'shared-protocol',
        expires_at: permission.expires_at,
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
  let pendingApprovalId: string | null = null;
  let activeThreadId = threadId;

  const abort = () => options.signal?.aborted === true || cancelRequested;

  write({ type: 'run_start' });
  if (abort()) {
    write({ type: 'cancelled' });
    return 0;
  }

  try {
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

    if (options.stdin?.readable) {
      const rl = createInterface({ input: options.stdin });
      rl.on('line', (line) => {
        try {
          const msg = JSON.parse(line) as {
            decision?: string;
            approval?: Record<string, unknown>;
          };
          if (msg.decision === 'cancel') {
            cancelRequested = true;
            void client.call('turn.cancel', { thread_id: activeThreadId }).catch(() => undefined);
            return;
          }
          if (msg.decision && msg.approval && pendingApprovalId) {
            void client
              .call('approval.decide', {
                approval_id: pendingApprovalId,
                decision: msg.decision,
                thread_id: activeThreadId,
                turn_id: String(msg.approval.turn_id ?? ''),
                ...(typeof msg.approval.operation_digest === 'string'
                  ? { operation_digest: msg.approval.operation_digest }
                  : {}),
              })
              .catch(() => undefined);
            pendingApprovalId = null;
          }
        } catch {
          /* ignore non-json stdin */
        }
      });
    }

    const lease = await client.call<
      'control.acquire',
      { thread_id: string; force: boolean },
      { epoch: number }
    >('control.acquire', { thread_id: threadId, force: false });

    if (abort()) {
      await client.call('turn.cancel', { thread_id: threadId }).catch(() => undefined);
      write({ type: 'cancelled' });
      return 0;
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
      `ws://127.0.0.1:${options.port}/ws?ticket=${encodeURIComponent(ticketBody.ticket)}`,
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
            const permission = params.permission as Record<string, unknown> | undefined;
            if (permission && typeof permission.approval_id === 'string') {
              pendingApprovalId = permission.approval_id;
            }
            const mapped = mapPermissionRequest(params);
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
      await client.call('turn.cancel', { thread_id: threadId }).catch(() => undefined);
      write({ type: 'cancelled' });
      return 0;
    }

    await client.call('turn.submit', {
      thread_id: threadId,
      message: options.task,
      control_epoch: lease.epoch,
      ...(options.commandId ? { command_id: options.commandId } : {}),
    });

    await turnDone;
    if (transportClosedUnexpectedly) {
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
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
  }
}

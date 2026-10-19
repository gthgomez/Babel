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
import type { RemoteCatalogResult } from './remoteCatalog.js';
import type { HistoryLookupResult, TurnTerminalRecord } from '../protocol/types.js';

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
  /** Per-RPC ceiling while observing emergency-stop terminal evidence (default 4s). */
  observationRpcTimeoutMs?: number;
  /** Wall-clock ceiling after emergency ACK before observation fails closed (default 15s). */
  emergencyObservationDeadlineMs?: number;
  /** Active-turn reconcile passes without terminal before observation fails closed (default 12). */
  emergencyObservationPassLimit?: number;
  /**
   * Clock for emergency-observation deadlines and per-op RPC timers only.
   * Production uses wall time; tests may inject a manual scheduler without changing timeout policy.
   */
  emergencyObservationClock?: SharedProtocolHostRunClock;
  /** When set, thread.create binds the matching own-CLI harness adapter. */
  harnessAdapterId?: 'command-code' | 'opencode' | 'babel-native';
}

/** Wall-clock and timers used for post-emergency-ACK observation bounds. */
export interface SharedProtocolHostRunClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realSharedProtocolHostRunClock: SharedProtocolHostRunClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

type ManualEmergencyTimer = { id: number; at: number; callback: () => void };

/**
 * Deterministic emergency-observation clock for tests. Time advances only via `advance`.
 */
export function createManualSharedProtocolHostRunClock(initialNow = 1_000_000): {
  clock: SharedProtocolHostRunClock;
  advance: (deltaMs: number) => Promise<void>;
} {
  let nowMs = initialNow;
  let nextTimerId = 1;
  const timers = new Map<number, ManualEmergencyTimer>();

  const drainDueTimers = (): void => {
    for (;;) {
      const due = [...timers.values()]
        .filter((entry) => entry.at <= nowMs)
        .sort((a, b) => a.at - b.at);
      if (due.length === 0) return;
      for (const entry of due) {
        timers.delete(entry.id);
        entry.callback();
      }
    }
  };

  const clock: SharedProtocolHostRunClock = {
    now: () => nowMs,
    setTimeout: (callback, delayMs) => {
      const id = nextTimerId++;
      timers.set(id, { id, at: nowMs + delayMs, callback });
      return id;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
  };

  const advance = async (deltaMs: number): Promise<void> => {
    nowMs += deltaMs;
    drainDueTimers();
    await new Promise<void>((resolve) => setImmediate(resolve));
    drainDueTimers();
  };

  return { clock, advance };
}

type NdjsonWriter = (event: Record<string, unknown>) => void;

function emergencyHostRunTrace(
  stage: string,
  detail?: Record<string, unknown>,
): void {
  if (process.env['BABEL_HOST_RUN_EMERGENCY_TRACE'] !== '1') return;
  process.stderr.write(
    `${JSON.stringify({
      type: 'host_run.emergency_trace',
      stage,
      ts: Date.now(),
      ...detail,
    })}\n`,
  );
}

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
          terminal_outcome:
            event.fixture_execution === true
              ? 'UNVERIFIED_PATCH'
              : (event.outcome ?? 'COMPLETED'),
          user_status: event.fixture_execution === true ? 'fixture' : (event.status ?? 'completed'),
          ...(event.fixture_execution === true ? { fixture_execution: true } : {}),
          ...(typeof event.fixture_kind === 'string' ? { fixture_kind: event.fixture_kind } : {}),
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

function normalizeRouteToken(value: string): string {
  return value.trim().toLowerCase();
}

function requestedRoute(options: SharedProtocolHostRunOptions): {
  provider?: string;
  model?: string;
} {
  const provider =
    options.provider ?? process.env['BABEL_DESKTOP_PROVIDER'] ?? process.env['BABEL_PROVIDER'];
  const model =
    options.model ??
    process.env['BABEL_DESKTOP_MODEL_ROUTE'] ??
    process.env['BABEL_MODEL'];
  return {
    ...(typeof provider === 'string' && provider ? { provider } : {}),
    ...(typeof model === 'string' && model ? { model } : {}),
  };
}

export function assertResumeRouteCompatible(
  saved: { provider?: string; model?: string },
  requested: { provider?: string; model?: string },
): void {
  if (requested.provider !== undefined && saved.provider !== undefined) {
    if (normalizeRouteToken(requested.provider) !== normalizeRouteToken(saved.provider)) {
      throw new Error(
        'The requested provider does not match this conversation. Start a new conversation to change provider.',
      );
    }
  }
  if (requested.model !== undefined && saved.model !== undefined) {
    if (normalizeRouteToken(requested.model) !== normalizeRouteToken(saved.model)) {
      throw new Error(
        'The requested model does not match this conversation. Start a new conversation to change model.',
      );
    }
  }
}

function writeControlRejected(write: NdjsonWriter, operation: string, error: string): void {
  write({ type: 'control.rejected', operation, error });
}

async function lookupAuthoritativePendingApproval(
  client: HttpProtocolClient,
  threadId: string,
  runId: string,
  turnId?: string,
  rpcOptions?: { signal?: AbortSignal },
): Promise<Record<string, unknown> | null> {
  const result = await client.call<
    'approval.lookup',
    { thread_id: string; turn_id?: string },
    { pending: Array<Record<string, unknown>> }
  >(
    'approval.lookup',
    {
      thread_id: threadId,
      ...(turnId ? { turn_id: turnId } : {}),
    },
    Date.now(),
    rpcOptions,
  );
  const record = result.pending.find((item) => item.state === 'pending');
  if (!record) return null;
  const mapped = mapPermissionRequest(
    {
      approval_id: String(record.approval_id ?? ''),
      thread_id: String(record.thread_id ?? ''),
      turn_id: String(record.turn_id ?? ''),
      operation_digest: String(record.operation_digest ?? ''),
      expires_at: String(record.expires_at ?? ''),
      ...(typeof record.command === 'string' ? { command: record.command } : {}),
      ...(typeof record.cwd === 'string' ? { cwd: record.cwd } : {}),
      ...(typeof record.reason === 'string' ? { reason: record.reason } : {}),
    },
    runId,
  );
  const item = mapped?.item as
    | {
        approval?: Record<string, unknown>;
        command?: string;
        cwd?: string;
        details?: string;
      }
    | undefined;
  if (!item?.approval) return null;
  return {
    ...item.approval,
    ...(typeof item.command === 'string' ? { command: item.command } : {}),
    ...(typeof item.cwd === 'string' ? { cwd: item.cwd } : {}),
    ...(typeof item.details === 'string' ? { reason: item.details } : {}),
  };
}

/** Build broker lookup params preserving authoritative operation presentation. */
export function permissionParamsFromPendingApproval(
  authoritative: Record<string, unknown>,
): Record<string, unknown> {
  return {
    approval_id: String(authoritative.request_id),
    thread_id: String(authoritative.thread_id),
    turn_id: String(authoritative.turn_id),
    operation_digest: String(authoritative.operation_digest),
    expires_at: String(authoritative.expires_at),
    ...(typeof authoritative.command === 'string' ? { command: authoritative.command } : {}),
    ...(typeof authoritative.cwd === 'string' ? { cwd: authoritative.cwd } : {}),
    ...(typeof authoritative.reason === 'string' ? { reason: authoritative.reason } : {}),
    ...(typeof authoritative.action_type === 'string'
      ? { action_type: authoritative.action_type }
      : {}),
    ...(typeof authoritative.target_path === 'string'
      ? { target_path: authoritative.target_path }
      : {}),
  };
}

function approvalItemFromAuthoritative(
  authoritative: Record<string, unknown>,
): Record<string, unknown> {
  return {
    approval: authoritative,
    ...(typeof authoritative.command === 'string' ? { command: authoritative.command } : {}),
    ...(typeof authoritative.cwd === 'string' ? { cwd: authoritative.cwd } : {}),
    ...(typeof authoritative.reason === 'string' ? { details: authoritative.reason } : {}),
  };
}

async function lookupCatalogSession(
  client: HttpProtocolClient,
  threadId: string,
  rpcOptions?: { signal?: AbortSignal },
): Promise<{ status: string; active_turn: boolean; active_turn_id?: number } | null> {
  const catalog = await client.call<'remote.catalog', Record<string, never>, RemoteCatalogResult>(
    'remote.catalog',
    {},
    Date.now(),
    rpcOptions,
  );
  const row = catalog.sessions.find((session) => session.thread_id === threadId);
  if (!row) return null;
  return {
    status: row.status,
    active_turn: row.active_turn,
    ...(row.active_turn_id !== undefined ? { active_turn_id: row.active_turn_id } : {}),
  };
}

async function resolveAuthoritativeTerminalOutcome(
  client: HttpProtocolClient,
  threadId: string,
  terminal: TurnTerminalRecord,
  rpcOptions?: { signal?: AbortSignal },
): Promise<string> {
  if (terminal.fixture_execution) return 'UNVERIFIED_PATCH';
  if (terminal.event_type === 'cancelled') return 'CANCELLED';
  if (terminal.event_type === 'failed') {
    return terminal.outcome ?? 'AGENT_FAILURE';
  }
  const outcome = terminal.outcome;
  if (!outcome) return 'UNVERIFIED_PATCH';
  if (outcome === 'VERIFIED_COMPLETE') {
    const verification = await client.call<
      'verification.lookup',
      { thread_id: string },
      { has_machine_evidence: boolean }
    >('verification.lookup', { thread_id: threadId }, Date.now(), rpcOptions);
    return verification.has_machine_evidence ? 'VERIFIED_COMPLETE' : 'UNVERIFIED_PATCH';
  }
  return outcome;
}

async function mapAuthoritativeTerminalToStream(
  client: HttpProtocolClient,
  threadId: string,
  terminal: TurnTerminalRecord,
  rpcOptions?: { signal?: AbortSignal },
): Promise<Record<string, unknown>> {
  if (terminal.event_type === 'cancelled') {
    return { type: 'cancelled' };
  }
  if (terminal.event_type === 'failed') {
    return {
      type: 'run_error',
      error: terminal.error ?? 'Turn failed on the shared protocol host',
    };
  }
  const terminalOutcome = await resolveAuthoritativeTerminalOutcome(
    client,
    threadId,
    terminal,
    rpcOptions,
  );
  return {
    type: 'run_complete',
    result: {
      session_id: threadId,
      answer: terminal.answer ?? '',
      ...(terminal.usage ? { usage: terminal.usage } : {}),
      terminal_outcome: terminalOutcome,
      user_status: terminal.status ?? 'completed',
      reconciled_from_host: true,
      ...(terminal.fixture_execution ? { fixture_execution: true } : {}),
      ...(terminal.fixture_kind ? { fixture_kind: terminal.fixture_kind } : {}),
    },
  };
}

/** Reconcile a settled turn from persisted terminal evidence when the live socket missed the event. */
export async function reconcileTerminalTurnFromHost(
  client: HttpProtocolClient,
  threadId: string,
  submittedTurnId?: number,
  rpcOptions?: { signal?: AbortSignal },
): Promise<Record<string, unknown> | null> {
  if (submittedTurnId === undefined) return null;
  const row = await lookupCatalogSession(client, threadId, rpcOptions);
  if (row?.active_turn) {
    if (row.active_turn_id === undefined || row.active_turn_id === submittedTurnId) {
      return null;
    }
  }
  if (row && (row.status === 'running' || row.status === 'waiting_approval')) {
    if (row.active_turn_id === undefined || row.active_turn_id === submittedTurnId) {
      return null;
    }
  }

  const history = await client.call<
    'history.lookup',
    { thread_id: string; turn_id?: number; limit?: number },
    HistoryLookupResult
  >(
    'history.lookup',
    {
      thread_id: threadId,
      turn_id: submittedTurnId,
      limit: 200,
    },
    Date.now(),
    rpcOptions,
  );
  const terminal = history.turn_terminal;
  if (!terminal || terminal.turn_id !== submittedTurnId) return null;
  return await mapAuthoritativeTerminalToStream(client, threadId, terminal, rpcOptions);
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
  /** Process exit code from the first terminal stream event (independent of settlement flag). */
  let terminalExitCode: number | null = null;
  let transportClosedUnexpectedly = false;
  let ws: WebSocket | null = null;
  let cancelRequested = false;
  let pendingApproval: Record<string, unknown> | null = null;
  let activeThreadId = threadId;
  let controlEpoch = 0;
  let submittedTurnId: number | undefined;
  let stdinInterface: Interface | null = null;
  /** Resolves the active turn observer promise (transport loss or external settlement). */
  let wakeTurnObserver: (() => void) | null = null;
  /** Resolves turnDone without marking transport loss (live terminal settlement). */
  let releaseTurnObserverAwait: (() => void) | null = null;
  /** Bearer emergency cancel RPC succeeded; terminal outcome still requires authoritative evidence. */
  let emergencyStopAcknowledged = false;
  /** Post-emergency authoritative recovery should poll RPC instead of waiting on turnDone. */
  let emergencyAuthoritativeRecoveryPoll = false;
  let emergencyObservationPasses = 0;
  const emergencyTerminalObservationLimit = options.emergencyObservationPassLimit ?? 12;
  const observationRpcTimeoutMs = options.observationRpcTimeoutMs ?? 4_000;
  const emergencyObservationDeadlineMs = options.emergencyObservationDeadlineMs ?? 15_000;
  const emergencyClock = options.emergencyObservationClock ?? realSharedProtocolHostRunClock;
  let emergencyObservationDeadlineAt = 0;
  let emergencyObservationDeadlineTimer: unknown = null;
  let emergencyObservationScopeEpoch = 0;
  const EMERGENCY_OBSERVATION_TIMEOUT_MESSAGE =
    'Emergency stop observation timed out before authoritative terminal was available';
  /** Primary turn socket may still deliver harness cancel terminals after emergency ACK. */
  const PRIMARY_TRANSPORT_EMERGENCY_SETTLEMENT_GRACE_MS = 450;
  let primaryTransportEmergencyWakeTimer: unknown = null;

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
    const runObservationScope = new AbortController();
    const transportSessionId = await client.createTransportSession(options.projectRoot);
    if (threadId) {
      const resumed = await client.call<
        'thread.resume',
        { thread_id: string; session_id: string },
        { thread_id: string; provider?: string; model?: string }
      >('thread.resume', { thread_id: threadId, session_id: transportSessionId });
      const savedRoute: { provider?: string; model?: string } = {};
      if (resumed.provider) savedRoute.provider = resumed.provider;
      if (resumed.model) savedRoute.model = resumed.model;
      assertResumeRouteCompatible(savedRoute, requestedRoute(options));
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
        ...(options.harnessAdapterId === 'command-code'
          ? { harness_adapter_id: 'command-code' }
          : options.harnessAdapterId === 'opencode'
            ? { harness_adapter_id: 'opencode' }
            : {}),
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

    if (abort()) {
      try {
        await cancelTurnDesktop(client, threadId, controlEpoch);
        write({ type: 'cancelled' });
        return 0;
      } catch (error) {
        writeControlRejected(
          write,
          'cancel',
          error instanceof Error ? error.message : 'Cancel was rejected',
        );
        return 0;
      }
    }

    const openTurnSocket = async (opSignal?: AbortSignal): Promise<WebSocket> => {
      const ticket = await (options.fetchImpl ?? fetch)(`${baseUrl}/ws/ticket`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: transportSessionId, thread_id: threadId }),
        ...(opSignal ? { signal: opSignal } : {}),
      });
      const ticketBody = (await ticket.json()) as { ticket?: string };
      if (!ticket.ok || !ticketBody.ticket) {
        throw new Error('Failed to mint WebSocket ticket');
      }
      const socket = new WebSocketCtor(
        `ws://127.0.0.1:${options.port}/ws?sessionId=${encodeURIComponent(transportSessionId)}&ticket=${encodeURIComponent(ticketBody.ticket)}`,
      );
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          socket.removeEventListener('open', onOpen);
          socket.removeEventListener('error', onError);
          opSignal?.removeEventListener('abort', onAbort);
        };
        const onOpen = () => {
          cleanup();
          resolve();
        };
        const onError = () => {
          cleanup();
          reject(new Error('WebSocket connection failed'));
        };
        const onAbort = () => {
          cleanup();
          try {
            socket.close();
          } catch {
            /* ignore */
          }
          reject(
            opSignal?.reason instanceof Error
              ? opSignal.reason
              : new Error('WebSocket observation was aborted'),
          );
        };
        socket.addEventListener('open', onOpen);
        socket.addEventListener('error', onError);
        if (opSignal?.aborted) {
          onAbort();
          return;
        }
        opSignal?.addEventListener('abort', onAbort);
      });
      return socket;
    };

    const exitCodeForTerminalEvent = (mapped: Record<string, unknown>): number => {
      const type = String(mapped.type);
      if (type === 'run_error') return 1;
      if (type === 'cancelled') return 0;
      if (type === 'run_complete') return 0;
      return 1;
    };

    const writeStreamEvent = (mapped: Record<string, unknown> | null): boolean => {
      if (!mapped) return false;
      const isTerminal = ['run_complete', 'run_error', 'cancelled'].includes(String(mapped.type));
      if (isTerminal) {
        if (turnSettled) return true;
        write(mapped);
        turnSettled = true;
        terminalExitCode = exitCodeForTerminalEvent(mapped);
        return true;
      }
      write(mapped);
      return false;
    };

    const finalizeHostRunExitCode = (): number => {
      if (terminalExitCode !== null) return terminalExitCode;
      return turnSettled ? 0 : 1;
    };

    const clearEmergencyObservationTimers = (): void => {
      if (emergencyObservationDeadlineTimer !== null) {
        emergencyClock.clearTimeout(emergencyObservationDeadlineTimer);
        emergencyObservationDeadlineTimer = null;
      }
      if (primaryTransportEmergencyWakeTimer !== null) {
        emergencyClock.clearTimeout(primaryTransportEmergencyWakeTimer);
        primaryTransportEmergencyWakeTimer = null;
      }
    };

    const abortRunObservation = (reason: Error): void => {
      if (runObservationScope.signal.aborted) return;
      runObservationScope.abort(reason);
    };

    const finalizeTerminalObservation = (mapped: Record<string, unknown> | null): void => {
      if (!mapped) return;
      const settled = writeStreamEvent(mapped);
      if (settled) {
        clearEmergencyObservationTimers();
        abortRunObservation(new Error('observation_terminal_settled'));
        const release = releaseTurnObserverAwait;
        releaseTurnObserverAwait = null;
        wakeTurnObserver = null;
        release?.();
      }
    };

    const finalizeFatalObservationError = (message: string): void => {
      if (turnSettled) return;
      finalizeTerminalObservation({
        type: 'run_error',
        error: message,
      });
    };

    const remainingEmergencyObservationMs = (): number => {
      if (emergencyObservationDeadlineAt === 0) return emergencyObservationDeadlineMs;
      return Math.max(0, emergencyObservationDeadlineAt - emergencyClock.now());
    };

    const fireEmergencyObservationDeadline = (epoch: number): void => {
      if (epoch !== emergencyObservationScopeEpoch || turnSettled) return;
      emergencyHostRunTrace('observation_scope_deadline', { submittedTurnId });
      const deadlineError = new Error(EMERGENCY_OBSERVATION_TIMEOUT_MESSAGE);
      finalizeFatalObservationError(EMERGENCY_OBSERVATION_TIMEOUT_MESSAGE);
      wakeTurnObserverTraced('emergency_scope_deadline');
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      abortRunObservation(deadlineError);
      clearEmergencyObservationTimers();
    };

    const armEmergencyObservationDeadline = (): void => {
      if (emergencyObservationDeadlineTimer) return;
      emergencyObservationScopeEpoch += 1;
      const epoch = emergencyObservationScopeEpoch;
      emergencyObservationDeadlineTimer = emergencyClock.setTimeout(
        () => fireEmergencyObservationDeadline(epoch),
        emergencyObservationDeadlineMs,
      );
    };

    const emergencyRpcOptions = (opSignal: AbortSignal): { signal: AbortSignal } => ({
      signal: opSignal,
    });

    const runEmergencyObservation = async <T>(
      label: string,
      fn: (opSignal: AbortSignal) => Promise<T>,
    ): Promise<T> => {
      if (turnSettled) {
        throw new Error('observation_terminal_settled');
      }
      const scopeSignal = runObservationScope.signal;
      if (scopeSignal.aborted) {
        const reason = scopeSignal.reason;
        throw reason instanceof Error ? reason : new Error(EMERGENCY_OBSERVATION_TIMEOUT_MESSAGE);
      }
      const opAbort = new AbortController();
      const linkScopeAbort = () => {
        if (opAbort.signal.aborted) return;
        const reason = scopeSignal.reason;
        opAbort.abort(
          reason instanceof Error ? reason : new Error(EMERGENCY_OBSERVATION_TIMEOUT_MESSAGE),
        );
      };
      scopeSignal.addEventListener('abort', linkScopeAbort, { once: true });
      let perOpTimer: unknown = null;
      if (emergencyStopAcknowledged) {
        const perOpMs = Math.min(
          observationRpcTimeoutMs,
          remainingEmergencyObservationMs() || observationRpcTimeoutMs,
        );
        if (perOpMs <= 0) {
          scopeSignal.removeEventListener('abort', linkScopeAbort);
          throw new Error(EMERGENCY_OBSERVATION_TIMEOUT_MESSAGE);
        }
        perOpTimer = emergencyClock.setTimeout(() => {
          emergencyHostRunTrace('rpc_timeout', { label, observationRpcTimeoutMs: perOpMs });
          opAbort.abort(new Error(`${label} observation RPC timed out after ${perOpMs}ms`));
        }, perOpMs);
      }
      try {
        const value = await fn(opAbort.signal);
        if (opAbort.signal.aborted) {
          const reason = opAbort.signal.reason;
          throw reason instanceof Error ? reason : new Error(`${label} observation was aborted`);
        }
        return value;
      } finally {
        if (perOpTimer !== null) emergencyClock.clearTimeout(perOpTimer);
        scopeSignal.removeEventListener('abort', linkScopeAbort);
      }
    };

    const wakeTurnObserverTraced = (reason: string): void => {
      emergencyHostRunTrace('observer_wake', { reason, turnSettled });
      if (!turnSettled) {
        emergencyAuthoritativeRecoveryPoll = true;
      }
      (wakeTurnObserver as (() => void) | null)?.();
    };

    const requestEmergencyObserverWakeAfterReconcile = async (): Promise<void> => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (turnSettled || transportClosedUnexpectedly) {
        wakeTurnObserverTraced('emergency_stdin_after_reconcile');
        return;
      }
      if (primaryTransportEmergencyWakeTimer !== null) {
        emergencyClock.clearTimeout(primaryTransportEmergencyWakeTimer);
        primaryTransportEmergencyWakeTimer = null;
      }
      const graceMs = Math.min(
        PRIMARY_TRANSPORT_EMERGENCY_SETTLEMENT_GRACE_MS,
        remainingEmergencyObservationMs(),
      );
      if (graceMs <= 0) {
        wakeTurnObserverTraced('emergency_primary_transport_grace_zero');
        return;
      }
      emergencyHostRunTrace('primary_transport_grace_arm', { graceMs });
      primaryTransportEmergencyWakeTimer = emergencyClock.setTimeout(() => {
        primaryTransportEmergencyWakeTimer = null;
        if (!turnSettled) {
          wakeTurnObserverTraced('emergency_primary_transport_grace_elapsed');
        }
      }, graceMs);
    };

    const waitForTurnObservation = async (stage: string): Promise<void> => {
      emergencyHostRunTrace('await_turn_observation_begin', {
        stage,
        turnSettled,
        emergencyStopAcknowledged,
        transportClosedUnexpectedly,
      });
      if (turnSettled) {
        emergencyHostRunTrace('await_turn_observation_skip_settled', { stage });
        return;
      }
      if (emergencyStopAcknowledged) {
        while (
          !turnSettled &&
          !transportClosedUnexpectedly &&
          !emergencyAuthoritativeRecoveryPoll
        ) {
          if (runObservationScope.signal.aborted || emergencyObservationBudgetExpired()) {
            emergencyHostRunTrace('await_turn_observation_budget_expired', { stage });
            return;
          }
          await new Promise((resolve) => {
            emergencyClock.setTimeout(() => resolve(undefined), 25);
          });
        }
        emergencyHostRunTrace('await_turn_observation_emergency_short_circuit', {
          stage,
          turnSettled,
          transportClosedUnexpectedly,
          emergencyAuthoritativeRecoveryPoll,
        });
        return;
      }
      await turnDone;
      emergencyHostRunTrace('await_turn_observation_turn_done', { stage });
    };

    const beginEmergencyObservationWindow = (): void => {
      if (emergencyObservationDeadlineAt === 0) {
        emergencyObservationDeadlineAt = emergencyClock.now() + emergencyObservationDeadlineMs;
      }
      armEmergencyObservationDeadline();
    };

    const emergencyObservationBudgetExpired = (): boolean => {
      if (!emergencyStopAcknowledged || emergencyObservationDeadlineAt === 0) return false;
      if (runObservationScope.signal.aborted) return true;
      if (emergencyClock.now() < emergencyObservationDeadlineAt) return false;
      fireEmergencyObservationDeadline(emergencyObservationScopeEpoch);
      return true;
    };

    const attachTurnObserver = (socket: WebSocket): Promise<void> =>
      new Promise<void>((resolve) => {
        const finishObservation = () => {
          releaseTurnObserverAwait = null;
          wakeTurnObserver = null;
          resolve();
        };
        releaseTurnObserverAwait = finishObservation;
        wakeTurnObserver = () => {
          transportClosedUnexpectedly = true;
          finishObservation();
        };
        const onMessage = (event: MessageEvent) => {
          try {
            const message = JSON.parse(String(event.data)) as Record<string, unknown>;
            if (message.method === 'turn.event') {
              const params = message.params as Record<string, unknown> | undefined;
              const eventThreadId = params?.thread_id;
              const eventTurnId = params?.turn_id;
              if (eventThreadId !== undefined && String(eventThreadId) !== threadId) return;
              if (
                submittedTurnId !== undefined &&
                eventTurnId !== undefined &&
                Number(eventTurnId) !== submittedTurnId
              ) {
                return;
              }
              const ev = params?.event as Record<string, unknown> | undefined;
              if (ev) {
                const mapped = mapTurnEventToStream(ev, threadId);
                if (mapped) {
                  const isTerminal = ['run_complete', 'run_error', 'cancelled'].includes(
                    String(mapped.type),
                  );
                  if (isTerminal) {
                    finalizeTerminalObservation(mapped);
                  } else {
                    writeStreamEvent(mapped);
                  }
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
            if (primaryTransportEmergencyWakeTimer !== null) {
              emergencyClock.clearTimeout(primaryTransportEmergencyWakeTimer);
              primaryTransportEmergencyWakeTimer = null;
              wakeTurnObserverTraced('emergency_transport_closed_during_grace');
            }
            finishObservation();
          }
        };
        socket.addEventListener('message', onMessage as EventListener);
        socket.addEventListener('close', onClose as EventListener);
      });

    if (options.stdin?.readable) {
      stdinInterface = createInterface({ input: options.stdin });
      stdinInterface.on('line', (line) => {
        void (async () => {
          let msg: {
            decision?: string;
            approval?: Record<string, unknown>;
            host_emergency_token?: string;
          };
          try {
            msg = JSON.parse(line) as {
              decision?: string;
              approval?: Record<string, unknown>;
              host_emergency_token?: string;
            };
          } catch {
            return;
          }
          try {
            if (msg.decision === 'emergency_admin_stop') {
              const token =
                typeof msg.host_emergency_token === 'string'
                  ? msg.host_emergency_token.trim()
                  : '';
              const expected = loadHostEmergencyBearerToken();
              if (!expected || token !== expected) {
                writeControlRejected(
                  write,
                  'emergency_admin_stop',
                  'Host emergency stop was rejected (invalid admin token)',
                );
                return;
              }
              try {
                await emergencyAdminStopTurn(
                  options.port,
                  activeThreadId,
                  token,
                  options.fetchImpl,
                );
                emergencyStopAcknowledged = true;
                beginEmergencyObservationWindow();
                emergencyHostRunTrace('emergency_ack', {
                  threadId: activeThreadId,
                  submittedTurnId,
                });
                write({ type: 'emergency_stop' });
                if (!turnSettled && submittedTurnId !== undefined) {
                  emergencyHostRunTrace('immediate_reconcile_begin', {
                    submittedTurnId,
                  });
                  try {
                    if (emergencyObservationBudgetExpired()) {
                      return;
                    }
                    const terminal = await runEmergencyObservation('turn terminal reconcile', (opSignal) =>
                      reconcileTerminalTurnFromHost(
                        client,
                        activeThreadId,
                        submittedTurnId,
                        emergencyRpcOptions(opSignal),
                      ),
                    );
                    if (terminal) finalizeTerminalObservation(terminal);
                    emergencyHostRunTrace('immediate_reconcile_end', {
                      settled: turnSettled,
                      hadTerminal: Boolean(terminal),
                    });
                  } catch (reconcileError) {
                    emergencyHostRunTrace('immediate_reconcile_error', {
                      message:
                        reconcileError instanceof Error
                          ? reconcileError.message
                          : 'Emergency stop reconciliation failed',
                    });
                    if (!turnSettled) {
                      finalizeFatalObservationError(
                        reconcileError instanceof Error
                          ? reconcileError.message
                          : 'Emergency stop reconciliation failed',
                      );
                    }
                  }
                }
                await requestEmergencyObserverWakeAfterReconcile();
              } catch (error) {
                writeControlRejected(
                  write,
                  'emergency_admin_stop',
                  error instanceof Error
                    ? error.message
                    : 'Host emergency stop failed',
                );
              }
              return;
            }
            if (msg.decision === 'cancel') {
              cancelRequested = true;
              try {
                await cancelTurnDesktop(client, activeThreadId, controlEpoch);
                write({ type: 'cancelled' });
              } catch (error) {
                writeControlRejected(
                  write,
                  'cancel',
                  error instanceof Error
                    ? error.message
                    : 'Cancel was rejected by the shared protocol host',
                );
              }
              return;
            }
            if (msg.decision === 'reconcile_pending_approval') {
              try {
                const turnHint =
                  pendingApproval && typeof pendingApproval.turn_id === 'string'
                    ? pendingApproval.turn_id
                    : undefined;
                const authoritative = await lookupAuthoritativePendingApproval(
                  client,
                  activeThreadId,
                  options.runId,
                  turnHint,
                );
                if (!authoritative) {
                  writeControlRejected(
                    write,
                    'reconcile_pending_approval',
                    'No pending approval remains on the shared protocol host',
                  );
                  return;
                }
                pendingApproval = authoritative;
                const remapped = mapPermissionRequest(
                  permissionParamsFromPendingApproval(authoritative),
                  options.runId,
                );
                if (remapped) write(remapped);
                write({
                  type: 'approval.reconciled',
                  item: approvalItemFromAuthoritative(authoritative),
                });
              } catch (error) {
                writeControlRejected(
                  write,
                  'reconcile_pending_approval',
                  error instanceof Error ? error.message : 'Approval reconciliation failed',
                );
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
                writeControlRejected(
                  write,
                  'approval',
                  'Approval decision did not match the pending request',
                );
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
                writeControlRejected(
                  write,
                  'approval',
                  error instanceof Error
                    ? error.message
                    : 'Approval decision was rejected by the shared protocol host',
                );
              }
            }
          } catch (error) {
            finalizeFatalObservationError(
              error instanceof Error ? error.message : 'Host control stdin handling failed',
            );
          }
        })();
      });
    }

    ws = await runEmergencyObservation('ws initial open', (opSignal) => openTurnSocket(opSignal));

    if (abort()) {
      try {
        await cancelTurnDesktop(client, threadId, controlEpoch);
        write({ type: 'cancelled' });
        return 0;
      } catch (error) {
        writeControlRejected(
          write,
          'cancel',
          error instanceof Error ? error.message : 'Cancel was rejected',
        );
        return 0;
      }
    }

    let turnDone = attachTurnObserver(ws);
    const submitted = await client.call<
      'turn.submit',
      { thread_id: string; message: string; control_epoch: number; command_id?: string },
      { turn_id: number }
    >('turn.submit', {
      thread_id: threadId,
      message: options.task,
      control_epoch: lease.epoch,
      ...(options.commandId ? { command_id: options.commandId } : {}),
    });
    submittedTurnId = submitted.turn_id;

    await waitForTurnObservation('primary');

    while (
      !turnSettled &&
      (transportClosedUnexpectedly || emergencyAuthoritativeRecoveryPoll)
    ) {
      if (emergencyObservationBudgetExpired()) {
        return finalizeHostRunExitCode();
      }
      transportClosedUnexpectedly = false;
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      try {
        ws = await runEmergencyObservation('ws transport reopen', (opSignal) =>
          openTurnSocket(opSignal),
        );
      } catch (error) {
        if (turnSettled) return finalizeHostRunExitCode();
        if (emergencyStopAcknowledged) {
          finalizeFatalObservationError(
            error instanceof Error ? error.message : 'WebSocket transport observation failed',
          );
          return finalizeHostRunExitCode();
        }
        throw error;
      }
      emergencyHostRunTrace('loop_reattach', { submittedTurnId });
      turnDone = attachTurnObserver(ws);
      const turnHint: string | undefined =
        pendingApproval && typeof pendingApproval.turn_id === 'string'
          ? pendingApproval.turn_id
          : undefined;
      let authoritative: Record<string, unknown> | null = null;
      try {
        authoritative = await runEmergencyObservation('approval.lookup', (opSignal) =>
          lookupAuthoritativePendingApproval(
            client,
            threadId,
            options.runId,
            turnHint,
            emergencyRpcOptions(opSignal),
          ),
        );
      } catch (error) {
        if (turnSettled) return finalizeHostRunExitCode();
        if (emergencyStopAcknowledged) {
          finalizeFatalObservationError(
            error instanceof Error ? error.message : 'Approval lookup observation failed',
          );
          return finalizeHostRunExitCode();
        }
        throw error;
      }
      if (turnSettled) break;
      let terminal: Record<string, unknown> | null = null;
      try {
        terminal = await runEmergencyObservation('turn terminal reconcile', (opSignal) =>
          reconcileTerminalTurnFromHost(
            client,
            threadId,
            submittedTurnId,
            emergencyRpcOptions(opSignal),
          ),
        );
      } catch (error) {
        if (turnSettled) return finalizeHostRunExitCode();
        if (emergencyStopAcknowledged) {
          finalizeFatalObservationError(
            error instanceof Error ? error.message : 'Turn terminal reconcile observation failed',
          );
          return finalizeHostRunExitCode();
        }
        throw error;
      }
      if (terminal && !turnSettled) {
        finalizeTerminalObservation(terminal);
        break;
      }
      if (turnSettled) break;
      let catalogRow: { status: string; active_turn: boolean; active_turn_id?: number } | null = null;
      try {
        catalogRow = await runEmergencyObservation('remote.catalog', (opSignal) =>
          lookupCatalogSession(client, threadId, emergencyRpcOptions(opSignal)),
        );
      } catch (error) {
        if (turnSettled) return finalizeHostRunExitCode();
        if (emergencyStopAcknowledged) {
          finalizeFatalObservationError(
            error instanceof Error ? error.message : 'Catalog observation failed',
          );
          return finalizeHostRunExitCode();
        }
        throw error;
      }
      if (turnSettled) break;
      if (
        emergencyStopAcknowledged &&
        !turnSettled &&
        submittedTurnId !== undefined &&
        catalogRow?.active_turn === true &&
        (catalogRow.active_turn_id === undefined ||
          catalogRow.active_turn_id === submittedTurnId)
      ) {
        emergencyObservationPasses += 1;
        if (emergencyObservationPasses >= emergencyTerminalObservationLimit) {
          finalizeFatalObservationError(
            'Emergency stop was acknowledged but authoritative turn terminal was not observed',
          );
          return finalizeHostRunExitCode();
        }
      }
      const recoverable = Boolean(authoritative) || catalogRow?.active_turn === true;
      if (authoritative) {
        pendingApproval = authoritative;
        write({
          type: 'approval.pending',
          message:
            'Approval is still pending after transport loss; reconcile before deciding.',
          item: approvalItemFromAuthoritative(authoritative),
          authoritative: true,
        });
        const remapped = mapPermissionRequest(
          permissionParamsFromPendingApproval(authoritative),
          options.runId,
        );
        if (remapped) write(remapped);
      }
      write({
        type: 'transport.disconnected',
        recoverable,
        message:
          'Shared protocol transport lost; observation paused without resubmitting the task.',
      });
      if (!recoverable && !turnSettled) {
        finalizeFatalObservationError('Shared protocol transport lost before turn settled');
        return finalizeHostRunExitCode();
      }
      if (turnSettled) break;
      if (emergencyStopAcknowledged) {
        await waitForTurnObservation('recovery_loop');
      } else {
        await turnDone;
        emergencyHostRunTrace('await_turn_observation_turn_done', { stage: 'recovery_loop' });
      }
    }

    return finalizeHostRunExitCode();
  } catch (err) {
    if (!turnSettled) {
      write({
        type: 'run_error',
        error: err instanceof Error ? err.message : String(err),
      });
      turnSettled = true;
      terminalExitCode = 1;
      emergencyHostRunTrace('observer_wake', { reason: 'outer_catch', turnSettled });
      (wakeTurnObserver as (() => void) | null)?.();
    }
    return terminalExitCode ?? 1;
  } finally {
    if (emergencyObservationDeadlineTimer !== null) {
      emergencyClock.clearTimeout(emergencyObservationDeadlineTimer);
      emergencyObservationDeadlineTimer = null;
    }
    if (primaryTransportEmergencyWakeTimer !== null) {
      emergencyClock.clearTimeout(primaryTransportEmergencyWakeTimer);
      primaryTransportEmergencyWakeTimer = null;
    }
    emergencyHostRunTrace('finally_cleanup', { turnSettled, terminalExitCode });
    closeStdinInterface();
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
  }
}

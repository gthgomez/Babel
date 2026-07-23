/**
 * Babel protocol client — JSON-RPC roundtrip over an in-process host (D2 stub).
 */

import type { ChatEngine, ChatEngineOptions } from '../../agent/chatEngine.js';
import type { JsonRpcResponse } from '../jsonRpc.js';
import type {
  HistoryLookupParams,
  HistoryLookupResult,
  ThreadCreateParams,
  ThreadCreateResult,
  ThreadResumeParams,
  ThreadResumeResult,
  TurnCancelParams,
  TurnCancelResult,
  TurnSubmitParams,
  TurnSubmitResult,
} from '../types.js';
import {
  assertSuccess,
  createProtocolHostState,
  handleProtocolRequest,
  type ProtocolHostState,
} from './host.js';
import { isProtocolClientEnabled } from './mode.js';

let sharedState: ProtocolHostState | null = null;

function getState(): ProtocolHostState {
  if (!sharedState) sharedState = createProtocolHostState();
  return sharedState;
}

async function invoke<M extends string, P, R>(
  method: M,
  params: P,
  id: string | number = Date.now(),
): Promise<R> {
  const response = await handleProtocolRequest(
    { jsonrpc: '2.0', id, method, params } as Parameters<typeof handleProtocolRequest>[0],
    getState(),
  );
  return assertSuccess<R>(response);
}

export class BabelProtocolClient {
  async threadCreate(params: ThreadCreateParams): Promise<ThreadCreateResult> {
    return invoke('thread.create', params);
  }

  async threadResume(params: ThreadResumeParams): Promise<ThreadResumeResult> {
    return invoke('thread.resume', params);
  }

  async turnSubmit(params: TurnSubmitParams): Promise<TurnSubmitResult> {
    return invoke('turn.submit', params);
  }

  async turnCancel(params: TurnCancelParams): Promise<TurnCancelResult> {
    return invoke('turn.cancel', params);
  }

  async historyLookup(params: HistoryLookupParams): Promise<HistoryLookupResult> {
    return invoke('history.lookup', params);
  }

  getEngine(threadId: string) {
    return getState().engines.get(threadId);
  }
}

let defaultClient: BabelProtocolClient | null = null;

export function getProtocolClient(): BabelProtocolClient {
  if (!defaultClient) defaultClient = new BabelProtocolClient();
  return defaultClient;
}

/** Register an in-process engine so turn.submit can resolve it (D2 stub path). */
export function registerEngineWithProtocolHost(threadId: string, engine: ChatEngine): void {
  getState().engines.set(threadId, engine);
}

/** Allocate a thread id via protocol (no engine construction). Returns null when protocol is off. */
export async function allocateThreadViaProtocol(
  options: ChatEngineOptions,
): Promise<string | null> {
  if (!isProtocolClientEnabled()) return null;

  const client = getProtocolClient();
  const created = await client.threadCreate({
    project_root: options.projectRoot,
    ...(options.task ? { task: options.task } : {}),
    ...(options.model ? { model: options.model } : {}),
  });
  return created.thread_id;
}

/** @deprecated Use allocateThreadViaProtocol */
export async function createThreadViaProtocol(
  options: ChatEngineOptions,
): Promise<{ threadId: string; useProtocol: boolean } | null> {
  const threadId = await allocateThreadViaProtocol(options);
  if (!threadId) return null;
  return { threadId, useProtocol: true };
}

/** Roundtrip a request line through the host (contract tests). */
export async function roundtripRequestLine(line: string): Promise<JsonRpcResponse | null> {
  const parsed = JSON.parse(line) as Parameters<typeof handleProtocolRequest>[0];
  return handleProtocolRequest(parsed, getState());
}
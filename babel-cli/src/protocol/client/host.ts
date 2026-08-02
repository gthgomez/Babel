/**
 * In-process protocol host — maps JSON-RPC methods to ChatEngine + threadStore.
 * D2 stub; future babel-app-server will reuse these handlers.
 */

import { ChatEngine } from '../../agent/chatEngine.js';
import type { BabelMode, SessionDescriptor } from '../../executor/contracts.js';
import {
  allocateThreadId,
  ensureThread,
  loadSessionDescriptor,
  loadThreadCells,
  resolveNextTurnId,
  writeSessionDescriptor,
  threadStoreExists,
} from '../../services/threadStore/index.js';
import type { JsonRpcRequest, JsonRpcResponse } from '../jsonRpc.js';
import { isJsonRpcErrorResponse } from '../jsonRpc.js';
import type { BabelProtocolRequest } from '../messages.js';
import type { ThreadCreateParams } from '../types.js';
import { BabelProtocolErrorCode } from '../types.js';
import type {
  CellCommittedParams,
  HistoryLookupResult,
  ThreadCreateResult,
  ThreadResumeResult,
  TurnCancelResult,
  TurnEventParams,
  TurnSubmitResult,
} from '../types.js';

export interface ProtocolHostState {
  engines: Map<string, ChatEngine>;
  activeTurns: Map<string, number>;
  descriptors: Map<string, SessionDescriptor>;
  engineFactory: (descriptor: SessionDescriptor) => ChatEngine;
  executeWithoutNotifications: boolean;
}

export function createProtocolHostState(options: {
  engineFactory?: (descriptor: SessionDescriptor) => ChatEngine;
  executeWithoutNotifications?: boolean;
} = {}): ProtocolHostState {
  return {
    engines: new Map(),
    activeTurns: new Map(),
    descriptors: new Map(),
    engineFactory: options.engineFactory ?? defaultEngineFactory,
    executeWithoutNotifications: options.executeWithoutNotifications ?? false,
  };
}

function modeExecutionProfile(mode: BabelMode): 'chat' | 'plan' | 'deep' {
  return mode;
}

function defaultEngineFactory(descriptor: SessionDescriptor): ChatEngine {
  const engine = new ChatEngine({
    task: descriptor.task ?? `Session ${descriptor.threadId}`,
    projectRoot: descriptor.projectRoot,
    ...(descriptor.model !== 'default' ? { model: descriptor.model } : {}),
    ...(descriptor.provider !== 'default' ? { provider: descriptor.provider } : {}),
    executionProfile: modeExecutionProfile(descriptor.mode),
    hardPlanMode: descriptor.mode === 'plan',
  });
  engine.assignRunId(descriptor.threadId);
  return engine;
}

function descriptorFromCreate(threadId: string, params: ThreadCreateParams): SessionDescriptor {
  const mode = params.mode ?? 'chat';
  return {
    schemaVersion: 1,
    threadId,
    projectRoot: params.project_root,
    mode,
    provider: params.provider ?? process.env['BABEL_PROVIDER'] ?? 'default',
    model: params.model ?? process.env['BABEL_MODEL'] ?? 'default',
    policyProfile: params.policy_profile ?? (mode === 'plan' ? 'read_only_audit' : 'safe_repo'),
    createdAt: new Date().toISOString(),
    kernelVersion: 'executor-kernel-v1',
    contractVersion: 'executor-contract-v1',
    ...(params.task !== undefined ? { task: params.task } : {}),
  };
}

function materializeEngine(state: ProtocolHostState, descriptor: SessionDescriptor): ChatEngine {
  const existing = state.engines.get(descriptor.threadId);
  if (existing) return existing;
  const engine = state.engineFactory(descriptor);
  state.engines.set(descriptor.threadId, engine);
  state.descriptors.set(descriptor.threadId, descriptor);
  return engine;
}

function errorResponse(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: { code, message },
  };
}

export async function handleProtocolRequest(
  request: BabelProtocolRequest,
  state: ProtocolHostState,
  onNotification?: (notification: import('../messages.js').BabelProtocolServerNotification) => void
): Promise<JsonRpcResponse> {
  const id = request.id;

  try {
    switch (request.method) {
      case 'thread.create': {
        const params = request.params;
        if (!params) {
          return errorResponse(id, BabelProtocolErrorCode.INVALID_PARAMS, 'Missing params');
        }
        const threadId = allocateThreadId();
        const descriptor = descriptorFromCreate(threadId, params);
        ensureThread(threadId, { project_root: descriptor.projectRoot });
        writeSessionDescriptor(descriptor);
        state.descriptors.set(threadId, descriptor);
        const result: ThreadCreateResult = { thread_id: threadId };
        return { jsonrpc: '2.0', id, result };
      }
      case 'thread.resume': {
        const params = request.params;
        if (!params) {
          return errorResponse(id, BabelProtocolErrorCode.INVALID_PARAMS, 'Missing params');
        }
        const threadId = params.thread_id;
        if (!threadStoreExists(threadId)) {
          return errorResponse(id, BabelProtocolErrorCode.THREAD_NOT_FOUND, `Thread not found: ${threadId}`);
        }
        const descriptor = loadSessionDescriptor(threadId) ?? {
          schemaVersion: 1,
          threadId,
          projectRoot: params.project_root ?? process.cwd(),
          mode: 'chat' as const,
          provider: process.env['BABEL_PROVIDER'] ?? 'default',
          model: process.env['BABEL_MODEL'] ?? 'default',
          policyProfile: 'safe_repo',
          createdAt: new Date().toISOString(),
          kernelVersion: 'executor-kernel-v1',
          contractVersion: 'executor-contract-v1',
        };
        if (params.project_root && params.project_root !== descriptor.projectRoot) {
          return errorResponse(id, BabelProtocolErrorCode.PROJECT_ROOT_MISMATCH, `Project root mismatch for thread: ${threadId}`);
        }
        writeSessionDescriptor(descriptor);
        state.descriptors.set(threadId, descriptor);
        const cells = loadThreadCells(threadId);
        const result: ThreadResumeResult = {
          thread_id: threadId,
          turn_count: cells.length > 0 ? (cells[cells.length - 1]?.turn_id ?? 0) : 0,
        };
        return { jsonrpc: '2.0', id, result };
      }
      case 'turn.submit': {
        const params = request.params;
        if (!params) {
          return errorResponse(id, BabelProtocolErrorCode.INVALID_PARAMS, 'Missing params');
        }
        if (!threadStoreExists(params.thread_id)) {
          return errorResponse(
            id,
            BabelProtocolErrorCode.THREAD_NOT_FOUND,
            `Thread not found: ${params.thread_id}`,
          );
        }
        if (state.activeTurns.has(params.thread_id)) {
          return errorResponse(
            id,
            BabelProtocolErrorCode.TURN_IN_PROGRESS,
            `Turn already in progress for thread: ${params.thread_id}`,
          );
        }
        const turnId = resolveNextTurnId(params.thread_id);
        state.activeTurns.set(params.thread_id, turnId);

        const descriptor = state.descriptors.get(params.thread_id) ?? loadSessionDescriptor(params.thread_id);
        const engine = descriptor ? materializeEngine(state, descriptor) : state.engines.get(params.thread_id);
        if (!engine) {
          state.activeTurns.delete(params.thread_id);
          return errorResponse(id, BabelProtocolErrorCode.INTERNAL_ERROR, `Unable to materialize thread runtime: ${params.thread_id}`);
        }

        if (onNotification || state.executeWithoutNotifications) {
          // Launch turn in background
          Promise.resolve().then(async () => {
            let seq = 0;
            try {
              for await (const event of engine.submitMessageStream(params.message)) {
                // Ignore disconnect errors when writing
                try {
                  onNotification?.({
                    jsonrpc: '2.0',
                    method: 'turn.event',
                    params: {
                      thread_id: params.thread_id,
                      turn_id: turnId,
                      seq: seq++,
                      event: event as any, // Mapped ChatEvent -> TurnStreamEvent
                    }
                  });
                } catch {
                  /* client disconnected */
                }
              }
            } catch (err: any) {
               try {
                 onNotification?.({
                   jsonrpc: '2.0',
                   method: 'turn.event',
                   params: {
                     thread_id: params.thread_id,
                     turn_id: turnId,
                     seq: seq++,
                     event: { type: 'failed', error: err.message ?? String(err) }
                   }
                 });
               } catch { /* ignore */ }
            } finally {
              state.activeTurns.delete(params.thread_id);
              try {
                onNotification?.({
                  jsonrpc: '2.0',
                  method: 'cell.committed',
                  params: {
                    thread_id: params.thread_id,
                    turn_id: turnId,
                    cells: loadThreadCells(params.thread_id),
                  }
                });
              } catch { /* ignore */ }
            }
          });
        }

        const result: TurnSubmitResult = { thread_id: params.thread_id, turn_id: turnId };
        return { jsonrpc: '2.0', id, result };
      }
      case 'turn.cancel': {
        const params = request.params;
        if (!params) {
          return errorResponse(id, BabelProtocolErrorCode.INVALID_PARAMS, 'Missing params');
        }
        const engine = state.engines.get(params.thread_id);
        if (!engine) {
          return errorResponse(
            id,
            BabelProtocolErrorCode.THREAD_NOT_FOUND,
            `Thread not found: ${params.thread_id}`,
          );
        }
        engine.cancel();
        const turnId = state.activeTurns.get(params.thread_id) ?? null;
        state.activeTurns.delete(params.thread_id);
        const result: TurnCancelResult = {
          thread_id: params.thread_id,
          turn_id: turnId,
          cancelled: true,
        };
        return { jsonrpc: '2.0', id, result };
      }
      case 'history.lookup': {
        const params = request.params;
        if (!params) {
          return errorResponse(id, BabelProtocolErrorCode.INVALID_PARAMS, 'Missing params');
        }
        const cells = loadThreadCells(params.thread_id);
        let filtered = cells;
        if (params.turn_id !== undefined) {
          filtered = filtered.filter((c) => c.turn_id === params.turn_id);
        }
        // cursor-based pagination: treat cursor as a cell_id and skip past it
        if (params.cursor) {
          const cursorIdx = filtered.findIndex((c) => c.cell_id === params.cursor);
          if (cursorIdx >= 0) {
            filtered = filtered.slice(cursorIdx + 1);
          }
        }
        if (params.cell_id) {
          const idx = filtered.findIndex((c) => c.cell_id === params.cell_id);
          filtered = idx >= 0 ? filtered.slice(idx) : [];
        }
        const limit = params.limit ?? filtered.length;
        const slice = filtered.slice(0, limit);
        const result: HistoryLookupResult = {
          cells: slice,
          has_more: slice.length < filtered.length,
        };
        // Provide the next-page cursor when there are more results
        if (result.has_more && slice.length > 0) {
          result.cursor = slice[slice.length - 1]?.cell_id ?? '';
        }
        return { jsonrpc: '2.0', id, result };
      }
      default:
        return errorResponse(id, BabelProtocolErrorCode.METHOD_NOT_FOUND, 'Unknown method');
    }
  } catch (err) {
    return errorResponse(
      id,
      BabelProtocolErrorCode.INTERNAL_ERROR,
      err instanceof Error ? err.message : String(err),
    );
  }
}

export function parseProtocolRequest(line: string): BabelProtocolRequest | null {
  try {
    const parsed = JSON.parse(line) as JsonRpcRequest;
    if (parsed.jsonrpc !== '2.0' || typeof parsed.method !== 'string') return null;
    return parsed as BabelProtocolRequest;
  } catch {
    return null;
  }
}

export function formatTurnEventNotification(params: TurnEventParams): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    method: 'turn.event',
    params,
  });
}

export function formatCellCommittedNotification(params: CellCommittedParams): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    method: 'cell.committed',
    params,
  });
}

export function assertSuccess<T>(response: JsonRpcResponse): T {
  if (isJsonRpcErrorResponse(response)) {
    throw new Error(`Protocol error ${response.error.code}: ${response.error.message}`);
  }
  return response.result as T;
}

/**
 * In-process protocol host — maps JSON-RPC methods to ChatEngine + threadStore.
 * D2 stub; future babel-app-server will reuse these handlers.
 */

import { ChatEngine, type ChatEvent } from '../../agent/chatEngine.js';
import type { BabelMode, SessionDescriptor } from '../../executor/contracts.js';
import {
  buildPreparedTurn,
  resolveModeCapability,
  type RestoreReport,
} from '../../executor/modeAdapters.js';
import {
  createRuntimeCoordinator,
  isRuntimeCoordinatorEnabled,
} from '../../runtime/coordinator.js';
import type { RuntimeCoordinator, RuntimeExecution } from '../../runtime/contracts.js';
import type { RepoIdentityResumeResult } from '../../agent/threadEventLog.js';
import {
  hydrateEngineFromRestore,
  inspectSessionRestoreState,
  inspectThreadRepoIdentityOnHydration,
  RepoIdentityMismatchError,
} from '../../services/threadStore/sessionHydration.js';
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
import { mapChatEventToTurnStreamEvent } from '../mapChatEvent.js';
import { hashUserMessage, type MessageIntegrity } from '../messageIntegrity.js';
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
  ApprovalDecideResult,
  WorkspaceChangesResult,
  VerificationLookupResult,
} from '../types.js';
import { RemoteApprovalBroker, runOnRemoteSurface } from '../../bridge/remoteApproval.js';
import { collectWorkspaceChanges } from '../../bridge/workspaceChanges.js';
import {
  mapVerificationEvidence,
  type VerificationEvidence,
} from '../../bridge/verificationMap.js';

/**
 * Ownership record for one in-flight protocol launch.
 *
 * `generation` is a per-thread monotonically increasing identity. A launch may
 * release ownership only while this exact record still owns the thread, so an
 * obsolete finalizer can never clear a successor's ownership.
 */
export interface ActiveLaunch {
  turnId: number;
  generation: number;
  /** Cancellation has been requested; the launch may still be settling. */
  cancelRequested: boolean;
  /** A host runner was actually scheduled for this launch. */
  scheduled: boolean;
  /** The launch reached a terminal path and may release ownership. */
  settled: boolean;
}

export interface ProtocolHostState {
  engines: Map<string, ChatEngine>;
  activeTurns: Map<string, ActiveLaunch>;
  /** Per-thread monotonic generation counter for active launches. */
  launchCounters: Map<string, number>;
  descriptors: Map<string, SessionDescriptor>;
  engineFactory: (descriptor: SessionDescriptor) => ChatEngine;
  executeWithoutNotifications: boolean;
  /** Optional authorization handle — not a sandbox. */
  projectRootGuard?: (projectRoot: string) => string;
  /** command_id → { messageSha256, response } */
  idempotency: Map<string, { messageSha256: string; response: JsonRpcResponse }>;
  /** thread:turn → integrity of the message passed into ChatEngine.submitMessageStream */
  lastMessageIntegrity: Map<string, MessageIntegrity>;
  /** Remote V1: bind ChatEngine tool/MCP authority to the loopback surface. */
  remoteSurface: boolean;
  approvalBroker: RemoteApprovalBroker;
  verificationByThread: Map<string, VerificationEvidence>;
  /** Durable-state restore outcome recorded at thread.resume time. */
  restoreReports: Map<string, RestoreReport>;
  /** P03: shared lifecycle facade that owns controller dispatch per turn. */
  coordinator: RuntimeCoordinator;
}

export function createProtocolHostState(options: {
  engineFactory?: (descriptor: SessionDescriptor) => ChatEngine;
  executeWithoutNotifications?: boolean;
  projectRootGuard?: (projectRoot: string) => string;
  remoteSurface?: boolean;
  coordinator?: RuntimeCoordinator;
} = {}): ProtocolHostState {
  return {
    engines: new Map(),
    activeTurns: new Map(),
    launchCounters: new Map(),
    descriptors: new Map(),
    engineFactory: options.engineFactory ?? defaultEngineFactory,
    executeWithoutNotifications: options.executeWithoutNotifications ?? false,
    ...(options.projectRootGuard ? { projectRootGuard: options.projectRootGuard } : {}),
    idempotency: new Map(),
    lastMessageIntegrity: new Map(),
    remoteSurface: options.remoteSurface === true,
    approvalBroker: new RemoteApprovalBroker(),
    verificationByThread: new Map(),
    restoreReports: new Map(),
    coordinator: options.coordinator ?? createRuntimeCoordinator(),
  };
}

function modeExecutionProfile(mode: BabelMode): 'chat' | 'plan' | 'deep' {
  return mode;
}

function defaultEngineFactory(descriptor: SessionDescriptor): ChatEngine {
  const prepared = buildPreparedTurn(descriptor);
  const engine = new ChatEngine({
    task: prepared.task,
    projectRoot: prepared.projectRoot,
    runtimeMode: 'direct',
    ...(prepared.model !== 'default' ? { model: prepared.model } : {}),
    ...(prepared.provider !== 'default' ? { provider: prepared.provider } : {}),
    executionProfile: modeExecutionProfile(prepared.mode),
    hardPlanMode: prepared.mode === 'plan',
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
  const report = state.restoreReports.get(descriptor.threadId);
  if (report?.resumable && report.source !== 'none') {
    if (!engineSupportsHydration(engine)) {
      throw new Error(
        `Cannot restore thread ${descriptor.threadId}: engine does not support conversation hydration`,
      );
    }
    // Hydrate before publishing so a failed restore cannot leave a poisoned
    // empty engine cached for the next submit. D04: identity is enforced again
    // at the seam so a materialization cannot bypass the host-level check.
    hydrateEngineFromRestore(engine, report, {
      currentRoot: descriptor.projectRoot,
      // R0-2: a synthesized descriptor is not historical evidence.
      fallbackSavedRoot: loadSessionDescriptor(descriptor.threadId)
        ? descriptor.projectRoot
        : null,
    });
  }
  state.engines.set(descriptor.threadId, engine);
  state.descriptors.set(descriptor.threadId, descriptor);
  return engine;
}

/** Hydration needs the ChatEngine conversation surface; tests may inject stubs. */
function engineSupportsHydration(engine: ChatEngine): boolean {
  const candidate = engine as unknown as {
    restoreEventLog?: unknown;
    replaceConversation?: unknown;
    getConversation?: unknown;
  };
  return (
    typeof candidate.restoreEventLog === 'function' &&
    typeof candidate.replaceConversation === 'function' &&
    typeof candidate.getConversation === 'function'
  );
}

/**
 * Release ownership only if `launch` is still the current owner of `threadId`.
 *
 * This is the guard that makes cancellation safe: a launch whose generation has
 * been superseded cannot delete the successor's active-turn record. Returns
 * true when this call actually released ownership.
 */
export function releaseLaunchOwnership(
  state: ProtocolHostState,
  threadId: string,
  launch: ActiveLaunch,
): boolean {
  // Only a settled launch may release ownership; an in-flight launch must not
  // be released by anything other than its own terminal path.
  if (!launch.settled) {
    return false;
  }
  const current = state.activeTurns.get(threadId);
  if (!current || current.generation !== launch.generation) {
    return false;
  }
  state.activeTurns.delete(threadId);
  return true;
}

function errorResponse(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: { code, message },
  };
}

/**
 * D04: fail-closed response for a provable physical repository mismatch.
 *
 * Mirrors the REPL seam's `repo_identity_mismatch` refusal so a moved or
 * replaced repository cannot be resumed/admitted on the protocol surface.
 */
function repoIdentityMismatchResponse(
  id: string | number | null,
  threadId: string,
  reason: string,
  savedRoot: string | null,
  currentRoot: string,
): JsonRpcResponse {
  return errorResponse(
    id,
    BabelProtocolErrorCode.PROJECT_ROOT_MISMATCH,
    `repo_identity_mismatch: ${reason} ` +
      `(thread: ${threadId}; saved repository root: ${savedRoot ?? 'unknown'}; current root: ${currentRoot})`,
  );
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
        let projectRoot = params.project_root;
        try {
          if (state.projectRootGuard) {
            projectRoot = state.projectRootGuard(params.project_root);
          }
        } catch (err) {
          return errorResponse(
            id,
            BabelProtocolErrorCode.INVALID_PARAMS,
            err instanceof Error ? err.message : String(err),
          );
        }
        const threadId = allocateThreadId();
        const descriptor = descriptorFromCreate(threadId, { ...params, project_root: projectRoot });
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
        const loadedDescriptor = loadSessionDescriptor(threadId);
        const descriptor = loadedDescriptor ?? {
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
        // D04: validate physical repository identity BEFORE any restore state is
        // declared resumable or an engine is admitted. The durable event log /
        // session-events identity is authoritative; the descriptor root is only
        // a fallback. Roots are never compared lexically.
        const currentRoot = params.project_root ?? descriptor.projectRoot;
        // R0-2: only a PERSISTED descriptor is historical identity evidence.
        // When none exists, the descriptor above is synthesized from the very
        // root being resumed; using it as its own "saved" root would verify
        // current B against synthetic saved B. Pass null so identity stays
        // unknown (never verified) without durable historical proof.
        const persistedRoot = loadedDescriptor ? descriptor.projectRoot : null;
        const identity = inspectThreadRepoIdentityOnHydration(
          threadId,
          currentRoot,
          persistedRoot,
        );
        if (!identity.ok && identity.status === 'mismatch') {
          return repoIdentityMismatchResponse(
            id,
            threadId,
            identity.reason,
            identity.savedRoot,
            currentRoot,
          );
        }
        // Never cement a synthesized descriptor: only persist a real one.
        if (loadedDescriptor) writeSessionDescriptor(descriptor);
        state.descriptors.set(threadId, descriptor);
        const resumeCapability = resolveModeCapability(descriptor.mode);
        const inspected = inspectSessionRestoreState(threadId, descriptor.mode, {
          currentRoot,
          fallbackSavedRoot: persistedRoot,
        });
        const report: RestoreReport = resumeCapability.resume
          ? inspected
          : {
              ...inspected,
              resumable: false,
              ...(resumeCapability.reason !== undefined ? { reason: resumeCapability.reason } : {}),
            };
        state.restoreReports.set(threadId, report);
        const result: ThreadResumeResult = {
          thread_id: threadId,
          turn_count: report.turnCount,
          restore: report,
        };
        return { jsonrpc: '2.0', id, result };
      }
      case 'turn.submit': {
        const params = request.params;
        if (!params) {
          return errorResponse(id, BabelProtocolErrorCode.INVALID_PARAMS, 'Missing params');
        }
        if (typeof params.message !== 'string') {
          return errorResponse(id, BabelProtocolErrorCode.INVALID_PARAMS, 'message must be a string');
        }
        if (!threadStoreExists(params.thread_id)) {
          return errorResponse(
            id,
            BabelProtocolErrorCode.THREAD_NOT_FOUND,
            `Thread not found: ${params.thread_id}`,
          );
        }
        const descriptor = state.descriptors.get(params.thread_id) ?? loadSessionDescriptor(params.thread_id);
        // R0-2: only a persisted descriptor is historical identity evidence.
        const persistedDescriptor = loadSessionDescriptor(params.thread_id);
        const registeredEngine = state.engines.get(params.thread_id);
        if (!descriptor && !registeredEngine) {
          return errorResponse(
            id,
            BabelProtocolErrorCode.MODE_UNSUPPORTED,
            `Cannot determine mode for thread ${params.thread_id}: no session descriptor or registered runtime`,
          );
        }
        let identityResult: RepoIdentityResumeResult | undefined;
        if (descriptor) {
          const capability = resolveModeCapability(descriptor.mode);
          if (!capability.submission) {
            return errorResponse(
              id,
              BabelProtocolErrorCode.MODE_UNSUPPORTED,
              capability.reason ?? `Mode ${descriptor.mode} is not supported on this surface`,
            );
          }
          // D04: identity is enforced before any cold restore is admitted. A
          // live registered engine was already validated when it was admitted.
          // R0-2: the cached/synthesized descriptor is not historical evidence;
          // only a persisted descriptor or durable log/session-events identity
          // may serve as the saved root.
          const identity = inspectThreadRepoIdentityOnHydration(
            params.thread_id,
            descriptor.projectRoot,
            persistedDescriptor ? persistedDescriptor.projectRoot : null,
          );
          identityResult = identity;
          if (!identity.ok && identity.status === 'mismatch') {
            return repoIdentityMismatchResponse(
              id,
              params.thread_id,
              identity.reason,
              identity.savedRoot,
              descriptor.projectRoot,
            );
          }
        }
        // Ordinary submission is self-sufficient: when no live runtime is
        // registered, inspect durable state before admitting so a cold host
        // hydrates (or refuses) instead of silently running on empty history.
        let restoreReport = state.restoreReports.get(params.thread_id);
        if (!restoreReport && !registeredEngine) {
          restoreReport = inspectSessionRestoreState(
            params.thread_id,
            descriptor?.mode ?? 'chat',
            descriptor
              ? {
                  currentRoot: descriptor.projectRoot,
                  fallbackSavedRoot: persistedDescriptor
                    ? persistedDescriptor.projectRoot
                    : null,
                }
              : undefined,
          );
          state.restoreReports.set(params.thread_id, restoreReport);
        }
        if (restoreReport && !restoreReport.resumable && !registeredEngine) {
          return errorResponse(
            id,
            BabelProtocolErrorCode.THREAD_NOT_RESUMABLE,
            restoreReport.reason ?? `Thread ${params.thread_id} has state that cannot be restored`,
          );
        }
        // R0-3: unknown repository identity may be inspected as history, but
        // executing against a thread with durable history requires an explicit
        // rebind/confirmation. A mismatch always fails closed above; unknown is
        // never silently treated as the current root's identity.
        if (
          identityResult &&
          !identityResult.ok &&
          identityResult.status === 'unknown' &&
          !registeredEngine &&
          restoreReport?.resumable &&
          restoreReport.source !== 'none' &&
          params.repo_identity_confirmed !== true
        ) {
          return errorResponse(
            id,
            BabelProtocolErrorCode.REPO_IDENTITY_UNKNOWN,
            `repo_identity_unknown: ${identityResult.reason}. Re-submit with repo_identity_confirmed=true to bind this thread to ${
              descriptor?.projectRoot ?? 'the requested root'
            }.`,
          );
        }
        const integrity = hashUserMessage(params.message);
        if (params.command_id) {
          const prior = state.idempotency.get(`${params.thread_id}:${params.command_id}`);
          if (prior) {
            if (prior.messageSha256 !== integrity.sha256) {
              return errorResponse(
                id,
                BabelProtocolErrorCode.INVALID_PARAMS,
                'command_id reused with a different message',
              );
            }
            return prior.response;
          }
        }
        if (state.activeTurns.has(params.thread_id)) {
          return errorResponse(
            id,
            BabelProtocolErrorCode.TURN_IN_PROGRESS,
            `Turn already in progress for thread: ${params.thread_id}`,
          );
        }
        const turnId = resolveNextTurnId(params.thread_id);
        const generation = (state.launchCounters.get(params.thread_id) ?? 0) + 1;
        state.launchCounters.set(params.thread_id, generation);
        const launch: ActiveLaunch = {
          turnId,
          generation,
          cancelRequested: false,
          scheduled: false,
          settled: false,
        };
        state.activeTurns.set(params.thread_id, launch);
        state.lastMessageIntegrity.set(`${params.thread_id}:${turnId}`, integrity);

        let engine: ChatEngine | undefined;
        try {
          engine = descriptor ? materializeEngine(state, descriptor) : state.engines.get(params.thread_id);
        } catch (err) {
          launch.settled = true;
          releaseLaunchOwnership(state, params.thread_id, launch);
          if (err instanceof RepoIdentityMismatchError) {
            return errorResponse(
              id,
              BabelProtocolErrorCode.PROJECT_ROOT_MISMATCH,
              err.message,
            );
          }
          return errorResponse(
            id,
            BabelProtocolErrorCode.INTERNAL_ERROR,
            err instanceof Error ? err.message : String(err),
          );
        }
        if (!engine) {
          launch.settled = true;
          releaseLaunchOwnership(state, params.thread_id, launch);
          return errorResponse(id, BabelProtocolErrorCode.INTERNAL_ERROR, `Unable to materialize thread runtime: ${params.thread_id}`);
        }

        if (onNotification || state.executeWithoutNotifications) {
          launch.scheduled = true;
          const launchTurn = async () => {
            let seq = 0;
            let runtimeExecution: RuntimeExecution | null = null;
            const emitEvents = async (events: AsyncIterable<ChatEvent>): Promise<void> => {
              for await (const event of events) {
                const mapped = mapChatEventToTurnStreamEvent(event);
                if (!mapped) continue;
                try {
                  onNotification?.({
                    jsonrpc: '2.0',
                    method: 'turn.event',
                    params: {
                      thread_id: params.thread_id,
                      turn_id: turnId,
                      seq: seq++,
                      event: mapped,
                    }
                  });
                } catch {
                  /* client disconnected */
                }
              }
            };
            try {
              // Hash immediately before the engine call — ChatEngine boundary.
              const engineBoundary = hashUserMessage(params.message);
              state.lastMessageIntegrity.set(`${params.thread_id}:${turnId}`, engineBoundary);
              // P03: dispatch through the shared runtime facade when a durable
              // descriptor exists. The pre-P03 direct adapter remains selectable
              // via the compatibility switch for trace comparison.
              if (isRuntimeCoordinatorEnabled() && descriptor != null) {
                runtimeExecution = state.coordinator.beginTurn({
                  prepared: buildPreparedTurn(descriptor),
                  threadId: params.thread_id,
                  turnId: String(turnId),
                  task: params.message,
                  subject: engine,
                });
                await emitEvents(state.coordinator.submit(runtimeExecution));
              } else {
                await emitEvents(engine.submitMessageStream(params.message));
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
              if (runtimeExecution !== null) state.coordinator.settle(runtimeExecution);
              launch.settled = true;
              releaseLaunchOwnership(state, params.thread_id, launch);
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
          };
          if (state.remoteSurface) {
            const surface = {
              broker: state.approvalBroker,
              threadId: params.thread_id,
              turnId: String(turnId),
              failClosedMcp: true as const,
              cwd: descriptor?.projectRoot ?? process.cwd(),
              ...(onNotification
                ? { notify: (notification: unknown) => onNotification(notification as never) }
                : {}),
            };
            void runOnRemoteSurface(surface, () => launchTurn());
          } else {
            void launchTurn();
          }
        }

        const result: TurnSubmitResult = { thread_id: params.thread_id, turn_id: turnId };
        const success: JsonRpcResponse = { jsonrpc: '2.0', id, result };
        if (params.command_id) {
          state.idempotency.set(`${params.thread_id}:${params.command_id}`, {
            messageSha256: integrity.sha256,
            response: success,
          });
        }
        return success;
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
        const launch = state.activeTurns.get(params.thread_id);
        if (!launch) {
          return errorResponse(
            id,
            BabelProtocolErrorCode.TURN_NOT_IN_PROGRESS,
            `No turn in progress for thread: ${params.thread_id}`,
          );
        }
        // Cancellation is a request. A scheduled launch keeps ownership until it
        // actually settles, so a successor cannot overlap this execution and a
        // stale finalizer cannot clear the next owner. A launch admitted without
        // a runner can never settle, so cancellation releases it here rather than
        // wedging the thread.
        if (!launch.cancelRequested) {
          engine.cancel();
          state.approvalBroker.cancelTurn(params.thread_id, String(launch.turnId));
          launch.cancelRequested = true;
        }
        if (!launch.scheduled) {
          launch.settled = true;
          releaseLaunchOwnership(state, params.thread_id, launch);
        }
        const result: TurnCancelResult = {
          thread_id: params.thread_id,
          turn_id: launch.turnId,
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
      case 'approval.decide': {
        const params = request.params;
        if (!params) {
          return errorResponse(id, BabelProtocolErrorCode.INVALID_PARAMS, 'Missing params');
        }
        const decided = state.approvalBroker.decide({
          approval_id: params.approval_id,
          decision: params.decision,
          thread_id: params.thread_id,
          turn_id: params.turn_id,
          ...(params.operation_digest !== undefined
            ? { operation_digest: params.operation_digest }
            : {}),
        });
        if (!decided.ok) {
          return errorResponse(
            id,
            BabelProtocolErrorCode.INVALID_PARAMS,
            `approval.decide rejected: ${decided.error}`,
          );
        }
        const result: ApprovalDecideResult = {
          approval_id: decided.record.approval_id,
          decision: params.decision === 'deny' ? 'deny' : 'allow_once',
          consumed: decided.record.state === 'consumed' || decided.record.state === 'denied',
        };
        onNotification?.({
          jsonrpc: '2.0',
          method: 'permission.respond',
          params: {
            thread_id: params.thread_id,
            permission: decided.record.operation.action_type,
            granted: decided.record.state === 'consumed',
          },
        });
        return { jsonrpc: '2.0', id, result };
      }
      case 'workspace.changes': {
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
        const descriptor =
          state.descriptors.get(params.thread_id) ?? loadSessionDescriptor(params.thread_id);
        const snapshot = collectWorkspaceChanges(descriptor?.projectRoot ?? process.cwd());
        const result: WorkspaceChangesResult = {
          available: snapshot.available,
          files: snapshot.files,
          diff: snapshot.diff,
          ...(snapshot.reason !== undefined ? { reason: snapshot.reason } : {}),
        };
        return { jsonrpc: '2.0', id, result };
      }
      case 'verification.lookup': {
        const params = request.params;
        if (!params) {
          return errorResponse(id, BabelProtocolErrorCode.INVALID_PARAMS, 'Missing params');
        }
        const stored = state.verificationByThread.get(params.thread_id);
        const mapped = mapVerificationEvidence(
          stored ?? { hasMachineEvidence: false },
        );
        const result: VerificationLookupResult = mapped;
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

/**
 * ADR-010 JSON-RPC gateway over the existing loopback HTTP/WebSocket bridge.
 * Transport only — semantics stay in protocol/client/host.ts.
 */

import type { IncomingMessage } from 'node:http';
import { resolve } from 'node:path';

import {
  createProtocolHostState,
  handleProtocolRequest,
  parseProtocolRequest,
  type ProtocolHostState,
} from '../protocol/client/host.js';
import type { BabelProtocolRequest } from '../protocol/messages.js';
import type { JsonRpcResponse } from '../protocol/jsonRpc.js';
import { BabelProtocolErrorCode } from '../protocol/types.js';
import { assertAllowedProjectRoot, canonicalizeContained } from './workspaceBound.js';
import { originAllowed as originAllowedStructured } from './originPolicy.js';
import { ThreadOwnershipRegistry, type ThreadOwnershipError } from './threadOwnership.js';
import { loadSessionDescriptor } from '../services/threadStore/sessionDescriptor.js';
import { threadStoreExists } from '../services/threadStore/threadStore.js';
import {
  buildRemoteCatalog,
  commandCodeOpenNativeAuthority,
  openCodeOpenNativeAuthority,
} from './remoteCatalog.js';
import { buildRemoteHarnessCapabilities } from './harnessAdapterRegistry.js';
import type { CommandCodeAcpRuntimeRegistry } from './commandCodeAcpRuntime.js';
import type { OpenCodeAcpRuntimeRegistry } from './openCodeAcpRuntime.js';
import type { HarnessAdapterId } from './harnessAdapterContract.js';
import { ControlLeaseRegistry } from './controlLease.js';
import type { BridgeClientContext } from './bridgeClientAuth.js';

export const MAX_RPC_BYTES = 2 * 1024 * 1024;

export const REMOTE_MUTATING_RPC_METHODS = new Set([
  'turn.submit',
  'turn.cancel',
  'approval.decide',
  'harness.command_code.open',
  'harness.opencode.open',
]);

const MUTATING_METHODS = REMOTE_MUTATING_RPC_METHODS;

export interface ProtocolDispatchContext {
  client: BridgeClientContext;
}

export type JsonRpcNotificationHandler = (payload: string) => void;

interface GatewaySubscriber {
  handler: JsonRpcNotificationHandler;
  threadId?: string;
}

function notificationThreadId(notification: object): string | undefined {
  const params = (notification as { params?: { thread_id?: unknown } }).params;
  return typeof params?.thread_id === 'string' ? params.thread_id : undefined;
}

export class ProtocolGateway {
  readonly host: ProtocolHostState;
  readonly threadOwnership = new ThreadOwnershipRegistry();
  readonly controlLeases = new ControlLeaseRegistry();
  private readonly registeredWorkspaceRoot: string;
  private readonly enforceControlLease: boolean;
  private readonly commandCodeRegistry: CommandCodeAcpRuntimeRegistry | undefined;
  private readonly openCodeRegistry: OpenCodeAcpRuntimeRegistry | undefined;
  private subscribers = new Set<GatewaySubscriber>();

  constructor(options: {
    allowedWorkspaceRoot: string;
    engineFactory?: ProtocolHostState['engineFactory'];
    remoteSurface?: boolean;
    enforceControlLease?: boolean;
    commandCodeRegistry?: CommandCodeAcpRuntimeRegistry;
    openCodeRegistry?: OpenCodeAcpRuntimeRegistry;
    openCodeInstallProbe?: () => Promise<import('./openCodeCliDiscovery.js').OpenCodeInstallProbe>;
    claudeCodeRegistry?: import('./claudeCodeAgentRuntime.js').ClaudeCodeAgentRuntimeRegistry;
    claudeCodeAdmissionDeps?: import('./claudeCodeSessionAdmission.js').ClaudeCodeSessionAdmissionDeps;
  }) {
    const allowedRoot = options.allowedWorkspaceRoot;
    this.registeredWorkspaceRoot = canonicalizeContained(resolve(allowedRoot));
    this.enforceControlLease = options.enforceControlLease === true;
    this.commandCodeRegistry = options.commandCodeRegistry;
    this.openCodeRegistry = options.openCodeRegistry;
    this.host = createProtocolHostState({
      executeWithoutNotifications: true,
      projectRootGuard: (projectRoot) => assertAllowedProjectRoot(projectRoot, allowedRoot),
      remoteSurface: options.remoteSurface !== false,
      ...(options.engineFactory ? { engineFactory: options.engineFactory } : {}),
      ...(options.openCodeInstallProbe
        ? { openCodeInstallProbe: options.openCodeInstallProbe }
        : {}),
      ...(options.claudeCodeRegistry ? { claudeCodeRegistry: options.claudeCodeRegistry } : {}),
      ...(options.claudeCodeAdmissionDeps
        ? { claudeCodeAdmissionDeps: options.claudeCodeAdmissionDeps }
        : {}),
    });
  }

  subscribe(
    handler: JsonRpcNotificationHandler,
    options?: { threadId?: string },
  ): () => void {
    const subscriber: GatewaySubscriber = {
      handler,
      ...(options?.threadId !== undefined ? { threadId: options.threadId } : {}),
    };
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  private fanout(notification: object): void {
    const payload = JSON.stringify(notification);
    const threadId = notificationThreadId(notification);
    const isGlobal = (notification as { scope?: unknown }).scope === 'global';
    for (const subscriber of this.subscribers) {
      if (isGlobal) {
        if (subscriber.threadId !== undefined) continue;
      } else {
        if (!subscriber.threadId) continue;
        if (!threadId || subscriber.threadId !== threadId) continue;
      }
      try {
        subscriber.handler(payload);
      } catch {
        /* drop disconnected subscribers */
      }
    }
  }

  async dispatch(
    raw: string,
    dispatchContext?: ProtocolDispatchContext,
  ): Promise<JsonRpcResponse> {
    if (Buffer.byteLength(raw, 'utf8') > MAX_RPC_BYTES) {
      return {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: BabelProtocolErrorCode.INVALID_REQUEST,
          message: `RPC payload exceeds ${MAX_RPC_BYTES} bytes`,
        },
      };
    }
    let parsedId: string | number | null = null;
    try {
      const envelope = JSON.parse(raw) as { method?: unknown; id?: unknown };
      if (envelope.method === 'remote.catalog') {
        parsedId =
          typeof envelope.id === 'string' || typeof envelope.id === 'number' ? envelope.id : null;
        const catalog = await buildRemoteCatalog({
          state: this.host,
          registeredWorkspaceRoot: this.registeredWorkspaceRoot,
          threadOwner: (threadId) => this.threadOwnership.ownerOf(threadId)?.sessionId,
          ...(this.commandCodeRegistry
            ? { commandCodeRegistry: this.commandCodeRegistry }
            : {}),
          ...(this.openCodeRegistry ? { openCodeRegistry: this.openCodeRegistry } : {}),
        });
        return {
          jsonrpc: '2.0',
          id: parsedId ?? 0,
          result: catalog,
        };
      }
      if (envelope.method === 'harness.command_code.open') {
        parsedId =
          typeof envelope.id === 'string' || typeof envelope.id === 'number' ? envelope.id : null;
        const openParams = ((envelope as { params?: unknown }).params ?? {}) as Record<string, unknown>;
        const leaseDenied = this.assertControlLeaseForMutation(
          {
            jsonrpc: '2.0',
            method: 'harness.command_code.open',
            id: parsedId ?? 0,
            params: openParams,
          } as unknown as BabelProtocolRequest,
          dispatchContext,
        );
        if (leaseDenied) return leaseDenied;
        return await this.dispatchHarnessOpen('command-code', openParams, parsedId);
      }
      if (envelope.method === 'harness.opencode.open') {
        parsedId =
          typeof envelope.id === 'string' || typeof envelope.id === 'number' ? envelope.id : null;
        const openParams = ((envelope as { params?: unknown }).params ?? {}) as Record<string, unknown>;
        const leaseDenied = this.assertControlLeaseForMutation(
          {
            jsonrpc: '2.0',
            method: 'harness.opencode.open',
            id: parsedId ?? 0,
            params: openParams,
          } as unknown as BabelProtocolRequest,
          dispatchContext,
        );
        if (leaseDenied) return leaseDenied;
        return await this.dispatchHarnessOpen('opencode', openParams, parsedId);
      }
      if (envelope.method === 'remote.capabilities') {
        parsedId =
          typeof envelope.id === 'string' || typeof envelope.id === 'number' ? envelope.id : null;
        const harness = await buildRemoteHarnessCapabilities();
        return {
          jsonrpc: '2.0',
          id: parsedId ?? 0,
          result: {
            control_lease_enforced: this.enforceControlLease,
            exclusive_remote_control: this.enforceControlLease,
            host_auto_control_bind: true,
            ...harness,
          },
        };
      }
      if (typeof envelope.method === 'string' && envelope.method.startsWith('control.')) {
        parsedId =
          typeof envelope.id === 'string' || typeof envelope.id === 'number' ? envelope.id : null;
        return this.dispatchControlRpc(
          envelope.method,
          (envelope as { params?: unknown }).params,
          parsedId,
          dispatchContext,
        );
      }
    } catch {
      /* fall through to standard parse */
    }
    const parsed = parseProtocolRequest(raw);
    if (!parsed) {
      return {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: BabelProtocolErrorCode.PARSE_ERROR,
          message: 'Invalid JSON-RPC request',
        },
      };
    }
    const clientKind = dispatchContext?.client.authKind;
    const mustCheckLease =
      this.enforceControlLease || clientKind === 'paired_device';
    const leaseDenied = mustCheckLease
      ? this.assertControlLeaseForMutation(parsed, dispatchContext)
      : null;
    if (leaseDenied) return leaseDenied;

    const response = await handleProtocolRequest(
      parsed as BabelProtocolRequest,
      this.host,
      (notification) => {
        this.fanout(notification);
      },
    );
    if (
      (parsed.method === 'thread.create' || parsed.method === 'thread.resume') &&
      'result' in response
    ) {
      const result = response.result as { thread_id?: unknown };
      const params = (parsed as { params?: { session_id?: unknown; thread_id?: unknown } }).params;
      const threadId =
        typeof result.thread_id === 'string'
          ? result.thread_id
          : typeof params?.thread_id === 'string'
            ? params.thread_id
            : undefined;
      if (
        typeof threadId === 'string' &&
        typeof params?.session_id === 'string' &&
        params.session_id.length > 0
      ) {
        if (parsed.method === 'thread.resume') {
          this.threadOwnership.transfer(threadId, params.session_id);
        } else {
          this.threadOwnership.bind(threadId, params.session_id);
        }
      }
    }
    return response;
  }

  /** Test helper: drive fan-out with a crafted notification. */
  emitNotification(notification: object): void {
    this.fanout(notification);
  }

  private async dispatchHarnessOpen(
    adapterId: HarnessAdapterId,
    params: Record<string, unknown>,
    parsedId: string | number | null,
  ): Promise<JsonRpcResponse> {
    const registry =
      adapterId === 'command-code' ? this.commandCodeRegistry : this.openCodeRegistry;
    const displayName = adapterId === 'command-code' ? 'Command Code' : 'OpenCode';
    if (!registry) {
      return {
        jsonrpc: '2.0',
        id: parsedId ?? 0,
        error: {
          code: BabelProtocolErrorCode.MODE_UNSUPPORTED,
          message: `${displayName} harness is not available on this host`,
        },
      };
    }
    const nativeId = params.harness_native_session_id;
    const threadId = params.thread_id;
    if (typeof nativeId !== 'string' || !nativeId) {
      return {
        jsonrpc: '2.0',
        id: parsedId ?? 0,
        error: {
          code: BabelProtocolErrorCode.INVALID_PARAMS,
          message: 'harness_native_session_id is required',
        },
      };
    }
    if (typeof threadId !== 'string' || !threadId || !threadStoreExists(threadId)) {
      return {
        jsonrpc: '2.0',
        id: parsedId ?? 0,
        error: {
          code: BabelProtocolErrorCode.THREAD_NOT_FOUND,
          message: 'thread_id is required and must reference an existing thread',
        },
      };
    }
    const persisted = loadSessionDescriptor(threadId);
    const descriptor = persisted ?? this.host.descriptors.get(threadId) ?? null;
    if (!descriptor || descriptor.harness_adapter_id !== adapterId) {
      return {
        jsonrpc: '2.0',
        id: parsedId ?? 0,
        error: {
          code: BabelProtocolErrorCode.MODE_UNSUPPORTED,
          message: `Thread is not a ${displayName} harness session`,
        },
      };
    }
    if (descriptor.harness_native_session_id !== nativeId) {
      return {
        jsonrpc: '2.0',
        id: parsedId ?? 0,
        error: {
          code: BabelProtocolErrorCode.INVALID_PARAMS,
          message: 'harness_native_session_id does not match the canonical thread binding',
        },
      };
    }
    const canonicalRoot = canonicalizeContained(resolve(descriptor.projectRoot));
    if (params.project_root !== undefined) {
      const requestedRoot =
        typeof params.project_root === 'string' ? params.project_root : String(params.project_root);
      try {
        const normalized = canonicalizeContained(resolve(requestedRoot));
        if (normalized !== canonicalRoot) {
          return {
            jsonrpc: '2.0',
            id: parsedId ?? 0,
            error: {
              code: BabelProtocolErrorCode.INVALID_PARAMS,
              message: 'project_root does not match the canonical thread workspace',
            },
          };
        }
      } catch (err) {
        return {
          jsonrpc: '2.0',
          id: parsedId ?? 0,
          error: {
            code: BabelProtocolErrorCode.INVALID_PARAMS,
            message: err instanceof Error ? err.message : String(err),
          },
        };
      }
    }
    try {
      assertAllowedProjectRoot(descriptor.projectRoot, this.registeredWorkspaceRoot);
    } catch (err) {
      return {
        jsonrpc: '2.0',
        id: parsedId ?? 0,
        error: {
          code: BabelProtocolErrorCode.INVALID_PARAMS,
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
    const openAuthority =
      adapterId === 'command-code'
        ? await commandCodeOpenNativeAuthority(this.host, canonicalRoot, nativeId, threadId)
        : await openCodeOpenNativeAuthority(this.host, canonicalRoot, nativeId, threadId);
    if (openAuthority === 'corrupt') {
      return {
        jsonrpc: '2.0',
        id: parsedId ?? 0,
        error: {
          code: BabelProtocolErrorCode.INVALID_PARAMS,
          message: `Multiple persisted Babel threads own this ${displayName} native session`,
        },
      };
    }
    if (openAuthority === 'conflict') {
      return {
        jsonrpc: '2.0',
        id: parsedId ?? 0,
        error: {
          code: BabelProtocolErrorCode.INVALID_PARAMS,
          message: `Another Babel thread already owns this ${displayName} native session`,
        },
      };
    }
    if (openAuthority === 'none') {
      return {
        jsonrpc: '2.0',
        id: parsedId ?? 0,
        error: {
          code: BabelProtocolErrorCode.INVALID_PARAMS,
          message: `No persisted canonical owner for this ${displayName} native session`,
        },
      };
    }
    const launch = this.host.activeTurns.get(threadId);
    if (launch && !launch.settled) {
      return {
        jsonrpc: '2.0',
        id: parsedId ?? 0,
        error: {
          code: BabelProtocolErrorCode.TURN_IN_PROGRESS,
          message: `Cannot open saved ${displayName} history while a turn is active`,
        },
      };
    }
    const opened = await registry.openSavedSession(descriptor);
    return {
      jsonrpc: '2.0',
      id: parsedId ?? 0,
      result: { thread_id: threadId, cell_count: opened.cell_count },
    };
  }

  private dispatchControlRpc(
    method: string,
    params: unknown,
    id: string | number | null,
    dispatchContext?: ProtocolDispatchContext,
  ): JsonRpcResponse {
    const client = dispatchContext?.client;
    if (!client || client.authKind === 'none') {
      return controlError(id, 'unauthorized', 'Authentication required');
    }
    const record = params && typeof params === 'object'
      ? (params as Record<string, unknown>)
      : {};
    const threadId = typeof record.thread_id === 'string' ? record.thread_id : '';
    if (!threadId) return controlError(id, 'invalid_request', 'thread_id is required');

    if (method === 'control.status') {
      const st = this.controlLeases.status(threadId);
      return {
        jsonrpc: '2.0',
        id: id ?? 0,
        result: {
          held: st.held,
          holder_client_id: st.holderClientId,
          epoch: st.epoch,
          expires_at_ms: st.expiresAtMs,
          committed_epoch: st.committed_epoch,
        },
      };
    }

    if (method === 'control.acquire') {
      const force =
        record.force === true &&
        (client.authKind === 'host_bearer' || client.authKind === 'query_bearer');
      const acquired = this.controlLeases.acquire({
        threadId,
        clientId: client.clientId,
        force,
        remotePriorityTakeover: client.authKind === 'paired_device',
      });
      if (!acquired.ok) {
        return controlError(id, acquired.error, `control acquire failed: ${acquired.error}`);
      }
      return {
        jsonrpc: '2.0',
        id: id ?? 0,
        result: {
          epoch: acquired.epoch,
          expires_at_ms: acquired.expiresAtMs,
          holder_client_id: client.clientId,
        },
      };
    }

    if (method === 'control.renew') {
      const epoch = typeof record.control_epoch === 'number' ? record.control_epoch : NaN;
      if (!Number.isFinite(epoch)) {
        return controlError(id, 'invalid_request', 'control_epoch is required');
      }
      const renewed = this.controlLeases.renew({
        threadId,
        clientId: client.clientId,
        epoch,
      });
      if (!renewed.ok) {
        return controlError(id, renewed.error, `control renew failed: ${renewed.error}`);
      }
      return {
        jsonrpc: '2.0',
        id: id ?? 0,
        result: { expires_at_ms: renewed.expiresAtMs },
      };
    }

    if (method === 'control.release') {
      const epoch = typeof record.control_epoch === 'number' ? record.control_epoch : NaN;
      if (!Number.isFinite(epoch)) {
        return controlError(id, 'invalid_request', 'control_epoch is required');
      }
      const released = this.controlLeases.release({
        threadId,
        clientId: client.clientId,
        epoch,
      });
      if (!released.ok) {
        return controlError(id, released.error, `control release failed: ${released.error}`);
      }
      return { jsonrpc: '2.0', id: id ?? 0, result: { ok: true } };
    }

    return controlError(id, 'method_not_found', `Unknown control method ${method}`);
  }

  private assertControlLeaseForMutation(
    parsed: BabelProtocolRequest,
    dispatchContext?: ProtocolDispatchContext,
  ): JsonRpcResponse | null {
    if (!MUTATING_METHODS.has(parsed.method)) return null;
    const client = dispatchContext?.client;
    if (!client || client.authKind === 'none') {
      return controlError(parsed.id ?? null, 'unauthorized', 'Authentication required');
    }
    const params = (parsed as unknown as { params?: Record<string, unknown> }).params;
    const threadId =
      params && typeof params.thread_id === 'string' ? params.thread_id : '';
    if (!threadId) return null;
    const allowHostAutoAcquire =
      client.authKind === 'host_bearer' || client.authKind === 'query_bearer';
    const requireExplicitEpoch =
      client.authKind === 'paired_device' || client.authKind === 'desktop_controller';
    const leaseInput: {
      threadId: string;
      clientId: string;
      allowHostAutoAcquire: boolean;
      requireExplicitEpoch: boolean;
      controlEpoch?: number;
    } = {
      threadId,
      clientId: client.clientId,
      allowHostAutoAcquire,
      requireExplicitEpoch,
    };
    const rawEpoch = params?.control_epoch;
    if (rawEpoch !== undefined && rawEpoch !== null) {
      if (typeof rawEpoch !== 'number' || !Number.isFinite(rawEpoch)) {
        return controlError(parsed.id ?? null, 'stale_epoch', 'control_epoch must be a finite number');
      }
      leaseInput.controlEpoch = rawEpoch;
    }
    const authorized = this.controlLeases.authorizeMutation(leaseInput);
    if (!authorized.ok) {
      return controlError(
        parsed.id ?? null,
        authorized.error,
        `control lease denied: ${authorized.error}`,
      );
    }
    if (
      params &&
      params.control_epoch === undefined &&
      (client.authKind === 'host_bearer' || client.authKind === 'query_bearer')
    ) {
      params.control_epoch = authorized.epoch;
    }
    return null;
  }

  authorizeTicketMint(input: {
    sessionId: string;
    threadId: string;
  }): { ok: true } | { ok: false; error: ThreadOwnershipError } {
    const threadExists =
      this.host.descriptors.has(input.threadId) ||
      threadStoreExists(input.threadId) ||
      this.threadOwnership.ownerOf(input.threadId) !== undefined;
    return this.threadOwnership.authorizeMint({
      threadId: input.threadId,
      sessionId: input.sessionId,
      threadExists,
    });
  }
}

export function readLimitedBody(
  req: IncomingMessage,
  maxBytes: number = MAX_RPC_BYTES,
): Promise<{ ok: true; body: string } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (result: { ok: true; body: string } | { ok: false; error: string }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    req.on('data', (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > maxBytes) {
        req.resume();
        finish({ ok: false, error: `RPC payload exceeds ${maxBytes} bytes` });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      finish({ ok: true, body: Buffer.concat(chunks).toString('utf8') });
    });
    req.on('error', (err) => {
      finish({ ok: false, error: err.message });
    });
  });
}

function controlError(
  id: string | number | null,
  code: string,
  message: string,
): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code: BabelProtocolErrorCode.INVALID_REQUEST,
      message,
      data: { control_error: code },
    },
  };
}

export function originAllowed(
  origin: string | undefined,
  allowedOrigins: string[],
  remoteAddress?: string,
): boolean {
  return originAllowedStructured(origin, allowedOrigins, remoteAddress);
}

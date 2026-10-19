/**
 * Authoritative remote session catalog derived from the protocol host and thread store.
 */

import type { ProtocolHostState } from '../protocol/client/host.js';
import { listThreads } from '../services/threadStore/index.js';
import type { CommandCodeAcpRuntimeRegistry } from './commandCodeAcpRuntime.js';
import { isPathInsideRoot } from './workspaceBound.js';

function workspaceRootMatches(projectRoot: string, registeredRoot: string): boolean {
  return isPathInsideRoot(registeredRoot, projectRoot);
}

export type RemoteSessionStatus =
  | 'idle'
  | 'running'
  | 'waiting_approval'
  | 'completed'
  | 'failed'
  | 'unknown';

export interface RemoteWorkspaceEntry {
  project_root: string;
  label: string;
}

export interface RemoteSessionEntry {
  thread_id: string;
  project_root: string;
  mode: string;
  status: RemoteSessionStatus;
  preview: string;
  updated_at: number;
  active_turn: boolean;
  /** Set when `active_turn` is true for the in-flight launch generation. */
  active_turn_id?: number;
  owned_by_bridge_session?: string;
  harness_adapter_id?: string;
  harness_native_session_id?: string;
}

export interface RemoteVendorSessionEntry {
  session_id: string;
  title?: string;
  harness_adapter_id: 'command-code';
  /** When true, a Babel thread already owns this native session. */
  bound?: boolean;
  /** Canonical Babel thread that owns this native session when bound. */
  canonical_thread_id?: string;
}

export function findCanonicalCommandCodeNativeOwner(
  state: ProtocolHostState,
  nativeSessionId: string,
): string | undefined {
  for (const [threadId, descriptor] of state.descriptors) {
    if (descriptor.harness_native_session_id === nativeSessionId) return threadId;
  }
  return undefined;
}

export interface RemoteCatalogResult {
  host: {
    execution_owner: 'protocol_host';
    registered_workspace_root: string;
  };
  workspaces: RemoteWorkspaceEntry[];
  sessions: RemoteSessionEntry[];
  vendor_sessions?: RemoteVendorSessionEntry[];
}

function workspaceLabel(projectRoot: string): string {
  const parts = projectRoot.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] ?? projectRoot;
}

function threadHasPersistedTerminal(state: ProtocolHostState, threadId: string): boolean {
  const prefix = `${threadId}:`;
  for (const key of state.turnTerminals.keys()) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
}

function sessionStatus(
  state: ProtocolHostState,
  threadId: string,
): RemoteSessionStatus {
  if (state.activeTurns.has(threadId)) return 'running';
  if (threadHasPersistedTerminal(state, threadId)) return 'completed';
  const engine = state.engines.get(threadId);
  if (engine) return 'idle';
  const report = state.restoreReports.get(threadId);
  if (report && !report.resumable) return 'failed';
  return 'completed';
}

export async function buildRemoteCatalog(input: {
  state: ProtocolHostState;
  registeredWorkspaceRoot: string;
  threadOwner?: (threadId: string) => string | undefined;
  commandCodeRegistry?: CommandCodeAcpRuntimeRegistry;
}): Promise<RemoteCatalogResult> {
  const root = input.registeredWorkspaceRoot;
  const workspaces: RemoteWorkspaceEntry[] = [
    { project_root: root, label: workspaceLabel(root) },
  ];

  const byId = new Map<string, RemoteSessionEntry>();

  for (const [threadId, descriptor] of input.state.descriptors) {
    if (!workspaceRootMatches(descriptor.projectRoot, root)) continue;
    const owner = input.threadOwner?.(threadId);
    const launch = input.state.activeTurns.get(threadId);
    byId.set(threadId, {
      thread_id: threadId,
      project_root: descriptor.projectRoot,
      mode: descriptor.mode,
      status: sessionStatus(input.state, threadId),
      preview: descriptor.task?.slice(0, 72) ?? '(active session)',
      updated_at: Date.parse(descriptor.createdAt) || Date.now(),
      active_turn: Boolean(launch && !launch.settled),
      ...(launch && !launch.settled ? { active_turn_id: launch.turnId } : {}),
      ...(owner ? { owned_by_bridge_session: owner } : {}),
      ...(descriptor.harness_adapter_id
        ? { harness_adapter_id: descriptor.harness_adapter_id }
        : {}),
      ...(descriptor.harness_native_session_id
        ? { harness_native_session_id: descriptor.harness_native_session_id }
        : {}),
    });
  }

  const threads = await listThreads({ limit: 100 });
  for (const thread of threads) {
    if (thread.project_root && !workspaceRootMatches(thread.project_root, root)) {
      continue;
    }
    const existing = byId.get(thread.thread_id);
    if (existing) {
      existing.preview = thread.preview ?? existing.preview;
      existing.updated_at = Math.max(existing.updated_at, thread.updated_at);
      existing.project_root = thread.project_root ?? existing.project_root;
      continue;
    }
    const owner = input.threadOwner?.(thread.thread_id);
    const launch = input.state.activeTurns.get(thread.thread_id);
    byId.set(thread.thread_id, {
      thread_id: thread.thread_id,
      project_root: thread.project_root ?? root,
      mode: 'chat',
      status: sessionStatus(input.state, thread.thread_id),
      preview: thread.preview ?? '(thread store)',
      updated_at: thread.updated_at,
      active_turn: Boolean(launch && !launch.settled),
      ...(launch && !launch.settled ? { active_turn_id: launch.turnId } : {}),
      ...(owner ? { owned_by_bridge_session: owner } : {}),
    });
  }

  const sessions = [...byId.values()].sort((a, b) => b.updated_at - a.updated_at);
  const nativeOwners = new Map<string, string>();
  for (const [threadId, descriptor] of input.state.descriptors) {
    if (descriptor.harness_native_session_id) {
      nativeOwners.set(descriptor.harness_native_session_id, threadId);
    }
  }
  let vendor_sessions: RemoteVendorSessionEntry[] | undefined;
  if (input.commandCodeRegistry) {
    try {
      const listed = await input.commandCodeRegistry.listSessions(root);
      vendor_sessions = listed.map((row) => {
        const owner = nativeOwners.get(row.sessionId);
        const entry: RemoteVendorSessionEntry = {
          session_id: row.sessionId,
          harness_adapter_id: 'command-code',
          bound: nativeOwners.has(row.sessionId),
          ...(row.title ? { title: row.title } : {}),
        };
        if (owner) entry.canonical_thread_id = owner;
        return entry;
      });
    } catch {
      vendor_sessions = [];
    }
  }
  return {
    host: {
      execution_owner: 'protocol_host',
      registered_workspace_root: root,
    },
    workspaces,
    sessions,
    ...(vendor_sessions !== undefined ? { vendor_sessions } : {}),
  };
}

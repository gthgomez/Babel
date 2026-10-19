/**
 * Authoritative remote session catalog derived from the protocol host and thread store.
 */

import type { ProtocolHostState } from '../protocol/client/host.js';
import { listThreads, loadSessionDescriptor } from '../services/threadStore/index.js';
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

interface CommandCodeNativeOwnerCandidate {
  threadId: string;
  persisted: boolean;
}

function isPersistedNativeOwner(threadId: string, nativeId: string): boolean {
  const persisted = loadSessionDescriptor(threadId);
  return persisted?.harness_native_session_id === nativeId;
}

function pickCanonicalNativeOwner(
  left: CommandCodeNativeOwnerCandidate,
  right: CommandCodeNativeOwnerCandidate,
): CommandCodeNativeOwnerCandidate {
  if (left.persisted !== right.persisted) return left.persisted ? left : right;
  return left.threadId < right.threadId ? left : right;
}

function considerNativeOwnerCandidate(
  owners: Map<string, CommandCodeNativeOwnerCandidate>,
  registeredWorkspaceRoot: string,
  threadId: string,
  descriptor: {
    harness_adapter_id?: string;
    harness_native_session_id?: string;
    projectRoot: string;
  },
): void {
  if (descriptor.harness_adapter_id !== 'command-code') return;
  const nativeId = descriptor.harness_native_session_id;
  if (!nativeId) return;
  if (!workspaceRootMatches(descriptor.projectRoot, registeredWorkspaceRoot)) return;
  const incoming: CommandCodeNativeOwnerCandidate = {
    threadId,
    persisted: isPersistedNativeOwner(threadId, nativeId),
  };
  const existing = owners.get(nativeId);
  if (!existing) {
    owners.set(nativeId, incoming);
    return;
  }
  owners.set(nativeId, pickCanonicalNativeOwner(existing, incoming));
}

/** Durable + in-memory native session ownership for one registered workspace root. */
export async function indexCommandCodeNativeOwners(
  state: ProtocolHostState,
  registeredWorkspaceRoot: string,
): Promise<Map<string, string>> {
  const candidates = new Map<string, CommandCodeNativeOwnerCandidate>();
  const seenThreads = new Set<string>();
  for (const [threadId, descriptor] of state.descriptors) {
    seenThreads.add(threadId);
    considerNativeOwnerCandidate(candidates, registeredWorkspaceRoot, threadId, descriptor);
  }
  const threads = await listThreads({ limit: 500 });
  for (const row of threads) {
    if (seenThreads.has(row.thread_id)) continue;
    const persisted = loadSessionDescriptor(row.thread_id);
    if (!persisted) continue;
    considerNativeOwnerCandidate(candidates, registeredWorkspaceRoot, row.thread_id, persisted);
  }
  const owners = new Map<string, string>();
  for (const [nativeId, candidate] of candidates) {
    owners.set(nativeId, candidate.threadId);
  }
  return owners;
}

export async function findCanonicalCommandCodeNativeOwnerForProject(
  state: ProtocolHostState,
  projectRoot: string,
  nativeSessionId: string,
): Promise<string | undefined> {
  const owners = await indexCommandCodeNativeOwners(state, projectRoot);
  return owners.get(nativeSessionId);
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
  const nativeOwners = await indexCommandCodeNativeOwners(input.state, root);
  let vendor_sessions: RemoteVendorSessionEntry[] | undefined;
  if (input.commandCodeRegistry) {
    try {
      const listed = await input.commandCodeRegistry.listSessions(root);
      const vendorById = new Map<string, RemoteVendorSessionEntry>();
      for (const row of listed) {
        const owner = nativeOwners.get(row.sessionId);
        vendorById.set(row.sessionId, {
          session_id: row.sessionId,
          harness_adapter_id: 'command-code',
          bound: nativeOwners.has(row.sessionId),
          ...(row.title ? { title: row.title } : {}),
          ...(owner ? { canonical_thread_id: owner } : {}),
        });
      }
      for (const [sessionId, ownerThreadId] of nativeOwners) {
        if (vendorById.has(sessionId)) continue;
        const descriptor =
          loadSessionDescriptor(ownerThreadId) ?? input.state.descriptors.get(ownerThreadId);
        if (!descriptor || descriptor.harness_adapter_id !== 'command-code') continue;
        if (descriptor.harness_native_session_id !== sessionId) continue;
        if (!workspaceRootMatches(descriptor.projectRoot, root)) continue;
        vendorById.set(sessionId, {
          session_id: sessionId,
          harness_adapter_id: 'command-code',
          bound: true,
          canonical_thread_id: ownerThreadId,
          title: 'saved',
        });
      }
      vendor_sessions = [...vendorById.values()];
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

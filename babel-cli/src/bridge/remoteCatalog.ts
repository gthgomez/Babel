/**
 * Authoritative remote session catalog derived from the protocol host and thread store.
 */

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

import type { ProtocolHostState } from '../protocol/client/host.js';
import { listThreads, loadSessionDescriptor } from '../services/threadStore/index.js';
import type { CommandCodeAcpRuntimeRegistry } from './commandCodeAcpRuntime.js';
import { isPathInsideRoot } from './workspaceBound.js';

export function canonicalCommandCodeProjectRoot(projectRoot: string): string {
  try {
    return realpathSync(resolve(projectRoot));
  } catch {
    return resolve(projectRoot);
  }
}

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

const NATIVE_OWNER_KEY_SEP = '\u0000';

const commandCodeNativeBindingQueues = new Map<string, Promise<void>>();

function nativeOwnerCompositeKey(projectRoot: string, nativeId: string): string {
  return `${canonicalCommandCodeProjectRoot(projectRoot)}${NATIVE_OWNER_KEY_SEP}${nativeId}`;
}

/** Serialize conflict-check and persistence for one canonical project + native session id. */
export async function withSerializedCommandCodeNativeBinding<T>(
  projectRoot: string,
  nativeSessionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = nativeOwnerCompositeKey(projectRoot, nativeSessionId);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prev = commandCodeNativeBindingQueues.get(key) ?? Promise.resolve();
  commandCodeNativeBindingQueues.set(key, prev.then(() => gate));
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

export type CommandCodeNativeOwnershipViolation = 'none' | 'conflict' | 'corrupt';

type CommandCodeNativeDescriptor = {
  harness_adapter_id?: string;
  harness_native_session_id?: string;
  projectRoot: string;
};

function matchesCommandCodeNativeBinding(
  descriptor: CommandCodeNativeDescriptor,
  projectRoot: string,
  nativeSessionId: string,
): boolean {
  if (descriptor.harness_adapter_id !== 'command-code') return false;
  if (descriptor.harness_native_session_id !== nativeSessionId) return false;
  return nativeOwnerCompositeKey(descriptor.projectRoot, nativeSessionId) ===
    nativeOwnerCompositeKey(projectRoot, nativeSessionId);
}

/** All persisted thread ids bound to the same canonical project + native id. */
export async function listPersistedCommandCodeNativeOwnerThreadIds(
  state: ProtocolHostState,
  projectRoot: string,
  nativeSessionId: string,
): Promise<string[]> {
  const found: string[] = [];
  const seen = new Set<string>();
  const consider = (threadId: string, descriptor: CommandCodeNativeDescriptor) => {
    if (!matchesCommandCodeNativeBinding(descriptor, projectRoot, nativeSessionId)) return;
    if (!isPersistedNativeOwner(threadId, nativeSessionId)) return;
    if (seen.has(threadId)) return;
    seen.add(threadId);
    found.push(threadId);
  };
  for (const [threadId, descriptor] of state.descriptors) {
    consider(threadId, descriptor);
  }
  const threads = await listThreads({ limit: 500 });
  for (const row of threads) {
    if (seen.has(row.thread_id)) continue;
    const persisted = loadSessionDescriptor(row.thread_id);
    if (!persisted) continue;
    consider(row.thread_id, persisted);
  }
  return found.sort();
}

export async function commandCodeNativeOwnershipViolation(
  state: ProtocolHostState,
  projectRoot: string,
  nativeSessionId: string,
  exceptThreadId?: string,
): Promise<CommandCodeNativeOwnershipViolation> {
  const owners = await listPersistedCommandCodeNativeOwnerThreadIds(
    state,
    projectRoot,
    nativeSessionId,
  );
  const others = exceptThreadId ? owners.filter((id) => id !== exceptThreadId) : owners;
  if (others.length === 0) return 'none';
  if (others.length > 1) return 'corrupt';
  return 'conflict';
}

function splitNativeOwnerCompositeKey(key: string): { projectKey: string; nativeId: string } {
  const sep = key.indexOf(NATIVE_OWNER_KEY_SEP);
  return {
    projectKey: key.slice(0, sep),
    nativeId: key.slice(sep + 1),
  };
}

function considerNativeOwnerCandidate(
  owners: Map<string, CommandCodeNativeOwnerCandidate>,
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
  const key = nativeOwnerCompositeKey(descriptor.projectRoot, nativeId);
  const incoming: CommandCodeNativeOwnerCandidate = {
    threadId,
    persisted: isPersistedNativeOwner(threadId, nativeId),
  };
  const existing = owners.get(key);
  if (!existing) {
    owners.set(key, incoming);
    return;
  }
  if (existing.threadId === incoming.threadId) return;
  if (existing.persisted && incoming.persisted) {
    return;
  }
  if (incoming.persisted && !existing.persisted) {
    owners.set(key, incoming);
  }
}

async function loadCommandCodeNativeOwnerCandidates(
  state: ProtocolHostState,
): Promise<Map<string, CommandCodeNativeOwnerCandidate>> {
  const candidates = new Map<string, CommandCodeNativeOwnerCandidate>();
  const seenThreads = new Set<string>();
  for (const [threadId, descriptor] of state.descriptors) {
    seenThreads.add(threadId);
    considerNativeOwnerCandidate(candidates, threadId, descriptor);
  }
  const threads = await listThreads({ limit: 500 });
  for (const row of threads) {
    if (seenThreads.has(row.thread_id)) continue;
    const persisted = loadSessionDescriptor(row.thread_id);
    if (!persisted) continue;
    considerNativeOwnerCandidate(candidates, row.thread_id, persisted);
  }
  return candidates;
}

/** Durable + in-memory native session ownership for one registered workspace root. */
export async function indexCommandCodeNativeOwners(
  state: ProtocolHostState,
  registeredWorkspaceRoot: string,
): Promise<Map<string, string>> {
  const candidates = await loadCommandCodeNativeOwnerCandidates(state);
  const owners = new Map<string, string>();
  for (const [key] of candidates) {
    const { projectKey, nativeId } = splitNativeOwnerCompositeKey(key);
    if (!workspaceRootMatches(projectKey, registeredWorkspaceRoot)) continue;
    const persisted = await listPersistedCommandCodeNativeOwnerThreadIds(
      state,
      projectKey,
      nativeId,
    );
    if (persisted.length !== 1) continue;
    owners.set(nativeId, persisted[0]!);
  }
  return owners;
}

export async function findCanonicalCommandCodeNativeOwnerForProject(
  state: ProtocolHostState,
  projectRoot: string,
  nativeSessionId: string,
): Promise<string | undefined> {
  const persisted = await listPersistedCommandCodeNativeOwnerThreadIds(
    state,
    projectRoot,
    nativeSessionId,
  );
  if (persisted.length !== 1) return undefined;
  return persisted[0];
}

export type CommandCodeOpenNativeAuthority = 'ok' | 'corrupt' | 'conflict' | 'none';

/** Authorize harness.command_code.open: one persisted owner must equal threadId. */
export async function commandCodeOpenNativeAuthority(
  state: ProtocolHostState,
  projectRoot: string,
  nativeSessionId: string,
  threadId: string,
): Promise<CommandCodeOpenNativeAuthority> {
  const owners = await listPersistedCommandCodeNativeOwnerThreadIds(
    state,
    projectRoot,
    nativeSessionId,
  );
  if (owners.length > 1) return 'corrupt';
  if (owners.length === 0) return 'none';
  if (owners[0] !== threadId) return 'conflict';
  return 'ok';
}

/** Returns an existing persisted owner for the same canonical project + native id, if any. */
export async function conflictingPersistedCommandCodeNativeOwner(
  state: ProtocolHostState,
  projectRoot: string,
  nativeSessionId: string,
  exceptThreadId?: string,
): Promise<string | undefined> {
  const violation = await commandCodeNativeOwnershipViolation(
    state,
    projectRoot,
    nativeSessionId,
    exceptThreadId,
  );
  if (violation === 'none') return undefined;
  const owners = await listPersistedCommandCodeNativeOwnerThreadIds(
    state,
    projectRoot,
    nativeSessionId,
  );
  const others = exceptThreadId ? owners.filter((id) => id !== exceptThreadId) : owners;
  return others[0];
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

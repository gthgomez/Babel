/**
 * Authoritative remote session catalog derived from the protocol host and thread store.
 */

import { resolve } from 'node:path';

import type { ProtocolHostState } from '../protocol/client/host.js';
import { listThreads, loadSessionDescriptor } from '../services/threadStore/index.js';
import type { CommandCodeAcpRuntimeRegistry } from './commandCodeAcpRuntime.js';
import type { OpenCodeAcpRuntimeRegistry } from './openCodeAcpRuntime.js';
import type { HarnessAdapterId } from './harnessAdapterContract.js';
import { canonicalizeContained, isPathInsideRoot } from './workspaceBound.js';

/** Same canonical project identity as gateway `workspaceBound.canonicalizeContained`. */
export function canonicalHarnessProjectRoot(projectRoot: string): string {
  try {
    return canonicalizeContained(resolve(projectRoot));
  } catch {
    return resolve(projectRoot);
  }
}

/** @deprecated Use `canonicalHarnessProjectRoot`. */
export const canonicalCommandCodeProjectRoot = canonicalHarnessProjectRoot;
export const canonicalOpenCodeProjectRoot = canonicalHarnessProjectRoot;

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
  harness_adapter_id: 'command-code' | 'opencode';
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

function nativeOwnerCompositeKey(projectRoot: string, nativeId: string): string {
  return `${canonicalHarnessProjectRoot(projectRoot)}${NATIVE_OWNER_KEY_SEP}${nativeId}`;
}

/** Serialize conflict-check and persistence for one canonical project + native session id. */
const harnessNativeBindingQueues = new Map<string, Promise<void>>();

export async function withSerializedHarnessNativeBinding<T>(
  projectRoot: string,
  nativeSessionId: string,
  adapterId: HarnessAdapterId,
  fn: () => Promise<T>,
): Promise<T> {
  const key = `${adapterId}:${nativeOwnerCompositeKey(projectRoot, nativeSessionId)}`;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prev = harnessNativeBindingQueues.get(key) ?? Promise.resolve();
  harnessNativeBindingQueues.set(key, prev.then(() => gate));
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

export async function withSerializedCommandCodeNativeBinding<T>(
  projectRoot: string,
  nativeSessionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withSerializedHarnessNativeBinding(projectRoot, nativeSessionId, 'command-code', fn);
}

export async function withSerializedOpenCodeNativeBinding<T>(
  projectRoot: string,
  nativeSessionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withSerializedHarnessNativeBinding(projectRoot, nativeSessionId, 'opencode', fn);
}

export type HarnessNativeOwnershipViolation = 'none' | 'conflict' | 'corrupt';
export type CommandCodeNativeOwnershipViolation = HarnessNativeOwnershipViolation;
export type OpenCodeNativeOwnershipViolation = HarnessNativeOwnershipViolation;

type HarnessNativeDescriptor = {
  harness_adapter_id?: string;
  harness_native_session_id?: string;
  projectRoot: string;
};

function matchesHarnessNativeBinding(
  descriptor: HarnessNativeDescriptor,
  projectRoot: string,
  nativeSessionId: string,
  adapterId: HarnessAdapterId,
): boolean {
  if (descriptor.harness_adapter_id !== adapterId) return false;
  if (descriptor.harness_native_session_id !== nativeSessionId) return false;
  return nativeOwnerCompositeKey(descriptor.projectRoot, nativeSessionId) ===
    nativeOwnerCompositeKey(projectRoot, nativeSessionId);
}

/** All persisted thread ids bound to the same canonical project + native id. */
export async function listPersistedHarnessNativeOwnerThreadIds(
  state: ProtocolHostState,
  projectRoot: string,
  nativeSessionId: string,
  adapterId: HarnessAdapterId,
): Promise<string[]> {
  const found: string[] = [];
  const seen = new Set<string>();
  const consider = (threadId: string, descriptor: HarnessNativeDescriptor) => {
    if (!matchesHarnessNativeBinding(descriptor, projectRoot, nativeSessionId, adapterId)) return;
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

export async function listPersistedCommandCodeNativeOwnerThreadIds(
  state: ProtocolHostState,
  projectRoot: string,
  nativeSessionId: string,
): Promise<string[]> {
  return listPersistedHarnessNativeOwnerThreadIds(state, projectRoot, nativeSessionId, 'command-code');
}

export async function listPersistedOpenCodeNativeOwnerThreadIds(
  state: ProtocolHostState,
  projectRoot: string,
  nativeSessionId: string,
): Promise<string[]> {
  return listPersistedHarnessNativeOwnerThreadIds(state, projectRoot, nativeSessionId, 'opencode');
}

export async function harnessNativeOwnershipViolation(
  state: ProtocolHostState,
  projectRoot: string,
  nativeSessionId: string,
  adapterId: HarnessAdapterId,
  exceptThreadId?: string,
): Promise<HarnessNativeOwnershipViolation> {
  const owners = await listPersistedHarnessNativeOwnerThreadIds(
    state,
    projectRoot,
    nativeSessionId,
    adapterId,
  );
  const others = exceptThreadId ? owners.filter((id) => id !== exceptThreadId) : owners;
  if (others.length === 0) return 'none';
  if (others.length > 1) return 'corrupt';
  return 'conflict';
}

export async function commandCodeNativeOwnershipViolation(
  state: ProtocolHostState,
  projectRoot: string,
  nativeSessionId: string,
  exceptThreadId?: string,
): Promise<CommandCodeNativeOwnershipViolation> {
  return harnessNativeOwnershipViolation(state, projectRoot, nativeSessionId, 'command-code', exceptThreadId);
}

export async function openCodeNativeOwnershipViolation(
  state: ProtocolHostState,
  projectRoot: string,
  nativeSessionId: string,
  exceptThreadId?: string,
): Promise<OpenCodeNativeOwnershipViolation> {
  return harnessNativeOwnershipViolation(state, projectRoot, nativeSessionId, 'opencode', exceptThreadId);
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
  adapterId: HarnessAdapterId,
): void {
  if (descriptor.harness_adapter_id !== adapterId) return;
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

async function loadHarnessNativeOwnerCandidates(
  state: ProtocolHostState,
  adapterId: HarnessAdapterId,
): Promise<Map<string, CommandCodeNativeOwnerCandidate>> {
  const candidates = new Map<string, CommandCodeNativeOwnerCandidate>();
  const seenThreads = new Set<string>();
  for (const [threadId, descriptor] of state.descriptors) {
    seenThreads.add(threadId);
    considerNativeOwnerCandidate(candidates, threadId, descriptor, adapterId);
  }
  const threads = await listThreads({ limit: 500 });
  for (const row of threads) {
    if (seenThreads.has(row.thread_id)) continue;
    const persisted = loadSessionDescriptor(row.thread_id);
    if (!persisted) continue;
    considerNativeOwnerCandidate(candidates, row.thread_id, persisted, adapterId);
  }
  return candidates;
}

/** Durable + in-memory native session ownership for one registered workspace root. */
export async function indexHarnessNativeOwners(
  state: ProtocolHostState,
  registeredWorkspaceRoot: string,
  adapterId: HarnessAdapterId,
): Promise<Map<string, string>> {
  const candidates = await loadHarnessNativeOwnerCandidates(state, adapterId);
  const owners = new Map<string, string>();
  for (const [key] of candidates) {
    const { projectKey, nativeId } = splitNativeOwnerCompositeKey(key);
    if (!workspaceRootMatches(projectKey, registeredWorkspaceRoot)) continue;
    const persisted = await listPersistedHarnessNativeOwnerThreadIds(
      state,
      projectKey,
      nativeId,
      adapterId,
    );
    if (persisted.length !== 1) continue;
    owners.set(nativeId, persisted[0]!);
  }
  return owners;
}

export async function indexCommandCodeNativeOwners(
  state: ProtocolHostState,
  registeredWorkspaceRoot: string,
): Promise<Map<string, string>> {
  return indexHarnessNativeOwners(state, registeredWorkspaceRoot, 'command-code');
}

export async function indexOpenCodeNativeOwners(
  state: ProtocolHostState,
  registeredWorkspaceRoot: string,
): Promise<Map<string, string>> {
  return indexHarnessNativeOwners(state, registeredWorkspaceRoot, 'opencode');
}

export async function findCanonicalHarnessNativeOwnerForProject(
  state: ProtocolHostState,
  projectRoot: string,
  nativeSessionId: string,
  adapterId: HarnessAdapterId,
): Promise<string | undefined> {
  const persisted = await listPersistedHarnessNativeOwnerThreadIds(
    state,
    projectRoot,
    nativeSessionId,
    adapterId,
  );
  if (persisted.length !== 1) return undefined;
  return persisted[0];
}

export async function findCanonicalCommandCodeNativeOwnerForProject(
  state: ProtocolHostState,
  projectRoot: string,
  nativeSessionId: string,
): Promise<string | undefined> {
  return findCanonicalHarnessNativeOwnerForProject(state, projectRoot, nativeSessionId, 'command-code');
}

export async function findCanonicalOpenCodeNativeOwnerForProject(
  state: ProtocolHostState,
  projectRoot: string,
  nativeSessionId: string,
): Promise<string | undefined> {
  return findCanonicalHarnessNativeOwnerForProject(state, projectRoot, nativeSessionId, 'opencode');
}

export type HarnessOpenNativeAuthority = 'ok' | 'corrupt' | 'conflict' | 'none';
export type CommandCodeOpenNativeAuthority = HarnessOpenNativeAuthority;
export type OpenCodeOpenNativeAuthority = HarnessOpenNativeAuthority;

/** Authorize harness.*.open: one persisted owner must equal threadId. */
export async function harnessOpenNativeAuthority(
  state: ProtocolHostState,
  projectRoot: string,
  nativeSessionId: string,
  threadId: string,
  adapterId: HarnessAdapterId,
): Promise<HarnessOpenNativeAuthority> {
  const owners = await listPersistedHarnessNativeOwnerThreadIds(
    state,
    projectRoot,
    nativeSessionId,
    adapterId,
  );
  if (owners.length > 1) return 'corrupt';
  if (owners.length === 0) return 'none';
  if (owners[0] !== threadId) return 'conflict';
  return 'ok';
}

export async function commandCodeOpenNativeAuthority(
  state: ProtocolHostState,
  projectRoot: string,
  nativeSessionId: string,
  threadId: string,
): Promise<CommandCodeOpenNativeAuthority> {
  return harnessOpenNativeAuthority(state, projectRoot, nativeSessionId, threadId, 'command-code');
}

export async function openCodeOpenNativeAuthority(
  state: ProtocolHostState,
  projectRoot: string,
  nativeSessionId: string,
  threadId: string,
): Promise<OpenCodeOpenNativeAuthority> {
  return harnessOpenNativeAuthority(state, projectRoot, nativeSessionId, threadId, 'opencode');
}

/** Returns an existing persisted owner for the same canonical project + native id, if any. */
export async function conflictingPersistedHarnessNativeOwner(
  state: ProtocolHostState,
  projectRoot: string,
  nativeSessionId: string,
  adapterId: HarnessAdapterId,
  exceptThreadId?: string,
): Promise<string | undefined> {
  const violation = await harnessNativeOwnershipViolation(
    state,
    projectRoot,
    nativeSessionId,
    adapterId,
    exceptThreadId,
  );
  if (violation === 'none') return undefined;
  const owners = await listPersistedHarnessNativeOwnerThreadIds(
    state,
    projectRoot,
    nativeSessionId,
    adapterId,
  );
  const others = exceptThreadId ? owners.filter((id) => id !== exceptThreadId) : owners;
  return others[0];
}

export async function conflictingPersistedCommandCodeNativeOwner(
  state: ProtocolHostState,
  projectRoot: string,
  nativeSessionId: string,
  exceptThreadId?: string,
): Promise<string | undefined> {
  return conflictingPersistedHarnessNativeOwner(
    state,
    projectRoot,
    nativeSessionId,
    'command-code',
    exceptThreadId,
  );
}

export async function conflictingPersistedOpenCodeNativeOwner(
  state: ProtocolHostState,
  projectRoot: string,
  nativeSessionId: string,
  exceptThreadId?: string,
): Promise<string | undefined> {
  return conflictingPersistedHarnessNativeOwner(
    state,
    projectRoot,
    nativeSessionId,
    'opencode',
    exceptThreadId,
  );
}

export interface RemoteVendorSessionListError {
  harness_adapter_id: 'command-code' | 'opencode';
  error: string;
}

export interface RemoteCatalogResult {
  host: {
    execution_owner: 'protocol_host';
    registered_workspace_root: string;
  };
  workspaces: RemoteWorkspaceEntry[];
  sessions: RemoteSessionEntry[];
  vendor_sessions?: RemoteVendorSessionEntry[];
  vendor_session_list_errors?: RemoteVendorSessionListError[];
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

async function appendVendorSessionsForAdapter(
  input: {
    state: ProtocolHostState;
    registeredWorkspaceRoot: string;
    adapterId: 'command-code' | 'opencode';
    listSessions: (root: string) => Promise<Array<{ sessionId: string; title?: string }>>;
  },
  nativeOwners: Map<string, string>,
): Promise<RemoteVendorSessionEntry[]> {
  const vendorById = new Map<string, RemoteVendorSessionEntry>();
  const listed = await input.listSessions(input.registeredWorkspaceRoot);
  for (const row of listed) {
    const owner = nativeOwners.get(row.sessionId);
    vendorById.set(row.sessionId, {
      session_id: row.sessionId,
      harness_adapter_id: input.adapterId,
      bound: nativeOwners.has(row.sessionId),
      ...(row.title ? { title: row.title } : {}),
      ...(owner ? { canonical_thread_id: owner } : {}),
    });
  }
  for (const [sessionId, ownerThreadId] of nativeOwners) {
    if (vendorById.has(sessionId)) continue;
    const descriptor =
      loadSessionDescriptor(ownerThreadId) ?? input.state.descriptors.get(ownerThreadId);
    if (!descriptor || descriptor.harness_adapter_id !== input.adapterId) continue;
    if (descriptor.harness_native_session_id !== sessionId) continue;
    if (!workspaceRootMatches(descriptor.projectRoot, input.registeredWorkspaceRoot)) continue;
    vendorById.set(sessionId, {
      session_id: sessionId,
      harness_adapter_id: input.adapterId,
      bound: true,
      canonical_thread_id: ownerThreadId,
      title: 'saved',
    });
  }
  return [...vendorById.values()];
}

export async function buildRemoteCatalog(input: {
  state: ProtocolHostState;
  registeredWorkspaceRoot: string;
  threadOwner?: (threadId: string) => string | undefined;
  commandCodeRegistry?: CommandCodeAcpRuntimeRegistry;
  openCodeRegistry?: OpenCodeAcpRuntimeRegistry;
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
  const vendor_sessions: RemoteVendorSessionEntry[] = [];
  const vendor_session_list_errors: RemoteVendorSessionListError[] = [];
  if (input.commandCodeRegistry) {
    try {
      const nativeOwners = await indexCommandCodeNativeOwners(input.state, root);
      vendor_sessions.push(
        ...(await appendVendorSessionsForAdapter(
          {
            state: input.state,
            registeredWorkspaceRoot: root,
            adapterId: 'command-code',
            listSessions: (r) => input.commandCodeRegistry!.listSessions(r),
          },
          nativeOwners,
        )),
      );
    } catch (error) {
      vendor_session_list_errors.push({
        harness_adapter_id: 'command-code',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (input.openCodeRegistry) {
    try {
      const nativeOwners = await indexOpenCodeNativeOwners(input.state, root);
      vendor_sessions.push(
        ...(await appendVendorSessionsForAdapter(
          {
            state: input.state,
            registeredWorkspaceRoot: root,
            adapterId: 'opencode',
            listSessions: (r) => input.openCodeRegistry!.listSessions(r),
          },
          nativeOwners,
        )),
      );
    } catch (error) {
      vendor_session_list_errors.push({
        harness_adapter_id: 'opencode',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    host: {
      execution_owner: 'protocol_host',
      registered_workspace_root: root,
    },
    workspaces,
    sessions,
    ...(vendor_sessions.length > 0 ? { vendor_sessions } : {}),
    ...(vendor_session_list_errors.length > 0 ? { vendor_session_list_errors } : {}),
  };
}

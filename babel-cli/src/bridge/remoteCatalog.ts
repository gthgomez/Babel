/**
 * Authoritative remote session catalog derived from the protocol host and thread store.
 */

import type { ProtocolHostState } from '../protocol/client/host.js';
import { listThreads } from '../services/threadStore/index.js';
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
  owned_by_bridge_session?: string;
}

export interface RemoteCatalogResult {
  host: {
    execution_owner: 'protocol_host';
    registered_workspace_root: string;
  };
  workspaces: RemoteWorkspaceEntry[];
  sessions: RemoteSessionEntry[];
}

function workspaceLabel(projectRoot: string): string {
  const parts = projectRoot.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] ?? projectRoot;
}

function sessionStatus(
  state: ProtocolHostState,
  threadId: string,
): RemoteSessionStatus {
  if (state.activeTurns.has(threadId)) return 'running';
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
}): Promise<RemoteCatalogResult> {
  const root = input.registeredWorkspaceRoot;
  const workspaces: RemoteWorkspaceEntry[] = [
    { project_root: root, label: workspaceLabel(root) },
  ];

  const byId = new Map<string, RemoteSessionEntry>();

  for (const [threadId, descriptor] of input.state.descriptors) {
    if (!workspaceRootMatches(descriptor.projectRoot, root)) continue;
    const owner = input.threadOwner?.(threadId);
    byId.set(threadId, {
      thread_id: threadId,
      project_root: descriptor.projectRoot,
      mode: descriptor.mode,
      status: sessionStatus(input.state, threadId),
      preview: descriptor.task?.slice(0, 72) ?? '(active session)',
      updated_at: Date.parse(descriptor.createdAt) || Date.now(),
      active_turn: input.state.activeTurns.has(threadId),
      ...(owner ? { owned_by_bridge_session: owner } : {}),
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
    byId.set(thread.thread_id, {
      thread_id: thread.thread_id,
      project_root: thread.project_root ?? root,
      mode: 'chat',
      status: sessionStatus(input.state, thread.thread_id),
      preview: thread.preview ?? '(thread store)',
      updated_at: thread.updated_at,
      active_turn: input.state.activeTurns.has(thread.thread_id),
      ...(owner ? { owned_by_bridge_session: owner } : {}),
    });
  }

  const sessions = [...byId.values()].sort((a, b) => b.updated_at - a.updated_at);
  return {
    host: {
      execution_owner: 'protocol_host',
      registered_workspace_root: root,
    },
    workspaces,
    sessions,
  };
}

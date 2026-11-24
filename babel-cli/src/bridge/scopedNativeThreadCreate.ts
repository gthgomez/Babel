import { realpathSync } from 'node:fs';
import type { JsonRpcResponse } from '../protocol/jsonRpc.js';
import type { ProtocolGateway } from './protocolGateway.js';
import type { NativeCommandJournal } from './commandJournal.js';
import { allocateThreadId } from '../services/threadStore/threadIds.js';

export interface ScopedNativePrincipal {
  principalId: string;
  projectId: string;
  sessionBinding: string;
  registrationGeneration: number;
  projectGeneration: number;
  hostInstanceId: string;
}

export interface ScopedRegisteredProject {
  projectId: string;
  canonicalRoot: string;
  generation: number;
}

export interface ScopedThreadCreateInput {
  acpCredential: string;
  transportSessionId: string;
  commandId: string;
  projectId: string;
  sessionBinding: string;
  expectedProjectGeneration: number;
  expectedHostInstance: string;
}

export type ScopedThreadCreateResult =
  | { ok: true; replayed: boolean; response: JsonRpcResponse }
  | { ok: false; reason: 'integration_authentication_required' | 'project_scope_denied' |
    'project_identity_changed' | 'stale_host_instance' | 'command_fingerprint_conflict' |
    'native_create_unavailable'; threadId?: string }
  | { ok: false; reason: 'reconcile_required'; threadId?: string };

/**
 * Strict, non-transport admission seam for native thread creation. A caller
 * must supply an authority backed by durable ACP principal/project records.
 * It deliberately exposes no task/prompt, adapter, provider or model input.
 */
export async function createScopedNativeThread(
  input: ScopedThreadCreateInput,
  deps: {
    resolveTransportSession: (input: { sessionId: string; acpCredential: string; expectedHostInstance: string }) =>
      (ScopedNativePrincipal & { transportSessionId: string }) | null;
    resolveProject: (projectId: string) => ScopedRegisteredProject | null;
    currentHostInstance: string;
    gateway: Pick<ProtocolGateway, 'dispatchScopedNativeThreadCreate'>;
    journal: NativeCommandJournal;
  },
): Promise<ScopedThreadCreateResult> {
  if (!input.commandId || input.commandId.length > 128) return { ok: false, reason: 'native_create_unavailable' };
  const principal = deps.resolveTransportSession({ sessionId: input.transportSessionId,
    acpCredential: input.acpCredential, expectedHostInstance: deps.currentHostInstance });
  if (!principal) return { ok: false, reason: 'integration_authentication_required' };
  if (principal.projectId !== input.projectId || principal.sessionBinding !== input.sessionBinding) {
    return { ok: false, reason: 'project_scope_denied' };
  }
  if (principal.hostInstanceId !== deps.currentHostInstance || input.expectedHostInstance !== deps.currentHostInstance) {
    return { ok: false, reason: 'stale_host_instance' };
  }
  if (principal.projectGeneration !== input.expectedProjectGeneration) {
    return { ok: false, reason: 'project_identity_changed' };
  }
  const project = deps.resolveProject(input.projectId);
  if (!project || project.projectId !== principal.projectId) return { ok: false, reason: 'project_scope_denied' };
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(project.canonicalRoot);
  } catch {
    return { ok: false, reason: 'project_identity_changed' };
  }
  if (project.generation !== principal.projectGeneration ||
      project.generation !== input.expectedProjectGeneration || canonicalRoot !== project.canonicalRoot) {
    return { ok: false, reason: 'project_identity_changed' };
  }

  const plannedThreadId = allocateThreadId();
  const reservation = deps.journal.reserve({
    commandId: input.commandId,
    principalId: principal.principalId,
    projectId: principal.projectId,
    threadId: plannedThreadId,
    hostInstanceId: principal.hostInstanceId,
    registrationGeneration: principal.registrationGeneration,
    payload: {
      method: 'thread.create', projectId: project.projectId, projectGeneration: project.generation,
      projectRoot: canonicalRoot, sessionBinding: principal.sessionBinding,
      principalGeneration: principal.registrationGeneration,
    },
  });
  if (!reservation.ok) return { ok: false, reason: 'command_fingerprint_conflict' };
  if (!reservation.created) {
    if (reservation.record.state === 'settled' && reservation.record.resultJson) {
      try {
        return { ok: true, replayed: true, response: JSON.parse(reservation.record.resultJson) as JsonRpcResponse };
      } catch {
        return { ok: false, reason: 'reconcile_required' };
      }
    }
    return { ok: false, reason: 'reconcile_required', ...(reservation.record.threadId ? { threadId: reservation.record.threadId } : {}) };
  }

  const currentProject = deps.resolveProject(input.projectId);
  let currentRoot: string | null = null;
  try { currentRoot = currentProject ? realpathSync(currentProject.canonicalRoot) : null; } catch { /* fail closed below */ }
  if (!currentProject || currentProject.generation !== principal.projectGeneration ||
      currentRoot !== canonicalRoot || deps.currentHostInstance !== principal.hostInstanceId) {
    deps.journal.markUnknown({ commandId: input.commandId, principalId: principal.principalId });
    return { ok: false, reason: currentProject ? 'project_identity_changed' : 'project_scope_denied', threadId: plannedThreadId };
  }

  try {
    const response = await deps.gateway.dispatchScopedNativeThreadCreate({
      threadId: plannedThreadId,
      commandId: input.commandId,
      principalId: principal.principalId,
      transportSessionId: principal.transportSessionId,
      projectId: principal.projectId,
      projectRoot: canonicalRoot,
      projectGeneration: project.generation,
      hostInstanceId: principal.hostInstanceId,
    });
    const result = 'result' in response ? response.result as { thread_id?: unknown } : null;
    if (!result || result.thread_id !== plannedThreadId) {
      deps.journal.markUnknown({ commandId: input.commandId, principalId: principal.principalId });
      return { ok: false, reason: 'reconcile_required', threadId: plannedThreadId };
    }
    if (!deps.journal.settle({ commandId: input.commandId, principalId: principal.principalId,
      result: response, threadId: plannedThreadId })) {
      return { ok: false, reason: 'reconcile_required', threadId: plannedThreadId };
    }
    return { ok: true, replayed: false, response };
  } catch {
    deps.journal.markUnknown({ commandId: input.commandId, principalId: principal.principalId });
    return { ok: false, reason: 'reconcile_required', threadId: plannedThreadId };
  }
}

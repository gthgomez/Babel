/**
 * chatEngineLiveSession.ts — thin H2/H3 live-session host helpers for ChatEngine.
 * Keeps chatEngine.ts under the architectural size ratchet.
 */

import { createHash } from 'node:crypto';
import type { ParityRuntime } from './chatEngineParityBridge.js';
import { assertSessionEventRecoveryReconciliationCausality, assertSessionEventToolLifecycleCausalities, assertSessionEventCompactionLifecycleCausality, type SessionEvent, type SessionEventLog } from './sessionEvents.js';
import type { ThreadEvent, ThreadEventLog } from './threadEventLog.js';
import type { LiveSessionV1 } from './liveSession.js';
import {
  resolveLiveSessionAuthority,
  persistLiveSessionAuthority,
  loadLiveSessionAuthority,
  loadLiveSessionAuthorityStrict,
  projectFromDurableSession,
  persistLiveSessionSnapshot,
  recoverCheckpointArtifacts,
  canMutateWithIdempotencyKey,
} from './liveSessionBridge.js';
import { paritySettleInterruptedOnResume } from './chatEngineParityBridge.js';

/** Minimal options slice — avoids circular import with chatEngine.ts. */
export interface LiveAuthorityOptionsSlice {
  projectRoot: string;
  task: string;
  model?: string;
  maxTurns?: number;
  requiredVerifierCommands?: readonly string[] | null;
}

export function initLiveAuthorityOnEngine(input: {
  parity: ParityRuntime;
  options: LiveAuthorityOptionsSlice;
  taskClass: string;
  executionProfile: string;
  engineRunDir: string;
}): void {
    const mode =
      input.executionProfile === 'plan'
        ? 'plan'
        : input.executionProfile === 'deep'
          ? 'deep'
          : 'chat';
    input.parity.liveAuthority = resolveLiveSessionAuthority({
      mode,
      projectRoot: input.options.projectRoot,
      task: input.options.task,
      taskClass: input.taskClass,
      ...(input.options.model ? { modelId: input.options.model } : {}),
      ...(input.options.maxTurns !== undefined
        ? { maxTurns: input.options.maxTurns }
        : {}),
      verifierRequirements: input.options.requiredVerifierCommands
        ? [...input.options.requiredVerifierCommands]
        : [],
    });
    persistLiveSessionAuthority(input.engineRunDir, input.parity.liveAuthority);
}

export function projectEngineLiveSession(
  parity: ParityRuntime,
  budgetCeilings?: {
    turns?: number;
    tokens?: number;
    repair_attempts?: number;
    infra_retries?: number;
  },
): LiveSessionV1 {
  const live = projectFromDurableSession({
    sessionLog: parity.sessionEvents,
    threadLog: parity.eventLog,
    ...(parity.liveAuthority ? { authority: parity.liveAuthority } : {}),
    ...(budgetCeilings ? { budgetCeilings } : {}),
  });
  parity.liveSession = live;
  return live;
}

/** Fail closed unless every C2 commit names exactly its durable thread capsule. */
function assertCompactionThreadLinks(log: SessionEventLog, threadLog: ThreadEventLog): void {
  for (const committed of log.events) {
    if (committed.kind !== 'compaction_committed') continue;
    const summary = log.events.find(
      (event): event is Extract<SessionEvent, { kind: 'compaction_summary' }> =>
        event.kind === 'compaction_summary' && event.operation_id === committed.operation_id,
    );
    const capsules = threadLog.events.filter(
      (event): event is Extract<ThreadEvent, { kind: 'compaction_capsule' }> =>
        event.kind === 'compaction_capsule' && event.event_id === committed.thread_event_id,
    );
    if (!summary || capsules.length !== 1) {
      throw new Error(`C2 compaction ${committed.operation_id} must link exactly one durable thread capsule`);
    }
    const capsule = capsules[0]!;
    const digest = createHash('sha256').update(capsule.content).digest('hex');
    if (digest !== committed.capsule_digest ||
      capsule.preserved_tool_call_ids.length !== summary.preserved_tool_call_ids.length ||
      capsule.preserved_tool_call_ids.length !== committed.preserved_tool_call_ids.length ||
      capsule.preserved_tool_call_ids.some((id, index) => id !== summary.preserved_tool_call_ids[index]) ||
      capsule.preserved_tool_call_ids.some((id, index) => id !== committed.preserved_tool_call_ids[index])) {
      throw new Error(`C2 compaction ${committed.operation_id} does not match its durable thread capsule`);
    }
  }
}

export function restoreEngineSessionEvents(input: {
  parity: ParityRuntime;
  log: SessionEventLog;
  runDir: string;
}): number {
  assertSessionEventToolLifecycleCausalities(input.log);
  assertSessionEventCompactionLifecycleCausality(input.log);
  assertSessionEventRecoveryReconciliationCausality(input.log);
  assertCompactionThreadLinks(input.log, input.parity.eventLog);
  recoverCheckpointArtifacts(input.runDir);
  input.parity.sessionEvents = input.log;
  const interrupted = paritySettleInterruptedOnResume(input.parity, input.runDir);
  const authority = loadLiveSessionAuthorityStrict(input.runDir);
  input.parity.liveAuthority = authority;
  input.parity.liveSession = projectFromDurableSession({
    sessionLog: input.parity.sessionEvents,
    threadLog: input.parity.eventLog,
    ...(input.parity.liveAuthority
      ? { authority: input.parity.liveAuthority }
      : {}),
  });
  try {
    if (input.parity.liveSession) {
      persistLiveSessionSnapshot(input.runDir, input.parity.liveSession);
    }
  } catch {
    /* best-effort */
  }
  return interrupted;
}

export function engineCanMutateKey(parity: ParityRuntime, key: string): boolean {
  return canMutateWithIdempotencyKey(projectEngineLiveSession(parity), key);
}

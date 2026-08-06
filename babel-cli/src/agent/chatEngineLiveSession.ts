/**
 * chatEngineLiveSession.ts — thin H2/H3 live-session host helpers for ChatEngine.
 * Keeps chatEngine.ts under the architectural size ratchet.
 */

import type { ParityRuntime } from './chatEngineParityBridge.js';
import type { SessionEventLog } from './sessionEvents.js';
import type { LiveSessionV1 } from './liveSession.js';
import {
  resolveLiveSessionAuthority,
  persistLiveSessionAuthority,
  loadLiveSessionAuthority,
  projectFromDurableSession,
  persistLiveSessionSnapshot,
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
  try {
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
  } catch {
    /* best-effort */
  }
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

export function restoreEngineSessionEvents(input: {
  parity: ParityRuntime;
  log: SessionEventLog;
  runDir: string;
}): number {
  input.parity.sessionEvents = input.log;
  const interrupted = paritySettleInterruptedOnResume(input.parity, input.runDir);
  const authority = loadLiveSessionAuthority(input.runDir);
  if (authority) input.parity.liveAuthority = authority;
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

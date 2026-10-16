/**
 * chatEngineLiveSession.ts — thin H2/H3 live-session host helpers for ChatEngine.
 * Keeps chatEngine.ts under the architectural size ratchet.
 */

import { createHash } from 'node:crypto';
import {sha256Canonical} from '../acceptance/canonical.js';
import type { ParityRuntime } from './chatEngineParityBridge.js';
import { assertSessionEventRecoveryReconciliationCausality, assertSessionEventToolLifecycleCausalities, assertSessionEventCompactionLifecycleCausality,createSessionEventLog,loadSessionEventLogIfPresentForResume,loadSessionEventLogForResume, type SessionEvent, type SessionEventLog } from './sessionEvents.js';
import {loadThreadEventLogFromDir,type ThreadEvent,type ThreadEventLog} from './threadEventLog.js';
import {assertConversationRestoreScope} from './chatExecutionScope.js';
import type { LiveSessionV1 } from './liveSession.js';
import {
  resolveLiveSessionAuthority,
  persistLiveSessionAuthority,
  loadLiveSessionAuthority,
  loadLiveSessionAuthorityStrict,
  projectFromDurableSession,
  persistLiveSessionSnapshot,
  loadLiveSessionSnapshot,
  recoverCheckpointArtifacts,
  canMutateWithIdempotencyKey,
  type LiveSessionAuthority,
} from './liveSessionBridge.js';
import { paritySettleInterruptedOnResume,checkpointParityEventLogStrictSync } from './chatEngineParityBridge.js';
import {reviseTaskModeCompanion} from './taskModeRevision.js';
import {advanceObjectiveMode} from './taskObjectiveLifecycle.js';
import { loadProjectSessionIdentityDispositionSync } from '../interactive/identity.js';
import { AUTHORITY_SESSION_FILENAME, establishAuthoritySession } from '../authority/sessionContext.js';
import {
  evaluateSessionTaskGate,
  type HumanEscalationResult,
} from '../authority/taskClarity.js';
import { join } from 'node:path';
import type { ChatCompiledStack } from './chatStackCompile.js';
import type {ChatExecutionScope} from './chatExecutionScope.js';

/** Minimal options slice — avoids circular import with chatEngine.ts. */
export interface LiveAuthorityOptionsSlice {
  projectRoot: string | null;
  executionScope?: ChatExecutionScope;
  task: string;
  resumeExisting?: boolean;
  retainedHistory?: boolean;
  instructionRoot?: string;
  workspaceRoot?: string | null;
  model?: string;
  maxTurns?: number;
  requiredVerifierCommands?: readonly string[] | null;
  compiledChatStack?: ChatCompiledStack;
}

export interface RefreshableAuthorityInput {
  taskId?:string;
  objectiveLifecycle?:boolean;
  parity: ParityRuntime;
  options: LiveAuthorityOptionsSlice;
  taskClass: string;
  executionProfile: string;
  engineRunDir: string;
}

/**
 * Rebuild the delivered-instruction authority (manifest + chat stack) from the
 * engine's *current* options and roots, then persist it.
 *
 * `applyTurnPreparation` on a reused engine replaces `projectRoot` /
 * `instructionRoot` / `systemContext` after construction, so a manifest built
 * only in the constructor silently misreports what later turns actually
 * delivered. Call this from the turn-preparation path (see the report: the call
 * site lives in the reserved `chatEngine.ts`) to keep the manifest current.
 *
 * Same-mode refresh preserves the frozen contract. A requested supported mode
 * creates a linked immutable revision with the same objective and acceptance,
 * committed with its manifest/history through the existing strict journal.
 */
export function prepareEngineInstructionAuthority(
  input: RefreshableAuthorityInput,
): LiveSessionAuthority {
  const mode =
    input.executionProfile === 'plan'
      ? 'plan'
      : input.executionProfile === 'deep'
        ? 'deep'
        : 'chat';
  // Delivered session identity is loaded from the same root that supplies
  // identity to the request (instructionRoot wins for trusted review), so the
  // manifest reports delivered files. Candidate-controlled target instructions
  // are never read when a trusted instructionRoot is set.
  const identityRoot = input.options.instructionRoot ?? input.options.projectRoot;
  const identity = identityRoot ? loadProjectSessionIdentityDispositionSync(
    identityRoot,
    input.options.instructionRoot ?? input.options.workspaceRoot ?? null,
  ) : {fragments:[]};
  return resolveLiveSessionAuthority({
    mode,
    ...(input.taskId?{taskId:input.taskId}:{}),
    ...(input.objectiveLifecycle?{objectiveLifecycle:true}:{}),
    projectRoot: input.options.projectRoot,
    ...(input.options.executionScope?{executionScope:input.options.executionScope}:{}),
    ...(input.options.instructionRoot ? { instructionRoot: input.options.instructionRoot } : {}),
    task: input.options.task,
    ...(input.options.compiledChatStack ? { compiledChatStack: input.options.compiledChatStack } : {}),
    taskClass: input.taskClass,
    ...(input.options.model ? { modelId: input.options.model } : {}),
    ...(input.options.maxTurns !== undefined ? { maxTurns: input.options.maxTurns } : {}),
    verifierRequirements: input.options.requiredVerifierCommands
      ? [...input.options.requiredVerifierCommands]
      : [],
    systemContextFragments: identity.fragments,
  });
}

export function refreshEngineInstructionManifest(input:RefreshableAuthorityInput):LiveSessionAuthority{
  const resolved=prepareEngineInstructionAuthority(input),mode=resolved.taskContract.mode;
  const current = input.parity.liveAuthority;
  const authority: LiveSessionAuthority = current
    ? {
        ...current,
        instructionManifest: resolved.instructionManifest,
        ...(resolved.chatStack ? { chatStack: resolved.chatStack } : {}),
      }
    : resolved;
  if(current&&current.taskContract.mode!==mode){
    const revised=reviseTaskModeCompanion(current.taskContract,mode,current.taskModeHistory??{schema_version:1,revisions:[current.taskContract]});
    if(input.options.resumeExisting===true||input.options.retainedHistory===true)hydrateRetainedModeSources(input);
    authority.taskContract=revised.contract;
    authority.taskModeHistory=revised.history;
    if(current.taskObjectiveLifecycle)authority.taskObjectiveLifecycle=advanceObjectiveMode(current.taskObjectiveLifecycle,{taskContract:authority.taskContract,taskModeHistory:authority.taskModeHistory});
    input.parity.liveAuthority=authority;
    const receipt=checkpointParityEventLogStrictSync(input.parity,input.engineRunDir);
    if(receipt.status!=='committed'){
      input.parity.liveAuthority=current;
      throw new Error('MODE_TRANSITION_NOT_COMMITTED: The prior mode is retained; repair session storage before retrying');
    }
    return authority;
  }
  input.parity.liveAuthority = authority;
  persistLiveSessionAuthority(input.engineRunDir, authority);
  return authority;
}

export function initLiveAuthorityOnEngine(input: RefreshableAuthorityInput): void {
    if(input.options.projectRoot)input.parity.authoritySession = establishAuthoritySession({
      repoRoot: input.options.projectRoot,
      persistPath: join(input.engineRunDir, AUTHORITY_SESSION_FILENAME),
    });
    else delete input.parity.authoritySession;
    refreshEngineInstructionManifest(input);
    refreshTaskAuthorityGate(input.parity, input.options.task);
}

function retainCompleteLog<T extends {events:unknown[]}>(current:T,durable:T):T{
  for(let index=0;index<Math.min(current.events.length,durable.events.length);index++)if(sha256Canonical(current.events[index])!==sha256Canonical(durable.events[index]))throw new Error('MODE_HISTORY_DIVERGED: Reconcile retained session history before changing modes');
  return current.events.length>=durable.events.length?current:durable;
}

/** Every retained-mode checkpoint uses complete compatible sources, including a
 * delayed selection after a cells/legacy resume. Pending live appends survive.
 */
export function hydrateRetainedModeSources(input:RefreshableAuthorityInput):void{
  const thread=loadThreadEventLogFromDir(input.engineRunDir);
  if(!thread)throw new Error('MODE_HISTORY_SOURCE_MISSING: Reopen this legacy session in its prior mode; a mode change requires its retained canonical history');
  assertConversationRestoreScope(thread,input.options);
  if(thread.thread_id!==input.parity.eventLog.thread_id)throw new Error('MODE_HISTORY_DIVERGED: Retained thread identity does not match');
  // A newly forked thread has no accepted turn yet. Missing is valid only for
  // that empty canonical generation; existing or malformed logs still validate.
  const session=thread.events.length===0&&input.parity.sessionEvents.events.length===0
    ?loadSessionEventLogIfPresentForResume(input.engineRunDir,thread.thread_id)??createSessionEventLog(thread.thread_id)
    :loadSessionEventLogForResume(input.engineRunDir,thread.thread_id);
  const retainedThread=retainCompleteLog(input.parity.eventLog,thread),retainedSession=retainCompleteLog(input.parity.sessionEvents,session);
  // Durable logs own event data; staging and subscribers belong to this runtime.
  input.parity.eventLog=retainedThread;input.parity.sessionEvents={...retainedSession,
    ...(input.parity.sessionEvents.observationBus?{observationBus:input.parity.sessionEvents.observationBus}:{}),
    ...(input.parity.sessionEvents.deferObservations?{deferObservations:true}:{}),
  };
  input.parity.authorizedObservationIds=new Set([...(input.parity.authorizedObservationIds??[]),...(loadLiveSessionSnapshot(input.engineRunDir)?.authorized_observation_ids??[])]);
}

/** A cold selection uses the same guard as a later resumed-mode preparation. */
export function refreshRestoredEngineMode(input:RefreshableAuthorityInput):void{
  refreshEngineInstructionManifest({...input,options:{...input.options,resumeExisting:true}});
}

function looksLikeClarificationAnswer(
  task: string,
  pending: { capability: string; options?: string[] },
): boolean {
  const trimmed = task.trim();
  if (pending.options?.some((opt) => opt.toLowerCase() === trimmed.toLowerCase())) return true;
  if (pending.capability === 'merge' || pending.capability === 'pr_mark_ready') {
    return /^#?\d+$/.test(trimmed);
  }
  if (pending.capability === 'production_deploy') {
    return /^(production|prod|staging|stage)$/i.test(trimmed);
  }
  if (pending.capability === 'force_push') {
    return /^(feat|fix)\//.test(trimmed);
  }
  return false;
}

export function refreshTaskAuthorityGate(
  parity: ParityRuntime,
  task: string,
): HumanEscalationResult {
  const pending = parity.pendingTaskClarification;
  const usePending = pending !== undefined && looksLikeClarificationAnswer(task, pending);
  const gate = evaluateSessionTaskGate({
    task,
    lease: parity.authoritySession?.lease ?? null,
    ...(usePending && pending ? { pending } : {}),
  });
  parity.taskAuthorityGate = gate;
  if (gate.kind === 'clarification' && gate.clarity.outcome === 'needs_clarification') {
    const capability =
      /deploy/i.test(task) ? 'production_deploy' : /force[-\s]?push/i.test(task) ? 'force_push' : 'merge';
    parity.pendingTaskClarification = {
      capability,
      ...(gate.clarity.options ? { options: gate.clarity.options } : {}),
    };
  } else if (gate.kind !== 'clarification') {
    delete parity.pendingTaskClarification;
  }
  return gate;
}

/** Non-null when ChatEngine must halt before tool dispatch. */
export function taskAuthorityHaltMessage(gate: HumanEscalationResult | undefined): {
  kind: 'clarification' | 'deny';
  message: string;
} | null {
  if (!gate) return null;
  if (gate.kind === 'clarification' && gate.clarity.outcome === 'needs_clarification') {
    return { kind: 'clarification', message: gate.clarity.question };
  }
  if (gate.kind === 'deny') {
    return { kind: 'deny', message: gate.reasonCode ?? 'DENY_MISSING_AUTHORITY' };
  }
  return null;
}

const ZERO_USAGE = {
  totalCostUSD: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalTokens: 0,
  modelBreakdown: {},
};

/** Refresh the session gate and return a ChatEngine stream event when work must halt. */
export function evaluateSubmitTaskAuthorityHalt(
  parity: ParityRuntime,
  task: string,
): { type: 'failed'; error: string } | { type: 'done'; answer: string; usage: typeof ZERO_USAGE } | null {
  const gate = refreshTaskAuthorityGate(parity, task);
  const halt = taskAuthorityHaltMessage(gate);
  if (!halt) return null;
  if (halt.kind === 'deny') return { type: 'failed', error: halt.message };
  return { type: 'done', answer: halt.message, usage: ZERO_USAGE };
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
    authorizedObservationIds: [...(parity.authorizedObservationIds ?? [])],
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
    authorizedObservationIds: [...(input.parity.authorizedObservationIds ?? [])],
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

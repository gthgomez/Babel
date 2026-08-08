/**
 * Durable H2/H3 authority bridge for the governed V9 Plan and Deep paths.
 *
 * This deliberately shares the existing LiveSessionV1 projection instead of
 * introducing another executor or session format. It records authority before
 * planning/execution begins and records an honest terminal mapping at finalization.
 * Tool-level pre-effect idempotency remains owned by the Chat controller until the
 * governed executor can emit equivalent boundaries in real time.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { BabelMode, ToolEffectClass } from '../executor/contracts.js';
import { buildInstructionManifestV1 } from '../agent/instructionManifest.js';
import {
  persistLiveSessionAuthority,
  persistLiveSessionSnapshot,
  projectFromDurableSession,
  type LiveSessionAuthority,
} from '../agent/liveSessionBridge.js';
import {
  buildTaskContractV1,
  freezeTaskContract,
  type TaskClass,
} from '../agent/taskContract.js';
import {
  createSessionEventLog,
  flushSessionEventLogStrict,
  recordBudgetSnapshot,
  recordCompletionDecision,
  recordModelStarted,
  recordTurnEnded,
  recordUserSubmitted,
  type SessionEventLog,
} from '../agent/sessionEvents.js';
import type { TerminalOutcome } from '../schemas/agentContracts.js';

export interface V9LiveSessionRuntime {
  readonly authority: LiveSessionAuthority;
  readonly sessionEvents: SessionEventLog;
  readonly runDir: string;
  readonly turnId: string;
  readonly projectRoot: string;
  readonly workspaceRevision?: string;
}

export interface InitializeV9LiveSessionInput {
  runDir: string;
  sessionId?: string;
  mode: Extract<BabelMode, 'plan' | 'deep'>;
  task: string;
  projectRoot: string;
  promptManifestPaths: readonly string[];
  modelId?: string;
}

function gitRevision(projectRoot: string): string | undefined {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: projectRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  return result.status === 0 ? result.stdout.trim() || undefined : undefined;
}

function taskClassForMode(mode: InitializeV9LiveSessionInput['mode']): TaskClass {
  return mode === 'plan' ? 'plan_only' : 'general_swe';
}

function effectsForMode(mode: InitializeV9LiveSessionInput['mode']): ToolEffectClass[] {
  return mode === 'plan'
    ? ['read_only']
    : ['read_only', 'idempotent', 'reconcilable_mutation', 'non_idempotent_local_effect'];
}

function outcomeForPipelineStatus(status: string, verifierSatisfied: boolean): TerminalOutcome {
  if (status === 'COMPLETE') return verifierSatisfied ? 'VERIFIED_COMPLETE' : 'UNVERIFIED_PATCH';
  if (status === 'COMPLETE_NO_MODIFICATION' || status === 'READ_ONLY_NO_MODIFICATION') {
    return 'NO_CHANGE_REQUIRED';
  }
  if (status === 'MANUAL_BRIDGE_REQUIRED') return 'NEEDS_HUMAN_DECISION';
  if (status === 'SHELL_COMMAND_DENIED' || status === 'WORKTREE_DIRTY_UNSAFE') {
    return 'BLOCKED_POLICY';
  }
  if (status.includes('MAX_ATTEMPTS') || status === 'EVIDENCE_LOOP_EXCEEDED') {
    return 'BUDGET_EXHAUSTED';
  }
  if (status === 'VERIFIER_NOT_FOUND') return 'BLOCKED_EXTERNAL';
  return 'AGENT_FAILURE';
}

/** Freeze and persist the V9 authority after typed stack resolution, before planning/acting. */
export function initializeV9LiveSession(input: InitializeV9LiveSessionInput): V9LiveSessionRuntime {
  if (input.promptManifestPaths.length === 0) {
    throw new Error('V9 live-session authority requires a resolved prompt manifest');
  }
  const pathContents = new Map(
    input.promptManifestPaths.map((path) => [path, readFileSync(path, 'utf8')]),
  );
  const workspaceRevision = gitRevision(input.projectRoot);
  const taskClass = taskClassForMode(input.mode);
  const authority: LiveSessionAuthority = {
    instructionManifest: buildInstructionManifestV1({
      mode: input.mode,
      taskClass,
      promptManifestPaths: input.promptManifestPaths,
      pathContents,
      inlineRules: [
        {
          rule_id: 'v9:governed-runtime-boundary',
          source: 'pipeline/liveSessionParity',
          content: 'The governed V9 runtime persists the resolved stack and frozen task contract before acting.',
          precedence: 'policy',
          selection_reason: 'v9_h2_h3_contract_parity',
          policy_class: 'mechanical',
        },
      ],
    }),
    taskContract: freezeTaskContract(buildTaskContractV1({
      mode: input.mode,
      user_request: input.task,
      task_class: taskClass,
      acceptance_criteria: [input.task],
      non_goals: ['Do not expand scope beyond the user request'],
      allowed_paths: [input.projectRoot],
      protected_paths: ['.env', '.git'],
      baseline_reproduction: 'git rev-parse HEAD',
      ...(workspaceRevision
        ? { baseline_verifier_state: { command: 'git rev-parse HEAD', exit_code: 0, summary: workspaceRevision } }
        : {}),
      allowed_effects: effectsForMode(input.mode),
      source: 'pipeline.liveSessionParity.initializeV9LiveSession',
    })),
  };
  persistLiveSessionAuthority(input.runDir, authority);

  const sessionEvents = createSessionEventLog(input.sessionId);
  const turnId = 'v9-turn-1';
  recordUserSubmitted(sessionEvents, {
    turn_id: turnId,
    task: input.task,
    ...(input.modelId ? { model: input.modelId } : {}),
    projectRoot: input.projectRoot,
    taskClass,
  });
  recordModelStarted(sessionEvents, { turn_id: turnId, ...(input.modelId ? { model: input.modelId } : {}) });
  recordBudgetSnapshot(sessionEvents, turnId, {
    turns_used: 1,
    turns_remaining: null,
    repair_attempts_used: 0,
    infra_retries_used: 0,
  });
  flushSessionEventLogStrict(input.runDir, sessionEvents);
  persistLiveSessionSnapshot(
    input.runDir,
    projectFromDurableSession({ sessionLog: sessionEvents, authority, ...(workspaceRevision ? { workspaceRevision } : {}) }),
  );
  return {
    authority,
    sessionEvents,
    runDir: input.runDir,
    turnId,
    projectRoot: input.projectRoot,
    ...(workspaceRevision ? { workspaceRevision } : {}),
  };
}

/** Return no runtime for Chat, which already owns its live-session boundary. */
export function maybeInitializeV9LiveSession(
  runDir: string,
  sessionId: string | undefined,
  mode: string,
  task: string,
  projectRoot: string,
  promptManifestPaths: readonly string[],
  modelId: string | undefined,
): V9LiveSessionRuntime | null {
  if (mode !== 'plan' && mode !== 'deep') return null;
  return initializeV9LiveSession({
    runDir,
    ...(sessionId ? { sessionId } : {}),
    mode,
    task,
    projectRoot,
    promptManifestPaths,
    ...(modelId ? { modelId } : {}),
  });
}

/** Record the final V9 terminal through the shared session vocabulary. */
export function finalizeV9LiveSession(input: {
  runtime: V9LiveSessionRuntime;
  status: string;
  reason: string;
  verifierSatisfied: boolean;
}): TerminalOutcome {
  const outcome = outcomeForPipelineStatus(input.status, input.verifierSatisfied);
  recordCompletionDecision(input.runtime.sessionEvents, input.runtime.turnId, {
    requestedOutcome: outcome,
    finalOutcome: outcome,
    allowed: input.runtime.authority.taskContract.allowed_terminal_outcomes.includes(outcome),
    reason: input.reason,
    evidenceRefs: ['terminal_status_summary.json'],
    policyVersion: 'task-contract-v1',
  });
  recordTurnEnded(input.runtime.sessionEvents, {
    turn_id: input.runtime.turnId,
    outcome,
    status: input.status,
  });
  flushSessionEventLogStrict(input.runtime.runDir, input.runtime.sessionEvents);
  const finalWorkspaceRevision = gitRevision(input.runtime.projectRoot) ?? input.runtime.workspaceRevision;
  persistLiveSessionSnapshot(
    input.runtime.runDir,
    projectFromDurableSession({
      sessionLog: input.runtime.sessionEvents,
      authority: input.runtime.authority,
      ...(finalWorkspaceRevision ? { workspaceRevision: finalWorkspaceRevision } : {}),
    }),
  );
  return outcome;
}

/** Compact pipeline-facing finalizer; preserves the legacy PipelineResult shape. */
export function finalizeV9LiveSessionForPipeline(
  runtime: V9LiveSessionRuntime | null,
  result: {
    status: string;
    errors?: readonly string[];
    terminalSummary?: { next_recommended_operator_action: string };
  },
  verifierSatisfied: boolean,
): void {
  if (!runtime) return;
  finalizeV9LiveSession({
    runtime,
    status: result.status,
    reason: result.errors?.[0] ?? result.terminalSummary?.next_recommended_operator_action ?? 'Pipeline finalized.',
    verifierSatisfied,
  });
}

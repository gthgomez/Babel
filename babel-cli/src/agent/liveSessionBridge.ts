/**
 * liveSessionBridge.ts — H2 live wiring for InstructionManifestV1 + LiveSession.
 *
 * Binds policy-bound session authority into Chat dual-write / resume without
 * competing with sessionEvents or threadEventLog as the durable event source.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildInstructionManifestV1,
  type InstructionManifestV1,
} from './instructionManifest.js';
import {
  projectLiveSession,
  canMutateWithIdempotencyKey,
  mayBlindRetryInterrupted,
  liveSessionsEquivalentForResume,
  type LiveSessionV1,
} from './liveSession.js';
import {
  loadSessionEventLogFromDir,
  recordBudgetSnapshot,
  type SessionEventLog,
} from './sessionEvents.js';
import {
  loadThreadEventLogFromDir,
  type ThreadEventLog,
} from './threadEventLog.js';
import { compileChatStack, type ChatCompiledStack } from './chatStackCompile.js';
import {
  buildTaskContractV1,
  freezeTaskContract,
  type TaskContractV1,
} from './taskContract.js';
import type { BabelMode } from '../executor/contracts.js';

export const INSTRUCTION_MANIFEST_FILENAME = 'instruction-manifest.json';
export const TASK_CONTRACT_FILENAME = 'task-contract.json';
export const LIVE_SESSION_SNAPSHOT_FILENAME = 'live-session-snapshot.json';

export interface LiveSessionAuthority {
  instructionManifest: InstructionManifestV1;
  taskContract: TaskContractV1;
  chatStack?: ChatCompiledStack;
}

/**
 * Resolve InstructionManifestV1 + frozen TaskContractV1 for a Chat session.
 */
export function resolveLiveSessionAuthority(input: {
  mode: BabelMode;
  projectRoot: string;
  task: string;
  taskClass?: string;
  modelId?: string;
  verifierRequirements?: string[];
  maxTurns?: number;
  protectedPaths?: string[];
}): LiveSessionAuthority {
  const chatStack = compileChatStack({
    projectRoot: input.projectRoot,
    task: input.task,
    ...(input.modelId ? { modelId: input.modelId } : {}),
  });

  const instructionManifest = buildInstructionManifestV1({
    mode: input.mode,
    ...(input.taskClass ? { taskClass: input.taskClass } : {}),
    chatStack,
    inlineRules: [
      {
        rule_id: 'safety:workspace-scope',
        source: 'chat-safety-adapter',
        content: 'Prefer workspace-scoped tools; never escape the project root.',
        precedence: 'safety',
        selection_reason: 'always_on_safety',
        policy_class: 'mechanical',
      },
      {
        rule_id: 'verifier:task-guidance',
        source: 'chat-verifier-adapter',
        content: 'Do not claim completion without verification evidence when required.',
        precedence: 'verifier',
        selection_reason: 'always_on_verifier',
        policy_class: 'mechanical',
      },
    ],
  });

  const contract = freezeTaskContract(
    buildTaskContractV1({
      mode: input.mode,
      user_request: input.task,
      task_class:
        (input.taskClass as TaskContractV1['task_class'] | undefined) ?? 'unknown',
      acceptance_criteria: [
        'Task acceptance criteria as stated in the user request',
      ],
      non_goals: ['Do not expand scope beyond the user request'],
      protected_paths: input.protectedPaths ?? ['.env', '.git'],
      verifier_requirements: input.verifierRequirements ?? [],
      ...(input.maxTurns !== undefined ? { max_turns: input.maxTurns } : {}),
      allowed_effects:
        input.mode === 'plan'
          ? ['read_only']
          : [
              'read_only',
              'idempotent',
              'reconcilable_mutation',
              'non_idempotent_local_effect',
            ],
      source: 'liveSessionBridge.resolveLiveSessionAuthority',
    }),
  );

  return { instructionManifest, taskContract: contract, chatStack };
}

/** Persist authority artifacts next to session-events.jsonl. */
export function persistLiveSessionAuthority(
  runDir: string,
  authority: LiveSessionAuthority,
): void {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, INSTRUCTION_MANIFEST_FILENAME),
    JSON.stringify(authority.instructionManifest, null, 2),
    'utf-8',
  );
  writeFileSync(
    join(runDir, TASK_CONTRACT_FILENAME),
    JSON.stringify(authority.taskContract, null, 2),
    'utf-8',
  );
}

export function loadLiveSessionAuthority(
  runDir: string,
): LiveSessionAuthority | null {
  const manPath = join(runDir, INSTRUCTION_MANIFEST_FILENAME);
  const tcPath = join(runDir, TASK_CONTRACT_FILENAME);
  if (!existsSync(manPath) || !existsSync(tcPath)) return null;
  try {
    const instructionManifest = JSON.parse(
      readFileSync(manPath, 'utf-8'),
    ) as InstructionManifestV1;
    const taskContract = JSON.parse(readFileSync(tcPath, 'utf-8')) as TaskContractV1;
    return { instructionManifest, taskContract };
  } catch {
    return null;
  }
}

/**
 * Dual-write remaining budget snapshot into the durable session event log.
 */
export function dualWriteBudgetSnapshot(
  sessionLog: SessionEventLog,
  turnId: string | null,
  budgets: {
    turns_used: number;
    turns_remaining: number | null;
    tokens_used?: number;
    tokens_remaining?: number | null;
    repair_attempts_used?: number;
    repair_attempts_remaining?: number | null;
    infra_retries_used?: number;
    infra_retries_remaining?: number | null;
  },
): void {
  recordBudgetSnapshot(sessionLog, turnId, {
    turns_used: budgets.turns_used,
    turns_remaining: budgets.turns_remaining,
    ...(budgets.tokens_used !== undefined ? { tokens_used: budgets.tokens_used } : {}),
    ...(budgets.tokens_remaining !== undefined
      ? { tokens_remaining: budgets.tokens_remaining }
      : {}),
    ...(budgets.repair_attempts_used !== undefined
      ? { repair_attempts_used: budgets.repair_attempts_used }
      : {}),
    ...(budgets.repair_attempts_remaining !== undefined
      ? { repair_attempts_remaining: budgets.repair_attempts_remaining }
      : {}),
    ...(budgets.infra_retries_used !== undefined
      ? { infra_retries_used: budgets.infra_retries_used }
      : {}),
    ...(budgets.infra_retries_remaining !== undefined
      ? { infra_retries_remaining: budgets.infra_retries_remaining }
      : {}),
  });
}

/**
 * Project LiveSession from durable logs + optional restored authority.
 */
export function projectFromDurableSession(input: {
  sessionLog: SessionEventLog;
  threadLog?: ThreadEventLog;
  authority?: LiveSessionAuthority | null;
  budgetCeilings?: {
    turns?: number;
    tokens?: number;
    repair_attempts?: number;
    infra_retries?: number;
  };
  workspaceRevision?: string;
}): LiveSessionV1 {
  return projectLiveSession({
    sessionLog: input.sessionLog,
    ...(input.threadLog ? { threadLog: input.threadLog } : {}),
    ...(input.authority?.instructionManifest
      ? { instructionManifest: input.authority.instructionManifest }
      : {}),
    ...(input.budgetCeilings ? { budgetCeilings: input.budgetCeilings } : {}),
    ...(input.workspaceRevision
      ? { workspaceRevision: input.workspaceRevision }
      : {}),
  });
}

/** Persist a projected live-session snapshot for operator inspection. */
export function persistLiveSessionSnapshot(
  runDir: string,
  session: LiveSessionV1,
): void {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, LIVE_SESSION_SNAPSHOT_FILENAME),
    JSON.stringify(session, null, 2),
    'utf-8',
  );
}

export function loadLiveSessionSnapshot(runDir: string): LiveSessionV1 | null {
  const p = join(runDir, LIVE_SESSION_SNAPSHOT_FILENAME);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as LiveSessionV1;
  } catch {
    return null;
  }
}

/**
 * Resume equivalence for H2: project twice from durable artifacts and compare.
 */
export function resumeEquivalenceFromDisk(runDir: string): {
  ok: boolean;
  mismatches: string[];
  live: LiveSessionV1 | null;
} {
  const sessionLog = loadSessionEventLogFromDir(runDir);
  if (!sessionLog) {
    return { ok: false, mismatches: ['missing_session_events'], live: null };
  }
  const authority = loadLiveSessionAuthority(runDir);
  let threadLog: ThreadEventLog | undefined;
  try {
    threadLog = loadThreadEventLogFromDir(runDir) ?? undefined;
  } catch {
    threadLog = undefined;
  }
  const a = projectFromDurableSession({
    sessionLog,
    ...(threadLog ? { threadLog } : {}),
    authority,
  });
  const b = projectFromDurableSession({
    sessionLog,
    ...(threadLog ? { threadLog } : {}),
    authority,
  });
  const eq = liveSessionsEquivalentForResume(a, b);
  return { ok: eq.ok, mismatches: eq.mismatches, live: a };
}

export {
  canMutateWithIdempotencyKey,
  mayBlindRetryInterrupted,
  projectLiveSession,
};

/**
 * liveSessionBridge.ts — H2 live wiring for InstructionManifestV1 + LiveSession.
 *
 * Binds policy-bound session authority into Chat dual-write / resume without
 * competing with sessionEvents or threadEventLog as the durable event source.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  buildInstructionManifestV1,
  validateInstructionManifestV1,
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
  validateTaskContractV1,
  type TaskContractV1,
} from './taskContract.js';
import type { BabelMode } from '../executor/contracts.js';

export const INSTRUCTION_MANIFEST_FILENAME = 'instruction-manifest.json';
export const TASK_CONTRACT_FILENAME = 'task-contract.json';
export const LIVE_SESSION_SNAPSHOT_FILENAME = 'live-session-snapshot.json';
export const CHECKPOINT_JOURNAL_FILENAME = 'live-session-checkpoint.journal.json';

export interface CheckpointJournal {
  schema_version: 1;
  batch_id: string;
  status: 'prepared' | 'committed';
  backups_ready: boolean;
  targets: string[];
}

export function writeCheckpointJournal(
  runDir: string,
  journal: CheckpointJournal,
): void {
  writeFileSync(
    join(runDir, CHECKPOINT_JOURNAL_FILENAME),
    JSON.stringify(journal, null, 2),
    'utf-8',
  );
}

/** Recover an interrupted multi-artifact checkpoint before reading session state. */
export function recoverCheckpointArtifacts(runDir: string): void {
  const journalPath = join(runDir, CHECKPOINT_JOURNAL_FILENAME);
  if (!existsSync(journalPath)) return;
  let journal: CheckpointJournal;
  try {
    journal = JSON.parse(readFileSync(journalPath, 'utf-8')) as CheckpointJournal;
  } catch (error) {
    throw new LiveSessionAuthorityError(
      'CHECKPOINT_JOURNAL_INVALID',
      `Checkpoint journal is not valid JSON in ${runDir}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    journal.schema_version !== 1 ||
    !journal.batch_id ||
    !Array.isArray(journal.targets) ||
    journal.targets.length === 0 ||
    new Set(journal.targets).size !== journal.targets.length ||
    journal.targets.some(
      (filename) =>
        typeof filename !== 'string' ||
        filename.length === 0 ||
        filename === '.' ||
        filename === '..' ||
        filename.includes('/') ||
        filename.includes('\\') ||
        filename.includes(':'),
    )
  ) {
    throw new LiveSessionAuthorityError(
      'CHECKPOINT_JOURNAL_INVALID',
      `Checkpoint journal is invalid in ${runDir}`,
    );
  }
  const remove = (path: string): void => {
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch (error) {
      throw new LiveSessionAuthorityError(
        'CHECKPOINT_RECOVERY_FAILED',
        `Unable to remove checkpoint sidecar ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  for (const filename of journal.targets) {
    const target = join(runDir, filename);
    const tmp = `${target}.${journal.batch_id}.tmp`;
    const bak = `${target}.${journal.batch_id}.bak`;
    if (journal.status === 'prepared' && journal.backups_ready) {
      if (existsSync(bak)) copyFileSync(bak, target);
      else if (!existsSync(tmp) && existsSync(target)) remove(target);
    }
    remove(tmp);
    remove(bak);
  }
  remove(journalPath);
}

export interface LiveSessionAuthority {
  instructionManifest: InstructionManifestV1;
  taskContract: TaskContractV1;
  chatStack?: ChatCompiledStack;
}

export class LiveSessionAuthorityError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'LiveSessionAuthorityError'
    this.code = code
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  const tempPath = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(tempPath, JSON.stringify(value, null, 2), 'utf-8')
    renameSync(tempPath, path)
  } finally {
    try {
      rmSync(tempPath, { force: true })
    } catch {
      // The durable target has already been renamed or the original error wins.
    }
  }
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
  writeJsonAtomic(join(runDir, INSTRUCTION_MANIFEST_FILENAME), authority.instructionManifest);
  writeJsonAtomic(join(runDir, TASK_CONTRACT_FILENAME), authority.taskContract);
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

/** Load and validate durable authority; absence and corruption are distinct failures. */
export function loadLiveSessionAuthorityStrict(runDir: string): LiveSessionAuthority {
  const manPath = join(runDir, INSTRUCTION_MANIFEST_FILENAME)
  const tcPath = join(runDir, TASK_CONTRACT_FILENAME)
  if (!existsSync(manPath) || !existsSync(tcPath)) {
    throw new LiveSessionAuthorityError(
      'LIVE_AUTHORITY_MISSING',
      `Live session authority is incomplete in ${runDir}`,
    )
  }
  let instructionManifest: InstructionManifestV1
  let taskContract: TaskContractV1
  try {
    instructionManifest = JSON.parse(readFileSync(manPath, 'utf-8')) as InstructionManifestV1
    taskContract = JSON.parse(readFileSync(tcPath, 'utf-8')) as TaskContractV1
  } catch (error) {
    throw new LiveSessionAuthorityError(
      'LIVE_AUTHORITY_CORRUPT',
      `Live session authority is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const manifestErrors = validateInstructionManifestV1(instructionManifest)
  const contractErrors = validateTaskContractV1(taskContract)
  if (manifestErrors.length > 0 || contractErrors.length > 0) {
    throw new LiveSessionAuthorityError(
      'LIVE_AUTHORITY_INVALID',
      `Live session authority failed validation: ${[...manifestErrors, ...contractErrors].join(', ')}`,
    )
  }
  if (instructionManifest.mode !== taskContract.mode) {
    throw new LiveSessionAuthorityError(
      'LIVE_AUTHORITY_MODE_MISMATCH',
      'Instruction manifest and task contract modes do not match',
    )
  }
  return { instructionManifest, taskContract }
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
  let authority: LiveSessionAuthority;
  try {
    authority = loadLiveSessionAuthorityStrict(runDir);
  } catch (error) {
    const code = error instanceof LiveSessionAuthorityError ? error.code : 'LIVE_AUTHORITY_INVALID';
    return { ok: false, mismatches: [`authority:${code}`], live: null };
  }
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
  const persisted = loadLiveSessionSnapshot(runDir);
  const snapshotEq = persisted
    ? liveSessionsEquivalentForResume(a, persisted)
    : { ok: true, mismatches: [] };
  const mismatches = [
    ...eq.mismatches.map((mismatch) => `projection:${mismatch}`),
    ...snapshotEq.mismatches.map((mismatch) => `snapshot:${mismatch}`),
  ];
  return { ok: mismatches.length === 0, mismatches, live: a };
}

export {
  canMutateWithIdempotencyKey,
  mayBlindRetryInterrupted,
  projectLiveSession,
};

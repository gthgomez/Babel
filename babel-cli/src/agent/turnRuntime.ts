/**
 * W0.3 / P0-C — TurnRuntime: per-user-submission execution state.
 *
 * ThreadState (conversation history, durable event log) lives on ChatEngine.
 * Task-scoped counters, intent, class, and budgets belong to a fresh runtime
 * each user submission unless the operator explicitly continues a prior task.
 *
 * Acceptance (Codex harness parity P0-C):
 * - Prior task writes cannot satisfy a later task's completion gate
 * - Sticky intent is explicit (continueTask or stickyIntent override)
 * - Isolated submissions re-resolve taskClass + limits (budgets) for the new text
 * - /model, /project, /retarget invalidate the engine so the *next* submission
 *   rebuilds with the new model/root (handled in interactive/commands/config.ts)
 * - turn_started records model, root, taskClass, gatePolicy, submissionIndex
 */

import {
  getChatTaskTune,
  resolveChatTaskClass,
  analyzeTaskShape,
  type ChatTaskClass,
  type VerificationPolicy,
  type TaskShape,
} from '../config/chatTaskClass.js';

export type TurnTaskIntent = 'execute' | 'explain';

/** Counters and policy that must not leak across unrelated user tasks. */
export interface TurnRuntimeCounters {
  writeCount: number;
  gateStrikes: number;
  criticStrikes: number;
  turnsWithoutWrite: number;
  consecutiveReadOnlyTools: number;
  consecutiveNonMutatingShells: number;
  toolsWithoutWrite: number;
  midLoopCriticFired: boolean;
  budgetExceeded: boolean;
  budgetLastChanceDone: boolean;
  restrictToolsNextTurn: boolean;
}

export interface TurnRuntimeSnapshot extends TurnRuntimeCounters {
  /** Monotonic id of the user submission within a ChatEngine thread. */
  submissionIndex: number;
  taskText: string;
  taskIntent: TurnTaskIntent;
  taskClass: ChatTaskClass;
  taskShape?: TaskShape;
  escalationReason?: string;
  gatePolicy: VerificationPolicy | null;
  /** Last sticky intent retained for explicit continuation. */
  stickyIntent: TurnTaskIntent | null;
  /** Whether this submission continued prior task counter state. */
  continuedTask: boolean;
  model?: string;
  projectRoot: string;
}

export interface BeginUserSubmissionInput {
  userInput: string;
  projectRoot: string;
  model?: string;
  /** Explicit intent override from the caller. */
  taskIntent?: TurnTaskIntent;
  /**
   * Explicit continuation linkage: preserve counters/verifier-facing state
   * from the previous submission. Default false = isolate.
   */
  continueTask?: boolean;
  /** Classifier when taskIntent is omitted. */
  classifyIntent: (text: string) => TurnTaskIntent;
  previous?: TurnRuntimeSnapshot | null;
}

export function emptyTurnCounters(): TurnRuntimeCounters {
  return {
    writeCount: 0,
    gateStrikes: 0,
    criticStrikes: 0,
    turnsWithoutWrite: 0,
    consecutiveReadOnlyTools: 0,
    consecutiveNonMutatingShells: 0,
    toolsWithoutWrite: 0,
    midLoopCriticFired: false,
    budgetExceeded: false,
    budgetLastChanceDone: false,
    restrictToolsNextTurn: false,
  };
}

/**
 * Build the TurnRuntime for a new user submission.
 * Isolates counters by default; only continues when continueTask is true.
 */
export function beginUserSubmission(input: BeginUserSubmissionInput): TurnRuntimeSnapshot {
  const prev = input.previous ?? null;
  const continueTask = input.continueTask === true && prev != null;
  const submissionIndex = (prev?.submissionIndex ?? 0) + 1;

  const taskIntent: TurnTaskIntent =
    input.taskIntent ??
    (continueTask && prev?.stickyIntent ? prev.stickyIntent : input.classifyIntent(input.userInput));

  const taskClass = continueTask && prev
    ? prev.taskClass
    : resolveChatTaskClass({
        taskText: input.userInput,
        autoClassify: true,
      });

  const gatePolicy = getChatTaskTune(taskClass).verificationPolicy;
  const counters = continueTask && prev
    ? {
        writeCount: prev.writeCount,
        gateStrikes: prev.gateStrikes,
        criticStrikes: prev.criticStrikes,
        turnsWithoutWrite: prev.turnsWithoutWrite,
        consecutiveReadOnlyTools: prev.consecutiveReadOnlyTools,
        consecutiveNonMutatingShells: prev.consecutiveNonMutatingShells,
        toolsWithoutWrite: prev.toolsWithoutWrite,
        midLoopCriticFired: prev.midLoopCriticFired,
        budgetExceeded: prev.budgetExceeded,
        budgetLastChanceDone: prev.budgetLastChanceDone,
        restrictToolsNextTurn: prev.restrictToolsNextTurn,
      }
    : emptyTurnCounters();

  const taskShape = analyzeTaskShape(input.userInput);

  return {
    submissionIndex,
    taskText: input.userInput,
    taskIntent,
    taskClass,
    taskShape,
    gatePolicy,
    stickyIntent: taskIntent,
    continuedTask: continueTask,
    projectRoot: input.projectRoot,
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...counters,
  };
}

/** Pure helper for tests: prior writes must not remain when isolated. */
export function priorWritesLeak(prev: TurnRuntimeSnapshot, next: TurnRuntimeSnapshot): boolean {
  if (next.continuedTask) return false;
  return prev.writeCount > 0 && next.writeCount === prev.writeCount && next.writeCount > 0;
}

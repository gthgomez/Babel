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
  resolveChatTaskClass,
  resolveTaskShape,
  type ChatTaskClass,
  type TaskOperation,
  type VerificationPolicy,
  type TaskShape,
  type RequestedTaskOperation,
} from '../config/chatTaskClass.js';
import { resolveCompletionVerificationContext } from './completionGatePolicy.js';

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
  /**
   * D01: effective operation for this accepted submission, derived from the
   * same TaskShape machinery that resolves taskClass. Read-only gating,
   * preparation fuses, progress policy and finalization consume this one
   * policy instead of re-deriving intent from a second classifier.
   */
  effectiveOperation?: TaskOperation;
  escalationReason?: string;
  gatePolicy: VerificationPolicy | null;
  /** Last sticky intent retained for explicit continuation. */
  stickyIntent: TurnTaskIntent | null;
  /** Whether this submission continued prior task counter state. */
  continuedTask: boolean;
  /** Objective linkage is independent from per-attempt counter isolation. */
  objectiveContinuation?: boolean;
  /**
   * True for a read-only status presentation of a live task. The submission is
   * read-only, but an explicit or gesture continuation after it resumes the
   * objective's real (possibly mutating) operation, not this read-only view.
   */
  presentationOnly?: boolean;
  model?: string;
  projectRoot: string | null;
  executionScope?: import('./chatExecutionScope.js').ChatExecutionScope;
  /** Accepted objective. Continuation and status questions do not replace it. */
  durableObjective?: string;
  /** Ordered amendments applied after the objective. */
  amendments?: string[];
}

export interface BeginUserSubmissionInput {
  userInput: string;
  projectRoot: string | null;
  executionScope?: import('./chatExecutionScope.js').ChatExecutionScope;
  model?: string;
  /** Frozen/host required verifier commands for effective gate policy at turn start. */
  requiredVerifierCommands?: readonly string[] | null;
  /** Explicit intent override from the caller. */
  taskIntent?: TurnTaskIntent;
  operation?: RequestedTaskOperation | undefined;
  /**
   * Explicit continuation linkage: preserve counters/verifier-facing state
   * from the previous submission. Default false = isolate.
   */
  continueTask?: boolean;
  /** Classifier when taskIntent is omitted. */
  classifyIntent: (text: string) => TurnTaskIntent;
  previous?: TurnRuntimeSnapshot | null;
}

export type UserSubmissionInput = Pick<BeginUserSubmissionInput,'userInput'|'taskIntent'|'continueTask'|'operation'>;
export interface PreparedUserSubmission {
  input: UserSubmissionInput;
  runtime: TurnRuntimeSnapshot;
  objectiveDisposition: 'initial'|'preserve'|'replace';
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
 * Bare continuation gestures carry no operation signal of their own. They are
 * not the task text; they mean "keep doing what we were doing". Production
 * callers do not set `continueTask`, so this is the reachable continuation
 * contract: carry the prior submission's operation/class forward rather than
 * re-deriving READ_ONLY from a verb-less prompt (I3). Explicit operation text
 * ("continue and fix X") does not match and is classified on its own merits.
 */
const CONTINUATION_PROMPT_RE =
  /^(?:(?:please|ok(?:ay)?|alright)\s+)?(?:continue|keep\s+going|go\s+on|carry\s+on|proceed|do\s+it|go\s+ahead|next)(?:\s+(?:please|now|with\s+(?:it|that|the(?:\s+\w+)?\s+task)))?[.!]?$/i;

export function isContinuationPrompt(taskText: string): boolean {
  return CONTINUATION_PROMPT_RE.test(taskText.trim());
}

const STATUS_PROMPT_RE = /^(?:status\??|what(?:'s| is) (?:the )?status\??|where are we\??)$/i;
const AMENDMENT_PROMPT_RE = /^(?:also|additionally|and)\b/i;

export function isStatusPrompt(taskText: string): boolean {
  return STATUS_PROMPT_RE.test(taskText.trim());
}

export function isAmendmentPrompt(taskText: string): boolean {
  return AMENDMENT_PROMPT_RE.test(taskText.trim());
}

/**
 * Build the TurnRuntime for a new user submission.
 * Isolates counters by default; only continues when continueTask is true.
 */
export function beginUserSubmission(input: BeginUserSubmissionInput): TurnRuntimeSnapshot {
  const prev = input.previous ?? null;
  const continueTask = input.continueTask === true && prev != null;
  const continuationGesture = !continueTask && prev != null && isContinuationPrompt(input.userInput);
  const statusQuestion = !continueTask && prev != null && isStatusPrompt(input.userInput);
  const amendment = !continueTask && prev != null && isAmendmentPrompt(input.userInput);
  const durableObjective = (continueTask || continuationGesture || statusQuestion || amendment) && prev
    ? prev.durableObjective ?? prev.taskText
    : input.userInput;
  const amendments = (continueTask || continuationGesture || statusQuestion || amendment) && prev
    ? [...(prev.amendments ?? [])]
    : [];
  if (amendment) amendments.push(input.userInput.trim());
  const taskText = amendments.length > 0 ? [durableObjective, ...amendments].join('\n') : durableObjective;
  // Operation/class freeze for explicit continuation and bare continuation
  // gestures; counters still isolate unless continueTask is true.
  // An amendment is reclassified from the preserved objective plus the new text.
  const carryOperation = (input.operation === undefined || input.operation === 'AUTO')
    && (continueTask || continuationGesture || statusQuestion)
    && !amendment;
  const submissionIndex = (prev?.submissionIndex ?? 0) + 1;

  // P-A: a status question is a READ-ONLY presentation of the live objective.
  // It must not inherit the prior submission's mutation operation (which would
  // classify it `execute` and inject a mutation mandate) while the objective is
  // preserved. It keeps the durable objective and prior counters so a later
  // explicit `continue` can still resume the task. An explicit CHANGE wins.
  const statusPresentation = statusQuestion && input.operation !== 'CHANGE';

  const taskShape = carryOperation && prev?.taskShape
    ? prev.taskShape
    : resolveTaskShape(taskText, input.operation);
  const effectiveOperation: TaskOperation =
    statusPresentation
      ? 'READ_ONLY'
      : carryOperation && prev
        // A continuation after a status presentation resumes the objective's
        // real operation, not the read-only presentation's operation.
        ? prev.presentationOnly
          ? prev.taskShape?.operation ?? resolveTaskShape(prev.taskText).operation
          : prev.effectiveOperation ?? prev.taskShape?.operation ?? resolveTaskShape(prev.taskText).operation
        : taskShape.operation;

  const taskIntent: TurnTaskIntent =
    effectiveOperation === 'READ_ONLY' ? 'explain'
      : input.operation === 'CHANGE' ? 'execute'
      : input.taskIntent ??
        (continueTask && prev?.stickyIntent ? prev.stickyIntent : input.classifyIntent(input.userInput));

  const taskClass = carryOperation && prev
    ? prev.taskClass
    : resolveChatTaskClass({
        taskText,
        autoClassify: true,
        operation: input.operation,
      });

  const gatePolicy = resolveCompletionVerificationContext({
    taskClass,
    task: taskText,
    ...(input.requiredVerifierCommands !== undefined
      ? { requiredVerifierCommands: input.requiredVerifierCommands }
      : {}),
  }).effectiveGatePolicy;
  const counters = (continueTask || statusPresentation) && prev
    ? {
        writeCount: prev.writeCount,
        gateStrikes: prev.gateStrikes,
        criticStrikes: prev.criticStrikes,
        turnsWithoutWrite: prev.turnsWithoutWrite,
        consecutiveReadOnlyTools: prev.consecutiveReadOnlyTools,
        consecutiveNonMutatingShells: prev.consecutiveNonMutatingShells,
        toolsWithoutWrite: prev.toolsWithoutWrite,
        midLoopCriticFired: prev.midLoopCriticFired,
        // A read-only status presentation must not inherit a task-terminal
        // budget flag: that would label the status answer budget_exhausted
        // instead of reporting the live objective. Progress counters are kept.
        budgetExceeded: statusPresentation ? false : prev.budgetExceeded,
        budgetLastChanceDone: statusPresentation ? false : prev.budgetLastChanceDone,
        restrictToolsNextTurn: prev.restrictToolsNextTurn,
      }
    : emptyTurnCounters();

  return {
    submissionIndex,
    taskText,
    durableObjective,
    amendments,
    taskIntent,
    taskClass,
    taskShape,
    effectiveOperation,
    gatePolicy,
    // A status presentation keeps the task's sticky intent so a later explicit
    // `continue` resumes the real task rather than the read-only presentation.
    stickyIntent: statusPresentation && prev ? prev.stickyIntent ?? prev.taskIntent : taskIntent,
    continuedTask: continueTask || statusPresentation,
    objectiveContinuation: continueTask || continuationGesture || statusQuestion || amendment,
    ...(statusPresentation ? { presentationOnly: true } : {}),
    projectRoot: input.projectRoot,
    ...(input.executionScope?{executionScope:input.executionScope}:{}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...counters,
  };
}

/** Pure helper for tests: prior writes must not remain when isolated. */
export function priorWritesLeak(prev: TurnRuntimeSnapshot, next: TurnRuntimeSnapshot): boolean {
  if (next.continuedTask) return false;
  return prev.writeCount > 0 && next.writeCount === prev.writeCount && next.writeCount > 0;
}

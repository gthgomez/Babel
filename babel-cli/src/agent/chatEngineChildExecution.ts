import { join } from "node:path";
import { globalCostTracker } from "../services/costTracker.js";
import { applyWorkingStateEvent } from "./codingLoop/index.js";
import {
  formatSubAgentFindings,
  chatActionToolName,
} from "./chatToolDefinitions.js";
import {
  buildReadOnlyChildResult,
  renderReadOnlyChildResultSection,
} from "./childConclusion.js";
import { formatChildSpecReceipt, resolveChildSpec } from "./childSpec.js";
import { recordMutationBatch, operationFingerprint } from "./sessionEvents.js";
import { getChatApprovalSession } from "./chatApproval.js";
import { deriveSubagentApprovalSession } from "./approvalRequests.js";
import {
  assertChildApprovalWithinParent,
  getExecutionContext,
  runWithExecutionContext,
  type ExecutionContext,
} from "./executionContext.js";
import { runReadOnlyAgentLoop } from "./lanes/readOnlyAgentLoop.js";
import {
  deriveChildAllowance,
  inheritedChildBudgetLimiter,
  type ChildBudgetLimiter,
  type InheritedChildAllowance,
} from "./childBudget.js";
import {
  childBudgetAttribution,
  classifySubagentFailure,
  runMutationAgentLoop,
  subagentFinishedCleanly,
  type SubagentAttribution,
} from "./lanes/runMutationAgentLoop.js";
import { runImplementWorktreeAgent } from "./implementWorktreeAgent.js";
import { invalidateVerifierLedger } from "./chatEngineSupport.js";
import type {
  ChatCallbacks,
  ChatEngineOptions,
  ChatTaskAllowanceSnapshot,
} from "./chatEngine.js";
import type { ChatToolAction } from "./chatToolDefinitions.js";
import type { ToolContext } from "../localTools.js";
import type { WorkingState } from "./codingLoop/workingState.js";
import type { ParityRuntime } from "./chatEngineParityBridge.js";
import type { ResolvedModelPolicy } from "../modelPolicy.js";
import type { MutationEffectStatus } from "./mutationTools.js";
import type { ChatUsageScope } from "./chatEngineProviderAccounting.js";
import type { OwnerAccountingFault } from "./chatEngineOwnerAccounting.js";
import type { ChatEngineStreamingLoopHost } from "./chatEngine.js";

export function childAttemptDir(
  engineRunDir: string,
  subId: string,
  attempt: number,
): string {
  return join(engineRunDir, subId, `attempt-${attempt}`);
}

export interface ChatSubAgentToolLogEntry {
  toolCallId?: string;
  tool: string;
  target: string;
  detail?: string;
  error?: string;
  index: number;
  exit_code?: number;
  stdout?: string;
  stderr?: string;
  verified?: boolean;
  mutation_paths?: string[];
  effect_status?: MutationEffectStatus;
}

export interface ChatEngineChildExecutionHost {
  _turnIndex: number;
  abortController: AbortController;
  childAttempts: Map<string, number>;
  readonly engineRunDir: string;
  readonly engineRunId: string;
  buildBaseExecutionContext: () => ExecutionContext;
  childDelegationIdForAction: (
    action: ChatToolAction,
    meta: { index: number },
  ) => string;
  currentCandidateRevisionHash: () => string | null;
  deriveChildAllowance: (maxRounds: number) => InheritedChildAllowance;
  isSubmissionCurrent: (ownerGeneration: number) => boolean;
  markChildBudgetExhausted: (
    limiter: ChildBudgetLimiter,
    reason: string,
  ) => void;
  readonly modelPolicy: ResolvedModelPolicy | undefined;
  readonly options: ChatEngineOptions;
  readonly parity: ParityRuntime;
  persistOwnerCharges: (ownerId: string, runDir?: string) => void;
  persistTaskCostBaseline: () => void;
  persistToolStartedAtExecutorDispatch: (
    action: ChatToolAction,
    meta: { index: number; idempotencyKey?: string },
  ) => void;
  recordOwnerAccountingFault: (
    scope: ChatUsageScope,
    kind: OwnerAccountingFault["kind"],
    reason: string,
    appliesToCurrent: boolean,
  ) => void;
  settleInheritedBudgetRejectedChild: (
    action: ChatToolAction,
    meta: { index: number; idempotencyKey?: string },
    callbacks: ChatCallbacks,
    toolId: number,
    subId: string,
    reason: string,
    limiter?: ChildBudgetLimiter,
  ) => { index: number; observation: string; stop: true };
  settleStaleChildResult: (
    tool: string,
    target: string,
    subId: string,
    index: number,
    reason: string,
  ) => { index: number; observation: string };
  readonly taskAllowance: ChatTaskAllowanceSnapshot | null;
  readonly toolCallLog: ChatSubAgentToolLogEntry[];
  workingState: WorkingState;
}

export interface ChatEngineChildExecutionInput {
  host: ChatEngineChildExecutionHost;
  action: ChatToolAction;
  toolContext: ToolContext;
  callbacks: ChatCallbacks;
  meta: { index: number; idempotencyKey?: string; ownerGeneration?: number };
  ownerGeneration: number;
  ownerRunDir: string;
  dispatchTurnId: string | null;
  tool: string;
  target: string;
  toolId: number;
}

export async function executeSubAgentAction(
  input: ChatEngineChildExecutionInput,
): Promise<{ index: number; observation: string; stop?: boolean }> {
  const {
    host,
    action,
    toolContext,
    callbacks,
    meta,
    ownerGeneration,
    ownerRunDir,
    dispatchTurnId,
    tool,
    target,
    toolId,
  } = input;
  if (action.type !== "sub_agent")
    throw new Error("executeSubAgentAction requires a sub_agent action");

  // S03/#213 slice 2: stable delegation id + per-attempt evidence dir.
  //
  // M7 (open, disclosed): this makes retry *identity* stable and prevents
  // the retry from overwriting attempt-1 evidence, but it does NOT yet
  // replay a terminal idempotency key instead of re-running the child.
  // The recon's full T05 dedupe gate remains unimplemented; the existing
  // recovered-outcome authorization gate (above) still blocks unknown
  // outcomes until reconciliation.
  const subId = host.childDelegationIdForAction(action, meta);
  const attempt = (host.childAttempts.get(subId) ?? 0) + 1;
  host.childAttempts.set(subId, attempt);
  const childRunDir = childAttemptDir(host.engineRunDir, subId, attempt);
  // S03/#213 slice 1: resolve ONE effective child spec. Every declared
  // option is honored, rejected, or clamped with a reason; the runtime
  // receipts and the advertised schema both derive from these semantics.
  const spec = resolveChildSpec({
    mutation: (action as { mutation?: boolean }).mutation === true,
    writeScope: (action as { write_scope?: string[] }).write_scope ?? [],
    instructions: (action as { instructions?: string }).instructions ?? null,
    model: (action as { model?: string }).model ?? null,
    maxRounds: (action as { max_rounds?: number }).max_rounds ?? null,
    parentModel: host.modelPolicy?.providerModelId ?? null,
  });
  const mutationEnabled = spec.mutation;
  const writeScope = spec.writeScope;
  const specReceipt = formatChildSpecReceipt(spec);
  // Test-only deterministic lane overrides (never set in production).
  const childLane = host.options.testChildLaneOverrides;

  // #11: Fork an isolated ToolContext with a child AbortController.
  // Cancelling the parent cascades; cancelling a sibling does not.
  const childController = new AbortController();
  const onParentAbort = () => childController.abort();
  host.abortController.signal.addEventListener("abort", onParentAbort, {
    once: true,
  });
  const mutationAllowance = mutationEnabled
    ? host.deriveChildAllowance(spec.effectiveRounds)
    : null;
  if (mutationAllowance) {
    const inheritedLimiter = inheritedChildBudgetLimiter(mutationAllowance);
    if (inheritedLimiter) {
      const reason = `child was not started: inherited ${inheritedLimiter} allowance already exhausted`;
      host.markChildBudgetExhausted(inheritedLimiter, reason);
      const rejected = host.settleInheritedBudgetRejectedChild(
        action,
        meta,
        callbacks,
        toolId,
        subId,
        reason,
        inheritedLimiter,
      );
      host.abortController.signal.removeEventListener("abort", onParentAbort);
      return rejected;
    }
  }

  // S04/#214: derive the child session ONLY from the ALS-bound parent
  // context and scope it with the async context. No global bind/restore,
  // so cancellation/rejection/exception restore the owner automatically
  // and a sibling scope can never be read.
  const parentContext =
    getExecutionContext() ?? host.buildBaseExecutionContext();
  const parentApproval =
    parentContext.approvalSession ?? getChatApprovalSession();
  const childCeiling = mutationEnabled
    ? (["shell", "write", "other"] as const)
    : (["other"] as const);
  const childApproval = deriveSubagentApprovalSession(parentApproval, subId, [
    ...childCeiling,
  ]);
  // Fail closed if a derived child would widen the parent lease.
  assertChildApprovalWithinParent(childApproval, parentApproval);
  const childContext: ExecutionContext = {
    ...parentContext,
    approvalSession: childApproval,
    parentTrace: {
      threadId: parentContext.threadId,
      turnId: parentContext.turnId,
    },
  };
  // R0-7: bind this child to the parent candidate revision at dispatch.
  // A child result may become authority only while it still applies to
  // the current parent candidate. A read-only child cannot move the
  // candidate itself, so a changed revision means the parent moved; a
  // mutation child does move it, so revision movement is judged only for
  // non-mutating children and the submission/turn identity carries the
  // rest. Existing authority only (RevisionManager + submission id).
  const dispatchRevisionHash = host.currentCandidateRevisionHash();
  const childResultIsStale = (changedFiles: number): boolean => {
    if (!host.isSubmissionCurrent(ownerGeneration)) return true;
    if (host.parity.turnId !== dispatchTurnId) return true;
    if (
      changedFiles === 0 &&
      dispatchRevisionHash !== host.currentCandidateRevisionHash()
    ) {
      return true;
    }
    return false;
  };
  // R1: scope the entire child dispatch with the run-scoped helper. The
  // AsyncLocalStorage binding starts at this call and unwinds when the
  // awaited body settles, so a finished child can never leave its context
  // visible to caller or sibling work. Never use `enterWith` here (it
  // rebinds the ambient execution until a manual restore) and never
  // manually restore ambient state.
  return await runWithExecutionContext(
    childContext,
    async (): Promise<{
      index: number;
      observation: string;
      stop?: boolean;
    }> => {
      // Mutation sub-agent path (W2.1: git worktree + write_scope allowlist)
      if (mutationEnabled) {
        try {
          // M3: the start callback runs inside the run-scoped child context so
          // a throwing callback unwinds with the scope and cannot leak.
          callbacks.onSubAgentStart?.({
            id: subId,
            label: action.task.slice(0, 60),
          });
          // Prefer implement-worktree isolation when write_scope is declared.
          // Empty write_scope still routes through the legacy in-tree loop so
          // read-only mutation attempts get the existing "no write scope" error.
          const useWorktree =
            writeScope.length > 0 &&
            process.env["BABEL_IMPLEMENT_WORKTREE"] !== "0";
          if (useWorktree) {
            host.persistToolStartedAtExecutorDispatch(action, meta);
            const implResult = await runImplementWorktreeAgent(
              {
                id: subId,
                task: action.task,
                writeScope,
                maxRounds: spec.effectiveRounds,
                ...(spec.resolvedModel ? { model: spec.resolvedModel } : {}),
                ...(spec.instructions
                  ? { instructions: spec.instructions }
                  : {}),
              },
              {
                projectRoot: host.options.projectRoot,
                runDir: childRunDir,
                abortSignal: childController.signal,
                cleanupWorktree: false,
                ...(childLane?.useDeterministicMock !== undefined
                  ? { useDeterministicMock: childLane.useDeterministicMock }
                  : {}),
                ...(childLane?.executor
                  ? { executor: childLane.executor }
                  : {}),
                toolContext: {
                  signal: childController.signal,
                },
                ...(mutationAllowance
                  ? { inheritedAllowance: mutationAllowance }
                  : {}),
                onUsageRecorded: () => {
                  if (mutationAllowance?.parentTaskOwnerId) {
                    try {
                      host.persistOwnerCharges(
                        mutationAllowance.parentTaskOwnerId,
                        ownerRunDir,
                      );
                    } catch (error) {
                      host.recordOwnerAccountingFault(
                        {
                          taskOwnerId: mutationAllowance.parentTaskOwnerId,
                          accountingEpoch:
                            globalCostTracker.getAccountingEpoch(),
                          turnId: host.parity.turnId,
                          chargeId: null,
                          ownerGeneration,
                        },
                        "persistence-failure",
                        error instanceof Error ? error.message : String(error),
                        mutationAllowance.parentTaskOwnerId ===
                          host.taskAllowance?.taskOwnerId &&
                          host.isSubmissionCurrent(ownerGeneration),
                      );
                      throw new Error(
                        "Delegated charge receipt could not be saved",
                      );
                    }
                  }
                  // R0-8: a superseded child must not flush the new task's
                  // cost baseline / active-execution checkpoint.
                  if (host.isSubmissionCurrent(ownerGeneration)) {
                    host.persistTaskCostBaseline();
                  }
                },
              },
            );
            // R0-7: a child that resolves after the parent moved must not
            // install evidence, invalidate verifier authority, or spend the
            // current task's budget. Visible as historical evidence only.
            if (childResultIsStale(implResult.changedFiles.length)) {
              return host.settleStaleChildResult(
                tool,
                target,
                subId,
                meta.index,
                "parent submission/revision superseded before the child resolved",
              );
            }
            if (
              implResult.inheritedBudgetExceeded &&
              implResult.inheritedBudgetLimiter
            ) {
              host.markChildBudgetExhausted(
                implResult.inheritedBudgetLimiter,
                implResult.error ?? "child inherited allowance exhausted",
              );
            }
            const attribution: SubagentAttribution = implResult.attribution;
            const clean = subagentFinishedCleanly(attribution);
            const details = clean
              ? `${implResult.stepsExecuted} steps, ${implResult.changedFiles.length} changed, attribution=${attribution} (worktree ${implResult.worktree.name})`
              : `failed: ${implResult.error || "unknown error"}, attribution=${attribution}`;
            if (implResult.changedFiles.length > 0) {
              host.workingState = applyWorkingStateEvent(host.workingState, {
                type: "mutation",
                path: implResult.changedFiles[0]!.path,
                fingerprint: operationFingerprint(
                  chatActionToolName(action),
                  action,
                ),
              });
            }
            host.toolCallLog.push({
              tool,
              target,
              detail: details,
              index: meta.index,
              exit_code: clean ? 0 : 1,
              ...(clean ? {} : { error: implResult.error || attribution }),
              ...(implResult.changedFiles.length > 0
                ? {
                    effect_status: "confirmed_change" as const,
                    mutation_paths: implResult.changedFiles.map(
                      (file) => file.path,
                    ),
                  }
                : clean
                  ? { effect_status: "confirmed_no_change" as const }
                  : { effect_status: "indeterminate" as const }),
            });
            callbacks?.onToolComplete?.(
              toolId,
              details,
              clean ? undefined : implResult.error || attribution,
              clean ? 0 : 1,
            );
            if (clean) {
              callbacks.onSubAgentComplete?.({ id: subId, summary: details });
            } else {
              callbacks.onSubAgentFailed?.({
                id: subId,
                error: implResult.error || attribution,
              });
            }
            const findings = [
              `### sub_agent ${subId}: ${action.task}`,
              `status: ${clean ? (attribution === "child_noop" ? "noop" : "success") : "failed"}`,
              `attribution: ${attribution}`,
              `isolation: git_worktree`,
              `child_spec: ${specReceipt}`,
              `worktree: ${implResult.worktree.path}`,
              `write_scope: ${implResult.writeScope.join(", ") || "(none)"}`,
              `parent_tree_clean: ${implResult.parentTreeClean}`,
              `steps: ${implResult.stepsExecuted}`,
              `changed_files: ${implResult.changedFiles.map((f) => f.path).join(", ") || "none"}`,
              implResult.summary,
            ].join("\n");
            return {
              index: meta.index,
              observation: findings,
              ...(implResult.inheritedBudgetExceeded ? { stop: true } : {}),
            };
          }

          host.persistToolStartedAtExecutorDispatch(action, meta);
          const mutResult = await runMutationAgentLoop({
            agentId: subId,
            task: action.task,
            projectRoot: host.options.projectRoot,
            writeScope,
            ...(host.options.workspaceRoot
              ? { workspaceRoot: host.options.workspaceRoot }
              : {}),
            toolContext: {
              agentId: subId,
              runId: host.engineRunId,
              runDir: childRunDir,
              babelRoot: process.env["BABEL_ROOT"] ?? process.cwd(),
              signal: childController.signal,
            },
            maxRounds: spec.effectiveRounds,
            abortSignal: childController.signal,
            runDir: childRunDir,
            ...(childLane?.useDeterministicMock !== undefined
              ? { useDeterministicMock: childLane.useDeterministicMock }
              : {}),
            ...(childLane?.actionResolver
              ? {
                  actionResolver: (prompt: string) =>
                    childLane.actionResolver!(prompt, 1),
                }
              : {}),
            ...(childLane?.executor ? { executor: childLane.executor } : {}),
            ...(mutationAllowance
              ? { inheritedAllowance: mutationAllowance }
              : {}),
            onUsageRecorded: () => {
              if (mutationAllowance?.parentTaskOwnerId) {
                try {
                  host.persistOwnerCharges(
                    mutationAllowance.parentTaskOwnerId,
                    ownerRunDir,
                  );
                } catch (error) {
                  host.recordOwnerAccountingFault(
                    {
                      taskOwnerId: mutationAllowance.parentTaskOwnerId,
                      accountingEpoch: globalCostTracker.getAccountingEpoch(),
                      turnId: host.parity.turnId,
                      chargeId: null,
                      ownerGeneration,
                    },
                    "persistence-failure",
                    error instanceof Error ? error.message : String(error),
                    mutationAllowance.parentTaskOwnerId ===
                      host.taskAllowance?.taskOwnerId &&
                      host.isSubmissionCurrent(ownerGeneration),
                  );
                  throw new Error(
                    "Delegated charge receipt could not be saved",
                  );
                }
              }
              // R0-8: a superseded child must not flush the new task's
              // cost baseline / active-execution checkpoint.
              if (host.isSubmissionCurrent(ownerGeneration)) {
                host.persistTaskCostBaseline();
              }
            },
            ...(spec.resolvedModel ? { model: spec.resolvedModel } : {}),
            ...(spec.instructions
              ? { additionalInstructions: spec.instructions }
              : {}),
          });
          // R0-7: a mutation child that resolves after the parent submission
          // was superseded must not mint a mutation batch, invalidate the new
          // task's verifier receipt, or be treated as incorporated into the
          // current candidate. Its disk effects remain real and historical.
          if (childResultIsStale(mutResult.changedFiles.length)) {
            return host.settleStaleChildResult(
              tool,
              target,
              subId,
              meta.index,
              "parent submission/revision superseded before the child resolved",
            );
          }
          const attribution: SubagentAttribution = mutResult.attribution;
          const clean = subagentFinishedCleanly(attribution);
          const details = clean
            ? `${mutResult.stepsExecuted} steps, ${mutResult.changedFiles.length} changed, attribution=${attribution}`
            : `failed: ${mutResult.error || "unknown error"}, attribution=${attribution}`;
          if (mutResult.changedFiles.length > 0) {
            host.workingState = applyWorkingStateEvent(host.workingState, {
              type: "mutation",
              path: mutResult.changedFiles[0]!.path,
              fingerprint: operationFingerprint(
                chatActionToolName(action),
                action,
              ),
            });
          }
          host.toolCallLog.push({
            tool,
            target,
            detail: details,
            index: meta.index,
            exit_code: clean ? 0 : 1,
            ...(clean ? {} : { error: mutResult.error || attribution }),
            ...(mutResult.changedFiles.length > 0
              ? {
                  effect_status: "confirmed_change" as const,
                  mutation_paths: mutResult.changedFiles.map(
                    (file) => file.path,
                  ),
                }
              : clean
                ? { effect_status: "confirmed_no_change" as const }
                : { effect_status: "indeterminate" as const }),
          });
          if (
            mutResult.inheritedBudgetExceeded &&
            mutResult.inheritedBudgetLimiter
          ) {
            host.markChildBudgetExhausted(
              mutResult.inheritedBudgetLimiter,
              mutResult.error ?? "child inherited allowance exhausted",
            );
          }
          if (mutResult.changedFiles.length > 0) {
            // R0-11: the in-tree mutation lane writes directly into the PARENT
            // candidate. A prior green parent verifier receipt is revision-
            // bound to the parent's earlier mutation scope; it must not remain
            // current for a candidate that now contains the child's changes.
            // (The worktree branch above is different: its diff is never
            // promoted into the parent tree, so a parent receipt stays valid
            // for the unchanged parent candidate.)
            invalidateVerifierLedger(
              host as never,
              "child mutation changed the parent candidate",
            );
            recordMutationBatch(
              host.parity.sessionEvents,
              // R0-7: attribute the child's change to the turn that
              // dispatched it, never to a turn that started afterwards.
              dispatchTurnId ?? String(host._turnIndex),
              { paths: mutResult.changedFiles.map((file) => file.path) },
            );
          }
          callbacks?.onToolComplete?.(
            toolId,
            details,
            clean ? undefined : mutResult.error || attribution,
            clean ? 0 : 1,
          );
          if (clean) {
            callbacks.onSubAgentComplete?.({ id: subId, summary: details });
          } else {
            callbacks.onSubAgentFailed?.({
              id: subId,
              error: mutResult.error || attribution,
            });
          }
          const findings = [
            `### sub_agent ${subId}: ${action.task}`,
            `status: ${clean ? (attribution === "child_noop" ? "noop" : "success") : "failed"}`,
            `attribution: ${attribution}`,
            `child_spec: ${specReceipt}`,
            `steps: ${mutResult.stepsExecuted}`,
            `changed_files: ${mutResult.changedFiles.map((f) => f.path).join(", ") || "none"}`,
            mutResult.summary,
          ].join("\n");
          return {
            index: meta.index,
            observation: findings,
            ...(mutResult.inheritedBudgetExceeded ? { stop: true } : {}),
          };
        } catch (err) {
          // R0-7: a child failure that surfaces after the parent was
          // superseded must not poison the current task's tool log/callbacks.
          if (!host.isSubmissionCurrent(ownerGeneration)) {
            return host.settleStaleChildResult(
              tool,
              target,
              subId,
              meta.index,
              "parent submission superseded before the child settled",
            );
          }
          const errMsg = err instanceof Error ? err.message : String(err);
          const attribution = classifySubagentFailure({
            success: false,
            error: errMsg,
            changedFilesCount: 0,
            aborted: childController.signal.aborted,
          });
          host.toolCallLog.push({
            tool,
            target,
            detail: `failed, attribution=${attribution}`,
            error: "error",
            index: meta.index,
            exit_code: 1,
          });
          callbacks?.onToolComplete?.(
            toolId,
            `failed, attribution=${attribution}`,
            errMsg,
            1,
          );
          callbacks.onSubAgentFailed?.({ id: subId, error: errMsg });
          return {
            index: meta.index,
            observation: `### sub_agent ${subId}: ${action.task}\nattribution: ${attribution}\nError: ${errMsg}`,
          };
        } finally {
          host.abortController.signal.removeEventListener(
            "abort",
            onParentAbort,
          );
        }
      }

      // Read-only sub-agent path (existing)
      try {
        // M3: start callback inside the run-scoped child context so a throw
        // unwinds with the scope and cannot leak.
        callbacks.onSubAgentStart?.({
          id: subId,
          label: action.task.slice(0, 60),
        });
        // S03: use the one resolved spec (bounds/defaults live in childSpec).
        const childRounds = spec.effectiveRounds;
        const readAllowance = host.deriveChildAllowance(childRounds);
        const readInheritedLimiter = inheritedChildBudgetLimiter(readAllowance);
        if (readInheritedLimiter) {
          const reason = `child was not started: inherited ${readInheritedLimiter} allowance already exhausted`;
          host.markChildBudgetExhausted(readInheritedLimiter, reason);
          const rejected = host.settleInheritedBudgetRejectedChild(
            action,
            meta,
            callbacks,
            toolId,
            subId,
            reason,
            readInheritedLimiter,
          );
          host.abortController.signal.removeEventListener(
            "abort",
            onParentAbort,
          );
          return rejected;
        }
        host.persistToolStartedAtExecutorDispatch(action, meta);
        const subResult = await runReadOnlyAgentLoop({
          verb: "ask",
          task: action.task,
          projectRoot: host.options.projectRoot,
          seedPaths: [],
          toolContext: {
            agentId: subId,
            runId: host.engineRunId,
            runDir: childRunDir,
            babelRoot: process.env["BABEL_ROOT"] ?? process.cwd(),
            signal: childController.signal,
          },
          maxRounds: childRounds,
          preset: "read_only",
          abortSignal: childController.signal,
          ...(childLane?.useDeterministicMock !== undefined
            ? { useDeterministicMock: childLane.useDeterministicMock }
            : {}),
          ...(childLane?.actionResolver
            ? { actionResolver: childLane.actionResolver }
            : {}),
          ...(childLane?.executor ? { executor: childLane.executor } : {}),
          ...(spec.resolvedModel ? { model: spec.resolvedModel } : {}),
          ...(spec.instructions
            ? { additionalInstructions: spec.instructions }
            : {}),
          inheritedAllowance: readAllowance,
          onUsageRecorded: () => {
            if (readAllowance.parentTaskOwnerId) {
              try {
                host.persistOwnerCharges(
                  readAllowance.parentTaskOwnerId,
                  ownerRunDir,
                );
              } catch (error) {
                host.recordOwnerAccountingFault(
                  {
                    taskOwnerId: readAllowance.parentTaskOwnerId,
                    accountingEpoch: globalCostTracker.getAccountingEpoch(),
                    turnId: host.parity.turnId,
                    chargeId: null,
                    ownerGeneration,
                  },
                  "persistence-failure",
                  error instanceof Error ? error.message : String(error),
                  readAllowance.parentTaskOwnerId ===
                    host.taskAllowance?.taskOwnerId &&
                    host.isSubmissionCurrent(ownerGeneration),
                );
                throw new Error("Delegated charge receipt could not be saved");
              }
            }
            // R0-8: a superseded child must not flush the new task's
            // cost baseline / active-execution checkpoint.
            if (host.isSubmissionCurrent(ownerGeneration)) {
              host.persistTaskCostBaseline();
            }
          },
        } as any);
        // R0-7: a read-only child that resolves after the parent candidate
        // moved (or the submission was superseded) is historical evidence
        // only — it must not be attributed to the current task.
        if (childResultIsStale(0)) {
          return host.settleStaleChildResult(
            tool,
            target,
            subId,
            meta.index,
            "parent submission/revision superseded before the child resolved",
          );
        }
        const attribution: SubagentAttribution =
          subResult.needsApproval || subResult.policyBlocked
            ? "child_policy_block"
            : subResult.inheritedBudgetExceeded
              ? childBudgetAttribution(subResult.inheritedBudgetLimiter)
              : subResult.providerError
                ? classifySubagentFailure({
                    success: false,
                    error: subResult.providerError,
                    changedFilesCount: 0,
                    aborted: childController.signal.aborted,
                  })
                : subResult.roundExhausted
                  ? "child_round_exhaustion"
                  : childController.signal.aborted
                    ? "child_cancellation"
                    : subResult.completed
                      ? "child_noop"
                      : classifySubagentFailure({
                          success: false,
                          error: subResult.blockedReason,
                          changedFilesCount: 0,
                        });
        const clean = subagentFinishedCleanly(attribution);
        const details = `${subResult.stepsExecuted} steps, 0 changed, attribution=${attribution}`;
        // S02/#212: one bounded child result (conclusion + structured status
        // + evidence refs). Child-reported only; never completion authority.
        const childResult = buildReadOnlyChildResult({
          steps: subResult.steps,
          toolCallLog: subResult.toolCallLog,
          observations: subResult.observations,
          stepsExecuted: subResult.stepsExecuted,
          degraded: subResult.degraded,
          completed: subResult.completed,
          roundExhausted: subResult.roundExhausted,
          policyBlocked: subResult.policyBlocked,
          ...(subResult.needsApproval !== undefined
            ? { needsApproval: subResult.needsApproval }
            : {}),
          ...(subResult.providerError !== undefined
            ? { providerError: subResult.providerError }
            : {}),
          ...(subResult.inheritedBudgetExceeded !== undefined
            ? { inheritedBudgetExceeded: subResult.inheritedBudgetExceeded }
            : {}),
          ...(subResult.blockedReason !== undefined
            ? { blockedReason: subResult.blockedReason }
            : {}),
          ...(subResult.roundsExecuted !== undefined
            ? { roundsExecuted: subResult.roundsExecuted }
            : {}),
          lane: "ask",
          childId: subId,
          maxRounds: childRounds,
          cancelled: childController.signal.aborted,
        });
        const childSection = renderReadOnlyChildResultSection(childResult);
        const findings = [
          formatSubAgentFindings(subId, action.task, {
            observations: subResult.observations,
            stepsExecuted: subResult.stepsExecuted,
            degraded: subResult.degraded,
            childResult,
          }),
          `attribution: ${attribution}`,
          `child_spec: ${specReceipt}`,
          `completed: ${subResult.completed}`,
          `round_exhausted: ${subResult.roundExhausted}`,
          ...(subResult.needsApproval ? ["needs_approval: true"] : []),
          ...(subResult.providerError
            ? [`provider_error: ${subResult.providerError}`]
            : []),
        ].join("\n");
        host.toolCallLog.push({
          tool,
          target,
          detail: details,
          index: meta.index,
          exit_code: clean ? 0 : 1,
          ...(clean ? {} : { error: subResult.blockedReason || attribution }),
          // S02: the text-tools path surfaces the bounded handoff via stdout;
          // `detail` stays untouched for gate/critic consumers. Note: this
          // also makes recordTurnToolObservability capture the child section
          // in observationTails (previously no tail existed for this row); it
          // is diagnostic only and is not re-injected as authority.
          stdout: childSection,
        });
        callbacks?.onToolComplete?.(
          toolId,
          details,
          clean ? undefined : subResult.blockedReason || attribution,
          clean ? 0 : 1,
        );
        if (clean) {
          callbacks.onSubAgentComplete?.({
            id: subId,
            summary: details,
          });
        } else {
          callbacks.onSubAgentFailed?.({
            id: subId,
            error: subResult.blockedReason || attribution,
          });
        }
        if (
          subResult.inheritedBudgetExceeded &&
          subResult.inheritedBudgetLimiter
        ) {
          host.markChildBudgetExhausted(
            subResult.inheritedBudgetLimiter,
            subResult.blockedReason ?? "child inherited allowance exhausted",
          );
        }
        return {
          index: meta.index,
          observation: findings,
          ...(subResult.inheritedBudgetExceeded ? { stop: true } : {}),
        };
      } catch (err) {
        // R0-7: a child failure that surfaces after the parent was
        // superseded must not poison the current task's tool log/callbacks.
        if (!host.isSubmissionCurrent(ownerGeneration)) {
          return host.settleStaleChildResult(
            tool,
            target,
            subId,
            meta.index,
            "parent submission superseded before the child settled",
          );
        }
        const errMsg = err instanceof Error ? err.message : String(err);
        const attribution = classifySubagentFailure({
          success: false,
          error: errMsg,
          changedFilesCount: 0,
          aborted: childController.signal.aborted,
        });
        host.toolCallLog.push({
          tool,
          target,
          detail: `failed, attribution=${attribution}`,
          error: "error",
          index: meta.index,
          exit_code: 1,
        });
        callbacks?.onToolComplete?.(
          toolId,
          `failed, attribution=${attribution}`,
          errMsg,
          1,
        );
        callbacks.onSubAgentFailed?.({ id: subId, error: errMsg });
        return {
          index: meta.index,
          observation: `### sub_agent ${subId}: ${action.task}\nattribution: ${attribution}\nError: ${errMsg}`,
        };
      } finally {
        host.abortController.signal.removeEventListener("abort", onParentAbort);
      }
    },
  );
}

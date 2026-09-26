import { readFile } from "node:fs/promises";
import { resolveClassCGateDecision } from "./autonomyEnforcement.js";
import {
  evaluatePlanThenExecuteGate,
  shouldRequireTodoPlan,
} from "./planThenExecute.js";
import {
  evaluateHardPlanModeGate,
  formatPlanHandoffUserMessage,
  operatorModeIsHardPlan,
  resolveForceMutateTurnsForHandoff,
  type ChatOperatorMode,
  type ChatPlanExecuteHandoff,
} from "./planExecuteMode.js";
import { evaluatePhaseToolGate } from "./phaseToolPolicy.js";
import {
  applyHonestTaskOutcomeToCompletion,
  createFailureBudgetTrackerFromContract,
  makeFailureCapsule,
  type FailureClassBudgetTracker,
  type FailureCapsuleV1,
} from "./taskContract.js";
import {
  resolveChatTaskClass,
  getChatTaskTune,
  type ChatTaskClass,
  type TaskOperation,
  type VerificationPolicy,
} from "../config/chatTaskClass.js";
import { appendPatchRecovery } from "./patchRecovery.js";
import {
  buildFullRereadSkipObservation,
  isExplorationBudgetTool,
  normalizeReadCacheKey,
  shouldSkipFullReread,
} from "./readThrashPolicy.js";
import {
  applyWorkingStateEvent,
  createWorkingState,
  decideReadInjection,
  evaluateReadRequest,
  formatReadFailureObservation,
  formatReadObservation,
  formatVerifierReceiptSummary,
  formatWorkingStateBlock,
  invalidateReadCacheForPath,
  recordControllerRecoveryStrategy,
  recoveryEvidenceKey,
  restoreWorkingStateSnapshot,
  sameRecoveryBinding,
  RECOVERY_EVIDENCE_TOOLS,
  resetOneShotSnapshot,
  targetMatchesGate,
  type RecoveryEvidenceProvenance,
  type RecoveryCandidateBinding,
  resolveNextTurnToolAccess,
  selectReadWindow,
  snapshotOnce,
  upsertWorkingStateMessage,
  type ReadInjectionCache,
  type WorkingState,
} from "./codingLoop/index.js";
import {
  ingestVerifierResult,
  rememberFullReadWindow,
} from "./codingLoop/chatBindings.js";
import {
  recoveryTargetIdentity,
  recoveryWorkspaceRevision,
} from "./codingLoop/recoveryIdentity.js";
import {
  actualRecoveryEdit,
  admitRecoveryPlan,
} from "./codingLoop/recoveryPlan.js";
import {
  ChatTurnSchema,
  buildAnswerSynthesisPrompt,
  mapChatActionToAgentAction,
  isMcpChatAction,
  mapChatMcpActionToToolRequest,
  formatChatToolObservation,
  formatSubAgentFindings,
  mapChatWebActionToToolRequest,
  chatActionToolName,
  chatActionTarget,
  type ChatMessage,
  type ChatToolAction,
  type ChatTurn,
  type ChatRuntimeMode,
} from "./chatToolDefinitions.js";
import {
  evaluateChatCompletionProof,
  mutationPathsFromSessionEvents,
  refreshChatVerifierReceiptStalenessSync,
  toGateToolLog,
  type BoundChatVerifierReceipt,
} from "../evidence/chatRevisionBinding.js";
import {
  executeActionWithPolicy,
  defaultToolExecutor,
  type PolicyGatedExecutionResult,
} from "./toolExecutor.js";
import { governedStrReplace } from "./governedMutations.js";
import {
  loadSessionEventLogForResume,
  loadSessionEventLogIfPresentForResume,
  interruptedToolRecoveries,
  recordCompletionDecision,
  recordCapabilityBindingReceipt,
  recordModelInputReceipt,
  recordModelInvocationPhase,
  recordModelResultDelivery,
  recordModelFailover,
  recordMutationBatch,
  recordPolicyIntervened,
  recordProgressRecovery,
  recordWorkingStateSnapshot,
  flushSessionEventLogStrict,
  resumedToolRecoveryGuidance,
  operationFingerprint,
  requiresRecoveredOutcomeReconciliation,
  type SessionEventLog,
} from "./sessionEvents.js";
import {
  remoteMcpFailClosedObservation,
  remoteMcpIsFailClosed,
} from "../bridge/remoteApproval.js";
import { createHash, randomUUID } from "node:crypto";
import {
  executeAwaitCommandAction,
  executeBackgroundRunCommandAction,
} from "./chatBackgroundShell.js";
import {
  executeSubAgentAction,
  type ChatEngineChildExecutionHost,
} from "./chatEngineChildExecution.js";
import { executeTool, renderGitDiff, type ToolContext } from "../localTools.js";
import { classifyShellCapability } from "./progressController.js";
import {
  assessMutationEffect,
  confirmedMutationPaths,
  isConfirmedMutation,
  isSuccessfulDirectMutation,
  type MutationEffectStatus,
} from "./mutationTools.js";
import {
  detectAndBuildBlockedReport as detectBlockedReportFromAnswer,
  runPostEditStaticCheck as runPostEditStaticCheckFn,
  summarizeDroppedTurns as summarizeDroppedTurnsFn,
  compactHeuristicConversation,
  pinProjectRootEnv,
  noteChatWorkspaceMutation,
  invalidateVerifierLedger,
  nativeToolUseToChatAction,
  formatResultDetail,
  countPatchStats,
  primaryPatchPath,
  executeLspChatToolAction,
} from "./chatEngineSupport.js";
import {
  isFatalWindowsProcessExit,
  logPlatformUnusableResult,
} from "./verifierFailFast.js";
import {
  prepareKernelVerifierInput,
  captureAndRecordVerifierReceipt,
  resolveEngineRequiredVerifiers,
  restorePersistedVerifierEvidence,
} from "./chatEngineVerifierAdapter.js";
import {
  deniesReadOnlyChatAction,
  filterReadOnlyChatTools,
  isReadOnlyChat,
  resolveChatRangePath,
} from "./chatReadOnly.js";
import { isDiscriminatingInspectionEvidence, wrapPresentationCallbacks, type ChatCallbacks, type ChatEngineActionExecutorHost } from './chatEngine.js';

export class ChatEngineActionExecutor {
  constructor(private readonly host: ChatEngineActionExecutorHost) {}

  async executeOneAction(
    action: ChatToolAction,
    toolContext: ToolContext,
    callbacks: ChatCallbacks,
    meta: { index: number; idempotencyKey?: string; ownerGeneration?: number },
  ): Promise<{ index: number; observation: string; stop?: boolean }>{
    // R0-10: a throwing presentation callback must not unwind settlement or
    // duplicate execution truth. All callbacks below are the safe wrappers.
    callbacks = wrapPresentationCallbacks(callbacks);
    // R0-7/R0-8: the submission that owns this action. Captured once, before
    // any await, so a tool/child that settles after the engine is superseded
    // is recognised as stale instead of being applied to the new task.
    const ownerGeneration =
      meta.ownerGeneration ?? this.host.activeSubmissionGeneration;
    const ownerRunDir = this.host.engineRunDir;
    // R0-7: the parent turn at dispatch time. Child mutation evidence must be
    // attributed to the turn that produced it, never to whatever turn is live
    // when the child finally resolves.
    const dispatchTurnId = this.host.parity.turnId;
    // R0-10: baseline for "did this invocation already record an execution
    // row?". `meta.index` is not unique across a turn (it is per-round), so the
    // catch must compare against this invocation's own baseline.
    const toolCallLogStart = this.host.toolCallLog.length;
    const tool = chatActionToolName(action);
    const target = chatActionTarget(action);
    const toolId = callbacks.onToolStart?.(tool, target) ?? -1;
    const restoreProjectRoot = pinProjectRootEnv(this.host.options.projectRoot);
    const toolStart = performance.now();

    try {
      // Plan-then-execute + optional phase tool gates (before side effects)
      const isMutationSubAgent =
        action.type === "sub_agent" &&
        (action as { mutation?: boolean }).mutation === true;
      // Implementor W1.3: hard plan mode (mutations blocked until /execute-plan).
      const hardPlanGate = deniesReadOnlyChatAction(action.type)
        ? {
            blocked: true,
            observation:
              "Read-only chat policy denied this tool; use only read_file/read_range/list_dir/grep/glob inspection.",
          }
        : evaluateHardPlanModeGate({
        toolName: tool,
        hardPlanMode: this.host.hardPlanMode,
        isMutationSubAgent,
      });
      if (hardPlanGate.blocked) {
        this.host.policyEventLog.record({
          at_turn: this.host._turnIndex,
          kind: "plan_gate_block",
          detail: "hard-plan-mode",
          tool,
        });
        this.host.toolCallLog.push({
          tool,
          target,
          detail: "hard-plan-mode",
          error: "blocked",
          index: meta.index,
          exit_code: 1,
        });
        callbacks?.onToolComplete?.(toolId, "hard-plan-mode", "blocked", 1);
        return {
          index: meta.index,
          observation: hardPlanGate.observation ?? "",
        };
      }
      const planGate = evaluatePlanThenExecuteGate({
        toolName: tool,
        requirePlan: this.host.requireTodoBeforeMutate,
        todoCount: this.host.todos.size,
        isMutationSubAgent,
      });
      if (planGate.blocked) {
        this.host.toolCallLog.push({
          tool,
          target,
          detail: "plan-gate",
          error: "blocked",
          index: meta.index,
          exit_code: 1,
        });
        callbacks?.onToolComplete?.(toolId, "plan-gate", "blocked", 1);
        return { index: meta.index, observation: planGate.observation ?? "" };
      }
      const phaseGate = evaluatePhaseToolGate({
        toolName: tool,
        phase: this.host._lastPhase,
        isMutationSubAgent,
      });
      if (phaseGate.blocked) {
        this.host.policyEventLog.record({
          at_turn: this.host._turnIndex,
          kind: "phase_gate_block",
          detail: `phase=${this.host._lastPhase ?? "null"}`,
          tool,
        });
        this.host.toolCallLog.push({
          tool,
          target,
          detail: "phase-gate",
          error: "blocked",
          index: meta.index,
          exit_code: 1,
        });
        callbacks?.onToolComplete?.(toolId, "phase-gate", "blocked", 1);
        return { index: meta.index, observation: phaseGate.observation ?? "" };
      }

      const mutationAttempt =
        action.type === "write_file" ||
        action.type === "str_replace" ||
        action.type === "apply_patch" ||
        (action.type === "sub_agent" &&
          (action as { mutation?: boolean }).mutation === true);
      // run_command is an arbitrary shell, so classify it as potentially
      // mutating before execution. A test_run command is also a process and
      // can write source despite its verifier label. During recovery it needs
      // the already-consumed one-shot repair plan before it may execute.
      const activeRecoveryGate = this.host.workingState.recoveryGate;
      const testRunWithoutRepairPermit =
        action.type === "test_run" &&
        activeRecoveryGate !== undefined &&
        !(
          activeRecoveryGate.permitConsumed === true &&
          activeRecoveryGate.admittedPlan !== undefined
        );
      const shellMutationAttempt =
        action.type === "run_command" || testRunWithoutRepairPermit;
      const shellObservation =
        action.type === "run_command" || action.type === "test_run";
      let recoveryGate = this.host.workingState.recoveryGate;
      let driftedCandidate = false;
      let currentBinding = null as RecoveryCandidateBinding | null;
      if (recoveryGate && (mutationAttempt || shellMutationAttempt)) {
        currentBinding = this.host.currentRecoveryBinding();
        if (
          !recoveryGate.binding ||
          !currentBinding ||
          !sameRecoveryBinding(recoveryGate.binding, currentBinding)
        ) {
          this.host.workingState = applyWorkingStateEvent(this.host.workingState, {
            type: "recovery_candidate_drift",
          });
          this.host.persistRecoveryWorkingState();
          recoveryGate = this.host.workingState.recoveryGate;
          driftedCandidate = true;
        }
      }
      const proposedEdit =
        recoveryGate &&
        (action.type === "write_file" ||
          action.type === "str_replace" ||
          action.type === "apply_patch")
        ? actualRecoveryEdit(action, this.host.options.projectRoot)
        : null;
      let admittedThisAction = false;
      if (
        recoveryGate?.satisfied &&
        mutationAttempt &&
        proposedEdit &&
        currentBinding &&
        !driftedCandidate
      ) {
        const proposal =
          "repair_plan" in action ? action.repair_plan : undefined;
        const admission = admitRecoveryPlan(
          this.host.workingState,
          proposal,
          proposedEdit,
          currentBinding,
        );
        if (admission.admitted) {
          this.host.workingState = admission.state;
          recoveryGate = this.host.workingState.recoveryGate;
          admittedThisAction = true;
        }
      }
      const recoveryAction =
        mutationAttempt || shellMutationAttempt || shellObservation;
      const actionFingerprint = recoveryAction
        ? (proposedEdit?.exactFingerprint ??
          operationFingerprint(chatActionToolName(action), action))
        : null;
      const equivalentRedMutation =
        recoveryAction &&
        recoveryGate?.satisfied === true &&
        recoveryGate.mutationFingerprint !== undefined &&
        recoveryGate.mutationFingerprint === actionFingerprint &&
        this.host.workingState.failureSurface?.errorSignature ===
          recoveryGate.failureSignature;
      const planRequired =
        recoveryGate !== undefined &&
        recoveryGate.satisfied === true &&
        !admittedThisAction;
      if (
        recoveryGate &&
        (((mutationAttempt || shellMutationAttempt) &&
          !recoveryGate.satisfied) ||
          ((mutationAttempt || shellMutationAttempt) && planRequired) ||
          equivalentRedMutation)
      ) {
        const detail = [
          driftedCandidate
            ? "[RECOVERY_CANDIDATE_DRIFT]"
            : equivalentRedMutation
              ? "[RECOVERY_STRATEGY_CHANGE_REQUIRED]"
              : planRequired
                ? "[RECOVERY_PLAN_REQUIRED]"
                : "[RECOVERY_EVIDENCE_REQUIRED]",
          `failure_signature=${recoveryGate.failureSignature}`,
          driftedCandidate
            ? "The workspace differs from the failed candidate; rerun the verifier before repairing."
            : equivalentRedMutation
              ? "The proposed edit repeats the failed operation."
              : planRequired
                ? "Submit a scoped repair plan supported by current observation IDs and the actual edit."
            : recoveryGate.requiredEvidence,
        ].join(" ");
        this.host.toolCallLog.push({
          tool,
          target,
          detail,
          error: "blocked",
          index: meta.index,
          exit_code: 1,
        });
              callbacks?.onToolComplete?.(
                toolId,
          "recovery-evidence-required",
          "blocked",
          1,
              );
              return {
                index: meta.index,
          observation: `### ${tool} ${target}\nexit_code: 1\n${detail}`,
              };
            }
      if (admittedThisAction) {
              this.host.workingState = applyWorkingStateEvent(this.host.workingState, {
          type: "recovery_plan_consumed",
            });
        this.host.persistRecoveryWorkingState();
              }
      if (
        this.host.recoveryStatePersistenceUnavailable &&
        (mutationAttempt || shellMutationAttempt)
      ) {
        const detail =
          "[RECOVERY_STATE_PERSISTENCE_UNAVAILABLE] Recovery state could not be saved before mutation.";
          this.host.toolCallLog.push({
            tool,
            target,
          detail,
          error: "blocked",
            index: meta.index,
          exit_code: 1,
          });
          callbacks?.onToolComplete?.(
            toolId,
          "recovery-state-persistence-unavailable",
          "blocked",
          1,
            );
          return {
            index: meta.index,
          observation: `### ${tool} ${target}\nexit_code: 1\n${detail}`,
          };
      }

      const localizationInspection =
        action.type === "read_file" ||
        action.type === "read_range" ||
        action.type === "grep" ||
        action.type === "glob" ||
        action.type === "list_dir" ||
        action.type === "semantic_search";
      if (localizationInspection) {
        const inspectionTarget =
          "file_path" in action && typeof action.file_path === "string"
            ? action.file_path
            : "path" in action && typeof action.path === "string"
              ? action.path
              : "";
        if (
          !this.host.beginRecoveryLocalizationInspection(
            action.type,
            inspectionTarget,
          )
        ) {
          const detail =
            this.host.workingState.localization?.phase === "exhausted"
              ? "[LOCALIZATION_EXHAUSTED] The four-call or two-scope localization allowance is spent."
              : "[RECOVERY_CANDIDATE_DRIFT] Rerun the verifier before localization.";
          this.host.toolCallLog.push({
              tool,
              target,
            detail,
            error: "blocked",
            index: meta.index,
            exit_code: 1,
          });
          callbacks?.onToolComplete?.(
            toolId,
            "localization-blocked",
            "blocked",
            1,
            );
          return {
            index: meta.index,
            observation: `### ${tool} ${target}\nexit_code: 1\n${detail}`,
          };
          }
      }

      const recoveredAuthorization =
        this.host.recoveredOperationDispatchAuthorization(action);
      if (!recoveredAuthorization.allowed) {
        const detail = `[RECOVERY_RECONCILIATION_REQUIRED] ${recoveredAuthorization.message ?? "Reconcile the prior unknown effect before retrying"}`;
          this.host.toolCallLog.push({
            tool,
            target,
          detail,
          error: "blocked",
            index: meta.index,
            exit_code: 1,
          });
        callbacks?.onToolComplete?.(
          toolId,
          "reconciliation-required",
          "blocked",
          1,
        );
          return {
            index: meta.index,
          observation: `### ${tool} ${target}\nexit_code: 1\n\`\`\`\n${detail}\n\`\`\``,
          };
        }

      if (action.type === "sub_agent") {
        return await executeSubAgentAction({
          host: this.host as unknown as ChatEngineChildExecutionHost,
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
        });
      }

      if (isMcpChatAction(action)) {
        if (remoteMcpIsFailClosed()) {
          const detail = remoteMcpFailClosedObservation(action.server);
          this.host.toolCallLog.push({
            tool,
            target,
            detail,
            index: meta.index,
            exit_code: 1,
          });
          callbacks?.onToolComplete?.(toolId, detail, detail, 1);
          return {
            index: meta.index,
            observation: formatChatToolObservation(action, {
              stdout: "",
              stderr: detail,
              exitCode: 1,
            }),
          };
        }
        // Local TUI: MCP calls execute without approval prompts in chat mode.
        // Safety is provided by the execution sandbox and circuit breaker,
        // not by blocking the model mid-flow. Remote does not inherit this bypass.
        const mcpResult = await executeTool(
          mapChatMcpActionToToolRequest(action),
          {
          ...toolContext,
            onBeforeDispatch: () =>
              this.host.persistToolStartedAtExecutorDispatch(action, meta),
          },
        );
        // R0-8: an MCP call is a suspension point; a superseded submission must
        // not append its result to the current task's tool log.
        if (!this.host.isSubmissionCurrent(ownerGeneration)) {
          return this.host.settleStaleActionResult(
            tool,
            target,
            meta.index,
            "parent submission superseded before the action settled",
          );
        }
        const detail =
          mcpResult.exit_code === 0
            ? "ok"
            : `exit ${mcpResult.exit_code ?? -1}`;
        this.host.toolCallLog.push({
          tool,
          target,
          detail,
          index: meta.index,
          exit_code: mcpResult.exit_code,
          stdout: mcpResult.stdout,
          stderr: mcpResult.stderr,
        });
        callbacks?.onToolComplete?.(
          toolId,
          detail,
          mcpResult.exit_code === 0 ? undefined : mcpResult.stderr || detail,
          mcpResult.exit_code ?? 0,
        );
        return {
          index: meta.index,
          observation: formatChatToolObservation(action, {
            stdout: mcpResult.stdout,
            stderr: mcpResult.stderr,
            exitCode: mcpResult.exit_code,
          }),
        };
      }

      if (action.type === "web_search" || action.type === "web_fetch") {
        const webResult = await executeTool(
          mapChatWebActionToToolRequest(action),
          {
          ...toolContext,
            onBeforeDispatch: () =>
              this.host.persistToolStartedAtExecutorDispatch(action, meta),
          },
        );
        // R0-8: a web call is a suspension point; a superseded submission must
        // not append its result to the current task's tool log.
        if (!this.host.isSubmissionCurrent(ownerGeneration)) {
          return this.host.settleStaleActionResult(
            tool,
            target,
            meta.index,
            "parent submission superseded before the action settled",
          );
        }
        const detail =
          webResult.exit_code === 0
            ? formatResultDetail(action, webResult)
            : `exit ${webResult.exit_code ?? -1}`;
        this.host.toolCallLog.push({
          tool,
          target,
          detail,
          index: meta.index,
          exit_code: webResult.exit_code,
          ...(webResult.exit_code !== 0 ? { error: "failed" as const } : {}),
        });
        callbacks?.onToolComplete?.(
          toolId,
          detail,
          webResult.exit_code === 0 ? undefined : webResult.stderr || detail,
          webResult.exit_code ?? 0,
        );
        return {
          index: meta.index,
          observation: formatChatToolObservation(action, {
            stdout: webResult.stdout,
            stderr: webResult.stderr,
            exitCode: webResult.exit_code,
          }),
        };
      }

      // Gap-1: LSP tool — read-only code intelligence via localTools executor.
      if (action.type === "lsp") {
        const lsp = await executeLspChatToolAction({
          action,
          toolContext: {
            ...toolContext,
            onBeforeDispatch: () =>
              this.host.persistToolStartedAtExecutorDispatch(action, meta),
          },
          executeTool,
        });
        // R0-8: an LSP call is a suspension point; a superseded submission must
        // not append its result to the current task's tool log.
        if (!this.host.isSubmissionCurrent(ownerGeneration)) {
          return this.host.settleStaleActionResult(
            tool,
            target,
            meta.index,
            "parent submission superseded before the action settled",
          );
        }
        this.host.toolCallLog.push({
          tool,
          target,
          detail: lsp.detail,
          index: meta.index,
          ...(lsp.exit_code !== undefined ? { exit_code: lsp.exit_code } : {}),
          ...(lsp.stdout !== undefined ? { stdout: lsp.stdout } : {}),
          ...(lsp.stderr !== undefined ? { stderr: lsp.stderr } : {}),
          ...(lsp.failed ? { error: "failed" as const } : {}),
        });
        callbacks?.onToolComplete?.(
          toolId,
          lsp.detail,
          lsp.failed ? lsp.stderr || "failed" : undefined,
          lsp.exit_code ?? (lsp.failed ? 1 : 0),
        );
        return { index: meta.index, observation: lsp.observation };
      }

      if (action.type === "finish") {
        this.host.toolCallLog.push({
          tool,
          target,
          detail: "done",
          index: meta.index,
          exit_code: 0,
        });
        callbacks?.onToolComplete?.(toolId, "done", undefined, 0);
        return { index: meta.index, observation: "" };
      }

      // ── B2: Read dedupe cache — skip read_file if file unchanged ─────
      // Path-normalized keys so absolute/relative variants share one slot.
      let fileReadCacheHash: string | undefined;
      if (action.type === "read_file") {
        if (isReadOnlyChat())
          resolveChatRangePath(this.host.options.projectRoot, action.path);
        const pathKey = this.host.readCacheKey(action.path);
        const maxFull = getChatTaskTune(this.host.taskClass).maxFullReadsPerFile;
        const priorFull = this.host.fullReadCounts.get(pathKey) ?? 0;
        if (
          shouldSkipFullReread({
            fullReadCount: priorFull,
            maxFullReads: maxFull,
          })
        ) {
          this.host.dedupeHitCount++;
          this.host.noteToolForReadThrash(tool);
          this.host.toolCallLog.push({
            tool,
            target,
            detail: "read_limit",
            index: meta.index,
            exit_code: 0,
          });
          callbacks?.onToolComplete?.(toolId, "read_limit", undefined, 0);
          return {
            index: meta.index,
            observation: buildFullRereadSkipObservation(
              target,
              priorFull,
              maxFull,
            ),
          };
        }
        fileReadCacheHash = await this.host.hashFilePath(action.path);
        // R0-8: hashing is a suspension point; a superseded submission must not
        // append its read result (or advance its caches) for the new task.
        if (!this.host.isSubmissionCurrent(ownerGeneration)) {
          return this.host.settleStaleActionResult(
            tool,
            target,
            meta.index,
            "parent submission superseded before the action settled",
          );
        }
        const fullDecision = decideReadInjection({
          pathKey,
          fileHash: fileReadCacheHash,
          request: { kind: "full" },
          cache: this.host.readCache,
          contextEpoch: this.host.readContextEpoch,
        });
        if (fullDecision.skip) {
          const cached = this.host.readCache.get(fullDecision.cacheKey);
          const secs = cached
            ? Math.round((Date.now() - cached.timestamp) / 1000)
            : 0;
          this.host.dedupeHitCount++;
          this.host.noteToolForReadThrash(tool);
          this.host.toolCallLog.push({
            tool,
            target,
            detail: "cached",
            index: meta.index,
            exit_code: 0,
          });
          callbacks?.onToolComplete?.(toolId, "cached", undefined, 0);
          return {
            index: meta.index,
            observation:
              `### ${tool} ${target}\nexit_code: 0\n\`\`\`\n` +
              `File ${target} unchanged since last identical full read (${secs}s ago). Skipping re-injection.\n\`\`\``,
          };
        }
      }

      // ── str_replace via governed mutation path (policy/checkpoint/cache) ──
      if (action.type === "str_replace") {
        const classC = resolveClassCGateDecision({
          executionProfile: this.host.executionProfile,
        });
        const gov = await governedStrReplace(
          {
            file_path: action.file_path,
            old_str: action.old_str,
            new_str: action.new_str,
          },
          {
            projectRoot: this.host.options.projectRoot,
            context: toolContext,
            preset: "workspace_write",
            executor: defaultToolExecutor,
            onDispatchAuthorized: () => recoveredAuthorization,
            onBeforeExecutorExecute: () =>
              this.host.persistToolStartedAtExecutorDispatch(action, meta),
            ...(this.host.parity.authoritySession
              ? { authoritySession: this.host.parity.authoritySession }
              : {}),
            ...(classC === "allow" ? { onAskApproval: async () => true } : {}),
          },
        );

        // R0-7/R0-8: governedStrReplace is a suspension point; a superseded
        // submission must not record a mutation batch from it.
        if (!this.host.isSubmissionCurrent(ownerGeneration)) {
          return this.host.settleStaleActionResult(
            tool,
            target,
            meta.index,
            "parent submission superseded before the action settled",
          );
        }
        if (gov.mutationPaths && gov.mutationPaths.length > 0) {
          recordMutationBatch(
            this.host.parity.sessionEvents,
            dispatchTurnId ?? "unknown",
            {
            paths: gov.mutationPaths,
              pre_hash: Object.values(gov.preBatchHash ?? {}).join(","),
              post_hash: Object.values(gov.postBatchHash ?? {}).join(","),
            ...(gov.mutationReceipt
              ? {
                  batch_id: gov.mutationReceipt.batchId,
                  starting_revision: gov.mutationReceipt.startingRevision,
                  ...(gov.mutationReceipt.endingRevision
                    ? { ending_revision: gov.mutationReceipt.endingRevision }
                    : {}),
                  changed_bytes: gov.mutationReceipt.changedBytes,
                  status: gov.mutationReceipt.status,
                  pre_image_hashes: gov.mutationReceipt.preImageHashes,
                  post_image_hashes: gov.mutationReceipt.postImageHashes,
                }
              : {}),
            },
          );
        }

        const strReplaceEffect = assessMutationEffect({
          tool: "str_replace",
          error: gov.error,
          exitCode: gov.exit_code,
          policyBlocked: gov.policyBlocked,
          mutationPaths: gov.mutationPaths,
          mutationReceipt: gov.mutationReceipt,
          effectTransaction: gov.effectTransaction,
          preDispatchNoEffect: gov.preDispatchNoEffect,
        });
        if (
          admittedThisAction &&
          proposedEdit &&
          strReplaceEffect.status === "confirmed_no_change" &&
          this.host.isSubmissionCurrent(ownerGeneration)
        ) {
          this.host.workingState = applyWorkingStateEvent(this.host.workingState, {
            type: "recovery_proven_no_effect",
            fingerprint: proposedEdit.exactFingerprint,
          });
          this.host.persistRecoveryWorkingState();
        }

        if (gov.exit_code !== 0) {
          // Process failure does not erase an independently proven workspace
          // effect.  Invalidate reads conservatively for every attempted target
          // and project confirmed changes while preserving the failed outcome.
          const effectPaths =
            gov.mutationPaths && gov.mutationPaths.length > 0
              ? gov.mutationPaths
              : [gov.absolutePath];
          for (const effectPath of effectPaths) {
            const effectKey = this.host.readCacheKey(effectPath);
            invalidateReadCacheForPath(this.host.readCache, effectKey);
            this.host.fullReadCounts.delete(effectKey);
          }
          if (strReplaceEffect.status === "indeterminate") {
            invalidateVerifierLedger(this.host as never, strReplaceEffect.reason);
          }
          if (strReplaceEffect.status === "confirmed_change") {
            const edit = actualRecoveryEdit(action, this.host.options.projectRoot);
            this.host.workingState = applyWorkingStateEvent(this.host.workingState, {
              type: "mutation",
              path: gov.absolutePath,
              fingerprint:
                edit?.exactFingerprint ??
                operationFingerprint(chatActionToolName(action), action),
              ...(edit ? { canonicalFingerprint: edit.editFingerprint } : {}),
            });
            noteChatWorkspaceMutation(this.host as never);
            callbacks?.onFileChanged?.(
              gov.absolutePath,
              (action.new_str.match(/\n/g) ?? []).length,
              (action.old_str.match(/\n/g) ?? []).length,
            );
            appendPatchRecovery(
              this.host.patchRecoveryPath ?? "",
              "str_replace",
              action.file_path,
              `old=${action.old_str.slice(0, 200)}\nnew=${action.new_str.slice(0, 200)}`,
            );
          }
          this.host.toolCallLog.push({
            tool,
            target,
            detail: "error",
            error: gov.error ?? "str_replace failed",
            index: meta.index,
            exit_code: gov.exit_code,
            effect_status: strReplaceEffect.status,
            ...(gov.mutationPaths
              ? { mutation_paths: [...gov.mutationPaths] }
              : {}),
          });
          callbacks?.onToolComplete?.(
            toolId,
            gov.policyBlocked ? "blocked" : "error",
            gov.error ?? (gov.policyBlocked ? "blocked" : "error"),
            gov.exit_code,
          );
          return { index: meta.index, observation: gov.observation };
        }
        if (strReplaceEffect.status !== "confirmed_change") {
          invalidateReadCacheForPath(
            this.host.readCache,
            this.host.readCacheKey(gov.absolutePath),
          );
          this.host.fullReadCounts.delete(this.host.readCacheKey(gov.absolutePath));
          if (strReplaceEffect.status === "indeterminate") {
            invalidateVerifierLedger(this.host as never, strReplaceEffect.reason);
          }
          this.host.toolCallLog.push({
            tool,
            target,
            detail: `effect: ${strReplaceEffect.status}`,
            index: meta.index,
            exit_code: 0,
            effect_status: strReplaceEffect.status,
          });
          callbacks?.onToolComplete?.(
            toolId,
            `effect: ${strReplaceEffect.status}`,
            undefined,
            0,
          );
          return {
            index: meta.index,
            observation: `${gov.observation}\n\nEffect: ${strReplaceEffect.status} (${strReplaceEffect.reason}).`,
          };
        }
        invalidateReadCacheForPath(
          this.host.readCache,
          this.host.readCacheKey(gov.absolutePath),
        );
        this.host.fullReadCounts.delete(this.host.readCacheKey(gov.absolutePath));
        const edit = actualRecoveryEdit(action, this.host.options.projectRoot);
        this.host.workingState = applyWorkingStateEvent(this.host.workingState, {
          type: "mutation",
          path: gov.absolutePath,
          fingerprint:
            edit?.exactFingerprint ??
            operationFingerprint(chatActionToolName(action), action),
          ...(edit ? { canonicalFingerprint: edit.editFingerprint } : {}),
        });
        noteChatWorkspaceMutation(this.host as never);
        const lineNumber = gov.lineNumber ?? 0;
        this.host.toolCallLog.push({
          tool,
          target,
          detail: `line ${lineNumber}`,
          index: meta.index,
          exit_code: 0,
          effect_status: strReplaceEffect.status,
          ...(gov.mutationPaths && gov.mutationPaths.length > 0
            ? { mutation_paths: [...gov.mutationPaths] }
            : {}),
        });
        callbacks?.onToolComplete?.(toolId, `line ${lineNumber}`, undefined, 0);
        callbacks.onFileChanged?.(
          gov.absolutePath,
          (action.new_str.match(/\n/g) ?? []).length,
          (action.old_str.match(/\n/g) ?? []).length,
        );
        let strObs = gov.observation;
        const staticResult = await this.host.runPostEditStaticCheck(
          gov.absolutePath,
        );
        if (staticResult)
          strObs += `\n\n### static_check ${target}\n${staticResult}`;
        // R0-8: the static check is a suspension point; a superseded submission
        // must not set the new task's verifier-tamper state.
        if (!this.host.isSubmissionCurrent(ownerGeneration)) {
          return this.host.settleStaleActionResult(
            tool,
            target,
            meta.index,
            "parent submission superseded before the action settled",
          );
        }
        const tamperWarning = this.host.checkVerifierTamper(gov.absolutePath);
        if (tamperWarning)
          strObs += `\n\n### verifier_integrity\n${tamperWarning}`;
        appendPatchRecovery(
          this.host.patchRecoveryPath ?? "",
          "str_replace",
          action.file_path,
          `old=${action.old_str.slice(0, 200)}\nnew=${action.new_str.slice(0, 200)}`,
        );
        return { index: meta.index, observation: strObs };
      }

      // ── B1: read_range — read specific lines ────────────────────────
      if (action.type === "read_range") {
        const rPath = resolveChatRangePath(
          this.host.options.projectRoot,
          action.file_path,
        );
        const rContent = await readFile(rPath, "utf-8");
        // R0-8: the read is a suspension point; a superseded submission must not
        // append its result for the new task.
        if (!this.host.isSubmissionCurrent(ownerGeneration)) {
          return this.host.settleStaleActionResult(
            tool,
            target,
            meta.index,
            "parent submission superseded before the action settled",
          );
        }
        const rHash = this.host.hashContent(rContent);
        const rKey = this.host.readCacheKey(rPath);
        // read_range does not bump fullReadCounts (line windows allowed)
        this.host.noteToolForReadThrash(tool);
        const evaluated = evaluateReadRequest({
          pathKey: rKey,
          fileHash: rHash,
          content: rContent,
          request: {
            kind: "range",
            startLine: action.start_line,
            endLine: action.end_line,
          },
          cache: this.host.readCache,
          contextEpoch: this.host.readContextEpoch,
        });
        if (
          evaluated.window.lines.length === 0 &&
          action.start_line > evaluated.window.totalLines
        ) {
          this.host.toolCallLog.push({
            tool,
            target,
            detail: "error",
            error: "start_line out of range",
            index: meta.index,
            exit_code: 1,
          });
          callbacks?.onToolComplete?.(
            toolId,
            "error",
            "start_line out of range",
            1,
          );
          return {
            index: meta.index,
            observation: `### read_range ${target}\nError: start_line (${action.start_line}) exceeds file length (${evaluated.window.totalLines})`,
          };
        }
        this.host.toolCallLog.push({
          tool,
          target,
          detail: `${evaluated.window.lines.length} lines`,
          index: meta.index,
          exit_code: 0,
        });
        callbacks?.onToolComplete?.(
          toolId,
          `${evaluated.window.lines.length} lines`,
          undefined,
          0,
        );
        if (this.host.isSubmissionCurrent(ownerGeneration)) {
          const evidence = `${action.type}:${target}`;
          const discrimination = isDiscriminatingInspectionEvidence(
            this.host.workingState,
            action,
            recoveryTargetIdentity(this.host.options.projectRoot, action.file_path),
            this.host.workingState.recoveryGate
              ? this.host.currentRecoveryBinding()
              : null,
            evaluated.window.lines.join("\n").trim()
              ? createHash("sha256")
                  .update(evaluated.window.lines.join("\n"))
                  .digest("hex")
              : "",
          );
          this.host.workingState = applyWorkingStateEvent(this.host.workingState, {
            type: "add_evidence",
            evidence,
            file: action.file_path,
            discriminating: discrimination.discriminating,
            ...(discrimination.provenance
              ? { provenance: discrimination.provenance }
              : {}),
          });
          if (discrimination.discriminating) {
            this.host.workingState = recordControllerRecoveryStrategy(
              this.host.workingState,
              {
              target,
              evidence,
              },
            );
            this.host.persistRecoveryWorkingState();
          }
          this.host.finishRecoveryLocalizationInspection({
            tool: "read_range",
            rawTarget: action.file_path,
            content: evaluated.window.lines.join("\n"),
            succeeded: true,
            startLine: evaluated.window.startLine,
          });
        }
        return {
          index: meta.index,
          observation: formatReadObservation(
            "read_range",
            target,
            evaluated.window,
          ),
        };
      }

      // ── B1: todo_write — merge-patch task list ─────────────────────
      if (action.type === "todo_write") {
        for (const item of action.todos) {
          this.host.todos.set(item.id, {
            content: item.content,
            status: item.status,
          });
        }
        const formattedTodos = [...this.host.todos.entries()]
          .map(([id, t]) => `- [${t.status}] ${t.content} (${id})`)
          .join("\n");
        this.host.toolCallLog.push({
          tool,
          target,
          detail: `${this.host.todos.size} todos`,
          index: meta.index,
          exit_code: 0,
        });
        callbacks?.onToolComplete?.(
          toolId,
          `${this.host.todos.size} todos`,
          undefined,
          0,
        );
        return {
          index: meta.index,
          observation: `### todo_write\nexit_code: 0\n\`\`\`\n${formattedTodos}\n\`\`\``,
        };
      }

      // Background shell — handlers in chatBackgroundShell.ts (size ratchet)
      if (action.type === "await_command") {
        return executeAwaitCommandAction(action, {
          projectRoot: this.host.options.projectRoot,
          tool,
          target,
          toolId,
          index: meta.index,
          pushLog: (entry) => {
            // R0-8: the await is a suspension point; a superseded submission
            // must not append the settled row to the new task's tool log.
            if (this.host.isSubmissionCurrent(ownerGeneration))
              this.host.toolCallLog.push(entry);
          },
          onToolComplete: callbacks.onToolComplete,
          onBeforeAwait: () =>
            this.host.persistToolStartedAtExecutorDispatch(action, meta),
        });
      }
      if (action.type === "run_command" && action.background === true) {
        return executeBackgroundRunCommandAction(action, {
          projectRoot: this.host.options.projectRoot,
          tool,
          target,
          toolId,
          index: meta.index,
          ownerId: this.host.engineRunId,
          toolCallId: meta.idempotencyKey,
          pushLog: (entry) => {
            // R0-8: a superseded submission must not append the settled row to
            // the new task's tool log.
            if (this.host.isSubmissionCurrent(ownerGeneration))
              this.host.toolCallLog.push(entry);
          },
          onToolComplete: callbacks.onToolComplete,
          onBeforeSpawn: () =>
            this.host.persistToolStartedAtExecutorDispatch(action, meta),
        });
      }

      // Capability check: reject recursive shell enumeration if shell.recursive_enumeration is DEGRADED/UNAVAILABLE
      if ("command" in action && typeof action.command === "string") {
        const classification = classifyShellCapability(
          action.type,
          action.command,
        );
        if (classification.isRecursiveEnum) {
          const capState = this.host.progressController.getCapabilityState(
            "shell.recursive_enumeration",
          );
          if (capState === "DEGRADED" || capState === "UNAVAILABLE") {
            const observation = `### ${tool} ${target}\nexit_code: 1\n\`\`\`\n[BABEL ADVISORY] Recursive shell command suppressed: shell.recursive_enumeration is DEGRADED due to repeated failures. Use the list_dir / directory_list tool instead for reliable filesystem inspection.\n\`\`\``;
            this.host.toolCallLog.push({
              tool,
              target,
              detail: "degraded_suppressed",
              index: meta.index,
              exit_code: 1,
              error: "capability_degraded",
            });
            callbacks?.onToolComplete?.(
              toolId,
              "degraded_suppressed",
              "capability_degraded",
              1,
            );
            return { index: meta.index, observation };
          }
        }
      }

      // Platform fail-fast: never re-exec a command that hard-crashed (A06 thrash).
      if (
        (action.type === "run_command" || action.type === "test_run") &&
        target &&
        this.host.platformUnusableVerifiers.has(target)
      ) {
        const prior =
          this.host.verifierReceiptCache.get(target)?.receipt.exit_code ??
          3221225794;
        return logPlatformUnusableResult({
          toolCallLog: this.host.toolCallLog,
          tool,
          target,
          exitCode: prior,
          meta,
          toolId,
          callbacks,
        });
      }

      // R8: Verifier run dedup — if the same verifier command was already run
      // and no writes have occurred since, return the cached receipt instead
      // of re-executing. This collapses repeated identical verifier runs.
      // Fatal Windows exits are not soft-cached: mark unusable and fail-fast.
      if (
        (action.type === "run_command" || action.type === "test_run") &&
        target
      ) {
        const cachedVerifier = this.host.verifierReceiptCache.get(target);
        if (
          cachedVerifier &&
          cachedVerifier.writeCountAtCache === this.host.writeCount
        ) {
          if (isFatalWindowsProcessExit(cachedVerifier.receipt.exit_code)) {
            this.host.platformUnusableVerifiers.add(target);
            return logPlatformUnusableResult({
              toolCallLog: this.host.toolCallLog,
              tool,
              target,
              exitCode: cachedVerifier.receipt.exit_code,
              meta,
              toolId,
              callbacks,
            });
          }
          this.host.dedupeHitCount++;
          this.host.toolCallLog.push({
            tool,
            target,
            detail: `cached receipt (exit ${cachedVerifier.receipt.exit_code})`,
            index: meta.index,
            exit_code: cachedVerifier.receipt.exit_code,
            stdout: cachedVerifier.receipt.summary,
          });
          callbacks?.onToolComplete?.(
            toolId,
            `cached (exit ${cachedVerifier.receipt.exit_code})`,
            cachedVerifier.receipt.exit_code === 0
              ? undefined
              : "verifier failed",
            cachedVerifier.receipt.exit_code,
          );
          return {
            index: meta.index,
            observation:
              `### ${tool} ${target}\nexit_code: ${cachedVerifier.receipt.exit_code}\n\`\`\`\n` +
              `Verifier result unchanged — no file writes since last run.\n` +
              `${cachedVerifier.receipt.summary}\n\`\`\``,
          };
        }
      }

      // Standard tool execution via policy gate
      const agentAction = mapChatActionToAgentAction(action);
      const classC = resolveClassCGateDecision({
        executionProfile: this.host.executionProfile,
      });
      const result: PolicyGatedExecutionResult = await executeActionWithPolicy(
        agentAction,
        // workspace_write = mutations auto-execute without user approval.
        // Network-touching commands (curl, npm install) are still hard-denied.
        // Future evolutions:
        //   B — new 'auto' preset that allows everything (no approval, no denial)
        //   C — BABEL_ALLOW_NETWORK_COMMANDS=1 env flag for graduated autonomy
        this.host.executionProfile === "plan" ||
          process.env["BABEL_READ_ONLY"] === "true" ||
          process.env["BABEL_EXECUTION_PROFILE"] === "read_only_audit"
          ? "read_only"
          : "workspace_write",
        toolContext,
        {
          executor: defaultToolExecutor,
          mode:
            this.host.executionProfile === "plan"
              ? "plan"
              : this.host.executionProfile === "deep"
                ? "deep"
                : "chat",
          completedIdempotencyKeys:
            this.host.getLiveSession().tools.completed_idempotency_keys,
          idempotencyKey:
            meta.idempotencyKey ??
            this.host._streamNativeToolCallIds[meta.index] ??
            `tool_call_${this.host._turnIndex}_${meta.index}`,
          ...(this.host.parity.liveAuthority?.taskContract.contract_id
            ? { taskId: this.host.parity.liveAuthority.taskContract.contract_id }
            : {}),
          ...(this.host.parity.liveAuthority?.taskContract.protected_paths
            ? {
                protectedPaths:
                  this.host.parity.liveAuthority.taskContract.protected_paths,
              }
            : {}),
          ...(this.host.parity.authoritySession
            ? { authoritySession: this.host.parity.authoritySession }
            : {}),
          onDispatchAuthorized: () =>
            this.host.recoveredOperationDispatchAuthorization(action),
          onBeforeExecutorExecute: () =>
            this.host.persistToolStartedAtExecutorDispatch(action, meta),
          // Privileged ops: lease/PDP decides. Benchmark pair is the only
          // remaining auto-approve exception. TTY is not authority.
          ...this.host.isolationBrokerFlags(),
          ...(classC === "allow" ? { onAskApproval: async () => true } : {}),
        },
      );

      // R0-7/R0-8: the governed action was a suspension point; a superseded
      // submission must not record a mutation batch or write the current
      // task's tool log from it.
      if (!this.host.isSubmissionCurrent(ownerGeneration)) {
        return this.host.settleStaleActionResult(
          tool,
          target,
          meta.index,
          "parent submission superseded before the action settled",
        );
      }
      if (result.mutationPaths && result.mutationPaths.length > 0) {
        recordMutationBatch(
          this.host.parity.sessionEvents,
          dispatchTurnId ?? "unknown",
          {
          paths: result.mutationPaths,
            pre_hash: Object.values(result.preBatchHash ?? {}).join(","),
            post_hash: Object.values(result.postBatchHash ?? {}).join(","),
          ...(result.mutationReceipt
            ? {
                batch_id: result.mutationReceipt.batchId,
                starting_revision: result.mutationReceipt.startingRevision,
                ...(result.mutationReceipt.endingRevision
                  ? { ending_revision: result.mutationReceipt.endingRevision }
                  : {}),
                changed_bytes: result.mutationReceipt.changedBytes,
                status: result.mutationReceipt.status,
                pre_image_hashes: result.mutationReceipt.preImageHashes,
                post_image_hashes: result.mutationReceipt.postImageHashes,
              }
            : {}),
          },
        );
      }

      const obsParts: string[] = [];
      for (const r of result.results) {
        if (action.type === "read_file") {
          if (r.exit_code === 0) {
            const window = selectReadWindow(r.stdout ?? "", { kind: "full" });
            obsParts.push(formatReadObservation("read_file", target, window));
          } else {
            obsParts.push(
              formatReadFailureObservation({
                tool: "read_file",
                target,
                exitCode: r.exit_code,
                stdout: r.stdout,
                stderr: r.stderr,
                toolCallId: String(toolId),
                spillDir: this.host.engineRunDir,
              }),
            );
          }
        } else {
          obsParts.push(
            formatChatToolObservation(
              action,
              {
                stdout: r.stdout,
                stderr: r.stderr,
                exitCode: r.exit_code,
              },
              { spillDir: this.host.engineRunDir, toolCallId: String(toolId) },
            ),
          );
        }
      }

      const lastResult = result.results[result.results.length - 1];
      if (lastResult) {
        if (
          lastResult.exit_code !== 0 ||
          (lastResult.stdout.trim() === "" && lastResult.stderr.trim() !== "")
        ) {
          const rec = this.host.progressController.recordFailure({
            tool: action.type,
            commandSnippet:
              "command" in action && typeof action.command === "string"
                ? action.command
                : undefined,
            exitCode: lastResult.exit_code,
            emptyStdout: lastResult.stdout.trim() === "",
          });
          if (rec.notice) {
            obsParts.push(`\n[BABEL ADVISORY] ${rec.notice}`);
          }
        } else if (lastResult.exit_code === 0) {
          this.host.progressController.recordSuccess("tool." + action.type);
          const cmd =
            "command" in action && typeof action.command === "string"
              ? action.command
              : undefined;
          const classification = classifyShellCapability(action.type, cmd);
          if (classification.isRecursiveEnum) {
            this.host.progressController.recordSuccess(
              "shell.recursive_enumeration",
            );
          }
        }
      }

      const detail = lastResult
        ? lastResult.exit_code === 0
          ? formatResultDetail(action, lastResult)
          : `exit ${lastResult.exit_code}`
        : "done";

      const directMutationAction =
        action.type === "write_file" || action.type === "apply_patch";
      const toolError = result.policyBlocked
        ? "blocked"
        : lastResult && lastResult.exit_code !== 0
          ? lastResult.stderr || detail
          : undefined;
      const mutationEffect = assessMutationEffect({
        tool,
        error: toolError,
        exitCode: lastResult?.exit_code,
        policyBlocked: result.policyBlocked,
        mutationPaths: result.mutationPaths,
        mutationReceipt: result.mutationReceipt,
        effectTransaction: result.effectTransaction,
      });
      if (
        admittedThisAction &&
        proposedEdit &&
        directMutationAction &&
        mutationEffect.status === "confirmed_no_change" &&
        this.host.isSubmissionCurrent(ownerGeneration)
      ) {
        this.host.workingState = applyWorkingStateEvent(this.host.workingState, {
          type: "recovery_proven_no_effect",
          fingerprint: proposedEdit.exactFingerprint,
        });
        this.host.persistRecoveryWorkingState();
      }
      const confirmedDirectMutation =
        directMutationAction && mutationEffect.status === "confirmed_change";

      // A direct mutation may have reached the executor without a confirmed
      // committed receipt (including a failed/partial effect). Refresh reads
      // conservatively, but do not count or project it as a confirmed write.
      if (directMutationAction && !result.policyBlocked && lastResult) {
        const possiblePaths =
          result.mutationPaths && result.mutationPaths.length > 0
            ? result.mutationPaths
            : [
                action.type === "write_file"
                  ? action.path
                  : primaryPatchPath(action.patch),
              ];
        for (const possiblePath of possiblePaths) {
          const possibleKey = this.host.readCacheKey(possiblePath);
          invalidateReadCacheForPath(this.host.readCache, possibleKey);
          this.host.fullReadCounts.delete(possibleKey);
        }
        if (!confirmedDirectMutation) {
          invalidateVerifierLedger(
            this.host as never,
            "direct mutation effect not confirmed",
          );
        }
      }

      // Keep apply_patch's user-facing projection tied to the executor's
      // actual path instead of the patch-text target summary.
      const projectedTarget =
        action.type === "apply_patch" && result.mutationPaths?.[0]
          ? result.mutationPaths[0]
          : target;

      // Log tool call for structured result metadata
      this.host.toolCallLog.push({
        tool,
        target: projectedTarget,
        detail,
        index: meta.index,
        ...(lastResult
          ? {
              exit_code: lastResult.exit_code,
              stdout: lastResult.stdout,
              stderr: lastResult.stderr,
            }
          : {}),
        ...(toolError ? { error: toolError } : {}),
        ...(result.mutationPaths && result.mutationPaths.length > 0
          ? { mutation_paths: [...result.mutationPaths] }
          : {}),
        ...(mutationEffect.status !== "not_applicable"
          ? { effect_status: mutationEffect.status }
          : {}),
      });

      if (result.policyBlocked) {
        callbacks?.onToolComplete?.(toolId, "blocked", "blocked", 1);
      } else {
        const hasErr = lastResult && lastResult.exit_code !== 0;
        callbacks?.onToolComplete?.(
          toolId,
          detail,
          hasErr ? lastResult?.stderr || "failed" : undefined,
          lastResult?.exit_code ?? 0,
        );

        if (action.type === "write_file" && confirmedDirectMutation) {
          const diff = renderGitDiff(
            { tool: "file_write", path: action.path, content: action.content },
            toolContext,
          );
          const adds = (diff.match(/^\+[^+]/gm) ?? []).length;
          const dels = (diff.match(/^-[^-]/gm) ?? []).length;
          callbacks.onFileChanged?.(action.path, adds, dels, diff);
          this.host.fullReadCounts.delete(this.host.readCacheKey(action.path));
          const edit = actualRecoveryEdit(action, this.host.options.projectRoot);
          this.host.workingState = applyWorkingStateEvent(this.host.workingState, {
            type: "mutation",
            path: action.path,
            fingerprint:
              edit?.exactFingerprint ??
              operationFingerprint(chatActionToolName(action), action),
            ...(edit ? { canonicalFingerprint: edit.editFingerprint } : {}),
          });
          noteChatWorkspaceMutation(this.host as never);
          // Crash-safe: persist patch to recovery log
          appendPatchRecovery(
            this.host.patchRecoveryPath ?? "",
            "write_file",
            action.path,
            action.content,
          );
        } else if (action.type === "apply_patch" && confirmedDirectMutation) {
          const { adds, dels } = countPatchStats(action.patch);
          const path = primaryPatchPath(action.patch);
          callbacks.onFileChanged?.(path, adds, dels, action.patch);
          const edit = actualRecoveryEdit(action, this.host.options.projectRoot);
          this.host.workingState = applyWorkingStateEvent(this.host.workingState, {
            type: "mutation",
            path,
            fingerprint:
              edit?.exactFingerprint ??
              operationFingerprint(chatActionToolName(action), action),
            ...(edit ? { canonicalFingerprint: edit.editFingerprint } : {}),
          });
          noteChatWorkspaceMutation(this.host as never);
          // Crash-safe: persist patch to recovery log
          appendPatchRecovery(
            this.host.patchRecoveryPath ?? "",
            "apply_patch",
            path,
            action.patch,
          );
        }

        // A shell action that reports confirmed mutation paths is a real write and
        // must account exactly once before verifier receipt capture. A successful
        // shell action without paths is indeterminate and only invalidates prior
        // verifier evidence.
        if (
          (action.type === "run_command" || action.type === "test_run") &&
          lastResult
        ) {
          const confirmedShellMutation =
            mutationEffect.status === "confirmed_change";
          const mutationPaths = result.mutationPaths ?? [];
          if (confirmedShellMutation) {
            this.host.workingState = applyWorkingStateEvent(this.host.workingState, {
              type: "mutation",
              path: mutationPaths[0] ?? target,
              fingerprint: operationFingerprint(
                chatActionToolName(action),
                action,
              ),
            });
            noteChatWorkspaceMutation(this.host as never);
          }

          // B1/B2: only authoritative verifier commands update the completion receipt.
          if (isFatalWindowsProcessExit(lastResult.exit_code) && target) {
            this.host.platformUnusableVerifiers.add(target);
          }
          let receipt: Awaited<
            ReturnType<typeof captureAndRecordVerifierReceipt>
          > = null;
          try {
            receipt = await captureAndRecordVerifierReceipt({
              projectRoot: this.host.options.projectRoot,
              command: target,
              exitCode: lastResult.exit_code,
              summary: formatVerifierReceiptSummary({
                verifierId: target,
                command: target,
                exitCode: lastResult.exit_code,
                stdout: lastResult.stdout,
                stderr: lastResult.stderr,
              }),
              mutationPaths: mutationPathsFromSessionEvents(
                this.host.parity.sessionEvents.events,
              ),
              allowRepositoryScopeForRedRecovery: lastResult.exit_code !== 0,
              sessionEvents: this.host.parity.sessionEvents,
              turnId: String(this.host.parity.turnId ?? this.host._turnIndex),
              ledger: this.host.executedVerifierLedger,
              cache: this.host.verifierReceiptCache,
              writeCount: this.host.writeCount,
              toolCallId:
                meta.idempotencyKey ??
                this.host._streamNativeToolCallIds[meta.index] ??
                `tool_call_${this.host._turnIndex}_${meta.index}`,
            });
          } catch (verifierErr) {
            // R0-7/R0-8: a superseded submission must not invalidate the live
            // task's verifier ledger from a stale capture failure.
            if (!this.host.isSubmissionCurrent(ownerGeneration)) {
              return this.host.settleStaleActionResult(
                tool,
                target,
                meta.index,
                "parent submission superseded before the verifier settled",
              );
            }
            // A verifier-receipt capture failure must degrade to "no receipt",
            // never fall through to the generic catch: that path records a
            // second terminal for an already-settled tool call and corrupts the
            // outbound tool protocol on the next provider request.
            invalidateVerifierLedger(
              this.host as never,
              "verifier receipt capture failed",
            );
            obsParts.push(
              `### verifier_receipt_unavailable\n${
                verifierErr instanceof Error
                  ? verifierErr.message
                  : String(verifierErr)
              }`,
            );
          }
          // R0-7/R0-8: verifier capture is a suspension point. A superseded
          // submission must not install its receipt, working state or ledger
          // invalidation on the task that now owns the engine.
          if (!this.host.isSubmissionCurrent(ownerGeneration)) {
            return this.host.settleStaleActionResult(
              tool,
              target,
              meta.index,
              "parent submission superseded before the verifier settled",
            );
          }
          if (receipt) {
            this.host.lastVerifierReceipt = receipt;
            const previousFailureSignature =
              this.host.workingState.failureSurface?.errorSignature;
            const recoveryBinding =
              lastResult.exit_code !== 0 ? this.host.currentRecoveryBinding() : null;
            const ingested = ingestVerifierResult({
              state: this.host.workingState,
              tool: action.type,
              target,
              exitCode: lastResult.exit_code,
              stdout: lastResult.stdout,
              stderr: lastResult.stderr,
              summary: receipt.summary ?? String(lastResult.exit_code),
              verifierId: target,
              recoveryProjectRoot: this.host.options.projectRoot,
              ...(recoveryBinding ? { recoveryBinding } : {}),
              ...(receipt.boundRevision?.compositeTreeHash
                ? {
                    workspaceRevision: String(
                      receipt.boundRevision.compositeTreeHash,
                    ),
                  }
                : {}),
            });
            this.host.workingState = ingested.state;
            this.host.persistRecoveryWorkingState();
            this.host.lastVerifierFailed = ingested.lastVerifierFailed;
            const surfaceKind = this.host.workingState.failureSurface?.kind;
            // Only a *classified* implementation failure spends implementation
            // repair budget. An unclassified/unknown failure may be a transport
            // or environment error after a mutation; charging it would blame the
            // repair strategy for something it did not cause.
            const implementationRepairSurface =
              surfaceKind === "TEST_FAILURE" ||
              surfaceKind === "TYPECHECK_FAILURE" ||
              surfaceKind === "BUILD_FAILURE" ||
              surfaceKind === "LINT_FAILURE" ||
              surfaceKind === "RUNTIME_FAILURE";
            if (
              implementationRepairSurface &&
              this.host.workingState.failureSurface &&
              this.host.workingState.failureSurface.causality !== "pre_existing" &&
              this.host.workingState.failureSurface.errorSignature !==
                previousFailureSignature
            ) {
              this.host.consumeFailureBudget(
                makeFailureCapsule(
                  "implementation",
                this.host.workingState.failureSurface.kind,
                this.host.workingState.failureSurface.errorSignature,
                  {
                    evidence_refs:
                      this.host.workingState.failureSurface.evidenceRefs,
                  },
                ),
              );
            }
          } else if (
            lastResult.exit_code !== 0 &&
            this.host.workingState.lastMutation
          ) {
            // A red command without a durable verifier receipt cannot grant
            // recovery authority. Keep the failed candidate closed until an
            // authoritative verifier can bind a fresh failure and revision.
            this.host.workingState = applyWorkingStateEvent(this.host.workingState, {
              type: "recovery_gate",
              failureSignature: "unbound-red-verifier",
              requiredEvidence:
                "Rerun an authoritative verifier to bind this failure to the current candidate.",
            });
            this.host.persistRecoveryWorkingState();
            this.host.lastVerifierFailed = true;
          } else if (lastResult.exit_code === 0 && !confirmedShellMutation) {
            invalidateVerifierLedger(
              this.host as never,
              "non-verifier shell command executed",
            );
          }

          // A command can mutate files and then fail. Prefer the executor's
          // changed-path receipt; without one, invalidate conservatively.
          if (!result.policyBlocked) {
            if (result.mutationPaths && result.mutationPaths.length > 0) {
              for (const changedPath of result.mutationPaths) {
                const changedKey = this.host.readCacheKey(changedPath);
                invalidateReadCacheForPath(this.host.readCache, changedKey);
                this.host.fullReadCounts.delete(changedKey);
              }
            } else {
              this.host.readCache.clear();
              this.host.fullReadCounts.clear();
            }
          }
        }

        // B2: Update read cache after successful read_file execution
        if (
          action.type === "read_file" &&
          lastResult &&
          lastResult.exit_code === 0 &&
          fileReadCacheHash
        ) {
          const pathKey = this.host.readCacheKey(action.path);
          rememberFullReadWindow(
            this.host.readCache,
            pathKey,
            fileReadCacheHash,
            lastResult.stdout ?? "",
            this.host.readContextEpoch,
          );
          this.host.fullReadCounts.set(
            pathKey,
            (this.host.fullReadCounts.get(pathKey) ?? 0) + 1,
          );
          this.host.noteToolForReadThrash(tool);
        } else if (
          action.type === "grep" ||
          action.type === "glob" ||
          action.type === "list_dir" ||
          action.type === "semantic_search"
        ) {
          this.host.noteToolForReadThrash(tool);
        }

        // A successful inspection is the discriminating observation required
        // after a red verifier.  This is controller-owned evidence: it clears
        // the recovery gate without treating model prose as proof.
        const inspectionAction =
          action.type === "read_file" ||
          action.type === "grep" ||
          action.type === "glob" ||
          action.type === "list_dir" ||
          action.type === "semantic_search";
        if (
          inspectionAction &&
          lastResult &&
          lastResult.exit_code === 0 &&
          this.host.isSubmissionCurrent(ownerGeneration)
        ) {
          const evidence = `${action.type}:${target}`;
          const discrimination = isDiscriminatingInspectionEvidence(
            this.host.workingState,
            action,
            recoveryTargetIdentity(
              this.host.options.projectRoot,
              "path" in action && typeof action.path === "string"
                ? action.path
                : "",
            ),
            this.host.workingState.recoveryGate
              ? this.host.currentRecoveryBinding()
              : null,
            lastResult.stdout.trim()
              ? createHash("sha256").update(lastResult.stdout).digest("hex")
              : "",
          );
          this.host.workingState = applyWorkingStateEvent(this.host.workingState, {
            type: "add_evidence",
            evidence,
            discriminating: discrimination.discriminating,
            ...(discrimination.provenance
              ? { provenance: discrimination.provenance }
              : {}),
            ...(action.type === "read_file" ? { file: action.path } : {}),
          });
          if (discrimination.discriminating) {
            this.host.workingState = recordControllerRecoveryStrategy(
              this.host.workingState,
              {
              target,
              evidence,
              },
            );
            this.host.persistRecoveryWorkingState();
          }
          this.host.finishRecoveryLocalizationInspection({
            tool: action.type,
            rawTarget:
              "path" in action && typeof action.path === "string"
                ? action.path
                : "",
            content: lastResult.stdout,
            succeeded: true,
            ...(action.type === "glob" ? { pattern: action.pattern } : {}),
          });
        }
      }

      // R3a: Post-edit static check after successful write/apply_patch
      if (
        (action.type === "write_file" || action.type === "apply_patch") &&
        !result.policyBlocked &&
        lastResult?.exit_code === 0
      ) {
        const editPath =
          action.type === "write_file"
            ? (action as any).path
            : primaryPatchPath((action as any).patch);
        if (editPath) {
          const staticResult = await this.host.runPostEditStaticCheck(editPath);
          if (staticResult) {
            obsParts.push(`### static_check ${editPath}\n${staticResult}`);
          }
          // R0-8: the static check is a suspension point; a superseded submission
          // must not set the new task's verifier-tamper state.
          if (!this.host.isSubmissionCurrent(ownerGeneration)) {
            return this.host.settleStaleActionResult(
              tool,
              target,
              meta.index,
              "parent submission superseded before the action settled",
            );
          }
          // R9: Check for verifier tampering — warn if a verifier dependency was modified
          const tamperWarning = this.host.checkVerifierTamper(editPath);
          if (tamperWarning) {
            obsParts.push(`### verifier_integrity\n${tamperWarning}`);
          }
        }
      }

      return { index: meta.index, observation: obsParts.join("\n") };
    } catch (err) {
      // R0-7/R0-8: an action that throws after its submission was superseded
      // must not append a failure row to the current task's tool log.
      if (!this.host.isSubmissionCurrent(ownerGeneration)) {
        return this.host.settleStaleActionResult(
          tool,
          target,
          meta.index,
          "parent submission superseded before the action settled",
        );
      }
      // R0-10: presentation callbacks are an observational side channel. If a
      // callback threw AFTER this action already recorded its execution row,
      // appending a second row would duplicate execution truth. One action
      // settles exactly one log row; only a genuine executor fault with no
      // prior row adds a failure row here.
      const alreadySettled = this.host.toolCallLog.length > toolCallLogStart;
      if (!alreadySettled) {
        this.host.toolCallLog.push({
          tool,
          target,
          detail: "error",
          error: "error",
          index: meta.index,
          exit_code: 1,
        });
      }
      try {
        callbacks?.onToolComplete?.(
          toolId,
          "error",
          err instanceof Error ? err.message : String(err),
          1,
        );
      } catch (callbackErr) {
        console.error(
          "[chatEngine] presentation callback failed after settlement (ignored):",
          callbackErr,
        );
      }
      return {
        index: meta.index,
        observation: `### ${tool} ${target}\nError: ${err instanceof Error ? err.message : String(err)}`,
      };
    } finally {
      const toolEnd = performance.now();
      const lastEntry = this.host.toolCallLog[this.host.toolCallLog.length - 1];
      const success =
        !lastEntry?.error &&
        (lastEntry?.exit_code === 0 || lastEntry?.exit_code === undefined);
      this.host.currentTurnTelemetry?.recordToolSpan(
        tool,
        target,
        Math.max(0, toolEnd - toolStart),
        success,
        toolStart,
        toolEnd,
      );
      restoreProjectRoot();
    }
  }
}

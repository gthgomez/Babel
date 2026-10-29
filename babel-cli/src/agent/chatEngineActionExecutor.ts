import { freezeChatVerifierCandidate, chatVerifierCandidateCurrent } from './chatVerifierContext.js';
import { verifierSemanticProgress } from './verifierSemanticProgress.js';
import { failedVerifierContextKey } from './codingLoop/failedVerifierExecution.js';
import { attestedFailedVerifierExecution, matchesFailedVerifierReplay } from './codingLoop/failedVerifierExecution.js';
import { formatRecoveryReadReference } from './codingLoop/workingState.js';
import { resolveClassCGateDecision } from "./autonomyEnforcement.js";
import {requireProjectRoot,denyConversationAction} from './chatToolScopeAdmission.js';
import { evaluatePlanThenExecuteGate } from "./planThenExecute.js";
import { evaluateHardPlanModeGate } from "./planExecuteMode.js";
import { evaluatePhaseToolGate } from "./phaseToolPolicy.js";
import { getChatTaskTune } from "../config/chatTaskClass.js";
import { appendPatchRecovery } from "./patchRecovery.js";
import { buildFullRereadSkipObservation, shouldSkipFullReread } from "./readThrashPolicy.js";
import {
  applyWorkingStateEvent,
  decideReadInjection,
  formatReadFailureObservation,
  formatReadObservation,
  invalidateReadCacheForPath,
  recordControllerRecoveryStrategy,
  sameRecoveryBinding,
  type RecoveryCandidateBinding,
  selectReadWindow,
} from "./codingLoop/index.js";
import {
  rememberFullReadWindow,
} from "./codingLoop/chatBindings.js";
import {
  EditReflectionTracker,
  EDIT_REFLECTION_CAP_MARKER,
  formatEditReflectionCapSurface,
  formatEditReflectionNote,
} from "./codingLoop/reflection.js";
import type { EditFormatId } from "./codingLoop/editFormatPolicy.js";
import { recoveryBindingUnavailableReason, recoveryTargetIdentity } from "./codingLoop/recoveryIdentity.js";
import {
  bindCapabilityRecoveryScope,
  bindIsolationPrerequisiteScope,
  shellBlockedByIsolation,
} from "./capabilityRecoveryScope.js";
import {
  actualRecoveryEdit,
  admitRecoveryPlan,
  formatRecoveryPlanRejection,
} from "./codingLoop/recoveryPlan.js";
import {
  mapChatActionToAgentAction,
  isMcpChatAction,
  mapChatMcpActionToToolRequest,
  formatChatToolObservation,
  mapChatWebActionToToolRequest,
  chatActionToolName,
  chatActionTarget,
  type ChatToolAction,
} from "./chatToolDefinitions.js";
import {
  executeActionWithPolicy,
  defaultToolExecutor,
  type PolicyGatedExecutionResult,
} from "./toolExecutor.js";
import { settleChatVerifierResult } from "./chatVerifierSettlement.js";
import { isAuthoritativeVerifierCommand } from "./completionGatePolicy.js";
import { acceptToolStop, settlePreventedChatAction } from './chatEngineRunControl.js';
import { RunStoppedError } from '../runtime/run-control.js';
import { chatReadToolExecutor } from "./chatReadExecutor.js";
import { governedStrReplace } from "./governedMutations.js";
import { executeGovernedApplyPatchAction } from "./codingLoop/applyPatchExecutor.js";
import { executeReadRangeAction } from "./codingLoop/readRangeExecutor.js";
import { executeTodoWriteAction } from "./codingLoop/todoWriteExecutor.js";
import { recordMutationBatch, operationFingerprint } from "./sessionEvents.js";
import {
  remoteMcpFailClosedObservation,
  remoteMcpIsFailClosed,
} from "../bridge/remoteApproval.js";
import { createHash } from "node:crypto";
import {
  executeChatAwaitCommandAction,
  createChatBackgroundExecutor,
} from "./chatBackgroundShell.js";
import {
  executeSubAgentAction,
  type ChatEngineChildExecutionHost,
} from "./chatEngineChildExecution.js";
import { executeTool, renderGitDiff, type ToolContext } from "../localTools.js";
import { classifyShellCapability } from "./progressController.js";
import { executeChatLspAction } from "./chatEngineLspAction.js";
import { assessMutationEffect } from "./mutationTools.js";
import {
  pinProjectRootEnv,
  invalidateChatPathReads,
  noteChatWorkspaceMutation,
  invalidateVerifierLedger,
  formatResultDetail,
  countPatchStats,
  primaryPatchPath,
} from "./chatEngineSupport.js";
import {
  isFatalWindowsProcessExit,
  logPlatformUnusableResult,
} from "./verifierFailFast.js";
import {
  resolveVerifierCacheIdentity,
  shouldReuseCachedVerifierReceipt,
} from "./chatEngineVerifierAdapter.js";
import {
  admitProjectContentRead,
  deniesReadOnlyChatAction,
  deniesReadOnlyTaskAction,
  isReadOnlyChat,
  resolveChatRangePath,
} from "./chatReadOnly.js";
import {
  isDiscriminatingInspectionEvidence,
  wrapPresentationCallbacks,
} from "./chatEngineHelpers.js";
import type { ChatActionResult, ChatCallbacks, ChatEngineActionExecutorHost } from "./chatEngineContracts.js";
import { captureRunArtifactAccess, executeReadArtifactAction, formatRegisteredToolObservation } from './codingLoop/readArtifactExecutor.js';
export type { ChatEngineActionExecutorHost } from "./chatEngineContracts.js";

export class ChatEngineActionExecutor {
  /** Bounded reflection counter on failed edits — per file per turn (C2). */
  private readonly editReflection = new EditReflectionTracker();
  /** Packet D2: whether any edit-format outcome has been observed this session. */
  private editFormatSawOutcome = false;

  constructor(private readonly host: ChatEngineActionExecutorHost) {}

  /**
   * Packet D2: feed one edit-format outcome into the per-session tracker and
   * record the active format in the policy event log. A policy block is a
   * gate decision, never format evidence. Demotion/promotion events and the
   * first observed outcome each assert the active format in telemetry.
   */
  private recordEditFormatOutcome(
    format: EditFormatId,
    effect: { status: string },
    policyBlocked: boolean,
  ): void {
    const session = this.host.editFormatSession;
    if (!session) return;
    const isFirstOutcome = !this.editFormatSawOutcome;
    this.editFormatSawOutcome = true;
    const applied = effect.status === "confirmed_change";
    const events = session.recordOutcome(format, { applied, policyBlocked });
    const detail =
      `format=${format} applied=${applied} ` +
      `active=${session.activeFormat()} family=${session.getFamily()}`;
    if (isFirstOutcome || events.demotedNow || events.promotedNow) {
      this.host.policyEventLog.record({
        at_turn: this.host._turnIndex,
        kind: "edit_format",
        detail: events.demotedNow
          ? `${detail} demoted=${events.demotedNow}`
          : events.promotedNow
            ? `${detail} promoted=${events.promotedNow}`
            : detail,
        tool: format,
      });
    }
  }

  async executeOneAction(
    action: ChatToolAction,
    toolContext: ToolContext,
    callbacks: ChatCallbacks,
    meta: { index: number; idempotencyKey?: string; ownerGeneration?: number },
  ): Promise<ChatActionResult> {
    // R0-10: a throwing presentation callback must not unwind settlement or
    // duplicate execution truth. All callbacks below are the safe wrappers.
    callbacks = wrapPresentationCallbacks(callbacks);
    if(this.host.options.executionScope?.kind==='conversation')return denyConversationAction(this.host,action,callbacks,meta.index,meta.ownerGeneration);
    // R0-7/R0-8: the submission that owns this action. Captured once, before
    // any await, so a tool/child that settles after the engine is superseded
    // is recognised as stale instead of being applied to the new task.
    const ownerGeneration =
      meta.ownerGeneration ?? this.host.activeSubmissionGeneration;
    const ownerRunDir = this.host.engineRunDir;
    const acceptedOperation = this.host.getTurnRuntimeSnapshot()?.effectiveOperation;
    const taskReadOnlyDenied = deniesReadOnlyTaskAction(action, acceptedOperation,
      acceptedOperation === "READ_ONLY" ? this.host.getResolvedRequiredVerifiers() : []);
    // R0-7: the parent turn at dispatch time. Child mutation evidence must be
    // attributed to the turn that produced it, never to whatever turn is live
    // when the child finally resolves.
    const dispatchTurnId = this.host.parity.turnId;
    // R0-10: indices restart each round. Match this invocation's index only
    // in rows appended to its dispatch log after this baseline.
    const toolCallLog = this.host.toolCallLog;
    const toolCallLogStart = toolCallLog.length;
    const turnTelemetry = this.host.currentTurnTelemetry;
    const tool = chatActionToolName(action);
    const target = chatActionTarget(action);
    const toolId = callbacks.onToolStart?.(tool, target) ?? -1;
    const artifactAccess = captureRunArtifactAccess(this.host, ownerGeneration, String(meta.idempotencyKey ?? toolId), tool);
    const restoreProjectRoot = pinProjectRootEnv(requireProjectRoot(this.host.options));
    const toolStart = performance.now();

    try {
    const frozenVerifierDispatch = action.type === 'run_command' || action.type === 'test_run' ? {
      owner: this.host.currentVerifierOwner(), candidate: this.host.currentRecoveryBinding(),
      proofCandidate: freezeChatVerifierCandidate(requireProjectRoot(this.host.options)),
      identity: resolveVerifierCacheIdentity({ projectRoot: requireProjectRoot(this.host.options), command: target,
        ...(action.cwd !== undefined ? { cwd: action.cwd } : {}) }),
      foreground: action.type === 'test_run' || action.background !== true, signal: toolContext.signal,
    } : undefined;
    const failedReplay = frozenVerifierDispatch?.foreground === true && !!frozenVerifierDispatch.candidate &&
      attestedFailedVerifierExecution(this.host.parity.sessionEvents, this.host.workingState.settledFailedVerifier) &&
      matchesFailedVerifierReplay(this.host.workingState.settledFailedVerifier, { command: target,
        owner: frozenVerifierDispatch.owner, cwd: frozenVerifierDispatch.identity.cwd, environmentFingerprint: frozenVerifierDispatch.identity.envKey });

      // Plan-then-execute + optional phase tool gates (before side effects)
      const isMutationSubAgent =
        action.type === "sub_agent" &&
        (action as { mutation?: boolean }).mutation === true;
      // Implementor W1.3: hard plan mode (mutations blocked until /execute-plan).
      const hardPlanGate = deniesReadOnlyChatAction(action.type) || taskReadOnlyDenied
        ? {
            blocked: true,
            observation:
              "Read-only chat policy denied this tool; use inspection or the task's declared foreground verifier within its execution policy.",
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
        repairInvestigation: this.host.lastVerifierFailed,
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
          this.host.workingState = applyWorkingStateEvent(
            this.host.workingState,
            {
              type: "recovery_candidate_drift",
            },
          );
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
          ? actualRecoveryEdit(action, requireProjectRoot(this.host.options))
          : null;
      let admittedThisAction = false;
      let recoveryPlanRejection: string | undefined;
      if (
        recoveryGate?.satisfied &&
        mutationAttempt &&
        proposedEdit &&
        currentBinding &&
        !driftedCandidate
      ) {
        const admission = admitRecoveryPlan(
          this.host.workingState,
          "repair_plan" in action ? action.repair_plan : undefined,
          proposedEdit,
          currentBinding,
        );
        recoveryPlanRejection = admission.reason;
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
        recoveryGate && !failedReplay &&
        (((mutationAttempt || shellMutationAttempt) &&
          !recoveryGate.satisfied) ||
          ((mutationAttempt || shellMutationAttempt) && planRequired) ||
          equivalentRedMutation)
      ) {
        const unavailableBindingReason = recoveryBindingUnavailableReason();
        const detail = [
          driftedCandidate
            ? unavailableBindingReason
              ? "[RECOVERY_SHADOW_CONTEXT_UNSUPPORTED]"
              : "[RECOVERY_CANDIDATE_DRIFT]"
            : equivalentRedMutation
              ? "[RECOVERY_STRATEGY_CHANGE_REQUIRED]"
              : planRequired
                ? "[RECOVERY_PLAN_REQUIRED]"
                : "[RECOVERY_EVIDENCE_REQUIRED]",
          `failure_signature=${recoveryGate.failureSignature}`,
          driftedCandidate
            ? unavailableBindingReason ?? "The workspace differs from the failed candidate; rerun the verifier before repairing."
            : equivalentRedMutation
              ? "The proposed edit repeats the failed operation."
              : planRequired
                ? formatRecoveryPlanRejection(this.host.workingState, recoveryPlanRejection, proposedEdit)
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
      // Revalidate the host admission at the last policy dispatch boundary. An
      // absent target may have appeared while governance/approval suspended.
      const recoveryDispatchAuthorization = () => {
        const recovered = this.host.recoveredOperationDispatchAuthorization(action);
        if (!recovered.allowed || !admittedThisAction || !proposedEdit) return recovered;
        const binding = this.host.currentRecoveryBinding();
        const actual = (action.type === "write_file" || action.type === "str_replace" || action.type === "apply_patch")
          ? actualRecoveryEdit(action, requireProjectRoot(this.host.options)) : null;
        if (!binding || !currentBinding || !sameRecoveryBinding(binding, currentBinding) || !actual ||
            JSON.stringify(actual.targetIdentities) !== JSON.stringify(proposedEdit.targetIdentities) ||
            JSON.stringify(actual.existingTargetIdentities) !== JSON.stringify(proposedEdit.existingTargetIdentities)) {
          if (this.host.isSubmissionCurrent(ownerGeneration)) {
            this.host.workingState = applyWorkingStateEvent(this.host.workingState, { type: "recovery_candidate_drift" });
            this.host.persistRecoveryWorkingState();
          }
          return { allowed: false, message: "[RECOVERY_CANDIDATE_DRIFT] Edit targets changed before dispatch; rerun the verifier and obtain fresh reads." };
        }
        return recovered;
      };
      if (admittedThisAction) {
        this.host.workingState = applyWorkingStateEvent(
          this.host.workingState,
          {
            type: "recovery_plan_consumed",
          },
        );
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
        this.host.beginRecoveryLocalizationInspection(action.type, inspectionTarget);
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
        return await executeChatLspAction({
          host: this.host, action, toolContext, callbacks, meta,
          ownerGeneration, tool, target, toolId,
          ...(acceptedOperation !== undefined ? { acceptedOperation } : {}),
        });
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
      // Admission runs before the cache hash so a denied path is never opened.
      const recoveryReadBindingBefore = action.type === 'read_file' && this.host.workingState.recoveryGate
        ? this.host.currentRecoveryBinding() : null;
      const recoveryReadTarget = action.type === 'read_file' ? recoveryTargetIdentity(requireProjectRoot(this.host.options), action.path) : null;
      const refreshRecoveryRead = action.type === 'read_file' && recoveryReadBindingBefore &&
        this.host.workingState.recoveryGate?.binding && sameRecoveryBinding(recoveryReadBindingBefore, this.host.workingState.recoveryGate.binding) &&
        !this.host.workingState.recoveryGate.readRecords?.slice(-8).some(record => record.tool === 'read_file' && record.target === recoveryReadTarget);
      let fileReadCacheHash: string | undefined;
      if (action.type === "read_file" || action.type === "read_range") {
        const requestedPath =
          action.type === "read_file" ? action.path : action.file_path;
        const admitted = admitProjectContentRead(
          requireProjectRoot(this.host.options),
          requestedPath,
        );
        if (!admitted.ok) {
          const detail = `${admitted.code}: ${admitted.message}`;
          this.host.toolCallLog.push({
            tool,
            target,
            detail: "denied",
            error: admitted.code,
            index: meta.index,
            exit_code: 1,
          });
          callbacks?.onToolComplete?.(toolId, "denied", admitted.code, 1);
          return {
            index: meta.index,
            observation: `### ${tool} ${target}\nexit_code: 1\n\`\`\`\n${detail}\n\`\`\``,
          };
        }
      }
      if (action.type === "read_file") {
        if (isReadOnlyChat())
          resolveChatRangePath(requireProjectRoot(this.host.options), action.path);
        const pathKey = this.host.readCacheKey(action.path);
        const maxFull = getChatTaskTune(
          this.host.taskClass,
        ).maxFullReadsPerFile;
        const priorFull = this.host.fullReadCounts.get(pathKey) ?? 0;
        if (
          !refreshRecoveryRead && shouldSkipFullReread({
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
            admittedProjectRead: true,
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
        if (fullDecision.skip && !refreshRecoveryRead) {
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
            admittedProjectRead: true,
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
            projectRoot: requireProjectRoot(this.host.options),
            context: toolContext,
            preset: "workspace_write",
            executor: this.host.options.toolExecutorForTesting ?? defaultToolExecutor,
            onDispatchAuthorized: recoveryDispatchAuthorization,
            onBeforeExecutorExecute: () =>
              this.host.persistToolStartedAtExecutorDispatch(action, meta),
            ...(this.host.parity.authoritySession
              ? { authoritySession: this.host.parity.authoritySession }
              : {}),
            ...(this.host.parity.liveAuthority?.taskContract.protected_paths
              ? {
                  protectedPaths:
                    this.host.parity.liveAuthority.taskContract.protected_paths,
                }
              : {}),
            ...(classC === "allow" ? { onAskApproval: async () => true } : {}),
          },
        );

        // R0-7/R0-8: governedStrReplace is a suspension point; a superseded
        // submission must not record a mutation batch from it.
        acceptToolStop(toolContext.runControl, gov);
        if (!this.host.isSubmissionCurrent(ownerGeneration)) {
          return this.host.settleStaleActionResult(
            tool,
            target,
            meta.index,
            "parent submission superseded before the action settled",
          );
        }
        const prevented = settlePreventedChatAction({ host: this.host, control: toolContext.runControl, notStarted: gov.notStarted, tool, target, toolId, meta, callbacks });
        if (prevented) return prevented;
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
        // Packet D2: outcome feeds per-model format demotion/promotion.
        this.recordEditFormatOutcome(
          "str_replace",
          strReplaceEffect,
          gov.policyBlocked === true,
        );
        if (
          admittedThisAction &&
          proposedEdit &&
          strReplaceEffect.status === "confirmed_no_change" &&
          this.host.isSubmissionCurrent(ownerGeneration)
        ) {
          this.host.workingState = applyWorkingStateEvent(
            this.host.workingState,
            {
              type: "recovery_proven_no_effect",
              fingerprint: proposedEdit.exactFingerprint,
            },
          );
          this.host.persistRecoveryWorkingState();
        }

        if (!gov.policyBlocked && strReplaceEffect.status !== "confirmed_no_change" && strReplaceEffect.status !== "not_applicable") {
          this.host.invalidateRepositoryContext(gov.mutationPaths ?? [gov.absolutePath], "governed string replacement settlement");
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
            invalidateVerifierLedger(
              this.host as never,
              strReplaceEffect.reason,
            );
          }
          if (strReplaceEffect.status === "confirmed_change") {
            const edit = actualRecoveryEdit(
              action,
              requireProjectRoot(this.host.options),
            );
            this.host.workingState = applyWorkingStateEvent(
              this.host.workingState,
              {
                type: "mutation",
                path: gov.absolutePath,
                fingerprint:
                  edit?.exactFingerprint ??
                  operationFingerprint(chatActionToolName(action), action),
                ...(edit ? { canonicalFingerprint: edit.editFingerprint } : {}),
              },
            );
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
          // C2: bounded reflection — the failed-edit diagnostics above already
          // flow back to the model; count the round and cap retries per file
          // per turn. A policy block is a gate decision, not an anchor
          // failure, so it does not consume a reflection round.
          let strReplaceReflectionObs = gov.observation;
          let strReplaceReflectionStop: boolean | undefined;
          if (!gov.policyBlocked) {
            const decision = this.editReflection.recordFailure(
              ownerGeneration,
              gov.absolutePath,
            );
            if (decision.capped) {
              strReplaceReflectionObs = formatEditReflectionCapSurface(
                target,
                gov.observation,
              );
              strReplaceReflectionStop = true;
              this.host.policyEventLog.record({
                at_turn: this.host._turnIndex,
                kind: "edit_reflection_cap",
                detail:
                  `rounds=${decision.round} file=${target} ` +
                  `error=${(gov.error ?? "str_replace failed").slice(0, 120)}`,
                tool,
              });
            } else {
              strReplaceReflectionObs += `\n\n${formatEditReflectionNote(decision)}`;
            }
          }
          this.host.toolCallLog.push({
            tool,
            target,
            detail: strReplaceReflectionStop
              ? EDIT_REFLECTION_CAP_MARKER
              : "error",
            error: gov.error ?? "str_replace failed",
            index: meta.index,
            exit_code: gov.exit_code,
            effect_status: strReplaceEffect.status,
            ...(gov.preDispatchNoEffect === true ? { preDispatchNoEffect: true as const } : {}),
            ...(gov.mutationPaths
              ? { mutation_paths: [...gov.mutationPaths] }
              : {}),
          });
          callbacks?.onToolComplete?.(
            toolId,
            strReplaceReflectionStop
              ? EDIT_REFLECTION_CAP_MARKER
              : gov.policyBlocked
                ? "blocked"
                : "error",
            gov.error ?? (gov.policyBlocked ? "blocked" : "error"),
            gov.exit_code,
          );
          return {
            index: meta.index,
            observation: strReplaceReflectionObs,
            ...(strReplaceReflectionStop ? { stop: true as const } : {}),
          };
        }
        // C2: a successful edit clears the file's reflection counter.
        if (gov.exit_code === 0) {
          this.editReflection.recordSuccess(ownerGeneration, gov.absolutePath);
        }
        if (strReplaceEffect.status !== "confirmed_change") {
          invalidateReadCacheForPath(
            this.host.readCache,
            this.host.readCacheKey(gov.absolutePath),
          );
          this.host.fullReadCounts.delete(
            this.host.readCacheKey(gov.absolutePath),
          );
          if (strReplaceEffect.status === "indeterminate") {
            invalidateVerifierLedger(
              this.host as never,
              strReplaceEffect.reason,
            );
          }
          this.host.toolCallLog.push({
            tool,
            target,
            detail: `effect: ${strReplaceEffect.status}`,
            index: meta.index,
            exit_code: 0,
            effect_status: strReplaceEffect.status,
            ...(gov.preDispatchNoEffect === true ? { preDispatchNoEffect: true as const } : {}),
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
        this.host.fullReadCounts.delete(
          this.host.readCacheKey(gov.absolutePath),
        );
        const edit = actualRecoveryEdit(action, requireProjectRoot(this.host.options));
        this.host.workingState = applyWorkingStateEvent(
          this.host.workingState,
          {
            type: "mutation",
            path: gov.absolutePath,
            fingerprint:
              edit?.exactFingerprint ??
              operationFingerprint(chatActionToolName(action), action),
            ...(edit ? { canonicalFingerprint: edit.editFingerprint } : {}),
          },
        );
        noteChatWorkspaceMutation(this.host as never);
        const lineNumber = gov.lineNumber ?? 0;
        this.host.toolCallLog.push({
          tool,
          target,
          detail: `line ${lineNumber}`,
          index: meta.index,
          exit_code: 0,
          effect_status: strReplaceEffect.status,
          ...(gov.preDispatchNoEffect === true ? { preDispatchNoEffect: true as const } : {}),
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

      // ── apply_patch via governed mutation path (transactional hunk applier).
      // Hunks are applied in memory first; any failed hunk means nothing is
      // written. Each target file's new content is dispatched through the same
      // write_file policy gate as str_replace. Extracted to
      // codingLoop/applyPatchExecutor.ts to respect the file-size ratchet.
      // Deliberately NOT a narrowing `action.type ===` comparison: a
      // type-exhaustive branch here would exclude "apply_patch" from `action`
      // for the remainder of this method and break downstream narrowing.
      const applyPatchAction = action as ChatToolAction | undefined;
      const isApplyPatch =
        applyPatchAction !== undefined &&
        (applyPatchAction as { type: string }).type === "apply_patch";
      if (isApplyPatch) {
        return await executeGovernedApplyPatchAction({
          host: this.host,
          action: action as Extract<ChatToolAction, { type: "apply_patch" }>,
          patchText: (action as Extract<ChatToolAction, { type: "apply_patch" }>).patch,
          toolContext,
          tool,
          target,
          toolId,
          meta,
          ownerGeneration,
          dispatchTurnId,
          recoveredAuthorization,
          recoveryDispatchAuthorization,
          admittedThisAction,
          proposedEdit,
          callbacks,
          editReflection: this.editReflection,
        });
      }

      // ── B1: read_range — read specific lines ────────────────────────
      if (action.type === 'read_artifact') {
        return executeReadArtifactAction({ host: this.host, action, access: artifactAccess,
          callbacks, meta, toolId, ownerGeneration, ...(toolContext.signal ? { signal: toolContext.signal } : {}) });
      }
      if (action.type === "read_range") {
        // Extracted to codingLoop/readRangeExecutor.ts to respect the
        // file-size ratchet (same pattern as the background-shell handlers).
        return await executeReadRangeAction({
          host: this.host,
          action,
          tool,
          target,
          toolId,
          meta,
          ownerGeneration,
          callbacks,
        });
      }

      // ── B1: todo_write — merge-patch task list ─────────────────────
      if (action.type === "todo_write") {
        return executeTodoWriteAction({
          host: this.host,
          action,
          tool,
          target,
          toolId,
          meta,
          callbacks,
        });
      }

      // Background shell — handlers in chatBackgroundShell.ts (size ratchet)
      if (action.type === "await_command") {
        return await executeChatAwaitCommandAction(action, {
          host: this.host,
          projectRoot: requireProjectRoot(this.host.options),
          tool,
          target,
          toolId,
          index: meta.index,
          ownerGeneration,
          meta,
          callbacks,
          artifactAccess,
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
            // One bounded probe per capability × task × trusted environment: a
            // success restores availability, a failure stays consumed.
            const probeAdmitted = this.host.progressController.admitCapabilityRecoveryProbe({
              capability: "shell.recursive_enumeration",
              ...bindCapabilityRecoveryScope(this.host),
            });
            if (!probeAdmitted) {
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
      // in this directory and environment, and the workspace bytes its receipt
      // bound are provably unchanged, return the cached receipt instead of
      // re-executing. Write count alone is not sufficient: some shell actions
      // mark receipts stale without bumping it. Fatal Windows exits are not
      // soft-cached: mark unusable and fail-fast.
      if (
        (action.type === "run_command" || action.type === "test_run") &&
        target
      ) {
        const cacheIdentity = resolveVerifierCacheIdentity({
          projectRoot: requireProjectRoot(this.host.options),
          command: target,
          ...(action.cwd !== undefined ? { cwd: action.cwd } : {}),
        });
        const cachedVerifier = this.host.verifierReceiptCache.get(cacheIdentity.key);
        if (
          cachedVerifier && !(failedReplay && (recoveryGate?.failureSignature === 'unbound-red-verifier' || driftedCandidate || !recoveryGate?.binding)) &&
          cachedVerifier.cwd === cacheIdentity.cwd &&
          cachedVerifier.envKey === cacheIdentity.envKey &&
          cachedVerifier.writeCountAtCache === this.host.writeCount &&
          shouldReuseCachedVerifierReceipt(
            requireProjectRoot(this.host.options),
            cachedVerifier.receipt,
          )
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
            // Cache reuse executes no process and changes no workspace bytes.
            effect_status: 'confirmed_no_change',
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
              `Verifier result unchanged — command, directory, environment and bound workspace bytes are identical since the last run.\n` +
              `${cachedVerifier.receipt.summary}\n\`\`\``,
          };
        }
      }

      if (action.type === "run_command" || action.type === "test_run") {
        const isolationFlags = this.host.isolationBrokerFlags();
        if (shellBlockedByIsolation(isolationFlags)) {
          const probeScope = bindIsolationPrerequisiteScope(this.host);
          const prerequisiteAdmitted =
            this.host.progressController.admitPrerequisiteDenialProbe(probeScope);
          if (!prerequisiteAdmitted) {
            const observation =
              `### ${tool} ${target}\nexit_code: 1\n\`\`\`\n` +
              `[BABEL ADVISORY] Shell prerequisite unchanged: isolation is still unavailable with host fallback forbidden. ` +
              `This attempt was suppressed at the execution boundary without re-running policy. ` +
              `Revise isolation prerequisites before retrying shell execution.\n\`\`\``;
            this.host.toolCallLog.push({
              tool,
              target,
              detail: "prerequisite_suppressed",
              index: meta.index,
              exit_code: 1,
              error: "prerequisite_suppressed",
            });
            callbacks?.onToolComplete?.(
              toolId,
              "prerequisite_suppressed",
              "prerequisite_suppressed",
              1,
            );
            return { index: meta.index, observation };
          }
        }
      }

      // Standard tool execution via policy gate
      const agentAction = mapChatActionToAgentAction(action);
      const classC = resolveClassCGateDecision({
        executionProfile: this.host.executionProfile,
      });
      const background = action.type === 'run_command' && action.background === true
        ? createChatBackgroundExecutor(action, {
            host: this.host, projectRoot: requireProjectRoot(this.host.options),
            tool, target, toolId, index: meta.index, ownerGeneration, meta, callbacks,
          })
        : null;
      const pendingResult = executeActionWithPolicy(
        agentAction,
        // Task/profile scope only narrows capability; executor authority,
        // isolation, network and approval decisions still govern dispatch.
        this.host.executionProfile === "plan" ||
          process.env["BABEL_READ_ONLY"] === "true" ||
          process.env["BABEL_EXECUTION_PROFILE"] === "read_only_audit"
          ? "read_only"
          : "workspace_write",
        toolContext,
        {
          executor: background?.executor ?? this.host.options.toolExecutorForTesting ?? chatReadToolExecutor,
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
            ? {
                taskId: this.host.parity.liveAuthority.taskContract.contract_id,
              }
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
          onDispatchAuthorized: recoveryDispatchAuthorization,
          onBeforeExecutorExecute: () =>
            this.host.persistToolStartedAtExecutorDispatch(action, meta),
          // Privileged ops: lease/PDP decides. Benchmark pair is the only
          // remaining auto-approve exception. TTY is not authority.
          ...this.host.isolationBrokerFlags(),
          ...(classC === "allow" ? { onAskApproval: async () => true } : {}),
        },
      );
      if (background) {
        const started = await background.waitForStart(pendingResult);
        if (started) return started;
      }
      const result: PolicyGatedExecutionResult = await pendingResult;
      const control = toolContext.runControl;
      acceptToolStop(control, result);

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

      const prevented = settlePreventedChatAction({ host: this.host, control, notStarted: result.notStarted, tool, target, toolId, meta, callbacks });
      if (prevented) return prevented;
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
            obsParts.push(
              formatReadObservation("read_file", target, window, r.output_completeness),
            );
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
            formatRegisteredToolObservation(action, r, artifactAccess, String(meta.idempotencyKey ?? toolId)),
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
            stderr: lastResult.stderr,
            policyBlocked: result.policyBlocked === true,
            // Trusted capability evidence comes only from the executor's typed
            // host-origin launch failure — never from child stderr, which a
            // failed command could forge.
            capabilityFailure: lastResult.launch_failure !== undefined,
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

      const directMutationAction =
        action.type === "write_file" || action.type === "apply_patch";
      const mutationEffect = assessMutationEffect({
        tool,
        error: lastResult && lastResult.exit_code !== 0 ? lastResult.stderr : undefined,
        exitCode: lastResult?.exit_code,
        policyBlocked: result.policyBlocked,
        mutationPaths: result.mutationPaths,
        mutationReceipt: result.mutationReceipt,
        effectTransaction: result.effectTransaction,
        preDispatchNoEffect: result.preDispatchNoEffect,
      });
      // Packet D2: outcome feeds per-model format demotion/promotion.
      if (directMutationAction) {
        this.recordEditFormatOutcome(
          action.type as EditFormatId,
          mutationEffect,
          result.policyBlocked === true,
        );
      }
      const detail = lastResult
        ? lastResult.exit_code === 0
          ? formatResultDetail(action, lastResult, mutationEffect)
          : `exit ${lastResult.exit_code}`
        : "done";

      const toolError = result.policyBlocked
        ? "blocked"
        : lastResult && lastResult.exit_code !== 0
          ? lastResult.stderr || detail
          : undefined;
      if (
        admittedThisAction &&
        proposedEdit &&
        directMutationAction &&
        mutationEffect.status === "confirmed_no_change" &&
        this.host.isSubmissionCurrent(ownerGeneration)
      ) {
        this.host.workingState = applyWorkingStateEvent(
          this.host.workingState,
          {
            type: "recovery_proven_no_effect",
            fingerprint: proposedEdit.exactFingerprint,
          },
        );
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
        invalidateChatPathReads(this.host, possiblePaths);
        if (mutationEffect.status !== "confirmed_no_change") {
          this.host.invalidateRepositoryContext(possiblePaths, "direct parent mutation settlement");
        }
        if (
          !confirmedDirectMutation &&
          mutationEffect.status !== "confirmed_no_change"
        ) {
          // A committed receipt that proves an identical post-state (byte-equal
          // pre/post image hashes, e.g. a model rewriting a file with its
          // current content) leaves the workspace revision exactly where the
          // verifier receipt bound it, so that receipt is factually current
          // and must stay authoritative. Only a real change or an
          // indeterminate effect invalidates verifier evidence.
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

      const verifierSemanticSignature = frozenVerifierDispatch?.owner && frozenVerifierDispatch.candidate &&
        !result.policyBlocked && !result.notStarted && lastResult?.process_started === true && lastResult.simulated !== true && lastResult.launch_failure === undefined
        && isAuthoritativeVerifierCommand(target)
        ? verifierSemanticProgress({ command: target, exitCode: lastResult.exit_code, stdout: lastResult.stdout, stderr: lastResult.stderr,
          executionContextKey: failedVerifierContextKey(target, frozenVerifierDispatch.owner, frozenVerifierDispatch.identity.cwd, frozenVerifierDispatch.identity.envKey),
          candidateRevision: frozenVerifierDispatch.candidate.workspaceRevision }) : undefined;
      // Log tool call for structured result metadata
      this.host.toolCallLog.push({
        tool,
        ...(result.preDispatchNoEffect === true ? { preDispatchNoEffect: true as const } : {}),
        target: projectedTarget,
        ...(verifierSemanticSignature ? { verifierSemanticSignature } : {}),
        detail,
        index: meta.index,
        ...((action.type === 'run_command' || action.type === 'test_run') ? {
          verifierExecuted: !result.policyBlocked && !result.notStarted &&
            lastResult?.process_started === true && lastResult.simulated !== true &&
            lastResult.launch_failure === undefined && isAuthoritativeVerifierCommand(target),
        } : {}),
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
          const edit = actualRecoveryEdit(
            action,
            requireProjectRoot(this.host.options),
          );
          this.host.workingState = applyWorkingStateEvent(
            this.host.workingState,
            {
              type: "mutation",
              path: action.path,
              fingerprint:
                edit?.exactFingerprint ??
                operationFingerprint(chatActionToolName(action), action),
              ...(edit ? { canonicalFingerprint: edit.editFingerprint } : {}),
            },
          );
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
          const edit = actualRecoveryEdit(
            action,
            requireProjectRoot(this.host.options),
          );
          this.host.workingState = applyWorkingStateEvent(
            this.host.workingState,
            {
              type: "mutation",
              path,
              fingerprint:
                edit?.exactFingerprint ??
                operationFingerprint(chatActionToolName(action), action),
              ...(edit ? { canonicalFingerprint: edit.editFingerprint } : {}),
            },
          );
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
            this.host.workingState = applyWorkingStateEvent(
              this.host.workingState,
              {
                type: "mutation",
                path: mutationPaths[0] ?? target,
                fingerprint: operationFingerprint(
                  chatActionToolName(action),
                  action,
                ),
              },
            );
            noteChatWorkspaceMutation(this.host as never);
          }

          const staleSettlement = await settleChatVerifierResult({
            host: this.host, action, result: lastResult, target, tool, meta,
            ownerGeneration, confirmedShellMutation, obsParts,
            ...(frozenVerifierDispatch ? { cacheIdentity: frozenVerifierDispatch.identity,
              verifierOwner: frozenVerifierDispatch.owner, foregroundDispatch: frozenVerifierDispatch.foreground ? frozenVerifierDispatch : undefined,
              canPublish: () => chatVerifierCandidateCurrent(requireProjectRoot(this.host.options), frozenVerifierDispatch.proofCandidate),
            } : {}),
          });
          if (staleSettlement) return staleSettlement;

          // A command can mutate files and then fail. Prefer the executor's
          // changed-path receipt; without one, invalidate conservatively.
          if (!result.policyBlocked && lastResult.simulated !== true) {
            if (mutationEffect.status !== "confirmed_no_change") {
              this.host.invalidateRepositoryContext(result.mutationPaths ?? [], "shell parent mutation settlement");
            }
            invalidateChatPathReads(this.host, result.mutationPaths ?? []);
          }
        }

        // B2: Update read cache after successful read_file execution
        if (
          action.type === "read_file" &&
          lastResult &&
          lastResult.exit_code === 0 &&
          lastResult.output_completeness?.complete !== false &&
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
          !result.policyBlocked &&
          lastResult && !lastResult.denial && lastResult.simulated !== true &&
          lastResult.exit_code === 0 &&
          this.host.isSubmissionCurrent(ownerGeneration)
        ) {
          const evidence = `${action.type}:${target}`;
          const discrimination = isDiscriminatingInspectionEvidence(
            this.host.workingState,
            action,
            recoveryReadTarget === recoveryTargetIdentity(requireProjectRoot(this.host.options), action.type === 'read_file' ? action.path : '') ? recoveryReadTarget : null,
            this.host.workingState.recoveryGate
              ? this.host.currentRecoveryBinding()
              : null,
            createHash("sha256").update(lastResult.stdout).digest("hex"),
            lastResult.read_window,
            recoveryReadBindingBefore,
          );
          this.host.workingState = applyWorkingStateEvent(
            this.host.workingState,
            {
              type: "add_evidence",
              evidence,
              discriminating: discrimination.discriminating,
              ...(discrimination.provenance
                ? { provenance: discrimination.provenance }
                : {}),
              ...(action.type === "read_file" ? { file: action.path } : {}),
            },
          );
          if (discrimination.provenance) {
            const reference = formatRecoveryReadReference(this.host.workingState, discrimination.provenance);
            if (reference) obsParts.push(reference);
            this.host.persistRecoveryWorkingState();
          }
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
        lastResult?.exit_code === 0 &&
        confirmedDirectMutation
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

      return { index: meta.index, observation: obsParts.join("\n"),
        ...(control?.stop() ? { stopRequest: control.stop()! } : {}),
        ...(action.type === 'read_file' && !result.policyBlocked && result.results.length > 0 &&
          result.results.every(r => r.exit_code === 0 && !r.denial) ? { admittedProjectRead: true as const } : {}),
      };
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
      if (err instanceof RunStoppedError && (isMcpChatAction(action) || action.type === 'web_search' || action.type === 'web_fetch')) {
        const prevented = settlePreventedChatAction({ host: this.host, control: toolContext.runControl,
          notStarted: { owner: err.stopRequest.owner, operationId: toolContext.toolCallId ?? tool, kind: 'tool' },
          tool, target, toolId, meta, callbacks });
        if (prevented) return prevented;
      }
      // R0-10: presentation callbacks are an observational side channel. If a
      // callback threw AFTER this action already recorded its execution row,
      // appending a second row would duplicate execution truth. One action
      // settles exactly one log row; only a genuine executor fault with no
      // prior row adds a failure row here.
      const alreadySettled = toolCallLog.slice(toolCallLogStart).some(entry => entry.index === meta.index);
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
      const lastEntry = toolCallLog.slice(toolCallLogStart).find(entry => entry.index === meta.index);
      const success =
        lastEntry !== undefined && !lastEntry.error &&
        (lastEntry?.exit_code === 0 || lastEntry?.exit_code === undefined);
      turnTelemetry?.recordToolSpan(
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

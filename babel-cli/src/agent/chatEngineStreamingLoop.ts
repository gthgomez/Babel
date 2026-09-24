import type {
  ChatEvent,
  ChatEngineStreamingLoopHost,
  SubmitMessageOptions,
  TaskIntent,
} from "./chatEngine.js";
import {
  canonicalizeToolCallId,
  reconcileStreamedAnswer,
} from "./chatEngineStreamingProtocol.js";
import { prepareStreamingSubmission } from "./chatEngineStreamingPreparation.js";
import { finalizeStreamingTurnLimit } from "./chatEngineStreamingFinalizer.js";
import { settleStreamingCompletion } from "./chatEngineStreamingCompletion.js";
import { realpathSync } from "node:fs";
import { isBabelHeadlessEnv } from "../utils/envFlags.js";
import { trace, SpanStatusCode, type Span } from "@opentelemetry/api";
import { endSpan } from "../telemetry/tracing.js";
import { globalCostTracker } from "../services/costTracker.js";

import {
  detectEnvBlockedFromText,
  extractToolEnvBlockedSignal,
  evaluateCompletionPrefersPatch,
} from "./implementorPolicy.js";

import { nativeTurnFromStream } from "./chatNativeTurn.js";
import { getChatTaskTune } from "../config/chatTaskClass.js";
import {
  applyWorkingStateEvent,
  formatWorkingStateBlock,
  resetOneShotSnapshot,
  upsertWorkingStateMessage,
} from "./codingLoop/index.js";
import { parseTextToolTurn } from "./textToolParser.js";
import {
  chatActionToolName,
  chatActionTarget,
  type ChatToolAction,
  type ChatTurn,
} from "./chatToolDefinitions.js";
import {
  parityRecordToolBatch,
  paritySettleProposeTools,
  parityArbitrateCycle,
  finalizeParityCancel,
  checkpointParityEventLog,
} from "./chatEngineParityBridge.js";

import {
  recordPolicyIntervened,
  recordProgressRecovery,
  operationFingerprint,
} from "./sessionEvents.js";
import { projectDurableToolBatch } from "./toolExecutionIdentity.js";
import { captureSessionEventAppendFailure } from "./sessionEventDiagnostics.js";
import { createHash } from "node:crypto";
import {
  updateStallState,
  isTextOnlyLoop,
  buildTextOnlyLoopIntervention,
  buildTextOnlyLoopBlockedMessage,
  TEXT_ONLY_FORCE_BLOCKED_THRESHOLD,
} from "./stallDetector.js";
import type { ProgressSignal } from "./progressController.js";
import {
  progressSignalsFromReceipt,
  type ProgressReceipt,
} from "./progressReceipt.js";
import {
  classifyPhase,
  buildPhaseNudge,
  shouldNudge,
} from "./chatPhaseNudge.js";
import { isConfirmedMutation } from "./mutationTools.js";

import { evaluateTokenExplosionAfterTurn } from "./budgetKillPolicy.js";
import {
  attachTerminalReason,
  buildPolicyTerminalBlockedReport,
  resolveInvestigateHardCapObserveOnly,
} from "./chatZeroWritePolicy.js";
import { evaluateZeroWriteWithShadow } from "./policyShadow.js";
import {
  persistPolicyEventsJsonl,
  recordPolicyEvent,
  recordTurnToolObservability,
} from "./chatEngineObservability.js";
import { nativeToolUseToChatAction } from "./chatEngineSupport.js";
import { filterReadOnlyChatTools, isReadOnlyChat } from "./chatReadOnly.js";

export class ChatEngineStreamingLoop {
  constructor(private readonly host: ChatEngineStreamingLoopHost) {}

  async *submitMessageStreamLoop(
    userInput: string,
    taskIntent?: TaskIntent,
    submitOpts?: SubmitMessageOptions,
  ): AsyncGenerator<ChatEvent, void, undefined> {
    const prepared = await prepareStreamingSubmission(
      this.host,
      userInput,
      taskIntent,
      submitOpts,
    );
    if (prepared.halted) {
      if (prepared.haltEvent) yield prepared.haltEvent;
      return;
    }
    const {
      submissionGeneration,
      runtime,
      effectiveOperation,
      isReadOnlyInspection,
      resolvedIntent,
      effectiveExecutePolicy,
      effectiveIntent,
      modelName,
      providerName,
      repoMapPromise,
      maxTurns,
    } = prepared;
    let allToolObservations = "";
    let _turnSpan: Span | null = null;

    for (let turn = 0; turn < maxTurns; turn++) {
      // R0-8: a superseded generator must stop before it executes another
      // turn, settles execution, or emits a terminal for the new owner.
      if (!this.host.isSubmissionCurrent(submissionGeneration)) return;
      // Tier A: Track turn index for per-turn observability metadata
      this.host._turnIndex = turn;
      // Never leak native tool-call IDs from a prior turn/batch into a new cycle.
      this.host._streamNativeToolCallIds = [];
      this.host._activeToolBatchId = null;
      // R9: Reset per-turn tamper flag
      this.host.tamperedThisTurn = false;

      // R11: Snapshot API token count at turn start for per-round ceiling check
      this.host.apiTokenCountAtTurnStart = this.host.apiTokenCount;
      // R11: Reset per-turn tool-call flag for auto-continue refusal
      this.host._hadToolCallsThisTurn = false;

      // Ensure repo map is available for subsequent turns that may rebuild system prompt
      if (turn === 0) await repoMapPromise;
      // R0-8: the repo-map await is a suspension point; re-check ownership.
      if (!this.host.isSubmissionCurrent(submissionGeneration)) return;
      if (this.host._cancelled || this.host.abortController.signal.aborted) {
        // AC3: stream cancel path flushes disk (idempotent if cancel() already did)
        finalizeParityCancel(this.host.parity, this.host.engineRunDir);
        if (!this.host.isSubmissionCurrent(submissionGeneration)) return;
        yield this.host.streamCancelled();
        return;
      }

      // Budget checks (P1): cost, wall-clock — honest receipts + last-chance critic
      if (this.host.terminatingLimiter === "child_exhaustion") {
        if (!this.host.isSubmissionCurrent(submissionGeneration)) return;
        const kill = await this.host.handleBudgetKill(
          this.host.terminalLimiterReason ??
            "Inherited child allowance exhausted.",
          { onThought: () => {} },
          effectiveIntent,
          submissionGeneration,
        );
        if (!kill || !this.host.isSubmissionCurrent(submissionGeneration))
          return;
        yield this.host.streamDone(kill.answer, {
          ...(kill.blockedReport ? { blockedReport: kill.blockedReport } : {}),
          ...(kill.criticReceipt ? { criticReceipt: kill.criticReceipt } : {}),
          ...(kill.verifierTampered ? { verifierTampered: true as const } : {}),
        });
        return;
      }
      const budget = this.host.checkBudgets();
      if (!budget.ok) {
        if (!this.host.isSubmissionCurrent(submissionGeneration)) return;
        const kill = await this.host.handleBudgetKill(
          budget.reason ?? "Budget limit exceeded.",
          { onThought: () => {} },
          effectiveIntent,
          submissionGeneration,
        );
        // AC3: every stream terminal goes through streamDone (buildResult already
        // finalized; streamDone finalize is idempotent on turn_ended).
        if (!kill || !this.host.isSubmissionCurrent(submissionGeneration))
          return;
        yield this.host.streamDone(kill.answer, {
          ...(kill.blockedReport ? { blockedReport: kill.blockedReport } : {}),
          ...(kill.criticReceipt ? { criticReceipt: kill.criticReceipt } : {}),
          ...(kill.verifierTampered ? { verifierTampered: true as const } : {}),
        });
        return;
      }
      this.host.consumeTaskTurn();

      resetOneShotSnapshot(this.host.logicalTurnToolPolicy);

      // ── OTel chat turn span ──
      const _tracer = trace.getTracer("babel-cli", "1.0.0");
      let _turnSpan: Span | null = _tracer.startSpan("babel.chat.turn");

      // Compact if needed; user-visible notice via stream event
      const compactionSpan =
        this.host.currentTurnTelemetry?.startCompactionSpan();
      const compactInfo = await this.host.compactIfNeeded(
        undefined,
        false,
        submissionGeneration,
      );
      compactionSpan?.end();
      // R0-8: compaction is a suspension point; a superseded generator must not
      // rewrite the new task's working state or conversation.
      if (!this.host.isSubmissionCurrent(submissionGeneration)) return;
      if (compactInfo) {
        yield { type: "context_compacted", ...compactInfo };
        if (!this.host.isSubmissionCurrent(submissionGeneration)) return;
      }

      // C1: Inject current todo list into conversation before LLM call
      this.host.updateTodoSystemMessage();
      if (!this.host.workingState.goal) {
        this.host.workingState = applyWorkingStateEvent(
          this.host.workingState,
          {
            type: "set_goal",
            goal: this.host.options.task.slice(0, 240),
          },
        );
      }
      this.host.conversation = upsertWorkingStateMessage(
        this.host.conversation,
        this.host.workingState,
      );

      if (
        this.host.conversation.some(
          (message) =>
            message.compactionCandidate === true ||
            (message.name === "compaction_summary" &&
              (message.role !== "assistant" ||
                message.provenance !== "model" ||
                message.authoritative !== false)) ||
            (message.name === "compaction_capsule" &&
              (message.role !== "system" ||
                message.provenance !== "controller" ||
                message.authoritative !== true)) ||
            (message.role === "system" &&
              (message.name === "compaction_summary" ||
                message.provenance === "model" ||
                message.provenance === "mixed" ||
                message.authoritative === false)),
        )
      ) {
        yield this.host.streamFailed(
          "An uncommitted compaction candidate cannot authorize provider dispatch.",
        );
        return;
      }

      const runner = this.host.resolveRoutedRunner();
      const useNativeTools = this.host.shouldUseNativeTools(runner);
      const useTextTools = !useNativeTools && this.host.shouldUseTextTools();
      const prompt = this.host.services.conversation.buildTurnPrompt({
        conversation: this.host.conversation,
        task: this.host.options.task,
        nativeTools: useNativeTools,
        textTools: useTextTools,
      });
      // WorkingState is mixed controller/model advisory context. Record the
      // exact revision before projecting provider messages so native warm and
      // cold requests share one durable source of model-visible truth.
      if (this.host.parity.turnId) {
        this.host.services.conversation.recordAssistantMessage(
          this.host.parity.eventLog,
          this.host.parity.turnId,
          formatWorkingStateBlock(this.host.workingState),
          {
            name: "working_state",
            provenance: "mixed",
            authoritative: false,
          },
        );
      }
      const activeSystemPrompt = this.host.getOrBuildSystemPrompt(
        useNativeTools ? "native" : useTextTools ? "text" : "legacy",
      );
      const hadInstalledP11Context =
        this.host.parity.contextCheckpoint !== undefined;
      const usageScope = {
        taskOwnerId: this.host.taskAllowance?.taskOwnerId ?? null,
        projectRoot: realpathSync(this.host.options.projectRoot),
        accountingEpoch: globalCostTracker.getAccountingEpoch(),
        turnId: this.host.parity.turnId,
        chargeId: null as string | null,
        ownerGeneration: submissionGeneration,
        isOwnerCurrent: () =>
          this.host.isSubmissionCurrent(submissionGeneration),
      };
      const settleRetiredUsage = (usedRunner: typeof runner): void => {
        if (!("usageMetadata" in usageScope))
          Object.assign(usageScope, { usageMetadata: null });
        this.host.trackRunnerUsage(usedRunner, usageScope);
      };
      const requestMode = useNativeTools
        ? "native"
        : useTextTools
          ? "text"
          : "legacy";
      const toolProfile = useNativeTools
        ? "native-tools"
        : useTextTools
          ? "text-tools"
          : "legacy-tools";
      const modelRoute = `${providerName}:${modelName}`;
      // R1/T5 ordering invariant (task-5 brief): candidate compaction → durable
      // capsule commit (compactIfNeeded above) → validate/install the CURRENT
      // checkpoint → rebuild provider messages FROM THE INSTALLED AUTHORITY →
      // provider invocation. A durable capsule that the in-memory root does not
      // name (committed this turn, or by an earlier admission-recovery
      // iteration) makes the previous generation stale — rebuilding from it
      // would dispatch a superseded sequence (the routed Task-4 trace). The
      // candidate below is a side-effect-free prepare: it never installs and
      // never authorizes a dispatch by itself — it only roots the rebuild that
      // computes this turn's route identity. `installP11ContextCheckpoint`
      // remains the single authority swap, and the dispatched messages are
      // re-projected from the INSTALLED checkpoint below. If the install cannot
      // happen while authority is pending/promoted, dispatch is refused — a
      // stale root never authorizes a request.
      const pendingCapsuleAuthority = this.host.hasPendingCompactionAuthority();
      const turnCheckpointCandidate =
        useNativeTools && (pendingCapsuleAuthority || hadInstalledP11Context)
          ? this.host.prepareP11ContextCheckpointCandidate({
              tool_profile: toolProfile,
              model_route: modelRoute,
            })
          : null;
      const rebuildRoot =
        turnCheckpointCandidate?.status === "prepared"
          ? turnCheckpointCandidate.checkpoint
          : this.host.parity.contextCheckpoint;
      let providerMessages = useNativeTools
        ? this.host.services.conversation.rebuildProviderMessages(
            this.host.parity.eventLog,
            {
              systemPrompt: activeSystemPrompt,
              ...(rebuildRoot
                ? { installedContextCheckpoint: rebuildRoot }
                : {}),
            },
          )
        : [];
      const preparedRoute = {
        compiled_request_identity: createHash("sha256")
          .update(
            JSON.stringify({
              mode: requestMode,
              prompt,
              systemPrompt: activeSystemPrompt,
              providerMessages,
            }),
          )
          .digest("hex"),
        tool_profile: toolProfile,
        model_route: modelRoute,
      } as const;
      const p11ContextInstalled =
        await this.host.installP11ContextCheckpoint(preparedRoute);
      // R0-8/R1: a superseded submission must not finalize the live turn as
      // failed nor dispatch a provider request for the new owner.
      if (!this.host.isSubmissionCurrent(submissionGeneration)) return;
      if (
        !p11ContextInstalled &&
        (hadInstalledP11Context || pendingCapsuleAuthority)
      ) {
        yield this.host.streamFailed(
          hadInstalledP11Context
            ? "P11 context installation was blocked; the previous context generation remains authoritative and provider dispatch was refused."
            : "P11 context installation was blocked; this turn committed a compaction capsule that no installed context root authorizes, so provider dispatch was refused.",
        );
        return;
      }
      // Single authority: project the dispatched messages from the checkpoint
      // that is NOW installed (equal to the candidate-rooted array above by
      // construction — the reconstruction tripwire below verifies it).
      if (
        useNativeTools &&
        p11ContextInstalled &&
        this.host.parity.contextCheckpoint
      ) {
        providerMessages =
          this.host.services.conversation.rebuildProviderMessages(
            this.host.parity.eventLog,
            {
              systemPrompt: activeSystemPrompt,
              installedContextCheckpoint: this.host.parity.contextCheckpoint,
            },
          );
      }
      if (
        useNativeTools &&
        providerMessages.some(
          (message) => message.name === "compaction_capsule",
        ) &&
        !this.host.parity.contextCheckpoint
      ) {
        yield this.host.streamFailed(
          "An uninstalled compaction capsule cannot authorize provider dispatch.",
        );
        return;
      }
      yield { type: "thinking" };
      if (!this.host.isSubmissionCurrent(submissionGeneration)) return;
      // Compaction can itself consume a paid request after the turn-start
      // allowance check. Recheck cost and wall limits at the final dispatch
      // boundary without charging this already-admitted turn twice.
      const dispatchBudget = this.host.checkBudgets(true);
      if (!dispatchBudget.ok) {
        const kill = await this.host.handleBudgetKill(
          dispatchBudget.reason ?? "Budget limit exceeded.",
          { onThought: () => {} },
          effectiveIntent,
          submissionGeneration,
        );
        if (!kill || !this.host.isSubmissionCurrent(submissionGeneration))
          return;
        endSpan(_turnSpan, SpanStatusCode.OK);
        _turnSpan = null;
        yield this.host.streamDone(kill.answer, {
          ...(kill.blockedReport ? { blockedReport: kill.blockedReport } : {}),
          ...(kill.criticReceipt ? { criticReceipt: kill.criticReceipt } : {}),
          ...(kill.verifierTampered ? { verifierTampered: true as const } : {}),
        });
        return;
      }

      let turnResult: ChatTurn;
      let toolsAnnouncedInStream = false;
      // Visible answer text already emitted chunk-by-chunk by this turn's
      // provider call. Terminal paths re-emit the full answer only when it
      // differs — re-emitting identical text duplicates it in the TUI.
      let streamedAnswerForTurn: string | null = null;

      if (useTextTools) {
        // ── Text-tools path — simplified format for small local models ──────
        // Buffered: rawText may contain [TOOL:…] markers that parseTextToolTurn
        // strips, so the final answer is not guaranteed append-compatible with
        // the stream. The reconciled final answer is emitted at the terminal.
        const systemPrompt = this.host.getOrBuildSystemPrompt("text");
        let rawText = "";
        const providerStart = performance.now();
        try {
          for await (const chunk of runner.executeRawStream(
            prompt,
            systemPrompt,
            this.host.abortController.signal,
            this.host.providerRetryCallbacks({
              deliveryMode: "text",
              conversationState: prompt,
              systemPolicyPrompt: systemPrompt,
              executionStage: "chat",
              usageScope,
              isOwnerCurrent: () =>
                this.host.isSubmissionCurrent(submissionGeneration),
            }),
          )) {
            if (!this.host.isSubmissionCurrent(submissionGeneration)) {
              settleRetiredUsage(runner);
              return;
            }
            rawText += chunk;
            this.host.currentTurnTelemetry?.markFirstToken();
          }
          const providerEnd = performance.now();
          if (!this.host.isSubmissionCurrent(submissionGeneration)) {
            settleRetiredUsage(runner);
            return;
          }
          this.host.currentTurnTelemetry?.recordProviderSpan(
            Math.max(0, providerEnd - providerStart),
            providerStart,
            providerEnd,
          );
          this.host.trackRunnerUsage(runner, usageScope);
          if (!this.host.isSubmissionCurrent(submissionGeneration)) return;
          turnResult = parseTextToolTurn(rawText);
        } catch (err: any) {
          if (!this.host.isSubmissionCurrent(submissionGeneration)) {
            settleRetiredUsage(runner);
            return;
          }
          const providerEnd = performance.now();
          this.host.currentTurnTelemetry?.recordProviderSpan(
            Math.max(0, providerEnd - providerStart),
            providerStart,
            providerEnd,
          );
          if (!this.host.isSubmissionCurrent(submissionGeneration)) return;
          const admissionRecovery =
            await this.host.recoverPreparedRequestAdmission(
              err,
              submissionGeneration,
            );
          if (admissionRecovery) {
            yield { type: "context_compacted", ...admissionRecovery };
            continue;
          }
          endSpan(_turnSpan, SpanStatusCode.ERROR);
          _turnSpan = null;
          if (!this.host.isSubmissionCurrent(submissionGeneration)) return;
          const cancelled = this.host.emitCancelledIfOperatorAbort(err);
          if (cancelled) {
            yield cancelled;
            return;
          }
          if (!this.host.isSubmissionCurrent(submissionGeneration)) return;
          yield this.host.streamFailed(err?.message ?? String(err));
          return;
        }
      } else if (useNativeTools) {
        const nextTools = this.host.nextTurnToolPolicy();
        const restrictTools = nextTools.restrict && !isReadOnlyChat();
        const toolDefs = filterReadOnlyChatTools(
          restrictTools
            ? this.host.services.tools.buildRestrictedDefinitions(
                nextTools.mode === "full" ? "act_or_verify" : nextTools.mode,
              )
            : this.host.services.tools.buildDefinitions(),
        );
        const nativeActions: ChatToolAction[] = [];
        const nativeToolCallIds: string[] = [];
        const seenToolCallIds = new Set<string>();
        let answerText = "";
        let nativeFinishReason: string | undefined;
        const systemPrompt = this.host.getOrBuildSystemPrompt("native");

        this.host.assertNativeRequestMatchesDurable(
          providerMessages,
          systemPrompt,
          systemPrompt,
        );
        const providerStart = performance.now();
        try {
          for await (const event of runner.executeWithToolsStream(
            providerMessages,
            toolDefs,
            systemPrompt,
            this.host.abortController.signal,
            restrictTools ? "required" : "auto",
            this.host.providerRetryCallbacks({
              deliveryMode: "native",
              conversationState: providerMessages,
              systemPolicyPrompt: systemPrompt,
              userTaskPrompt: prompt,
              toolSchema: toolDefs,
              executionStage: "chat",
              usageScope,
              isOwnerCurrent: () =>
                this.host.isSubmissionCurrent(submissionGeneration),
            }),
          )) {
            if (!this.host.isSubmissionCurrent(submissionGeneration)) {
              settleRetiredUsage(runner);
              return;
            }
            switch (event.type) {
              case "text_delta":
                this.host.currentTurnTelemetry?.markFirstToken();
                answerText += event.text;
                yield { type: "answer_chunk", text: event.text };
                break;
              case "thought_delta":
                this.host.currentTurnTelemetry?.markFirstToken();
                yield { type: "thought", text: event.text };
                break;
              case "tool_use": {
                const action = nativeToolUseToChatAction(
                  event.name,
                  event.input,
                );
                nativeActions.push(action);
                nativeToolCallIds.push(
                  canonicalizeToolCallId(
                    event,
                    turn,
                    nativeActions.length - 1,
                    seenToolCallIds,
                  ),
                );
                const toolCallId = nativeToolCallIds.at(-1)!;
                toolsAnnouncedInStream = true;
                yield {
                  type: "tool_start",
                  toolCallId,
                  tool: event.name,
                  target: chatActionTarget(action),
                };
                break;
              }
              case "error":
                throw new Error(event.message);
              case "done":
                nativeFinishReason = event.finishReason;
                break;
            }
          }
          const providerEnd = performance.now();
          if (!this.host.isSubmissionCurrent(submissionGeneration)) {
            settleRetiredUsage(runner);
            return;
          }
          this.host.currentTurnTelemetry?.recordProviderSpan(
            Math.max(0, providerEnd - providerStart),
            providerStart,
            providerEnd,
          );
          this.host.trackRunnerUsage(runner, usageScope);
          if (!this.host.isSubmissionCurrent(submissionGeneration)) return;
          this.host._streamNativeToolCallIds = nativeToolCallIds;
          streamedAnswerForTurn = answerText;
          turnResult = nativeTurnFromStream({
            answerText,
            actions: nativeActions,
            finishReason: nativeFinishReason,
          });
        } catch (err: any) {
          if (!this.host.isSubmissionCurrent(submissionGeneration)) {
            settleRetiredUsage(runner);
            return;
          }
          const providerEnd = performance.now();
          this.host.currentTurnTelemetry?.recordProviderSpan(
            Math.max(0, providerEnd - providerStart),
            providerStart,
            providerEnd,
          );
          if (!this.host.isSubmissionCurrent(submissionGeneration)) return;
          const admissionRecovery =
            await this.host.recoverPreparedRequestAdmission(
              err,
              submissionGeneration,
            );
          if (admissionRecovery) {
            yield { type: "context_compacted", ...admissionRecovery };
            continue;
          }
          if (!this.host.isSubmissionCurrent(submissionGeneration)) return;
          const fb = yield* this.host.resolveFallbackOrFail(
            err,
            turn,
            submissionGeneration,
          );
          if (!this.host.isSubmissionCurrent(submissionGeneration)) return;
          if (!fb) {
            endSpan(_turnSpan, SpanStatusCode.ERROR);
            _turnSpan = null;
            return;
          }
          if (typeof fb.executeWithToolsStream !== "function") {
            endSpan(_turnSpan, SpanStatusCode.ERROR);
            _turnSpan = null;
            if (!this.host.isSubmissionCurrent(submissionGeneration)) return;
            yield this.host.streamFailed(err.message);
            return;
          }
          nativeActions.length = 0;
          nativeToolCallIds.length = 0;
          seenToolCallIds.clear();
          answerText = "";
          nativeFinishReason = undefined;
          this.host.assertNativeRequestMatchesDurable(
            providerMessages,
            systemPrompt,
            undefined,
          );
          const fbStart = performance.now();
          try {
            for await (const event of fb.executeWithToolsStream(
              providerMessages,
              toolDefs,
              undefined,
              this.host.abortController.signal,
              undefined,
              this.host.providerRetryCallbacks({
                deliveryMode: "native",
                conversationState: providerMessages,
                userTaskPrompt: prompt,
                toolSchema: toolDefs,
                executionStage: "chat",
                substitutionOrFallback: true,
                usageScope,
                isOwnerCurrent: () =>
                  this.host.isSubmissionCurrent(submissionGeneration),
              }),
            )) {
              if (!this.host.isSubmissionCurrent(submissionGeneration)) {
                settleRetiredUsage(fb);
                return;
              }
              switch (event.type) {
                case "text_delta":
                  this.host.currentTurnTelemetry?.markFirstToken();
                  answerText += event.text;
                  yield { type: "answer_chunk", text: event.text };
                  break;
                case "thought_delta":
                  this.host.currentTurnTelemetry?.markFirstToken();
                  yield { type: "thought", text: event.text };
                  break;
                case "tool_use": {
                  const action = nativeToolUseToChatAction(
                    event.name,
                    event.input,
                  );
                  nativeActions.push(action);
                  nativeToolCallIds.push(
                    canonicalizeToolCallId(
                      event,
                      turn,
                      nativeActions.length - 1,
                      seenToolCallIds,
                    ),
                  );
                  const toolCallId = nativeToolCallIds.at(-1)!;
                  toolsAnnouncedInStream = true;
                  yield {
                    type: "tool_start",
                    toolCallId,
                    tool: event.name,
                    target: chatActionTarget(action),
                  };
                  break;
                }
                case "error":
                  throw new Error(event.message);
                case "done":
                  nativeFinishReason = event.finishReason;
                  break;
              }
            }
            const fbEnd = performance.now();
            if (!this.host.isSubmissionCurrent(submissionGeneration)) {
              settleRetiredUsage(fb);
              return;
            }
            this.host.currentTurnTelemetry?.recordProviderSpan(
              Math.max(0, fbEnd - fbStart),
              fbStart,
              fbEnd,
            );
            this.host.trackRunnerUsage(fb, usageScope);
            if (!this.host.isSubmissionCurrent(submissionGeneration)) return;
            this.host._streamNativeToolCallIds = nativeToolCallIds;
            streamedAnswerForTurn = answerText;
            turnResult = nativeTurnFromStream({
              answerText,
              actions: nativeActions,
              finishReason: nativeFinishReason,
            });
          } catch (fbErr: any) {
            if (!this.host.isSubmissionCurrent(submissionGeneration)) {
              settleRetiredUsage(fb);
              return;
            }
            const fbEnd = performance.now();
            this.host.currentTurnTelemetry?.recordProviderSpan(
              Math.max(0, fbEnd - fbStart),
              fbStart,
              fbEnd,
            );
            // If tools still fail, degrade to raw-text (buffered — the lenient
            // parser may transform the final answer; not append-compatible).
            yield { type: "thought", text: "Retrying without tools…" };
            if (!this.host.isSubmissionCurrent(submissionGeneration)) return;
            let rawText = "";
            const rawFbStart = performance.now();
            try {
              for await (const chunk of fb.executeRawStream(
                prompt,
                undefined,
                this.host.abortController.signal,
                this.host.providerRetryCallbacks({
                  deliveryMode: "text",
                  conversationState: prompt,
                  executionStage: "chat",
                  substitutionOrFallback: true,
                  usageScope,
                  isOwnerCurrent: () =>
                    this.host.isSubmissionCurrent(submissionGeneration),
                }),
              )) {
                if (!this.host.isSubmissionCurrent(submissionGeneration)) {
                  settleRetiredUsage(fb);
                  return;
                }
                rawText += chunk;
                this.host.currentTurnTelemetry?.markFirstToken();
              }
              const rawFbEnd = performance.now();
              if (!this.host.isSubmissionCurrent(submissionGeneration)) {
                settleRetiredUsage(fb);
                return;
              }
              this.host.currentTurnTelemetry?.recordProviderSpan(
                Math.max(0, rawFbEnd - rawFbStart),
                rawFbStart,
                rawFbEnd,
              );
              this.host.trackRunnerUsage(fb, usageScope);
              if (!this.host.isSubmissionCurrent(submissionGeneration)) return;
              turnResult = this.host.parseChatTurnLenient(rawText);
            } catch (rawErr: any) {
              if (!this.host.isSubmissionCurrent(submissionGeneration)) {
                settleRetiredUsage(fb);
                return;
              }
              const rawFbEnd = performance.now();
              this.host.currentTurnTelemetry?.recordProviderSpan(
                Math.max(0, rawFbEnd - rawFbStart),
                rawFbStart,
                rawFbEnd,
              );
              endSpan(_turnSpan, SpanStatusCode.ERROR);
              _turnSpan = null;
              if (!this.host.isSubmissionCurrent(submissionGeneration)) return;
              const cancelled = this.host.emitCancelledIfOperatorAbort(rawErr);
              if (cancelled) {
                yield cancelled;
                return;
              }
              if (!this.host.isSubmissionCurrent(submissionGeneration)) return;
              yield this.host.streamFailed(rawErr?.message ?? String(rawErr));
              return;
            }
          }
        }
      } else {
        // ── Legacy prompt-based JSON path ─────────────────────────────────
        // Buffered: raw output is re-parsed (lenient JSON extraction), so the
        // parsed final answer is not append-compatible with the raw stream.
        let rawText = "";
        const legacyStart = performance.now();
        try {
          for await (const chunk of runner.executeRawStream(
            prompt,
            undefined,
            this.host.abortController.signal,
            this.host.providerRetryCallbacks({
              deliveryMode: "text",
              conversationState: prompt,
              executionStage: "chat",
              usageScope,
              isOwnerCurrent: () =>
                this.host.isSubmissionCurrent(submissionGeneration),
            }),
          )) {
            if (!this.host.isSubmissionCurrent(submissionGeneration)) {
              settleRetiredUsage(runner);
              return;
            }
            rawText += chunk;
            this.host.currentTurnTelemetry?.markFirstToken();
          }
          const legacyEnd = performance.now();
          if (!this.host.isSubmissionCurrent(submissionGeneration)) {
            settleRetiredUsage(runner);
            return;
          }
          this.host.currentTurnTelemetry?.recordProviderSpan(
            Math.max(0, legacyEnd - legacyStart),
            legacyStart,
            legacyEnd,
          );
          this.host.trackRunnerUsage(runner, usageScope);
          if (!this.host.isSubmissionCurrent(submissionGeneration)) return;
        } catch (err: any) {
          if (!this.host.isSubmissionCurrent(submissionGeneration)) {
            settleRetiredUsage(runner);
            return;
          }
          const legacyEnd = performance.now();
          this.host.currentTurnTelemetry?.recordProviderSpan(
            Math.max(0, legacyEnd - legacyStart),
            legacyStart,
            legacyEnd,
          );
          if (!this.host.isSubmissionCurrent(submissionGeneration)) return;
          const admissionRecovery =
            await this.host.recoverPreparedRequestAdmission(
              err,
              submissionGeneration,
            );
          if (admissionRecovery) {
            yield { type: "context_compacted", ...admissionRecovery };
            continue;
          }
          if (!this.host.isSubmissionCurrent(submissionGeneration)) return;
          const fb = yield* this.host.resolveFallbackOrFail(
            err,
            turn,
            submissionGeneration,
          );
          if (!this.host.isSubmissionCurrent(submissionGeneration)) return;
          if (!fb) {
            endSpan(_turnSpan, SpanStatusCode.ERROR);
            _turnSpan = null;
            return;
          }
          rawText = "";
          try {
            for await (const chunk of fb.executeRawStream(
              prompt,
              undefined,
              this.host.abortController.signal,
              this.host.providerRetryCallbacks({
                deliveryMode: "text",
                conversationState: prompt,
                executionStage: "chat",
                substitutionOrFallback: true,
                usageScope,
                isOwnerCurrent: () =>
                  this.host.isSubmissionCurrent(submissionGeneration),
              }),
            )) {
              if (!this.host.isSubmissionCurrent(submissionGeneration)) {
                settleRetiredUsage(fb);
                return;
              }
              rawText += chunk;
              this.host.currentTurnTelemetry?.markFirstToken();
            }
            this.host.trackRunnerUsage(fb, usageScope);
            if (!this.host.isSubmissionCurrent(submissionGeneration)) return;
          } catch (fbErr: any) {
            if (!this.host.isSubmissionCurrent(submissionGeneration)) {
              settleRetiredUsage(fb);
              return;
            }
            endSpan(_turnSpan, SpanStatusCode.ERROR);
            _turnSpan = null;
            if (!this.host.isSubmissionCurrent(submissionGeneration)) return;
            const cancelled = this.host.emitCancelledIfOperatorAbort(fbErr);
            if (cancelled) {
              yield cancelled;
              return;
            }
            if (!this.host.isSubmissionCurrent(submissionGeneration)) return;
            yield this.host.streamFailed(fbErr?.message ?? String(fbErr));
            return;
          }
        }

        turnResult = this.host.parseChatTurnLenient(rawText);
      }

      // Item 7: end-of-turn token explosion on stream path (after LLM usage tracked)
      const streamExplosion = evaluateTokenExplosionAfterTurn({
        tokensAtTurnStart: this.host.apiTokenCountAtTurnStart,
        tokensNow: this.host.apiTokenCount,
        maxTokensPerRound: this.host.limits.maxTokensPerRound,
        hasAnyWrites: this.host.hasAnyWrites(),
      });
      if (streamExplosion.abort) {
        // Tier A2: Record token explosion event before aborting
        recordPolicyEvent(
          this.host.policyEventLog,
          this.host._turnIndex,
          "token_explosion",
          `tokens_this_turn=${streamExplosion.tokensThisTurn}`,
        );
        endSpan(_turnSpan, SpanStatusCode.OK);
        _turnSpan = null;
        // R0-8: a superseded generator must not install a terminal limiter on
        // the task that now owns the engine.
        if (!this.host.isSubmissionCurrent(submissionGeneration)) return;
        this.host.terminatingLimiter = "tokens";
        this.host.terminalLimiterReason = `Token explosion with zero mutations: ${streamExplosion.tokensThisTurn} tokens this turn (ceiling ${this.host.limits.maxTokensPerRound}).`;
        if (!this.host.isSubmissionCurrent(submissionGeneration)) return;
        const kill = await this.host.handleBudgetKill(
          this.host.terminalLimiterReason,
          { onThought: () => {} },
          effectiveIntent,
          submissionGeneration,
        );
        if (!kill || !this.host.isSubmissionCurrent(submissionGeneration))
          return;
        yield this.host.streamDone(kill.answer, {
          ...(kill.blockedReport ? { blockedReport: kill.blockedReport } : {}),
          ...(kill.criticReceipt ? { criticReceipt: kill.criticReceipt } : {}),
          ...(kill.verifierTampered ? { verifierTampered: true as const } : {}),
        });
        return;
      }

      if (turnResult.type === "tool_calls" && turnResult.actions.length > 0) {
        if (turnResult.thinking) {
          yield { type: "thought", text: turnResult.thinking };
          if (!this.host.isSubmissionCurrent(submissionGeneration)) return;
        }

        // R7: After force_status intervention (level ≥ 3), check if the model
        // declared BLOCKED in its thinking text while still issuing tool calls.
        if (
          turnResult.thinking &&
          this.host.stallState.interventionLevel >= 3
        ) {
          const thinkingBlocked = this.host.detectAndBuildBlockedReport(
            turnResult.thinking,
          );
          if (thinkingBlocked) {
            this.host.conversation.push({
              role: "assistant",
              content: turnResult.thinking,
            });
            _turnSpan.setAttribute("babel.chat.blocked", "true");
            endSpan(_turnSpan, SpanStatusCode.OK);
            _turnSpan = null;
            if (!this.host.isSubmissionCurrent(submissionGeneration)) return;
            yield this.host.streamDone(turnResult.thinking, {
              blockedReport: thinkingBlocked,
            });
            return;
          }
        }

        // R0-8: a superseded generator must not reserve the new task's
        // tool-call identity or propose its tools.
        if (!this.host.isSubmissionCurrent(submissionGeneration)) return;
        // Capture toolCallLog start index BEFORE execution so the
        // per-turn slice is correct even as the log grows across turns.
        this.host._turnToolCallLogStart = this.host.toolCallLog.length;
        this.host._activeToolBatchId = `batch_${turn}_${this.host._turnToolCallLogStart}`;

        // W2.2 settle: assign stable call ids, persist tool_proposed+tool_started
        // to session-events.jsonl BEFORE any side effects (kill/resume safety).
        const settleCallIds = turnResult.actions.map((_, idx) => {
          if (this.host._streamNativeToolCallIds[idx])
            return this.host._streamNativeToolCallIds[idx]!;
          return `tool_call_${turn}_${idx}`;
        });
        if (
          this.host._streamNativeToolCallIds.length === 0 &&
          turnResult.actions.length > 0
        ) {
          this.host._streamNativeToolCallIds = settleCallIds;
        }
        if (!toolsAnnouncedInStream) {
          for (const [idx, action] of turnResult.actions.entries()) {
            yield {
              type: "tool_start",
              toolCallId: settleCallIds[idx]!,
              tool: chatActionToolName(action),
              target: chatActionTarget(action),
            };
            if (!this.host.isSubmissionCurrent(submissionGeneration)) return;
          }
        }
        if (turnResult.actions.length > 0) {
          paritySettleProposeTools(
            this.host.parity,
            turnResult.actions.map((action, idx) => ({
              id: settleCallIds[idx]!,
              name: chatActionToolName(action),
              argsDigest: operationFingerprint(
                chatActionToolName(action),
                action,
              ),
              action_index: idx,
              batch_id: this.host._activeToolBatchId!,
              target_summary: chatActionTarget(action),
            })),
            this.host.engineRunDir,
          );
        }

        const subAgentEvents: ChatEvent[] = [];

        const { observations, observationList } =
          await this.host.executeActions(
            turnResult.actions,
            {
              onToolStart: (_tool, _target) => {
                this.host._hadToolCallsThisTurn = true;
                return 0;
              },
              onToolComplete: (id, detail) => {
                // handled below via toolCallLog
              },
              onSubAgentStart: (info) => {
                subAgentEvents.push({
                  type: "sub_agent_start",
                  id: info.id,
                  label: info.label,
                });
              },
              onSubAgentComplete: (info) => {
                subAgentEvents.push({
                  type: "sub_agent_complete",
                  id: info.id,
                  summary: info.summary,
                });
              },
              onSubAgentFailed: (info) => {
                subAgentEvents.push({
                  type: "sub_agent_failed",
                  id: info.id,
                  error: info.error,
                });
              },
              onFileChanged: (path, additions, deletions, content) => {
                subAgentEvents.push({
                  type: "file_changed",
                  path,
                  additions,
                  deletions,
                  ...(content ? { content } : {}),
                });
              },
            },
            submissionGeneration,
          );

        // R0-8: tools are a suspension point. If the submission was superseded
        // while they ran, stop before mutating the new owner's state or
        // emitting a terminal on its behalf.
        if (!this.host.isSubmissionCurrent(submissionGeneration)) return;

        // Repetition loop detection: record each executed action and check for loops
        for (const action of turnResult.actions) {
          const tool = chatActionToolName(action);
          const target = chatActionTarget(action);
          this.host.repetitionDetector.record({
            type: tool,
            fingerprint: `${tool}:${target}`,
          });
        }
        const streamLoopResult = this.host.repetitionDetector.detect();
        if (streamLoopResult.loop) {
          this.host.conversation.push({
            role: "system",
            content: `[SYSTEM] Detected repetition loop: ${streamLoopResult.message} Please proceed to the next step or use [TOOL:finish] if done.`,
          });
          this.host.repetitionDetector.reset();
        }

        // Yield sub-agent lifecycle events collected during execution
        for (const event of subAgentEvents) {
          yield event;
          if (!this.host.isSubmissionCurrent(submissionGeneration)) return;
        }

        recordTurnToolObservability(this.host.obsHandles());

        allToolObservations += observations;
        this.host.conversation.push({
          role: "assistant",
          content: turnResult.thinking ?? "Using tools…",
          name: "tool_calls",
        });
        // Text-tools models need plain text [OK]/[RESULT] results instead of role:tool
        if (useTextTools) {
          this.host.conversation.push({
            role: "user",
            content: this.host.buildTextToolResults(
              this.host._turnToolCallLogStart,
            ),
          });
        } else {
          this.host.conversation.push({ role: "tool", content: observations });
        }

        let providerToolCallIds: string[] | undefined;
        if (useNativeTools && turnResult.type === "tool_calls") {
          providerToolCallIds = turnResult.actions.map((_, idx) => {
            if (
              this.host._streamNativeToolCallIds.length ===
              turnResult.actions.length
            ) {
              return this.host._streamNativeToolCallIds[idx]!;
            }
            return `tool_call_${this.host._turnIndex}_${idx}`;
          });
        }

        // Yield tool complete events (slice from this turn's start, sorted by
        // original action index so tool_complete order matches tool_start order
        // even when read tools complete concurrently in a different order).
        for (const [settlementIndex, tc] of this.host.toolCallLog
          .slice(this.host._turnToolCallLogStart)
          .sort((a, b) => a.index - b.index)
          .entries()) {
          tc.toolCallId = settleCallIds[settlementIndex]!;
          yield {
            type:
              tc.error || (tc.exit_code !== undefined && tc.exit_code !== 0)
                ? "tool_failed"
                : "tool_complete",
            toolCallId: tc.toolCallId,
            tool: tc.tool,
            target: tc.target,
            ...(tc.detail ? { detail: tc.detail } : {}),
            ...(tc.error ? { error: tc.error } : {}),
            ...(tc.exit_code !== undefined ? { exitCode: tc.exit_code } : {}),
            ...(tc.effect_status !== undefined
              ? { effect_status: tc.effect_status }
              : {}),
            ...(tc.mutation_paths !== undefined
              ? { mutation_paths: [...tc.mutation_paths] }
              : {}),
          };
          if (!this.host.isSubmissionCurrent(submissionGeneration)) return;
        }

        await new Promise((resolve) => setImmediate(resolve));
        // R0-8: the setImmediate yield is a real suspension point — a second
        // submission can start here. A superseded generator must not update the
        // new task's progress counters, phase, or durable session events.
        if (!this.host.isSubmissionCurrent(submissionGeneration)) return;
        // Only reset gate strikes when this turn includes a mutation —
        // read-only turns don't reset the counter.
        if (this.host.currentTurnHasMutation()) {
          this.host.gateStrikes = 0;
          this.host.criticStrikes = 0;
          this.host.turnsWithoutWrite = 0;
          this.host.consecutiveReadOnlyTools = 0;
          this.host.consecutiveNonMutatingShells = 0;
          this.host.toolsWithoutWrite = 0;
          this.host.investigateSoftNudgeDone = false;
          this.host.midLoopCriticFired = false;
          this.host.applyPostWriteRepairBudget();
        } else {
          this.host.turnsWithoutWrite++;
        }

        // Mid-loop heuristic critic (stream path)
        if (
          this.host.currentTurnHasMutation() ||
          (this.host.hasAnyWrites() && this.host.lastVerifierReceipt)
        ) {
          this.host.maybeInjectMidLoopHeuristicCritic(
            { onThought: () => {} },
            effectiveIntent,
          );
        }

        const exploreFuses = this.host.applyExploreFuses(
          effectiveExecutePolicy,
          isReadOnlyInspection,
        );
        for (const label of exploreFuses.labels) {
          yield { type: "thought", text: label };
          if (!this.host.isSubmissionCurrent(submissionGeneration)) return;
        }

        // P2: Update stall detector and inject phase nudge if needed
        const turnCallsStr = this.host.toolCallLog.slice(
          this.host._turnToolCallLogStart,
        );
        this.host.stallState = updateStallState(
          this.host.stallState,
          turnCallsStr,
          turn,
        );

        const streamPhase = classifyPhase(
          this.host.stallState,
          this.host.hasAnyWrites(),
          this.host.stallState.lastVerifierTurn >= 0,
        );
        // Tier A2: Record phase change event
        if (streamPhase !== this.host._lastPhase && streamPhase !== null) {
          recordPolicyEvent(
            this.host.policyEventLog,
            this.host._turnIndex,
            "phase_change",
            `${this.host._lastPhase ?? "start"}→${streamPhase}`,
          );
        }
        this.host._lastPhase = streamPhase;
        if (shouldNudge(this.host._lastPhase) && !isReadOnlyInspection) {
          const hintsStr = turnCallsStr
            .filter(
              (e) =>
                e.tool === "read_file" ||
                e.tool === "read_range" ||
                isConfirmedMutation({
                  tool: e.tool,
                  error: e.error,
                  effectStatus: e.effect_status,
                  mutationPaths: e.mutation_paths,
                }),
            )
            .map((e) => e.target)
            .filter(Boolean);
          this.host.conversation.push({
            role: "user",
            content: buildPhaseNudge(this.host._lastPhase, hintsStr),
          });
        }

        // R9: Tamper-aware escalation — if verifier files were modified this
        // turn, accelerate intervention regardless of write-stall count.
        const tamperEscalation = this.host.applyTamperEscalation();
        if (tamperEscalation === "__TAMPER_AUTO_BLOCKED__") {
          _turnSpan.setAttribute("babel.chat.tamper_blocked", "true");
          endSpan(_turnSpan, SpanStatusCode.OK);
          _turnSpan = null;
          const tamperAnswer = await this.host
            .synthesizeAnswer(allToolObservations, {
              onAnswerChunk: (_chunk: string) => {},
            })
            .catch(() => "");
          // R0-8: synthesis is a suspension point; a superseded generator must
          // not append to the new task's conversation.
          if (!this.host.isSubmissionCurrent(submissionGeneration)) return;
          // R0/W7: the tamper violation is established by the harness
          // (applyTamperEscalation at tamperCount >= 3), so the blocked report
          // is harness-origin and typed. Model prose may supply the answer text
          // but can no longer determine whether a block exists — a prose-only
          // path could emit a false `completed` terminal.
          const tamperBlocked = this.host.buildTamperBlockedReport();
          const finalTamperAnswer =
            tamperAnswer && /(?:^|\n)\s*BLOCKED\b/.test(tamperAnswer)
              ? tamperAnswer
              : `BLOCKED: Verifier integrity compromised — ${this.host.tamperCount} verifier dependency files were modified. The task cannot be completed honestly.`;
          this.host.conversation.push({
            role: "assistant",
            content: finalTamperAnswer,
          });
          if (!this.host.isSubmissionCurrent(submissionGeneration)) return;
          yield this.host.streamDone(finalTamperAnswer, {
            blockedReport: tamperBlocked,
            verifierTampered: true,
          });
          return;
        }
        if (tamperEscalation) {
          this.host.conversation.push({
            role: "user",
            content: tamperEscalation,
          });
          yield {
            type: "thought",
            text: `[Tamper escalation: ${this.host.tamperCount} violations]`,
          };
          if (!this.host.isSubmissionCurrent(submissionGeneration)) return;
        }

        // R2: Escalating stall intervention — kill routed through parity arbiter
        const stallIntervention =
          this.host.checkStallIntervention(isReadOnlyInspection);
        if (stallIntervention && stallIntervention.level !== "kill") {
          recordPolicyEvent(
            this.host.policyEventLog,
            this.host._turnIndex,
            "stall_intervention",
            `level=${stallIntervention.level}`,
          );
          // I4: never latch a mutate-only tool restriction onto a read-only
          // operation; the read-only stall path concludes or synthesizes.
          if (
            stallIntervention.level === "restrict_tools" &&
            !isReadOnlyInspection
          ) {
            this.host.restrictToolsNextTurn = true;
          }
          this.host.conversation.push({
            role: "user",
            content: stallIntervention.message,
          });
          yield {
            type: "thought",
            text: `[Stall intervention: ${stallIntervention.level}]`,
          };
          if (!this.host.isSubmissionCurrent(submissionGeneration)) return;
        }
        if (stallIntervention?.level === "kill") {
          recordPolicyEvent(
            this.host.policyEventLog,
            this.host._turnIndex,
            "stall_intervention",
            "level=kill",
          );
        }

        // Record progress + durable tool results (contentHash for re-read fidelity).
        // Identity is the original action index, never completion-order slice position.
        const turnSlice = this.host.toolCallLog.slice(
          this.host._turnToolCallLogStart,
        );
        const isReadTool = (name: string) =>
          name === "read_file" ||
          name === "file_read" ||
          name === "read_range" ||
          name === "grep";
        const projected = projectDurableToolBatch({
          turnSlice,
          observationsByActionIndex: observationList,
          ...(turnResult.type === "tool_calls"
            ? { actions: turnResult.actions as Array<Record<string, unknown>> }
            : {}),
          turn,
          batchId:
            this.host._activeToolBatchId ??
            `batch_${turn}_${this.host._turnToolCallLogStart}`,
          ...(providerToolCallIds ? { providerToolCallIds } : {}),
          streamNativeToolCallIds: this.host._streamNativeToolCallIds,
          contentHashFor: (toolName, content) =>
            isReadTool(toolName) && content.length > 0
              ? createHash("sha256").update(content).digest("hex").slice(0, 16)
              : undefined,
        });
        let cycleReceipt: ProgressReceipt | null = null;
        try {
          cycleReceipt = parityRecordToolBatch(this.host.parity, {
            at_turn: turn,
            ...(turnResult.type === "tool_calls" && turnResult.thinking
              ? { thinking: turnResult.thinking }
              : {}),
            toolCalls: projected.toolCalls,
            results: projected.results,
            patchAttempted: turnSlice.some((t) =>
              isConfirmedMutation({
                tool: t.tool,
                error: t.error,
                effectStatus: t.effect_status,
                mutationPaths: t.mutation_paths,
              }),
            ),
            patchFailed: turnSlice.some(
              (t) =>
                t.tool === "str_replace" && t.error != null && t.error !== "",
            ),
            verifierChanged: this.host.computeVerifierChanged(
              projected.results,
            ),
            // Context epoch: advancing it makes necessary re-reads count again.
            contextEpoch: this.host.readContextEpoch,
            // W2.2: propose+start already flushed before executeActions.
            settleAlreadyProposed: turnResult.actions.length > 0,
            // Do NOT pass every read as localizedPaths — re-reads use contentHash only.
          });
        } catch (err) {
          const captured = captureSessionEventAppendFailure(
            err,
            this.host.engineRunDir,
          );
          this.host._streamNativeToolCallIds = [];
          this.host._activeToolBatchId = null;
          if (captured) {
            if (!this.host.isSubmissionCurrent(submissionGeneration)) return;
            yield this.host.streamFailed(captured.operatorMessage);
            return;
          }
          throw err;
        }
        this.host._streamNativeToolCallIds = [];
        this.host._activeToolBatchId = null;

        // D02: score the W3 progress/recovery controller from the same evidence
        // set as the durable receipt (confirmed mutation + receipt read-novelty)
        // instead of an empty mutation-only list. A read-only investigation with
        // distinct reads therefore stays at "none" rather than emitting false
        // restricted_tools / terminal_blocked labels.
        const progressSignals: ProgressSignal[] = [];
        if (
          turnCallsStr.some(
            (tc) =>
              isConfirmedMutation({
                tool: tc.tool,
                error: tc.error,
                effectStatus: tc.effect_status,
                mutationPaths: tc.mutation_paths,
              }) ||
              (tc.tool === "sub_agent" &&
                tc.effect_status === "confirmed_change"),
          )
        ) {
          progressSignals.push("production_mutation");
        }
        for (const signal of progressSignalsFromReceipt(cycleReceipt)) {
          if (!progressSignals.includes(signal)) progressSignals.push(signal);
        }
        const isTextOnly = turnCallsStr.length === 0;
        const pcResult = this.host.progressController.scoreTurn(
          progressSignals,
          isTextOnly,
          this.host.gateStrikes,
        );
        recordProgressRecovery(
          this.host.parity.sessionEvents,
          String(this.host.parity.turnId ?? this.host._turnIndex),
          {
            intervention: pcResult.intervention,
            score: pcResult.score,
            signals: progressSignals,
            reason: "turn_scored",
          },
        );
        if (pcResult.transitioned) {
          this.host.currentTurnTelemetry?.recordPolicyIntervention();
          yield {
            type: "progress_recovery",
            intervention: pcResult.intervention,
            source: "progress_controller",
            score: pcResult.score,
            message: `Transitioned to ${pcResult.intervention}`,
          };
          if (!this.host.isSubmissionCurrent(submissionGeneration)) return;
        }

        // P0-E: zero-write shadow by default for coding classes (one-shot log);
        // enforce ablation is a real terminal via zeroWriteTerminalMessage.
        const alreadyHasZeroWriteShadow = this.host.policyEventLog
          .all()
          .some((e) => e.kind === "zero_write_shadow");
        const zeroWriteDecision = evaluateZeroWriteWithShadow({
          executeIntent: effectiveExecutePolicy,
          completedTurns: turn + 1,
          hasAnyWrites: this.host.hasAnyWrites(),
          taskClass: this.host.taskClass,
          atTurn: turn,
          alreadyHasZeroWriteShadow,
        });
        for (const ev of zeroWriteDecision.events) {
          this.host.policyEventLog.record(ev);
        }
        // Host/toolchain env block (missing pytest, host deps before patch) →
        // terminal ENV_BLOCKED instead of progress_terminal thrash.
        // After writes, import failures are treated as patch-induced (not host env).
        const sessionHasWrites = this.host.hasAnyWrites();
        const envBlockedSignal = (() => {
          for (const t of turnSlice) {
            const signal = extractToolEnvBlockedSignal(t, {
              hasAnyWrites: sessionHasWrites,
            });
            if (signal) return signal;
          }
          return null;
        })();
        // I01 observation mode: the identical counter and terminal candidate
        // were computed above; withhold only this candidate from the arbiter
        // and record durable would-fire evidence instead. All other terminals,
        // nudges, budgets, and permissions are untouched.
        const executeHardCapTerminal = !isReadOnlyInspection
          ? exploreFuses.investigateHardCapTerminal
          : null;
        const i01ObserveOnly =
          executeHardCapTerminal !== null &&
          resolveInvestigateHardCapObserveOnly();
        if (i01ObserveOnly) {
          recordPolicyIntervened(
            this.host.parity.sessionEvents,
            this.host.parity.turnId ?? "policy",
            {
              source: "investigate_hard_cap",
              action: "would_fire_observe_only",
              detail: `i01: tools_without_write=${this.host.toolsWithoutWrite} terminal_withheld_from_arbiter=1`,
            },
          );
        }
        const arb = parityArbitrateCycle({
          rt: this.host.parity,
          isReadOnlyInspection,
          fuseLabels: exploreFuses.labels,
          forceMutateMessage: exploreFuses.forceMutateMessage,
          readThrashMessage: exploreFuses.readThrashMessage,
          explorationFuseMessage: exploreFuses.explorationFuseMessage,
          shellSoftMessage: exploreFuses.shellSoftMessage,
          investigateBudgetMessage: exploreFuses.investigateBudgetMessage,
          readOnlyHardCapTerminal: isReadOnlyInspection
            ? exploreFuses.investigateHardCapTerminal
            : null,
          investigateHardCapTerminal: i01ObserveOnly
            ? null
            : executeHardCapTerminal,
          stallMessage:
            stallIntervention && stallIntervention.level !== "kill"
              ? stallIntervention.message
              : null,
          stallKillMessage:
            stallIntervention?.level === "kill"
              ? stallIntervention.message
              : null,
          zeroWriteCandidate: zeroWriteDecision.arbiterMessage,
          zeroWriteTerminalMessage: zeroWriteDecision.terminalMessage,
          envBlockedSignal,
        });
        if (arb.policySource) {
          this.host.policyEventLog.record({
            at_turn: turn,
            kind:
              arb.policySource === "env_blocked"
                ? "progress_policy"
                : arb.terminalAnswer
                  ? "progress_terminal"
                  : "progress_policy",
            detail: `${arb.policySource}: ${arb.policyMessage ?? arb.terminalAnswer ?? ""}`,
          });
        }
        if (arb.terminalAnswer) {
          endSpan(_turnSpan, SpanStatusCode.OK);
          _turnSpan = null;

          // Read-only inspection terminal: synthesize gathered evidence into a
          // bounded final informational answer instead of a generic capability
          // block. Covers the read-only hard cap and the evidence-based
          // no-progress terminal (never press a research task to mutate).
          if (
            (arb.policySource === "investigate_hard_cap" ||
              arb.policySource === "read_only_hard_cap" ||
              arb.policySource === "progress_terminal") &&
            isReadOnlyInspection
          ) {
            let synthAnswer = "";
            let synthError: Error | null = null;
            try {
              synthAnswer = await this.host.synthesizeAnswer(
                allToolObservations,
                {
                  onAnswerChunk: (_chunk: string) => {},
                },
              );
            } catch (err: any) {
              synthError = err instanceof Error ? err : new Error(String(err));
            }
            // R0-8: synthesis is a suspension point; a superseded generator must
            // not append to the new task's conversation.
            if (!this.host.isSubmissionCurrent(submissionGeneration)) return;

            if (synthError || !synthAnswer?.trim()) {
              const failMsg = `Answer synthesis failed after inspection completed: ${synthError?.message ?? "no answer generated"}`;
              this.host.conversation.push({
                role: "assistant",
                content: failMsg,
              });
              yield { type: "answer_chunk", text: failMsg };
              if (!this.host.isSubmissionCurrent(submissionGeneration)) return;
              yield this.host.streamDone(failMsg, {
                blockedReport: attachTerminalReason(
                  {
                    schema_version: 1,
                    status: "BLOCKED",
                    reason: "Answer synthesis unavailable",
                    missing: "LLM provider response for answer synthesis",
                    checked: [
                      {
                        action: "synthesize_answer",
                        target: "provider",
                        finding:
                          synthError?.message ?? "Empty synthesis output",
                      },
                    ],
                  },
                  arb.terminalReason,
                ),
                ...(arb.terminalReason !== undefined
                  ? { reason: arb.terminalReason }
                  : {}),
              });
              return;
            }

            const finalAnswer = synthAnswer.trim();
            const synthBlocked =
              this.host.detectAndBuildBlockedReport(finalAnswer);
            this.host.conversation.push({
              role: "assistant",
              content: finalAnswer,
            });
            yield { type: "answer_chunk", text: finalAnswer };
            if (!this.host.isSubmissionCurrent(submissionGeneration)) return;
            yield this.host.streamDone(finalAnswer, {
              blockedReport: synthBlocked ?? null,
              // D03: the arbiter reason survives even when the bounded synthesis
              // produced an informational answer rather than a blocked report.
              ...(arb.terminalReason !== undefined
                ? { reason: arb.terminalReason }
                : {}),
            });
            return;
          }

          // Prefer BLOCKED synthesis when stall kill and agent already diagnosed
          if (stallIntervention?.level === "kill") {
            const killAnswer = await this.host
              .synthesizeAnswer(allToolObservations, {
                onAnswerChunk: (_chunk: string) => {},
              })
              .catch(() => "");
            // R0-8: synthesis is a suspension point; a superseded generator must
            // not append to the new task's conversation.
            if (!this.host.isSubmissionCurrent(submissionGeneration)) return;
            const killBlocked = killAnswer
              ? this.host.detectAndBuildBlockedReport(killAnswer)
              : null;
            if (killBlocked) {
              this.host.conversation.push({
                role: "assistant",
                content: killAnswer,
              });
              if (!this.host.isSubmissionCurrent(submissionGeneration)) return;
              yield this.host.streamDone(killAnswer, {
                blockedReport: killBlocked,
                // D03: this branch runs inside the arbiter-terminal block, so the
                // structured reason is known — do not let the reason degrade to
                // the outcome fallback.
                ...(arb.terminalReason !== undefined
                  ? { reason: arb.terminalReason }
                  : {}),
              });
              return;
            }
          }
          this.host.conversation.push({
            role: "assistant",
            content: arb.terminalAnswer,
          });
          if (!this.host.isSubmissionCurrent(submissionGeneration)) return;
          yield this.host.streamDone(arb.terminalAnswer, {
            blockedReport: buildPolicyTerminalBlockedReport(
              arb.policySource ?? "progress_terminal",
              arb.terminalAnswer,
              arb.terminalReason,
            ),
            ...(arb.terminalReason !== undefined
              ? { reason: arb.terminalReason }
              : {}),
          });
          return;
        }
        if (arb.policyMessage) {
          this.host.conversation.push({
            role: "user",
            content: arb.policyMessage,
          });
          yield { type: "thought", text: `[Policy: ${arb.policySource}]` };
          if (!this.host.isSubmissionCurrent(submissionGeneration)) return;
        }
        // Mid-loop checkpoint only (turn continues) — terminal paths use finalizeParityTurn.
        // Also flush policy events so hard harness kills still leave scoreboard data.
        checkpointParityEventLog(this.host.parity, this.host.engineRunDir);
        persistPolicyEventsJsonl(
          this.host.engineRunDir,
          this.host.policyEventLog,
        );

        _turnSpan.setAttribute("babel.chat.turn", `${turn + 1}:tool_calls`);
        endSpan(_turnSpan, SpanStatusCode.OK);
        _turnSpan = null;
        continue;
      }

      if (turnResult.type === "completion") {
        const answer = turnResult.answer;

        if (this.host.parity.turnId) {
          this.host.services.conversation.recordAssistantMessage(
            this.host.parity.eventLog,
            this.host.parity.turnId,
            answer,
          );
        }

        // R1: Check for BLOCKED declaration before the gate — the agent may
        // declare BLOCKED even though no writes were made.
        const blockedReport = this.host.detectAndBuildBlockedReport(answer);
        if (blockedReport) {
          const blockedDelta = reconcileStreamedAnswer(
            streamedAnswerForTurn,
            answer,
          );
          if (blockedDelta !== null) {
            yield { type: "answer_chunk", text: blockedDelta };
            if (!this.host.isSubmissionCurrent(submissionGeneration)) return;
          }
          this.host.conversation.push({ role: "assistant", content: answer });
          _turnSpan.setAttribute("babel.chat.blocked", "true");
          endSpan(_turnSpan, SpanStatusCode.OK);
          _turnSpan = null;
          if (!this.host.isSubmissionCurrent(submissionGeneration)) return;
          yield this.host.streamDone(answer, { blockedReport });
          return;
        }

        // R11: Per-round token ceiling — must run BEFORE any continuation
        // mechanism (text-only guard, prefers-patch refusal). Both of those
        // `continue` the loop and would otherwise starve this cost terminal:
        // a single text round that burned > maxTokensPerRound must hard-stop
        // immediately instead of being re-queried.
        const tokenCeilingBlocked = this.host.checkPerRoundTokenCeiling(false);
        if (tokenCeilingBlocked) {
          _turnSpan.setAttribute("babel.chat.token_ceiling_blocked", "true");
          endSpan(_turnSpan, SpanStatusCode.OK);
          _turnSpan = null;
          this.host.conversation.push({ role: "assistant", content: answer });
          this.host.conversation.push({
            role: "assistant",
            content: tokenCeilingBlocked,
          });
          if (!this.host.isSubmissionCurrent(submissionGeneration)) return;
          yield this.host.streamDone(tokenCeilingBlocked, {
            blockedReport: {
              schema_version: 1 as const,
              status: "BLOCKED" as const,
              // R0/W7: harness-origin budget condition. Typed so
              // computeTerminalOutcome cannot fall through to the legacy prose
              // regex and fabricate external blame.
              reason_code: "budget_exhausted" as const,
              cause_class: "harness" as const,
              reason: `Per-round token ceiling exceeded: ${this.host.apiTokenCount - this.host.apiTokenCountAtTurnStart} tokens with zero tool calls`,
              missing: "Agent produced only text — no tool calls were made",
              checked: [
                {
                  action: "token_ceiling",
                  target: "per_round_limit",
                  finding: `${(this.host.apiTokenCount - this.host.apiTokenCountAtTurnStart).toLocaleString()} tokens this turn (limit: ${this.host.limits.maxTokensPerRound.toLocaleString()})`,
                },
              ],
            },
            ...(this.host.verifierTampered
              ? { verifierTampered: true as const }
              : {}),
          });
          return;
        }

        // R11: Text-only loop guard — detect when the model produces only
        // text/completion responses without any tool calls. This must run
        // BEFORE the implementor prefers-patch refusal below: the refusal
        // continues unconditionally on every zero-write execute completion,
        // which would starve this bounded escalation (force_status at 3,
        // BLOCKED at 5) and re-query pure-text loops until maxTurns.
        this.host.stallState = {
          ...this.host.stallState,
          textOnlyTurns: this.host.stallState.textOnlyTurns + 1,
        };
        if (isTextOnlyLoop(this.host.stallState)) {
          const hasAnyWrites = this.host.hasAnyWrites();
          if (
            !hasAnyWrites &&
            this.host.stallState.textOnlyTurns >=
              TEXT_ONLY_FORCE_BLOCKED_THRESHOLD
          ) {
            // 5+ text-only turns with zero writes — force BLOCKED.
            _turnSpan.setAttribute("babel.chat.text_only_blocked", "true");
            endSpan(_turnSpan, SpanStatusCode.OK);
            _turnSpan = null;
            const textBlockedMsg = buildTextOnlyLoopBlockedMessage(
              this.host.stallState,
            );
            this.host.conversation.push({ role: "assistant", content: answer });
            this.host.conversation.push({
              role: "assistant",
              content: textBlockedMsg,
            });
            if (!this.host.isSubmissionCurrent(submissionGeneration)) return;
            yield this.host.streamDone(textBlockedMsg, {
              blockedReport: {
                schema_version: 1 as const,
                status: "BLOCKED" as const,
                // R0/W7: harness-origin stall/recovery terminal. Typed so
                // computeTerminalOutcome cannot fabricate external blame.
                reason_code: "recovery_exhausted" as const,
                cause_class: "harness" as const,
                reason:
                  "Agent produced only text responses without tool calls or file changes",
                missing: "Unable to determine — no tool calls were made",
                checked: [
                  {
                    action: "chat_turn",
                    target: "text_only_loop",
                    finding: `${this.host.stallState.textOnlyTurns} consecutive turns with zero tool calls and zero writes`,
                  },
                ],
              },
              ...(this.host.verifierTampered
                ? { verifierTampered: true as const }
                : {}),
            });
            return;
          }
          // At threshold 3: inject force_status and continue the loop.
          this.host.conversation.push({ role: "assistant", content: answer });
          this.host.conversation.push({
            role: "user",
            content: buildTextOnlyLoopIntervention(this.host.stallState),
          });
          yield {
            type: "thought",
            text: `[Text-only loop: ${this.host.stallState.textOnlyTurns} turns, escalating]`,
          };
          if (!this.host.isSubmissionCurrent(submissionGeneration)) return;
          _turnSpan.setAttribute(
            "babel.chat.text_only_turn",
            this.host.stallState.textOnlyTurns,
          );
          endSpan(_turnSpan, SpanStatusCode.OK);
          _turnSpan = null;
          continue;
        }

        // Implementor I-03: refuse silent complete on execute with zero writes
        // (allow env_blocked answers through). Import errors after writes are not host env.
        const completionHasWrites = this.host.hasAnyWrites();
        const envDetectOpts = { hasAnyWrites: completionHasWrites };
        const envBlocked =
          (!isReadOnlyChat() &&
            detectEnvBlockedFromText(answer, envDetectOpts)) ||
          this.host.toolCallLog.some(
            (t) => extractToolEnvBlockedSignal(t, envDetectOpts) !== null,
          );
        const completionPref = evaluateCompletionPrefersPatch({
          executeIntent: effectiveExecutePolicy,
          hasAnyWrites: completionHasWrites,
          envBlocked,
        });
        if (!completionPref.allowComplete && completionPref.message) {
          this.host.conversation.push({ role: "assistant", content: answer });
          this.host.conversation.push({
            role: "user",
            content: completionPref.message,
          });
          yield {
            type: "thought",
            text: "[Implementor: completion prefers patch — continuing]",
          };
          if (!this.host.isSubmissionCurrent(submissionGeneration)) return;
          this.host.policyEventLog.record({
            at_turn: this.host._turnIndex,
            kind: "progress_policy",
            detail: "completion_prefers_patch",
          });
          endSpan(_turnSpan, SpanStatusCode.OK);
          _turnSpan = null;
          continue;
        }

        const disposition = yield* settleStreamingCompletion({
          host: this.host,
          answer,
          turnResult,
          effectiveExecutePolicy,
          effectiveIntent,
          submissionGeneration,
          streamedAnswerForTurn,
          turn,
          turnSpan: _turnSpan!,
        });
        if (disposition === "continue") continue;
        return;

      }
    }

    yield* finalizeStreamingTurnLimit({
      host: this.host,
      submissionGeneration,
      allToolObservations,
      effectiveExecutePolicy,
      effectiveIntent,
      maxTurns,
    });
  }
}

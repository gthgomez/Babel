import { SpanStatusCode, type Span } from "@opentelemetry/api";
import { endSpan } from "../telemetry/tracing.js";
import { isBabelHeadlessEnv } from "../utils/envFlags.js";
import { getChatTaskTune } from "../config/chatTaskClass.js";
import type {
  ChatEngineStreamingLoopHost,
  ChatEvent,
  TaskIntent,
} from "./chatEngine.js";
import type { ChatTurn } from "./chatToolDefinitions.js";
import {
  AUTO_CONTINUE_REFUSAL_MSG,
  buildAutoContinueBlockedReport,
  planCompletionGateReject,
  resolveVerificationPolicy,
} from "./completionGatePolicy.js";
import { recordProgressRecovery } from "./sessionEvents.js";
import { reconcileStreamedAnswer } from "./chatEngineStreamingProtocol.js";

const MAX_GATE_STRIKES = 3;

/** Resolve completion gates and settle one completed streaming turn. */
export async function* settleStreamingCompletion(input: {
  host: ChatEngineStreamingLoopHost;
  answer: string;
  turnResult: ChatTurn;
  effectiveExecutePolicy: boolean;
  effectiveIntent: TaskIntent;
  submissionGeneration: number;
  streamedAnswerForTurn: string | null;
  turn: number;
  turnSpan: Span;
}): AsyncGenerator<ChatEvent, "continue" | "done", undefined> {
  const {
    host,
    answer,
    turnResult,
    effectiveExecutePolicy,
    effectiveIntent,
    submissionGeneration,
    streamedAnswerForTurn,
    turn,
  } = input;
  let turnSpan: Span | null = input.turnSpan;
  // Execution gate: buffer streaming answer until gate check passes
  const gateResult = host.evaluateCompletionGate(
    turnResult,
    effectiveIntent,
  );
  const hardGate = isBabelHeadlessEnv() || !process.stdout.isTTY;

  if (gateResult === "reject") {
    const tuneStream = getChatTaskTune(host.taskClass);
    const policyStream = resolveVerificationPolicy({
      policy: tuneStream.verificationPolicy,
      task: host.options.task,
    });
    host.gatePolicy = policyStream;
    const plan = planCompletionGateReject({
      hasWrites: host.hasAnyWrites(),
      policy: policyStream,
      hardGate,
      hadToolCallsThisTurn: host._hadToolCallsThisTurn,
      gateStrikes: host.gateStrikes,
      maxGateStrikes: MAX_GATE_STRIKES,
    });
    if (plan.kind === "auto_continue_block") {
      turnSpan.setAttribute("babel.chat.auto_continue_refused", "true");
      endSpan(turnSpan, SpanStatusCode.OK);
      turnSpan = null;
      host.conversation.push({ role: "assistant", content: answer });
      host.conversation.push({
        role: "assistant",
        content: AUTO_CONTINUE_REFUSAL_MSG,
      });
      if (!host.isSubmissionCurrent(submissionGeneration)) return "done";
      yield host.streamDone(AUTO_CONTINUE_REFUSAL_MSG, {
        blockedReport: buildAutoContinueBlockedReport(),
        ...(host.verifierTampered
          ? { verifierTampered: true as const }
          : {}),
      });
      return "done";
    }
    if (plan.kind === "blocked") {
      turnSpan.setAttribute("babel.chat.gate_blocked", "true");
      endSpan(turnSpan, SpanStatusCode.OK);
      turnSpan = null;
      if (!host.isSubmissionCurrent(submissionGeneration)) return "done";
      yield host.streamDone(`BLOCKED: ${plan.reason}`, {
        blockedReport: host.buildVerifierBlockedReport(plan.reason),
        ...(host.verifierTampered
          ? { verifierTampered: true as const }
          : {}),
      });
      return "done";
    }
    if (plan.kind === "reject_continue") {
      host.gateStrikes = plan.gateStrikesAfter;

      // W3 Phase 3 Progress and Recovery Controller
      const pcResult = host.progressController.scoreTurn(
        [],
        true,
        host.gateStrikes,
      );
      recordProgressRecovery(
        host.parity.sessionEvents,
        String(host.parity.turnId ?? host._turnIndex),
        {
          intervention: pcResult.intervention,
          score: pcResult.score,
          signals: ["text_only_turn", "gate_rejection"],
          reason: "completion_gate_rejection",
        },
      );
      if (pcResult.transitioned) {
        yield {
          type: "progress_recovery",
          intervention: pcResult.intervention,
          source: "progress_controller",
          score: pcResult.score,
          message: `Gate strike threshold escalated to ${pcResult.intervention}`,
        };
        if (!host.isSubmissionCurrent(submissionGeneration)) return "done";
      }

      host.conversation.push({ role: "assistant", content: answer });
      host.conversation.push({
        role: "user",
        content: plan.useGreenMessage
          ? host.buildGateRejectUserMessage()
          : host.buildRejectionMessage(),
      });
      turnSpan.setAttribute(
        "babel.chat.gate_strike",
        host.gateStrikes,
      );
      endSpan(turnSpan, SpanStatusCode.OK);
      turnSpan = null;
      return "continue";
    }
    host.gateStrikes = plan.gateStrikesAfter;
  }

  // Idea 14: asymmetric diff critic before complete (streaming path)
  const streamCritic = await host.runAsymmetricDiffCritic(
    answer,
    {
      onThought: (_t) => {
        /* thought emitted via yield below when we can */
      },
    },
    effectiveIntent,
  );
  // R0-8: the diff critic is a suspension point; a superseded generator
  // must not install critic receipts, strikes or repair budgets on the
  // task that now owns the engine.
  if (!host.isSubmissionCurrent(submissionGeneration)) return "done";
  if (host.lastCriticReceipt) {
    yield {
      type: "thought",
      text: `[Diff critic: ${host.lastCriticReceipt.verdict}]`,
    };
    if (!host.isSubmissionCurrent(submissionGeneration)) return "done";
  }
  if (streamCritic === "reject") {
    turnSpan.setAttribute(
      "babel.chat.critic_strike",
      host.criticStrikes,
    );
    // Shrink remaining cost to a repair window (do not burn full session max).
    host.applyCriticRepairCostBudget();
    // Inject critic feedback so the model knows WHY and can fix it.
    const receipt = host.lastCriticReceipt;
    if (receipt?.reasons?.length) {
      const reasons = receipt.reasons
        .map((r, i) => `${i + 1}. ${r}`)
        .join("\n");
      host.conversation.push({ role: "assistant", content: answer });
      host.conversation.push({
        role: "user",
        content: [
          "## Diff critic rejected your patch",
          "",
          reasons,
          "",
          "Fix these issues before trying to complete again.",
          "If the critic says you modified the wrong method or API,",
          "re-read the issue to identify the CORRECT symbol to fix.",
          host.criticRepairCostCapUsd != null
            ? `\nCost repair window active — finish the fix soon (cap $${host.criticRepairCostCapUsd.toFixed(2)}).`
            : "",
        ]
          .filter(Boolean)
          .join("\n"),
      });
    }
    endSpan(turnSpan, SpanStatusCode.OK);
    turnSpan = null;
    return "continue";
  }
  if (streamCritic === "block") {
    const report = host.buildCriticBlockedReport(
      host.lastCriticReceipt ?? {
        verdict: "reject",
        reasons: ["critic hard-block"],
        confidence: 1,
      },
    );
    const blockedAnswer = host.buildCriticBlockedAnswer(report);
    host.conversation.push({ role: "assistant", content: answer });
    host.conversation.push({
      role: "assistant",
      content: blockedAnswer,
    });
    turnSpan.setAttribute(
      "babel.chat.critic_strike",
      host.criticStrikes,
    );
    turnSpan.setAttribute("babel.chat.critic_hard_block", "true");
    endSpan(turnSpan, SpanStatusCode.OK);
    turnSpan = null;
    if (!host.isSubmissionCurrent(submissionGeneration)) return "done";
    yield host.streamDone(blockedAnswer, {
      blockedReport: report,
      ...(host.lastCriticReceipt
        ? { criticReceipt: host.lastCriticReceipt }
        : {}),
      ...(host.verifierTampered
        ? { verifierTampered: true as const }
        : {}),
    });
    return "done";
  }

  // Emit only the not-yet-streamed remainder of the final answer —
  // re-emitting identical or prefix-overlapping text duplicates it in
  // the TUI (see reconcileStreamedAnswer).
  const answerDelta = reconcileStreamedAnswer(
    streamedAnswerForTurn,
    answer,
  );
  if (answerDelta !== null) {
    yield { type: "answer_chunk", text: answerDelta };
    if (!host.isSubmissionCurrent(submissionGeneration)) return "done";
  }
  host.conversation.push({ role: "assistant", content: answer });
  turnSpan.setAttribute("babel.chat.turn", `${turn + 1}:completion`);
  if (host.lastCriticReceipt) {
    turnSpan.setAttribute(
      "babel.chat.critic_verdict",
      host.lastCriticReceipt.verdict,
    );
  }
  endSpan(turnSpan, SpanStatusCode.OK);
  turnSpan = null;
  if (!host.isSubmissionCurrent(submissionGeneration)) return "done";
  yield host.streamDone(answer, {
    ...(host.lastCriticReceipt
      ? { criticReceipt: host.lastCriticReceipt }
      : {}),
  });
  return "done";

}

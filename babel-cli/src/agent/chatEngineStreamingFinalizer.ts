import type {
  ChatEvent,
  ChatEngineStreamingLoopHost,
  TaskIntent,
} from "./chatEngine.js";

/** Emit the terminal outcome when a submission exhausts its turn allowance. */
export async function* finalizeStreamingTurnLimit(input: {
  host: ChatEngineStreamingLoopHost;
  submissionGeneration: number;
  allToolObservations: string;
  effectiveExecutePolicy: boolean;
  effectiveIntent: TaskIntent;
  maxTurns: number;
}): AsyncGenerator<ChatEvent, void, undefined> {
  const {
    host,
    submissionGeneration,
    allToolObservations,
    effectiveExecutePolicy,
    effectiveIntent,
    maxTurns,
  } = input;
  // maxTurns exceeded
  host.terminatingLimiter = host.terminatingLimiter ?? "turns";
  host.terminalLimiterReason =
    host.terminalLimiterReason ??
    `Turn limit reached (${host.taskAllowance?.consumed.turns ?? maxTurns} of ` +
      `${host.taskAllowance?.grant.turnCap ?? maxTurns}).`;
  const maxTurnAnswer = await host
    .synthesizeAnswer(allToolObservations, {
      onAnswerChunk: (_chunk) => {},
    })
    .catch(() => "");
  // R0-8: synthesis is a suspension point; a superseded generator must not
  // append to the new task's conversation.
  if (!host.isSubmissionCurrent(submissionGeneration)) return;
  host.conversation.push({ role: "assistant", content: maxTurnAnswer });

  // R1: Check synthesized answer for BLOCKED before gate — must come
  // before the gate check since BLOCKED is a valid terminal outcome
  // that bypasses the write/verifier gate.
  const maxTurnBlockedReport = host.detectAndBuildBlockedReport(maxTurnAnswer);
  if (maxTurnBlockedReport) {
    if (!host.isSubmissionCurrent(submissionGeneration)) return;
    yield host.streamDone(maxTurnAnswer, {
      blockedReport: maxTurnBlockedReport,
    });
    return;
  }

  if (effectiveExecutePolicy) {
    const gateResult = host.evaluateCompletionGate(
      { type: "completion", answer: "" },
      effectiveIntent,
    );
    if (gateResult === "reject") {
      if (!host.isSubmissionCurrent(submissionGeneration)) return;
      yield host.streamFailed(
        `Turn limit exceeded. ${host.buildRejectionMessage()}`,
      );
      return;
    }

    // Critic on stream max-turn completion: terminal — reject becomes hard-block.
    const terminalCritic = await host.runAsymmetricDiffCritic(
      maxTurnAnswer,
      {
        onThought: (_t) => {
          /* no-op on terminal stream path */
        },
      },
      effectiveIntent,
      { terminal: true },
    );
    // R0-8: terminal critic inference is a suspension point. Do not read
    // its receipt or emit any terminal evidence after ownership changes.
    if (!host.isSubmissionCurrent(submissionGeneration)) return;
    if (host.lastCriticReceipt) {
      yield {
        type: "thought",
        text: `[Diff critic: ${host.lastCriticReceipt.verdict}]`,
      };
      if (!host.isSubmissionCurrent(submissionGeneration)) return;
    }
    if (terminalCritic === "block" || terminalCritic === "reject") {
      const report = host.buildCriticBlockedReport(
        host.lastCriticReceipt ?? {
          verdict: "reject",
          reasons: ["critic reject at turn limit"],
          confidence: 1,
        },
      );
      const blockedAnswer = host.buildCriticBlockedAnswer(report);
      if (!host.isSubmissionCurrent(submissionGeneration)) return;
      yield host.streamDone(blockedAnswer, {
        blockedReport: report,
        ...(host.lastCriticReceipt
          ? { criticReceipt: host.lastCriticReceipt }
          : {}),
      });
      return;
    }
  }
  if (!host.isSubmissionCurrent(submissionGeneration)) return;
  yield host.streamDone(maxTurnAnswer, {
    ...(host.lastCriticReceipt
      ? { criticReceipt: host.lastCriticReceipt }
      : {}),
  });
}

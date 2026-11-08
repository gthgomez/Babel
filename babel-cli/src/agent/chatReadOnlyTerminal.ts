import type { ChatEvent } from './chatEngineContracts.js';
import type { ChatEngineStreamingLoopHost } from './chatEngineContracts.js';
import { attachTerminalReason } from './chatZeroWritePolicy.js';

type ArbiterResult = ReturnType<typeof import('./chatEngineParityBridge.js').parityArbitrateCycle>;

export interface ReadOnlyTerminalInput {
  host: ChatEngineStreamingLoopHost;
  submissionGeneration: number;
  allToolObservations: string;
  userInput: string;
  arb: ArbiterResult;
}

/** Read-only inspection terminal: synthesize gathered evidence into a bounded final answer. */
export async function* streamReadOnlyTerminal(input: ReadOnlyTerminalInput): AsyncGenerator<ChatEvent, void, undefined> {
  const { host, submissionGeneration, allToolObservations, userInput, arb } = input;
  let synthAnswer = "";
  let synthError: Error | null = null;
  try {
    synthAnswer = await host.synthesizeAnswer(
      allToolObservations,
      { onAnswerChunk: (_chunk: string) => {} },
      userInput,
    );
  } catch (err: any) {
    synthError = err instanceof Error ? err : new Error(String(err));
  }
  // R0-8: synthesis is a suspension point; a superseded generator must not
  // append to the new task's conversation.
  if (!host.isSubmissionCurrent(submissionGeneration)) return;

  if (synthError || !synthAnswer?.trim()) {
    if (synthError?.message.startsWith('RESPONSE_EVIDENCE_INVALID:')) {
      yield host.streamFailed(synthError.message);
      return;
    }
    const failMsg = `Answer synthesis failed after inspection completed: ${synthError?.message ?? "no answer generated"}`;
    host.conversation.push({ role: "assistant", content: failMsg });
    yield { type: "answer_chunk", text: failMsg };
    if (!host.isSubmissionCurrent(submissionGeneration)) return;
    yield host.streamDone(failMsg, {
      blockedReport: attachTerminalReason(
        {
          schema_version: 1,
          status: "BLOCKED",
          reason: "Answer synthesis unavailable",
          missing: "LLM provider response for answer synthesis",
          checked: [{ action: "synthesize_answer", target: "provider", finding: synthError?.message ?? "Empty synthesis output" }],
        },
        arb.terminalReason,
      ),
      ...(arb.terminalReason !== undefined ? { reason: arb.terminalReason } : {}),
    });
    return;
  }

  const finalAnswer = synthAnswer.trim();
  const synthBlocked = host.detectAndBuildBlockedReport(finalAnswer);
  host.conversation.push({ role: "assistant", content: finalAnswer });
  yield { type: "answer_chunk", text: finalAnswer };
  if (!host.isSubmissionCurrent(submissionGeneration)) return;
  yield host.streamDone(finalAnswer, {
    blockedReport: synthBlocked ?? null,
    ...(arb.terminalReason !== undefined ? { reason: arb.terminalReason } : {}),
  });
}

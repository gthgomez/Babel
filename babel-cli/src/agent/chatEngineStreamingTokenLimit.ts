import type { ChatEvent, ChatEngineStreamingLoopHost, TaskIntent } from './chatEngineContracts.js';
import type { Span } from '@opentelemetry/api';
import { SpanStatusCode } from '@opentelemetry/api';
import { endSpan } from '../telemetry/tracing.js';
import { evaluateTokenExplosionAfterTurn } from './budgetKillPolicy.js';
import { recordPolicyEvent } from './chatEngineObservability.js';

/** Apply the canonical token terminal before any continuation can reset its baseline. */
export async function* settleStreamingTokenExplosion(
  host: ChatEngineStreamingLoopHost,
  effectiveIntent: TaskIntent,
  submissionGeneration: number,
  turnSpan: Span | null,
  hasAnyWrites = host.hasAnyWrites(),
): AsyncGenerator<ChatEvent, boolean, undefined> {
  const streamExplosion = evaluateTokenExplosionAfterTurn({
    tokensAtTurnStart: host.apiTokenCountAtTurnStart,
    tokensNow: host.apiTokenCount,
    maxTokensPerRound: host.limits.maxTokensPerRound,
    hasAnyWrites,
  });
  if (streamExplosion.abort) {
    // Tier A2: Record token explosion event before aborting
    recordPolicyEvent(
      host.policyEventLog,
      host._turnIndex,
      "token_explosion",
      `tokens_this_turn=${streamExplosion.tokensThisTurn}`,
    );
    endSpan(turnSpan, SpanStatusCode.OK);
    // R0-8: a superseded generator must not install a terminal limiter on
    // the task that now owns the engine.
    if (!host.isSubmissionCurrent(submissionGeneration)) return true;
    host.terminatingLimiter = "tokens";
    host.terminalLimiterReason = `Token explosion with zero mutations: ${streamExplosion.tokensThisTurn} tokens this turn (ceiling ${host.limits.maxTokensPerRound}).`;
    if (!host.isSubmissionCurrent(submissionGeneration)) return true;
    const kill = await host.handleBudgetKill(
      host.terminalLimiterReason,
      { onThought: () => {} },
      effectiveIntent,
      submissionGeneration,
    );
    if (!kill || !host.isSubmissionCurrent(submissionGeneration))
      return true;
    yield host.streamDone(kill.answer, {
      ...(kill.blockedReport ? { blockedReport: kill.blockedReport } : {}),
      ...(kill.criticReceipt ? { criticReceipt: kill.criticReceipt } : {}),
      ...(kill.verifierTampered ? { verifierTampered: true as const } : {}),
    });
    return true;
  }

  return false;
}

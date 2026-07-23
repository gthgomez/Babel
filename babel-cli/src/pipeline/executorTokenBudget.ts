import { globalCostTracker } from '../services/costTracker.js';
import {
  checkTokenBudget,
  formatBudgetStatus,
} from '../services/tokenBudgetEnforcer.js';
import { buildHaltReport } from '../stages/executorHelpers.js';
import { writeValidatedExecutionReport } from './executionReports.js';
import { log, logDetail } from './logging.js';
import type { ExecutorLoopResult } from './executorLoopTypes.js';
import type { HaltTag, ToolCallLog } from '../schemas/agentContracts.js';
import type { EvidenceBundle } from '../evidence.js';

// ── Extracted helper result type ─────────────────────────────────────────────

type TokenBudgetResult =
  | { kind: 'return'; result: ExecutorLoopResult }
  | { kind: 'ok' };

/**
 * Extracted: enforces the token budget at the top of each executor turn.
 *
 * Checks the current session token usage against the configured budget limit.
 * If the budget is exceeded, a halt report is written, executor context is
 * persisted as terminal, and a terminal `ExecutorLoopResult` is returned
 * (via `{ kind: 'return', result }`). Otherwise returns `{ kind: 'ok' }` to
 * allow the turn to continue.
 *
 * @param toolCallLog         The accumulated tool call log for this executor run.
 * @param reportWarnings      Accumulated warning strings (mutated in place).
 * @param evidence            Evidence bundle for writing execution reports.
 * @param persistExecutorContext  Closure to persist executor context to disk.
 * @param totalJitLatencyMs       Accumulated JIT latency telemetry.
 * @param totalStreamPauseDurationMs Accumulated stream pause telemetry.
 * @param totalLockWaitMs          Accumulated lock wait telemetry.
 * @param peakBufferBytes          Peak output buffer byte count.
 * @returns `{ kind: 'return', result }` when the budget is exceeded (terminal),
 *          or `{ kind: 'ok' }` to continue the loop.
 */
export async function enforceTokenBudget(
  toolCallLog: ToolCallLog[],
  reportWarnings: string[],
  evidence: EvidenceBundle,
  persistExecutorContext: (
    status: 'ready_for_next_turn' | 'after_tool_call' | 'terminal',
    nextTurnPrompt: string,
    details?: { terminalStatus?: string; haltTag?: string; condition?: string },
  ) => Promise<void>,
  totalJitLatencyMs: number,
  totalStreamPauseDurationMs: number,
  totalLockWaitMs: number,
  peakBufferBytes: number,
): Promise<TokenBudgetResult> {
  // ── Phase 1d: Token budget enforcement ────────────────────────────────
  const sessionUsage = globalCostTracker.getSessionSummary();
  const budgetCheck = checkTokenBudget(sessionUsage.totalTokens);
  if (!budgetCheck.proceed) {
    const condition = `Token budget exceeded: ${budgetCheck.tokensUsed}/${budgetCheck.budgetLimit} tokens used.`;
    logDetail(formatBudgetStatus(budgetCheck));
    reportWarnings.push(formatBudgetStatus(budgetCheck));
    const budgetReport = buildHaltReport(
      toolCallLog,
      'BUDGET_EXCEEDED' as HaltTag,
      Math.max(1, toolCallLog.length),
      condition,
    );
    await persistExecutorContext('terminal', '', {
      terminalStatus: 'EXECUTION_HALTED',
      haltTag: 'BUDGET_EXCEEDED',
      condition,
    });
    writeValidatedExecutionReport(evidence, budgetReport, toolCallLog, reportWarnings);
    log(`  Executor: EXECUTION_HALTED [BUDGET_EXCEEDED] ${condition}`);
    return {
      kind: 'return',
      result: {
        toolCallLog,
        terminalStatus: 'EXECUTION_HALTED',
        haltTag: 'BUDGET_EXCEEDED' as HaltTag,
        condition,
        jitLatencyMs: totalJitLatencyMs,
        streamPauseDurationMs: totalStreamPauseDurationMs,
        lockWaitMs: totalLockWaitMs,
        bufferPeakBytes: peakBufferBytes,
      },
    };
  }
  if (budgetCheck.reason) {
    logDetail(formatBudgetStatus(budgetCheck));
  }
  return { kind: 'ok' };
}

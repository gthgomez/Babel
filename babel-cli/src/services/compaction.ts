// (no node:fs imports needed — compaction telemetry is written via evidence.writeDebugFile)
import { randomUUID } from 'node:crypto';

import { EvidenceBundle } from '../evidence.js';
import type { PrunedMessageRange } from '../runtime/events.js';
import { type ToolCallLog } from '../schemas/agentContracts.js';
import { formatHistoryEntry } from '../stages/executorHelpers.js';
import { type CondensationFactChannel, prunedIndexesToRanges } from './condensationFacts.js';
import { countTextTokens } from './tokenCounter.js';

/**
 * Run-scoped compaction circuit state.
 *
 * The failure counter used to be module-level mutable state. In a resident
 * process that serves several sessions (daemon, Desktop, concurrent pipelines)
 * one session's failures tripped the breaker for every other session. Callers
 * now own one state object per run; only legacy callers that omit it share the
 * compatibility default below.
 */
export interface CompactionCircuitState {
  consecutiveFailures: number;
}

/** Create one independent breaker state for a governed run. */
export function createCompactionCircuitState(): CompactionCircuitState {
  return { consecutiveFailures: 0 };
}

const legacyCompactionCircuitState = createCompactionCircuitState();
const MAX_COMPACTION_FAILURES = 3;

export async function autoCompactIfNeeded(
  history: string,
  turn: number,
  toolCallLog: ToolCallLog[],
  evidence?: EvidenceBundle,
  /**
   * Packet A5: when provided, a strict condensation started/completed fact
   * pair is built for every compaction and delivered through the channel.
   * An interrupted compaction (the catch path below) leaves the started fact
   * unpaired — a visible fail-closed gap — and no completed fact is minted.
   */
  condensation?: CondensationFactChannel,
  /** Run-scoped failure state. Omit only for legacy single-session callers. */
  circuitState: CompactionCircuitState = legacyCompactionCircuitState,
): Promise<{
  compacted: boolean;
  newHistory: string;
  tokensBefore: number;
  tokensAfter: number;
  bytesPruned: number;
  /** Condensation id of the emitted fact pair, when facts were emitted. */
  condensationId?: string;
}> {
  const tokensBefore = countTextTokens(history);

  // If the number of turns is 5 or less, no compaction is needed
  if (toolCallLog.length <= 5) {
    return {
      compacted: false,
      newHistory: history,
      tokensBefore,
      tokensAfter: tokensBefore,
      bytesPruned: 0,
    };
  }

  if (circuitState.consecutiveFailures >= MAX_COMPACTION_FAILURES) {
    console.warn('[compaction] Circuit breaker tripped — skipping compaction');
    return {
      compacted: false,
      newHistory: history,
      tokensBefore,
      tokensAfter: tokensBefore,
      bytesPruned: 0,
    };
  }

  console.log(
    `[compaction] Triggering context compaction for turn ${turn} (Steps: ${toolCallLog.length})`,
  );

  // Packet A5: the started fact precedes any pruning work. Every failure path
  // below leaves it unpaired — an explicitly visible interrupted compaction.
  let condensationId: string | undefined;
  if (condensation) {
    condensationId = randomUUID();
    const started = condensation.emitter.begin({
      compactionId: condensationId,
      path: 'pipeline_step_prune',
      countBefore: tokensBefore,
    });
    if (started) condensation.emit(started);
    else condensationId = undefined;
  }

  try {
    let prunedBytes = 0;
    const newHistoryEntries: string[] = [];
    const prunedSteps: number[] = [];

    for (const entry of toolCallLog) {
      const isRecent = entry.step > turn - 5;
      if (isRecent) {
        newHistoryEntries.push(formatHistoryEntry(entry));
      } else {
        prunedSteps.push(entry.step);
        // Prune older history
        const originalStdoutLen = entry.stdout ? entry.stdout.length : 0;
        const originalStderrLen = entry.stderr ? entry.stderr.length : 0;

        let stdout = entry.stdout || '';
        let stderr = entry.stderr || '';

        if (stdout.length > 2048) {
          const stub = `\n[Step ${entry.step} stdout truncated: ${stdout.length} bytes replaced by metadata stub]\n`;
          prunedBytes += stdout.length - stub.length;
          stdout = stub;
        }
        if (stderr.length > 2048) {
          const stub = `\n[Step ${entry.step} stderr truncated: ${stderr.length} bytes replaced by metadata stub]\n`;
          prunedBytes += stderr.length - stub.length;
          stderr = stub;
        }

        const prunedEntry: ToolCallLog = {
          ...entry,
          stdout,
          stderr,
        };
        newHistoryEntries.push(formatHistoryEntry(prunedEntry));
      }
    }

    const newHistory = newHistoryEntries.join('\n\n');
    const tokensAfter = countTextTokens(newHistory);
    console.log(
      `[compaction] ✓ Compacted older history. Pruned bytes: ${prunedBytes}. Tokens before: ${tokensBefore}, after: ${tokensAfter}`,
    );

    if (evidence) {
      // Write debug file
      evidence.writeDebugFile(
        'compaction_telemetry.json',
        JSON.stringify(
          {
            turn,
            total_steps: toolCallLog.length,
            pruned_bytes: prunedBytes,
            tokens_before: tokensBefore,
            tokens_after: tokensAfter,
            timestamp: new Date().toISOString(),
          },
          null,
          2,
        ),
      );

      // Compaction telemetry is recorded in compaction_telemetry.json (written
      // above via writeDebugFile). It is intentionally NOT merged into
      // cost_ledger.json — finalizeResult overwrites the cost ledger with a
      // fresh build from the waterfall log, which would silently drop any
      // telemetry appended here. The debug file is the canonical record.
    }

    circuitState.consecutiveFailures = 0;

    // Packet A5: completed fact carries the real token counts and the pruned
    // step ranges derived from the actual pruning pass above.
    if (condensation && condensationId !== undefined) {
      const prunedMessageRanges: PrunedMessageRange[] = prunedIndexesToRanges(prunedSteps);
      const completed = condensation.emitter.complete({
        compactionId: condensationId,
        countAfter: tokensAfter,
        prunedMessageRanges,
      });
      if (completed) condensation.emit(completed);
      else condensationId = undefined;
    }

    return {
      compacted: true,
      newHistory,
      tokensBefore,
      tokensAfter,
      bytesPruned: prunedBytes,
      ...(condensationId !== undefined ? { condensationId } : {}),
    };
  } catch (err) {
    circuitState.consecutiveFailures++;
    console.warn(
      `[compaction] Compaction failed (${circuitState.consecutiveFailures}/${MAX_COMPACTION_FAILURES}): ${err instanceof Error ? err.message : String(err)}`,
    );
    // Packet A5: the started fact (if emitted) intentionally has no completed
    // pair — `condensationId` surfaces the interrupted compaction to callers.
    return {
      compacted: false,
      newHistory: history,
      tokensBefore,
      tokensAfter: tokensBefore,
      bytesPruned: 0,
      ...(condensationId !== undefined ? { condensationId } : {}),
    };
  }
}

/**
 * Reset one run's compaction circuit breaker.
 *
 * Resets the supplied state so that `autoCompactIfNeeded` will attempt
 * compaction again. This resets ONLY the step-level pruning breaker in this
 * module. ChatEngine's separate inline conversation breaker
 * (`compactConversation()` in chatEngine.ts) has its own reset method — call
 * ChatEngine.resetCompactionCircuitBreaker() for that.
 *
 * @param circuitState Run state to reset; defaults to the legacy shared state.
 */
export function resetCompactionCircuitBreaker(
  circuitState: CompactionCircuitState = legacyCompactionCircuitState,
): void {
  circuitState.consecutiveFailures = 0;
}

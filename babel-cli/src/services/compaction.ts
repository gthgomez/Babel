// (no node:fs imports needed — compaction telemetry is written via evidence.writeDebugFile)
import { EvidenceBundle } from '../evidence.js';
import { type ToolCallLog } from '../schemas/agentContracts.js';
import { formatHistoryEntry } from '../stages/executorHelpers.js';
import { countTextTokens } from './tokenCounter.js';

/**
 * Circuit breaker: consecutive compaction failures before disabling.
 *
 * WARNING: Module-level mutable state.
 * This counter is shared by ALL callers of `autoCompactIfNeeded` within the
 * same process. A failure in one session trips the circuit breaker for ALL
 * sessions. To mitigate this, call `resetCompactionCircuitBreaker()` during
 * session initialization (see AgentSession.runDispatch in session.ts) so that
 * each new session starts with a clean slate.
 *
 * This circuit breaker guards the `autoCompactIfNeeded` function below and is
 * used by the governed pipeline (pipeline.ts / executorLoop.ts). It tracks
 * failures of the step-level ToolCallLog[] stdout/stderr pruning logic.
 *
 * ChatEngine has a SEPARATE circuit breaker for its own inline conversation
 * compaction (`compactConversation()` in chatEngine.ts, lines 173-175) that
 * tracks failures of the ChatMessage[] conversation-dropping path. They are
 * intentionally independent because the two compaction mechanisms operate on
 * different data structures and serve different callers.
 *
 * @see ChatEngine.compactionConsecutiveFailures in chatEngine.ts
 */
let compactionConsecutiveFailures = 0;
const MAX_COMPACTION_FAILURES = 3;

export async function autoCompactIfNeeded(
  history: string,
  turn: number,
  toolCallLog: ToolCallLog[],
  evidence?: EvidenceBundle,
): Promise<{
  compacted: boolean;
  newHistory: string;
  tokensBefore: number;
  tokensAfter: number;
  bytesPruned: number;
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

  if (compactionConsecutiveFailures >= MAX_COMPACTION_FAILURES) {
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

  try {
    let prunedBytes = 0;
    const newHistoryEntries: string[] = [];

    for (const entry of toolCallLog) {
      const isRecent = entry.step > turn - 5;
      if (isRecent) {
        newHistoryEntries.push(formatHistoryEntry(entry));
      } else {
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

    compactionConsecutiveFailures = 0;

    return {
      compacted: true,
      newHistory,
      tokensBefore,
      tokensAfter,
      bytesPruned: prunedBytes,
    };
  } catch (err) {
    compactionConsecutiveFailures++;
    console.warn(
      `[compaction] Compaction failed (${compactionConsecutiveFailures}/${MAX_COMPACTION_FAILURES}): ${err instanceof Error ? err.message : String(err)}`,
    );
    return {
      compacted: false,
      newHistory: history,
      tokensBefore,
      tokensAfter: tokensBefore,
      bytesPruned: 0,
    };
  }
}

/**
 * Reset the module-level compaction circuit breaker.
 *
 * Resets `compactionConsecutiveFailures` to 0 so that `autoCompactIfNeeded`
 * will attempt compaction again. This resets ONLY the circuit breaker in this
 * module (which guards autoCompactIfNeeded's step-level pruning). ChatEngine's
 * separate circuit breaker (`compactConversation()` in chatEngine.ts) has its
 * own reset method — call ChatEngine.resetCompactionCircuitBreaker() for that.
 */
export function resetCompactionCircuitBreaker(): void {
  compactionConsecutiveFailures = 0;
}

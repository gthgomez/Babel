import { runWithFallback } from '../execute.js';
import { CompactionSummarySchema } from '../schemas/agentContracts.js';
import { EvidenceBundle } from '../evidence.js';
import {
  buildUntrustedContentBlock,
  untrustedContentInstruction,
} from '../utils/untrustedContent.js';

// Tunable via BABEL_COMPACTION_THRESHOLD env var (chars). Default is conservative for Llama-4-Scout (328K context).
const COMPACTION_THRESHOLD = Number(process.env['BABEL_COMPACTION_THRESHOLD'] ?? '250000') || 250_000;

export async function autoCompactIfNeeded(
  history: string,
  turn: number,
  evidence?: EvidenceBundle
): Promise<{ compacted: boolean; newHistory: string }> {
  if (history.length < COMPACTION_THRESHOLD) {
    return { compacted: false, newHistory: history };
  }

  console.log(`[compaction] Triggering context compaction for turn ${turn} (Size: ${history.length} chars)`);

  const compactionPrompt = `
You are the Babel Context Compactor. Your goal is to compress the following tool execution history into a high-density summary that preserves all critical logical invariants and file state changes while discarding redundant debris.
${untrustedContentInstruction('execution_history')}

CRITICAL INVARIANTS TO PRESERVE:
1. Every file that has been successfully modified and the nature of the change.
2. Any specific errors that were encountered and how they were resolved.
3. The current location of the executor within the overall implementation plan.

HISTORY TO COMPRESS:
${buildUntrustedContentBlock('execution_history', history)}

Return your response as a structured JSON object.
`;

  try {
    const result = await runWithFallback(compactionPrompt, CompactionSummarySchema, {
      stage: 'orchestrator',
      schemaName: 'CompactionSummarySchema',
      ...(evidence ? { evidence } : {})
    });

    const newHistory = `
[CONTEXT COMPACTION BOUNDARY - TURN ${turn}]
The earlier execution history has been compacted for efficiency.

SUMMARY OF PRIOR WORK:
${result.summary_text}

FILES MODIFIED:
${result.applied_changes.map(f => `- ${f}`).join('\n')}

CURRENT STATE:
${result.current_state}
---
[RESUMING LIVE CONTEXT]
`;

    console.log(`[compaction] ✓ Successfully compacted context. New size: ${newHistory.length} chars.`);
    return { compacted: true, newHistory };

  } catch (error) {
    console.warn(`[compaction] ✗ Compaction failed — continuing with original history. ${error instanceof Error ? error.message : String(error)}`);
    return { compacted: false, newHistory: history };
  }
}

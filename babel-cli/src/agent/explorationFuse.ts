/**
 * Exploration fuse — progressive escalation to prevent analysis paralysis.
 *
 * Tracks cumulative exploration tool usage across a session and escalates
 * through nudge → escalate → exhausted phases at 2×/3×/4× of the
 * configured `readThrashToolBudget`.
 *
 * Pure functions — callers own the conversation array and field updates.
 */

export interface ExplorationEscalationResult {
  /** Log messages describing what was pushed (empty if nothing fired). */
  fired: string[];
  /** Whether tools should be restricted next turn (4× exhaustion). */
  restrictTools: boolean;
}

/**
 * Apply progressive cumulative exploration escalation.
 *
 * At 2× budget: nudge the model to start acting.
 * At 3× budget: escalate — require action or BLOCKED within 2 turns.
 * At 4× budget: auto-BLOCKED — forbid further reads.
 *
 * `pushMessage` is called with { role: 'user', content: string } for each
 * escalation level that fires. The caller owns the conversation array.
 */
export function applyCumulativeExplorationEscalation(
  cumulativeExplorationTools: number,
  readThrashToolBudget: number,
  pushMessage: (msg: { role: 'user'; content: string }) => void,
): ExplorationEscalationResult {
  const out: ExplorationEscalationResult = { fired: [], restrictTools: false };
  const budget = readThrashToolBudget;
  if (budget <= 0 || cumulativeExplorationTools <= 0) return out;

  if (cumulativeExplorationTools >= budget * 4) {
    pushMessage({
      role: 'user',
      content: [
        `EXPLORATION_BUDGET_EXHAUSTED: ${cumulativeExplorationTools} exploration tools used with no path to completion.`,
        'You must stop exploring and declare BLOCKED immediately.',
        'State what is missing (missing file, unclear API, unknown test command) and stop.',
        'Do not read any more files.',
      ].join('\n'),
    });
    out.restrictTools = true;
    out.fired.push('[Exploration exhausted: require BLOCKED declaration]');
  } else if (cumulativeExplorationTools >= budget * 3) {
    pushMessage({
      role: 'user',
      content: [
        `EXPLORATION_ESCALATION: ${cumulativeExplorationTools} exploration tools used.`,
        'You have spent significant effort reading without producing a fix.',
        'Within the next 2 turns you must either:',
        '1) Commit to a fix path — pick a file and mutate it',
        '2) Declare BLOCKED with a specific reason',
        'Further reading without action will be treated as BLOCKED.',
      ].join('\n'),
    });
    out.fired.push('[Exploration escalation: 2 turns to act or BLOCKED]');
  } else if (cumulativeExplorationTools >= budget * 2) {
    pushMessage({
      role: 'user',
      content: [
        `EXPLORATION_NUDGE: ${cumulativeExplorationTools} exploration tools used.`,
        'Consider whether you have enough context to start a fix.',
        'If you need more specific information, ask a targeted question rather than reading broadly.',
        'Otherwise, commit to a file and start mutating.',
      ].join('\n'),
    });
    out.fired.push('[Exploration nudge: consider acting]');
  }

  return out;
}

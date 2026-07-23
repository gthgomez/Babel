// ─── Phase Nudge Builder ────────────────────────────────────────────────────
// P2: Guides the model through investigate → mutate → verify phases by
// injecting targeted user messages when the model stalls in a phase.
// This is prompt-based nudging — the harness does not reject tool calls.

import type { StallState } from './stallDetector.js';

export type ChatPhase = 'investigate' | 'mutate' | 'verify' | 'escalate';

/**
 * Classify the agent control phase.
 *
 * Verify requires a real patch (`hasWrites`). Shell / pytest alone must not
 * advance to verify — that previously caused zero-write run_command thrash
 * (false "file changes detected" nudges + Pro routing).
 *
 * `hasVerifier` is retained for call-site compatibility and future sub-signals
 * but does not force verify without writes.
 */
export function classifyPhase(
  stallState: StallState,
  hasWrites: boolean,
  _hasVerifier: boolean,
): ChatPhase {
  // Wrote (with or without verifier yet) → verify / re-verify
  if (hasWrites) return 'verify';
  if (stallState.turnsSinceLastWrite >= 4) return 'escalate'; // stuck
  if (stallState.turnsSinceLastWrite >= 2) return 'mutate'; // read enough
  return 'investigate';
}

export function buildPhaseNudge(
  phase: ChatPhase,
  fileHints: string[],
  investigateModelConfigured?: boolean,
): string {
  const files = fileHints.filter(Boolean).slice(0, 3);
  const fileList = files.length > 0 ? files.join(', ') : 'the relevant source files';

  switch (phase) {
    case 'investigate': {
      const parts = [
        '[Phase: Investigate]',
        `Localize with read_file/read_range/grep on ${fileList}. Prefer file tools over shell.`,
        'Do not run full test suites yet — find the edit target first, then mutate.',
      ];
      if (investigateModelConfigured) {
        parts.push(
          'Use read_range for large files. Be thorough but cost-aware; move to str_replace as soon as the target is clear.',
        );
      }
      return parts.join(' ');
    }

    case 'mutate':
      return [
        '[Phase: Apply Changes]',
        `You have gathered enough context. Use str_replace (preferred) or write_file to apply the fix to ${fileList}.`,
        'Do not read more files — you have what you need.',
      ].join(' ');

    case 'verify':
      return [
        '[Phase: Verify]',
        'File changes detected. Now run the verifier (test_run or run_command)',
        'to confirm the fix works.',
      ].join(' ');

    case 'escalate':
      return [
        '[Phase: Escalate]',
        `You have not made file changes after several turns. The fix needs to go in ${fileList}.`,
        files.length > 0
          ? `Apply the fix with str_replace or write_file to ${files[0]} NOW.`
          : 'Apply the fix with str_replace or write_file NOW.',
      ].join(' ');

    default:
      return '';
  }
}

/** Whether a phase should trigger a nudge injection. */
export function shouldNudge(phase: ChatPhase): boolean {
  return phase === 'mutate' || phase === 'escalate' || phase === 'verify';
}

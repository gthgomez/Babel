/**
 * Bounded reflection loop on failed edits (Aider `max_reflections` pattern).
 *
 * When an edit fails to apply, the structured failure diagnostics already
 * flow back to the model in the tool observation; the model may retry. This
 * module bounds the retry loop: per file per turn, at most
 * MAX_EDIT_REFLECTION_ROUNDS failed rounds are reflected. Within the cap the
 * observation carries an explicit reflection note; once the cap is reached
 * the loop halts with an explicit failure surface — a failed edit is never
 * silently dropped.
 *
 * The retry itself always re-enters the same governed write path
 * (governedStrReplace / governedApplyPatch); reflection only annotates the
 * observation and bounds the rounds. Each retry settles through the normal
 * dispatch path, so operation.prepared / operation.settled facts are already
 * emitted per attempt — reflection adds no fact emission of its own.
 */

/** Maximum reflection rounds (failed-edit → feedback → retry) per file per turn. */
export const MAX_EDIT_REFLECTION_ROUNDS = 3

/** Observation heading of the terminal surface emitted when the cap is hit. */
export const EDIT_REFLECTION_CAP_MARKER = 'edit_reflection_cap'

export interface EditReflectionDecision {
  /** 1-based count of failed rounds for this file within the current turn. */
  round: number
  /** True when round reached the cap — no further reflection retries. */
  capped: boolean
}

/**
 * Per-file per-turn reflection counter. A turn is one owner submission
 * (generation); when a new turn key is observed the whole counter resets, and
 * a successful edit for a file clears that file's count immediately.
 */
export class EditReflectionTracker {
  private readonly rounds = new Map<string, number>()
  private lastTurnKey: string | number | null = null

  /** Record a failed edit round. Returns the round decision for the turn. */
  recordFailure(turnKey: string | number, filePath: string): EditReflectionDecision {
    if (this.lastTurnKey !== null && this.lastTurnKey !== turnKey) {
      this.rounds.clear()
    }
    this.lastTurnKey = turnKey
    const key = reflectionKey(filePath)
    const next = (this.rounds.get(key) ?? 0) + 1
    this.rounds.set(key, next)
    return { round: next, capped: next >= MAX_EDIT_REFLECTION_ROUNDS }
  }

  /** Clear the counter for a file after a successful edit. */
  recordSuccess(turnKey: string | number, filePath: string): void {
    if (this.lastTurnKey !== null && this.lastTurnKey !== turnKey) {
      this.rounds.clear()
      this.lastTurnKey = turnKey
    }
    this.rounds.delete(reflectionKey(filePath))
  }

  /** Current failed-round count (diagnostics / tests). */
  roundsFor(filePath: string): number {
    return this.rounds.get(reflectionKey(filePath)) ?? 0
  }
}

function reflectionKey(filePath: string): string {
  return filePath.replace(/\\/g, '/').toLowerCase()
}

/**
 * Reflection feedback appended to a failed-edit observation while under the
 * cap. The failure diagnostics above it remain authoritative; this note only
 * makes the bounded-retry contract explicit to the model.
 */
export function formatEditReflectionNote(decision: EditReflectionDecision): string {
  const remaining = MAX_EDIT_REFLECTION_ROUNDS - decision.round
  return (
    `### edit_reflection\n` +
    `Edit failed to apply (reflection round ${decision.round}/${MAX_EDIT_REFLECTION_ROUNDS}). ` +
    `Use the failure diagnostics above to correct the anchor and retry the same edit. ` +
    (remaining > 0
      ? `${remaining} reflection round${remaining === 1 ? '' : 's'} remain${remaining === 1 ? 's' : ''} for this file this turn.`
      : `This was the last reflection round for this file this turn.`)
  )
}

/**
 * Terminal surface after the reflection cap: the loop stops retrying and the
 * failure is surfaced explicitly (never silently dropped). The original
 * failed-edit observation is embedded so no diagnostic is lost.
 */
export function formatEditReflectionCapSurface(
  filePath: string,
  lastFailureObservation: string,
): string {
  return (
    `### ${EDIT_REFLECTION_CAP_MARKER} ${filePath}\n` +
    `Edit failed to apply after ${MAX_EDIT_REFLECTION_ROUNDS} reflection rounds. ` +
    `Automatic retries for this file are stopped for this turn.\n\n` +
    lastFailureObservation
  )
}

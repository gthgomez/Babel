/**
 * Snapshot a one-shot tool restriction once per logical model turn so
 * native, text, stream, and retry paths cannot consume it twice.
 */

export interface OneShotPolicySnapshot<T> {
  taken: boolean
  value?: T
}

export function snapshotOnce<T>(slot: OneShotPolicySnapshot<T>, compute: () => T): T {
  if (!slot.taken) {
    slot.value = compute()
    slot.taken = true
  }
  return slot.value as T
}

export function resetOneShotSnapshot<T>(slot: OneShotPolicySnapshot<T>): void {
  slot.taken = false
  delete slot.value
}

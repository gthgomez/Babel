// License: Apache-2.0 - see LICENSE
import { parseRequiredTapInventory } from './summarize_required_tap.mjs'

/**
 * Whole-stream gate: never trim TAP (a trailing passing stream must not hide an
 * earlier failed stream). Inventory rejects duplicate/missing TAP version headers.
 */
export function requiredTapSuiteGate(suite, stdout, childResult = {}) {
  const tap = stdout ?? ''
  const inventory = parseRequiredTapInventory(tap, suite)
  const childSpawnError = childResult.error ?? null
  const childSignal = childResult.signal ?? null
  const childExitCode = childResult.status
  const childFailed =
    childSpawnError != null ||
    childSignal != null ||
    childExitCode !== 0
  const inventoryFailed =
    inventory.status === 'failed' ||
    inventory.failed > 0 ||
    (inventory.status !== 'complete' && inventory.errors.length > 0)
  return {
    tap,
    inventory,
    childFailed,
    inventoryFailed,
    failed: childFailed || inventoryFailed,
    childSpawnError,
    childSignal,
    childExitCode,
  }
}

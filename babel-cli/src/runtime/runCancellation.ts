/** Run-local cancellation follows asynchronous stages without changing authority. */
import { AsyncLocalStorage } from 'node:async_hooks'

const signals = new AsyncLocalStorage<AbortSignal>()

/** A child signal can add cancellation, never replace its parent's stop signal. */
export function getRunAbortSignal(local?: AbortSignal): AbortSignal | undefined {
  const parent = signals.getStore()
  return parent && local && parent !== local ? AbortSignal.any([parent, local]) : local ?? parent
}

/** Bind the owning signal to this run and its asynchronous continuations only. */
export function withRunCancellation<T>(signal: AbortSignal | undefined, run: () => T): T {
  const effective = getRunAbortSignal(signal)
  if (!effective) return run()
  effective.throwIfAborted()
  return signals.run(effective, run)
}

/** Recheck cancellation immediately before admitting another request or effect. */
export function throwIfRunAborted(): void {
  signals.getStore()?.throwIfAborted()
}

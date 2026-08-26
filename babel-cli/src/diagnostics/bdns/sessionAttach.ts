/** Session-owned BDNS attach point. Canonical flush must not await this work. */

import { createBdnsRuntime, type BdnsRuntime } from './runtime.js'

export interface BdnsSessionAttachInput {
  sessionId: string
  runDir: string
  workspaceRoot?: string
  close?: boolean
}

const runtimes = new Map<string, BdnsRuntime>()
const inflight = new Map<string, Promise<void>>()

/**
 * Create or reuse the session BDNS runtime, then persist a bounded bundle.
 *
 * @param input Session identity, run directory, and optional close
 * @returns Persistence work; callers on the canonical path must not await it
 */
export function bindBdnsAfterCanonicalFlush(input: BdnsSessionAttachInput): Promise<void> {
  const previous = inflight.get(input.sessionId) ?? Promise.resolve()
  const work = previous
    .catch(() => undefined)
    .then(async () => {
      let runtime = runtimes.get(input.sessionId)
      if (input.close) {
        if (!runtime) return
        await runtime.close()
        runtimes.delete(input.sessionId)
        return
      }
      if (!runtime) {
        runtime = createBdnsRuntime({
          runDir: input.runDir,
          sessionId: input.sessionId,
          workspaceRoot: input.workspaceRoot ?? process.env['BABEL_PROJECT_ROOT'] ?? process.cwd(),
        })
        runtimes.set(input.sessionId, runtime)
      }
      await runtime.flushPersistence()
    })
    .catch(() => undefined)
  inflight.set(input.sessionId, work)
  return work
}

/**
 * Await in-flight BDNS persistence for tests. Not a canonical execution path.
 *
 * @param sessionId Session id used when attaching
 */
export function waitForBdnsSession(sessionId: string): Promise<void> {
  return inflight.get(sessionId) ?? Promise.resolve()
}

/**
 * Dispose every attached runtime. Tests only.
 */
export async function closeAllBdnsSessions(): Promise<void> {
  const pending = [...runtimes.entries()].map(async ([sessionId, runtime]) => {
    try {
      await runtime.close()
    } catch {
      /* fail-soft */
    }
    runtimes.delete(sessionId)
  })
  await Promise.all(pending)
  inflight.clear()
}

/**
 * Snapshot whether a session currently owns an attached runtime.
 *
 * @param sessionId Session id
 * @returns True when a runtime is live
 */
export function hasAttachedBdnsSession(sessionId: string): boolean {
  return runtimes.has(sessionId)
}

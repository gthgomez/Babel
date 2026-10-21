import { FixtureResearchModelBridge } from '../../model/fixtureModelBridge.js'
import type { ResearchModelPort } from '../../ports/researchModelPort.js'

/** Resolves once the injected model's first `invokeStructured` entry (deterministic cancel timing). */
export class ModelEntryLatch {
  private readonly resolveEntry: () => void
  private readonly entryPromise: Promise<void>

  constructor() {
    let resolve!: () => void
    this.entryPromise = new Promise<void>((r) => {
      resolve = r
    })
    this.resolveEntry = resolve
  }

  markModelEntered(): void {
    this.resolveEntry()
  }

  waitForModelEntry(timeoutMs = 10_000): Promise<void> {
    return Promise.race([
      this.entryPromise,
      new Promise<void>((_, reject) => {
        setTimeout(() => reject(new Error('timed out waiting for model invokeStructured entry')), timeoutMs)
      }),
    ])
  }
}

async function waitUntilAbortOrContinue(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return
  await new Promise<void>((resolve) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }
    signal.addEventListener('abort', onAbort)
  })
}

/** Blocks in model invoke until `signal` aborts, then returns cancelled (offline lifecycle tests). */
export class BlockingUntilAbortModel implements ResearchModelPort {
  constructor(
    private readonly latch?: ModelEntryLatch,
    private readonly inner = new FixtureResearchModelBridge(),
  ) {}

  async invokeStructured(request: Parameters<ResearchModelPort['invokeStructured']>[0]) {
    this.latch?.markModelEntered()
    await waitUntilAbortOrContinue(request.signal)
    if (request.signal.aborted) {
      return {
        status: 'cancelled' as const,
        operationId: request.operationId,
        usageSettlement: { attempt_id: request.attemptId, cost: { status: 'unknown' as const } },
      }
    }
    return this.inner.invokeStructured(request)
  }
}

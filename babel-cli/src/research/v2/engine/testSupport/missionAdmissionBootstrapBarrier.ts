/**
 * Deterministic pause between mission admission and bootstrap shell in mission runner tests.
 */
export class MissionAdmissionBootstrapBarrier {
  private entered = false
  private releaseWaiters: Array<() => void> = []

  /** Runner test seam: block until {@link release} is called. */
  async afterMissionAdmitted(): Promise<void> {
    this.entered = true
    await new Promise<void>((resolve) => {
      this.releaseWaiters.push(resolve)
    })
  }

  /** Poll until the runner has admitted the mission and is blocked on the seam. */
  async waitUntilBlocked(): Promise<void> {
    for (let i = 0; i < 200; i += 1) {
      if (this.entered) return
      await new Promise((r) => setTimeout(r, 5))
    }
    throw new Error('mission admission bootstrap barrier: runner never entered seam')
  }

  release(): void {
    for (const resolve of this.releaseWaiters) {
      resolve()
    }
    this.releaseWaiters = []
  }
}

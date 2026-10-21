/** Serializes async work on one durable store instance (same-handle concurrency). */
export class MutationQueue {
  private tail: Promise<void> = Promise.resolve()
  private closed = false

  enqueue<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error('durable research store is closed'))
    }
    const next = this.tail.then(work)
    this.tail = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  async drain(): Promise<void> {
    this.closed = true
    await this.tail
  }
}

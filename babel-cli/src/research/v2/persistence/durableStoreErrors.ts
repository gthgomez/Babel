export class DurableStoreBusyError extends Error {
  constructor(message = 'research store directory is already open elsewhere') {
    super(message)
    this.name = 'DurableStoreBusyError'
  }
}

export class DurableStoreSnapshotError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DurableStoreSnapshotError'
  }
}

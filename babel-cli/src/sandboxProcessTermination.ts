/**
 * Deferred async spawn child-tree termination latches shared by SafeExecutor
 * and spawnCommandAsync.
 */

/**
 * Deferred child-tree terminations requested by aborted async spawns.
 *
 * Cancel settles the tool result before the tree kill so Windows cancel latency
 * is not dominated by `taskkill`. A caller that immediately removes the child's
 * working tree must first await this latch, otherwise the still-live child can
 * hold the directory on Windows and fail the delete with EBUSY.
 */
export class ProcessTerminationError extends Error {
  readonly code = 'PROCESS_TERMINATION_FAILED'

  constructor(readonly ownerId: string, readonly executionId: string, cause: unknown) {
    super(`Process ${executionId} for ${ownerId} did not terminate cleanly`, { cause })
    this.name = 'ProcessTerminationError'
  }
}

const pendingProcessTerminations = new Map<number, { ownerId: string; promise: Promise<void> }>()
const failedProcessTerminations = new Map<number, ProcessTerminationError>()
let processTerminationSequence = 0

/** Retain a deferred closure result until the initiating owner acknowledges it. */
export function registerPendingProcessTermination(
  termination: Promise<void>,
  ownerId: string,
  executionId: string,
): void {
  const id = ++processTerminationSequence
  pendingProcessTerminations.set(id, { ownerId, promise: termination })
  void termination.then(
    () => { pendingProcessTerminations.delete(id) },
    (cause: unknown) => {
      pendingProcessTerminations.delete(id)
      failedProcessTerminations.set(id, new ProcessTerminationError(ownerId, executionId, cause))
    },
  )
}

/** Resolve once every deferred abort-path child-tree termination has closed. */
export async function awaitPendingProcessTerminations(ownerId?: string): Promise<void> {
  await Promise.allSettled(
    [...pendingProcessTerminations.values()]
      .filter((pending) => ownerId === undefined || pending.ownerId === ownerId)
      .map((pending) => pending.promise),
  )
  const failures = [...failedProcessTerminations.entries()]
    .filter(([, failure]) => ownerId === undefined || failure.ownerId === ownerId)
  for (const [id] of failures) failedProcessTerminations.delete(id)
  if (failures.length === 1) throw failures[0]![1]
  if (failures.length > 1) {
    throw new AggregateError(failures.map(([, failure]) => failure),
      'Multiple deferred process terminations failed')
  }
}

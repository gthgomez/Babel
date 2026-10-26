/** One-way submission control. Admission here never grants effects or proves success. */
export type RunIdentity = Readonly<{ runId: string; turnId: string; generation: number }>
export type StopKind = 'completed' | 'blocked' | 'failed' | 'cancelled' | 'budget_exhausted' | 'superseded'
export type StopRequest = Readonly<{
  owner: RunIdentity
  kind: StopKind
  reasonCode: string
  source: 'executor' | 'completion' | 'budget' | 'user' | 'supersession' | 'runtime'
  prerequisiteKey?: string
}>
export type DispatchRequest = Readonly<{ owner: RunIdentity; operationId: string; kind: 'model' | 'tool' }>
export type DispatchResult<T> = { kind: 'started'; value: T } | { kind: 'not_started'; stop: StopRequest }
export interface RunControl {
  readonly owner: RunIdentity
  readonly signal: AbortSignal
  stop(): StopRequest | null
  requestStop(request: StopRequest): boolean
  dispatchIfRunning<T>(request: DispatchRequest, start: () => Promise<T>): Promise<DispatchResult<T>>
}

/** Host evidence that the supplied start callback was never invoked. */
export class RunStoppedError extends Error {
  constructor(readonly stopRequest: StopRequest) {
    super('RUN_STOPPED_BEFORE_DISPATCH')
    this.name = 'RunStoppedError'
  }
}

/** Shared final boundary for transports that report a rejected start by exception. */
export async function dispatchRunOperation<T>(control: RunControl | undefined, kind: DispatchRequest['kind'], operationId: string, start: () => Promise<T>): Promise<T> {
  if (!control) return start()
  const result = await control.dispatchIfRunning({ owner: control.owner, kind, operationId }, start)
  if (result.kind === 'not_started') throw new RunStoppedError(result.stop)
  return result.value
}

function sameOwner(a: RunIdentity, b: RunIdentity): boolean {
  return a.runId === b.runId && a.turnId === b.turnId && a.generation === b.generation
}

/** Prepare/approve/persist first, then invoke this final synchronous dispatch check. */
export function createRunControl(input: RunIdentity): RunControl {
  if (!input.runId || !input.turnId || !Number.isSafeInteger(input.generation) || input.generation < 1) throw new Error('Invalid run control owner')
  const owner: RunIdentity = Object.freeze({ runId: input.runId, turnId: input.turnId, generation: input.generation })
  const controller = new AbortController()
  let winningStop: StopRequest | null = null
  const control: RunControl = {
    owner,
    signal: controller.signal,
    stop: () => winningStop,
    requestStop(request) {
      if (!sameOwner(request.owner, owner) || winningStop) return false
      winningStop = Object.freeze({ owner, kind: request.kind, reasonCode: request.reasonCode, source: request.source,
        ...(request.prerequisiteKey !== undefined ? { prerequisiteKey: request.prerequisiteKey } : {}),
      })
      controller.abort(winningStop)
      return true
    },
    async dispatchIfRunning<T>(request: DispatchRequest, start: () => Promise<T>): Promise<DispatchResult<T>> {
      if (!sameOwner(request.owner, owner)) return { kind: 'not_started', stop: Object.freeze({
        owner: Object.freeze({ ...request.owner }), kind: 'superseded', reasonCode: 'dispatch_owner_mismatch', source: 'supersession',
      }) }
      if (winningStop) return { kind: 'not_started', stop: winningStop }
      // No await before start: an accepted stop cannot slip between this check
      // and the physical operation. Started work still settles to its owner.
      const pending = start()
      return { kind: 'started', value: await pending }
    },
  }
  return Object.freeze(control)
}

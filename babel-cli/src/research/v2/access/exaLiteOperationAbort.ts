import { AdmittedNetworkPolicyError } from './admittedHttpGet.js'

export class ExaLiteCallerAbortError extends Error {
  constructor(message = 'search cancelled by caller') {
    super(message)
    this.name = 'ExaLiteCallerAbortError'
  }
}

export class ExaLiteOperationDeadlineError extends Error {
  constructor(message = 'operation deadline exceeded') {
    super(message)
    this.name = 'ExaLiteOperationDeadlineError'
  }
}

export interface LinkedOperationAbort {
  signal: AbortSignal
  dispose: () => void
}

export function operationErrorFromAbortSignal(signal: AbortSignal): Error {
  if (!signal.aborted) {
    return new AdmittedNetworkPolicyError('search aborted')
  }
  const reason = signal.reason
  if (reason instanceof ExaLiteOperationDeadlineError) {
    return reason
  }
  return new ExaLiteCallerAbortError()
}

/** Links user abort + wall-clock deadline into one signal that tears down transport work. */
export function createLinkedOperationAbort(
  userSignal: AbortSignal,
  deadlineMs: number,
): LinkedOperationAbort {
  const controller = new AbortController()
  const onUserAbort = () => {
    controller.abort(new ExaLiteCallerAbortError())
  }
  if (userSignal.aborted) {
    onUserAbort()
  } else {
    userSignal.addEventListener('abort', onUserAbort, { once: true })
  }
  const timer = setTimeout(() => {
    controller.abort(new ExaLiteOperationDeadlineError())
  }, deadlineMs)
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer)
      userSignal.removeEventListener('abort', onUserAbort)
    },
  }
}

export function assertOperationSignalActive(signal: AbortSignal, stage: string): void {
  if (signal.aborted) {
    throw operationErrorFromAbortSignal(signal)
  }
}

/**
 * Races `work` against linked-signal abort. Late `work` settlement is consumed and ignored.
 * Does not cancel in-flight OS DNS; only stops awaiting and blocks downstream dispatch.
 */
export function awaitWithLinkedOperationSignal<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(operationErrorFromAbortSignal(signal))
  }
  return new Promise((resolve, reject) => {
    let settled = false
    const onAbort = () => {
      if (settled) return
      settled = true
      reject(operationErrorFromAbortSignal(signal))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      (value) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        if (signal.aborted) {
          reject(operationErrorFromAbortSignal(signal))
          return
        }
        resolve(value)
      },
      (err) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
}

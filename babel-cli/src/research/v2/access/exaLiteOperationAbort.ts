import { AdmittedNetworkPolicyError } from './admittedHttpGet.js'

export interface LinkedOperationAbort {
  signal: AbortSignal
  dispose: () => void
}

/** Links user abort + wall-clock deadline into one signal that tears down transport work. */
export function createLinkedOperationAbort(
  userSignal: AbortSignal,
  deadlineMs: number,
): LinkedOperationAbort {
  const controller = new AbortController()
  const onUserAbort = () => {
    controller.abort(userSignal.reason ?? new AdmittedNetworkPolicyError('search aborted'))
  }
  if (userSignal.aborted) {
    onUserAbort()
  } else {
    userSignal.addEventListener('abort', onUserAbort, { once: true })
  }
  const timer = setTimeout(() => {
    controller.abort(new AdmittedNetworkPolicyError('operation deadline exceeded'))
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
    throw new AdmittedNetworkPolicyError(`${stage} aborted`)
  }
}

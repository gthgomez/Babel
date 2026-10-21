import { PDF_DESTROY_BOUND_MS, PdfExtractionCancelled, throwIfPdfAborted } from './pdfExtractionLimits.js'

export type PdfLoadingTaskLike = {
  promise: Promise<unknown>
  destroy: () => void | Promise<void>
}

export function consumeLateRejection(promise: Promise<unknown>): void {
  void promise.catch(() => {
    /* absorb after cancellation or bounded cleanup */
  })
}

export function invokePdfDestroy(destroy: () => void | Promise<void>): void {
  let result: void | Promise<void>
  try {
    result = destroy()
  } catch (error) {
    consumeLateRejection(Promise.reject(error))
    return
  }
  if (result !== undefined && result !== null && typeof (result as Promise<void>).then === 'function') {
    consumeLateRejection(result as Promise<void>)
  }
}

export async function awaitBoundedDestroy(
  destroy: () => Promise<void>,
  boundMs: number = PDF_DESTROY_BOUND_MS,
): Promise<void> {
  const pending = destroy()
  consumeLateRejection(pending)
  await Promise.race([
    pending.then(
      () => undefined,
      () => undefined,
    ),
    new Promise<void>((resolve) => setTimeout(resolve, boundMs)),
  ])
}

export async function destroyLoadingTask(loadingTask: PdfLoadingTaskLike | null): Promise<void> {
  if (!loadingTask) return
  let result: void | Promise<void>
  try {
    result = loadingTask.destroy()
  } catch (error) {
    consumeLateRejection(Promise.reject(error))
    return
  }
  if (result !== undefined && result !== null && typeof (result as Promise<void>).then === 'function') {
    const pending = result as Promise<void>
    consumeLateRejection(pending)
    await Promise.race([
      pending.then(
        () => undefined,
        () => undefined,
      ),
      new Promise<void>((resolve) => setTimeout(resolve, PDF_DESTROY_BOUND_MS)),
    ])
  }
}

export async function awaitWithPdfAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
  onAbort?: () => void | Promise<void>,
): Promise<T> {
  throwIfPdfAborted(signal)
  if (!signal) return promise

  return new Promise<T>((resolve, reject) => {
    const finish = (handler: () => void) => {
      signal.removeEventListener('abort', onAbortHandler)
      handler()
    }

    const onAbortHandler = () => {
      try {
        const cleanup = onAbort?.()
        if (
          cleanup !== undefined &&
          cleanup !== null &&
          typeof (cleanup as Promise<void>).then === 'function'
        ) {
          consumeLateRejection(cleanup as Promise<void>)
        }
      } catch {
        /* best-effort */
      }
      finish(() => reject(new PdfExtractionCancelled()))
    }

    if (signal.aborted) {
      onAbortHandler()
      return
    }

    signal.addEventListener('abort', onAbortHandler, { once: true })
    consumeLateRejection(promise)
    promise.then(
      (value) => {
        finish(() => {
          try {
            throwIfPdfAborted(signal)
            resolve(value)
          } catch (error) {
            reject(error)
          }
        })
      },
      (error) => finish(() => reject(error)),
    )
  })
}

export function mergeAbortSignals(
  userSignal?: AbortSignal,
  deadlineMs?: number,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController()
  const disposers: Array<() => void> = []

  const attach = (source: AbortSignal) => {
    if (source.aborted) {
      controller.abort(source.reason)
      return
    }
    const onAbort = () => controller.abort(source.reason)
    source.addEventListener('abort', onAbort)
    disposers.push(() => source.removeEventListener('abort', onAbort))
  }

  if (userSignal) attach(userSignal)
  if (deadlineMs !== undefined && deadlineMs > 0) {
    attach(AbortSignal.timeout(deadlineMs))
  }

  if (disposers.length === 0) {
    return { signal: controller.signal, dispose: () => {} }
  }

  return {
    signal: controller.signal,
    dispose: () => {
      for (const disposeListener of disposers) disposeListener()
    },
  }
}

export async function destroyPdfResources(
  doc: { destroy: () => Promise<void> } | null,
  loadingTask: PdfLoadingTaskLike | null,
): Promise<void> {
  if (doc) {
    await awaitBoundedDestroy(() => doc.destroy())
  }
  await destroyLoadingTask(loadingTask)
}

import { PdfExtractionCancelled, throwIfPdfAborted } from './pdfExtractionLimits.js'

export function consumeLateRejection(promise: Promise<unknown>): void {
  void promise.catch(() => {
    /* absorb after cancellation */
  })
}

export async function awaitWithPdfAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
  onAbort?: () => void,
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
        onAbort?.()
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
  const sources: AbortSignal[] = []
  if (userSignal) sources.push(userSignal)
  if (deadlineMs !== undefined && deadlineMs > 0) {
    sources.push(AbortSignal.timeout(deadlineMs))
  }
  if (sources.length === 0) {
    return { signal: controller.signal, dispose: () => {} }
  }

  const forward = (source: AbortSignal) => {
    if (source.aborted) controller.abort(source.reason)
    else {
      source.addEventListener(
        'abort',
        () => controller.abort(source.reason),
        { once: true },
      )
    }
  }
  for (const source of sources) forward(source)

  return {
    signal: controller.signal,
    dispose: () => {
      /* listeners are once; scope ends with extraction */
    },
  }
}

export async function destroyPdfResources(
  doc: { destroy: () => Promise<void> } | null,
  loadingTask: { destroy: () => void } | null,
): Promise<void> {
  if (doc) {
    try {
      await doc.destroy()
    } catch {
      /* best-effort */
    }
  }
  if (loadingTask) {
    try {
      loadingTask.destroy()
    } catch {
      /* best-effort */
    }
  }
}

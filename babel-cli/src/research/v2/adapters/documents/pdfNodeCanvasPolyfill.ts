/** pdfjs 5.x expects DOMMatrix in Node; load @napi-rs/canvas before pdfjs-dist. */
let canvasRuntimeReady: Promise<void> | undefined

export function ensurePdfJsNodeCanvasRuntime(): Promise<void> {
  if (!canvasRuntimeReady) {
    canvasRuntimeReady = import('@napi-rs/canvas').then(() => undefined)
  }
  return canvasRuntimeReady
}

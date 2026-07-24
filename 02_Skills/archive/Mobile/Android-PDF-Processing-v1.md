<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: Android PDF Processing — Platform APIs (v1.0)

**Category:** Mobile
**Status:** Active
**Pairs with:** `domain_android_kotlin`, `skill_android_saf`
**Activation:** Load for any task that reads, renders, compresses, or produces PDF files
using `android.graphics.pdf.PdfRenderer` or `android.graphics.pdf.PdfDocument`. Also load
when writing tests for a PDF processing engine.

---

## Purpose

`PdfRenderer` and `PdfDocument` are Android platform APIs available since API 21/19
respectively. They rasterize PDF pages to `Bitmap` and allow constructing new PDFs
page-by-page. They are powerful but have four silent failure modes:

1. `PdfRenderer` requires a **seekable** file descriptor — passing a content URI's FD
   directly crashes at runtime. The URI must first be copied to a temp file.
2. Rendered pages have a **transparent background by default** — without erasing the
   canvas to white, the output PDF has black pages.
3. **OutOfMemoryError** is not a standard exception — it is a `Throwable` and bypasses
   normal `try/catch(Exception)` blocks. Each bitmap must be explicitly recycled and OOM
   must be caught separately.
4. `PdfDocument` page numbering is **1-indexed** — passing `pageNumber = 0` to
   `PageInfo.Builder` produces a corrupt PDF on some devices.

This skill converts those silent failure modes into explicit implementation requirements.

---

## Step 1 — PDFRENDERER CONTRACT

`PdfRenderer` wraps a PDF file and opens its pages one at a time for rendering.

**API contract:**

```
PdfRenderer(ParcelFileDescriptor)
  └── openPage(pageIndex: Int): PdfRenderer.Page   // 0-indexed
        └── render(bitmap, null, null, renderMode)
        └── close()
  └── pageCount: Int
  └── close()
```

**Requirements before constructing:**

| Requirement | Consequence if violated |
|------------|------------------------|
| FD must be seekable | `IllegalArgumentException` or rendering corruption |
| File must not be password-protected | Constructor throws `IOException` ("File has bad magic") |
| File must be a valid PDF | Constructor throws `IOException` |

**Encrypted PDF detection:**

```kotlin
val renderer = try {
    PdfRenderer(pfd)
} catch (e: IOException) {
    pfd.close()
    return PdfEngineResult.Failure(PdfFailure.InvalidFile)
} catch (e: Exception) {
    pfd.close()
    return PdfEngineResult.Failure(PdfFailure.InvalidFile)
}
```

**Rule:** Always wrap `PdfRenderer(pfd)` in try/catch. Any exception from the constructor
means the file is invalid, encrypted, or corrupt. Surface `InvalidFile` — never re-throw.

---

## Step 2 — PAGE RENDERING PIPELINE

Each page is rendered to a `Bitmap` at a target resolution. The target DPI determines
output quality and memory usage.

**DPI to pixel size conversion:**

```kotlin
// page.width and page.height are in PostScript points (1 pt = 1/72 inch)
val bitmapWidth  = (page.width  * dpi / 72f).toInt().coerceAtLeast(1)
val bitmapHeight = (page.height * dpi / 72f).toInt().coerceAtLeast(1)
```

**Common DPI values and their trade-offs:**

| DPI | Quality | Bitmap memory (A4) | Use case |
|-----|---------|-------------------|----------|
| 72  | Readable but degraded | ~3.5 MB | Last-resort compression attempt |
| 100 | Acceptable for most docs | ~6.8 MB | Aggressive compression |
| 150 | Good — most PDFs land here | ~15 MB | Default quality |
| 300 | Print quality | ~62 MB | Never for compression — OOM risk |

**White background is not automatic:**

```kotlin
val bitmap = Bitmap.createBitmap(bitmapWidth, bitmapHeight, Bitmap.Config.ARGB_8888)
bitmap.eraseColor(android.graphics.Color.WHITE)  // ← required
page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
page.close()
```

**Render modes:**

| Mode | When to use |
|------|-------------|
| `RENDER_MODE_FOR_DISPLAY` | App display and compression output — RGB color, screen-accurate |
| `RENDER_MODE_FOR_PRINT` | High-fidelity print output — CMYK processing, higher memory usage |

**Rule:** Always call `bitmap.eraseColor(Color.WHITE)` before `page.render()`. Transparent
pages render as black in the output PDF.

---

## Step 3 — OOM GUARD PROTOCOL

Processing a multi-page PDF allocates one `Bitmap` per page. At 150 DPI, an A4 page is
~15 MB. A 50-page document renders ~750 MB total if bitmaps are not freed between pages.
`OutOfMemoryError` kills the process on low-RAM devices without any warning.

**Required pattern for every page:**

```kotlin
var renderBitmap: Bitmap? = null
var jpegBitmap: Bitmap? = null

try {
    renderBitmap = try {
        Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
            .also { it.eraseColor(Color.WHITE) }
    } catch (e: OutOfMemoryError) {
        page.close()
        return false  // caller maps this to ProcessingFailed
    }

    page.render(renderBitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
    page.close()

    // JPEG round-trip (see Step 4)
    val baos = ByteArrayOutputStream()
    renderBitmap.compress(Bitmap.CompressFormat.JPEG, quality, baos)
    renderBitmap.recycle()  // ← free immediately after compress
    renderBitmap = null

    jpegBitmap = try {
        BitmapFactory.decodeByteArray(baos.toByteArray(), 0, baos.size()) ?: return false
    } catch (e: OutOfMemoryError) {
        return false
    }

    // draw to PdfDocument ...

} finally {
    renderBitmap?.recycle()  // safety net if exception escaped the inner try
    jpegBitmap?.recycle()
}
```

**Rules:**
- Call `bitmap.recycle()` immediately after use — do not wait for GC.
- Catch `OutOfMemoryError` separately from `Exception`. OOM is a `Throwable`, not an
  `Exception`. A `catch(e: Exception)` block does NOT catch OOM.
- Call `page.close()` as soon as rendering is done — before the JPEG step — to release
  the page's native memory.
- Wrap the entire processing function in `catch (e: OutOfMemoryError)` as a final safety net.

---

## Step 4 — JPEG ROUND-TRIP COMPRESSION

`PdfDocument` does not apply compression to page content by default. Drawing a raw
`Bitmap` onto a `PdfDocument` page produces a large uncompressed output file.

**The JPEG round-trip technique reduces file size significantly:**

1. Render the page to a `Bitmap` at target DPI.
2. Compress the `Bitmap` to JPEG bytes at a target quality (0–100).
3. Decode the JPEG bytes back to a `Bitmap`.
4. Draw the decoded (now JPEG-reduced) `Bitmap` onto the `PdfDocument` page.

```kotlin
// Step 2: compress to JPEG bytes
val baos = ByteArrayOutputStream()
renderBitmap.compress(Bitmap.CompressFormat.JPEG, jpegQuality, baos)
renderBitmap.recycle()

// Step 3: decode back
val jpegBitmap = BitmapFactory.decodeByteArray(baos.toByteArray(), 0, baos.size())

// Step 4: draw onto PdfDocument at original PostScript dimensions
val pageInfo = PdfDocument.PageInfo.Builder(pageWidthPts, pageHeightPts, pageNumber).create()
val pdfPage = pdfDocument.startPage(pageInfo)
val scaleX = pageWidthPts.toFloat() / jpegBitmap.width
val scaleY = pageHeightPts.toFloat() / jpegBitmap.height
pdfPage.canvas.drawBitmap(jpegBitmap, Matrix().apply { setScale(scaleX, scaleY) }, Paint())
pdfDocument.finishPage(pdfPage)
```

**Quality / DPI ladder (compress to meet a target file size):**

```kotlin
private val compressionAttempts = listOf(
    Pair(150, 85),  // high quality — most docs meet Email target here
    Pair(150, 65),  // same resolution, lower JPEG quality
    Pair(100, 75),  // reduced DPI — noticeable quality drop, still readable
    Pair(72,  60),  // aggressive — last resort before FileTooLarge
)
```

**Trade-off disclosure:** The JPEG round-trip strips PDF text vectors and replaces them with
pixel data. The output is image-based — text is no longer selectable. This must be disclosed
in the app's store listing and in the UI (per PRODUCT_DOC requirements).

---

## Step 5 — PDFDOCUMENT CONTRACT

`PdfDocument` is the write-side counterpart to `PdfRenderer`. It constructs a PDF page by page.

**Lifecycle contract:**

```
PdfDocument()
  └── startPage(PageInfo): PdfDocument.Page
        └── page.canvas: Canvas       // draw here
        └── [must call finishPage before next startPage]
  └── finishPage(page)
  └── writeTo(outputStream)
  └── close()                         // must always be called — leaks native memory if skipped
```

**Critical rules:**

| Rule | Consequence if violated |
|------|------------------------|
| `finishPage()` must be called before `startPage()` for the next page | `IllegalStateException` |
| Page numbers are 1-indexed | `pageNumber = 0` causes corrupt PDF on some devices |
| `close()` must always be called | Native memory leak — not caught by GC |
| `writeTo()` must be called before `close()` | Calling after close throws `IllegalStateException` |

**Write pattern:**

```kotlin
val pdfDocument = PdfDocument()
try {
    for (i in 0 until pageCount) {
        val pageInfo = PdfDocument.PageInfo.Builder(widthPts, heightPts, i + 1).create()
        val page = pdfDocument.startPage(pageInfo)
        // draw content to page.canvas
        pdfDocument.finishPage(page)
    }
    outputFile.outputStream().use { pdfDocument.writeTo(it) }
} finally {
    pdfDocument.close()  // always in finally
}
```

---

## Step 6 — PROGRESS REPORTING AND ANR PREVENTION

PDF processing runs on `Dispatchers.IO` but progress updates must reach the UI.

**The `onProgress` callback is called from the IO thread.** Compose's `mutableStateOf`
is thread-safe for reads and writes, so ViewModel state can be updated directly from the
callback without explicit `withContext(Dispatchers.Main)`:

```kotlin
// In ViewModel:
val result = engine.compress(
    context = appContext,
    uri = uri,
    targetMaxBytes = targetBytes,
    onProgress = { progress ->
        uiState = uiState.copy(processingProgress = progress)
        // mutableStateOf is safe to write from any thread
    }
)
```

**Progress frequency:** Emit after each page. For a 50-page PDF this is 50 updates — acceptable.
Do not throttle for normal document sizes. For 500+ page documents, throttle to every 5 pages.

**ANR risk:** `Dispatchers.IO` prevents ANR. Never call `page.render()` on the main thread —
rendering a large page at 150 DPI can take 200–500 ms.

---

## Hard Rules

1. Never pass a content URI directly to `PdfRenderer`. Copy to a temp file first (see
   `skill_android_saf` Step 2).
2. Never skip `bitmap.eraseColor(Color.WHITE)`. Transparent PDF pages render black.
3. Never catch only `Exception` for OOM protection. `OutOfMemoryError` is a `Throwable` —
   catch it explicitly in every bitmap allocation site.
4. Never call `bitmap.recycle()` after passing the bitmap to a `Canvas.drawBitmap()` call
   that hasn't been committed yet. Recycle only after `finishPage()`.
5. Never pass `pageNumber = 0` to `PdfDocument.PageInfo.Builder`. Page numbers are
   1-indexed — start at `i + 1`.
6. Never call `pdfDocument.writeTo()` after `pdfDocument.close()`. Always write in the
   `try` block, close in the `finally` block.
7. Never render at DPI > 200 in a compression pipeline. The bitmap size grows as DPI²;
   300 DPI is 4× the memory of 150 DPI and produces no benefit for a compression use case.
8. Never run `page.render()` on the main thread. It blocks for hundreds of milliseconds on
   large pages and causes ANR on slow devices.

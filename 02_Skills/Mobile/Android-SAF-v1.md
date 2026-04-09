<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: Android Storage Access Framework (v1.0)

**Category:** Mobile
**Status:** Active
**Pairs with:** `domain_android_kotlin`
**Activation:** Load for any task that touches file picking, document saving, file sharing,
FileProvider, content URIs, ContentResolver, or any `ActivityResultContracts.*Document*` usage.

---

## Purpose

SAF is the correct, permission-free way to access user files on modern Android. It is also
the source of three silent failure modes that do not produce compiler errors:

1. A content URI passed to `PdfRenderer` (or any API that needs a seekable FD) crashes at
   runtime — content providers are not required to return seekable file descriptors.
2. A raw `file://` URI passed to a share intent throws `FileUriExposedException` on Android 7+.
3. A FileProvider with the wrong authority string silently returns URIs no receiving app can
   open — the authority is a runtime contract, not verified at compile time.

This skill enforces the patterns that prevent those failures.

---

## Step 1 — CONTRACT SELECTION

Use the correct `ActivityResultContracts` type for the job:

| Intent | Contract | Notes |
|--------|----------|-------|
| Pick one document | `OpenDocument(mimeTypes)` | Returns `Uri?`. MIME filter is advisory — always validate the returned file. |
| Pick multiple documents | `OpenMultipleDocuments(mimeTypes)` | Returns `List<Uri>`. Same MIME advisory caveat. |
| Save/export a file | `CreateDocument(mimeType)` | User chooses filename and location. Returns `Uri?`. |
| Share via system sheet | `FileProvider.getUriForFile()` + `Intent.ACTION_SEND` | Do NOT use CreateDocument for sharing — CreateDocument requires user interaction. |

**For PDF selection (example_app_two pattern):**

```kotlin
val compressLauncher = rememberLauncherForActivityResult(
    contract = ActivityResultContracts.OpenDocument(),
    onResult = { uri -> viewModel.onFilePicked(uri) }
)
// Launch:
compressLauncher.launch(arrayOf("application/pdf"))

val mergeLauncher = rememberLauncherForActivityResult(
    contract = ActivityResultContracts.OpenMultipleDocuments(),
    onResult = { uris -> viewModel.onMultiFilePicked(uris) }
)
mergeLauncher.launch(arrayOf("application/pdf"))
```

**Rule:** Never use `GetContent()` for document workflows — it requires `READ_MEDIA_*`
permissions on Android 13+. `OpenDocument` grants a one-time URI permission with zero
permission declarations.

---

## Step 2 — CONTENT URI SEMANTICS AND SEEKABLE FD

A content URI (`content://`) is an opaque handle to a content provider. The file descriptor
returned by `ContentResolver.openFileDescriptor()` is **not guaranteed to be seekable**.

**APIs that require a seekable FD:**
- `PdfRenderer(ParcelFileDescriptor)` — crashes on a non-seekable FD
- `MediaMetadataRetriever`
- Any API that calls `lseek()` internally

**Fix: always copy to a temp file before passing to these APIs:**

```kotlin
fun copyUriToTempFile(context: Context, uri: Uri): File? {
    return try {
        val tempFile = File(context.cacheDir, "input_${System.nanoTime()}.pdf")
        context.contentResolver.openInputStream(uri)?.use { input ->
            tempFile.outputStream().use { input.copyTo(it) }
        }
        if (tempFile.length() > 0) tempFile else { tempFile.delete(); null }
    } catch (e: Exception) {
        null
    }
}
```

**Rule:** Never pass a content URI directly to `PdfRenderer`, `FileInputStream(File)`,
or any API that requires a local path. Always go through `openInputStream` or copy to
a temp file first.

**APIs that work directly with content URIs (via ContentResolver):**
- `openInputStream(uri)` — streaming read, no seekability required
- `openOutputStream(uri)` — streaming write for SAF-created destinations
- `query(uri, projection, ...)` — metadata (display name, size)

---

## Step 3 — FILE METADATA FROM CONTENT URI

Do not call `File(uri.path).length()` on a content URI — the path segment is opaque and
does not map to a real filesystem path.

**Correct patterns for file metadata:**

```kotlin
// File size
fun getFileSizeBytes(context: Context, uri: Uri): Long =
    try {
        context.contentResolver.openFileDescriptor(uri, "r")?.use { pfd ->
            pfd.statSize.takeIf { it > 0 }
        } ?: 0L
    } catch (e: Exception) { 0L }

// Display name
fun getDisplayName(context: Context, uri: Uri): String? {
    val projection = arrayOf(OpenableColumns.DISPLAY_NAME)
    return context.contentResolver.query(uri, projection, null, null, null)?.use { cursor ->
        if (cursor.moveToFirst()) cursor.getString(0) else null
    }
}

// MIME type (do not trust the URI scheme alone)
fun getMimeType(context: Context, uri: Uri): String? =
    context.contentResolver.getType(uri)
```

**Rule:** Never construct a `File` from a content URI path. Use `ContentResolver` queries only.

---

## Step 4 — FILEPROVIDER SETUP

FileProvider enables safe file sharing via `content://` URIs. Misconfiguration is silent —
the wrong authority returns URIs that cannot be opened by the receiving app.

**AndroidManifest.xml:**

```xml
<provider
    android:name="androidx.core.content.FileProvider"
    android:authorities="${applicationId}.fileprovider"
    android:exported="false"
    android:grantUriPermissions="true">
    <meta-data
        android:name="android.support.FILE_PROVIDER_PATHS"
        android:resource="@xml/file_paths" />
</provider>
```

**`res/xml/file_paths.xml`** — declare every directory that FileProvider will serve:

```xml
<?xml version="1.0" encoding="utf-8"?>
<paths>
    <cache-path name="exports" path="exports/" />
    <cache-path name="root_cache" path="." />
    <!-- Add external-files-path, files-path etc. only if you actually serve those dirs -->
</paths>
```

**Getting a FileProvider URI:**

```kotlin
val authority = context.packageName + ".fileprovider"
val uri = FileProvider.getUriForFile(context, authority, file)
```

**Hard rules for FileProvider:**
- `exported` must be `false`. A `true` value exposes all declared paths to any app.
- `grantUriPermissions` must be `true`. Without it, the receiving app cannot read the file.
- The authority **must exactly match** `${applicationId}.fileprovider` — mismatch causes
  `IllegalArgumentException` at runtime, not at build time.
- Only declare path roots you actually use. Over-declaring creates unnecessary attack surface.

---

## Step 5 — TEMP FILE LIFECYCLE

Temp files in `cacheDir` are not automatically cleaned up. Unbounded temp file creation
causes storage accumulation across sessions.

**Creation convention:**

```kotlin
// Always use a unique name — never a fixed name (parallel ops overwrite each other)
File(context.cacheDir, "fixed_document_${System.currentTimeMillis()}.pdf")
File(context.cacheDir, "render_input_${System.nanoTime()}.pdf")
```

**Cleanup contract:**

| When | Action |
|------|--------|
| `ViewModel.onCleared()` | Delete `AppUiState.pdfResult?.outputFile` |
| `MainActivity.onCreate()` | Call `ExportManager.cleanUpCache(context)` to clear stale files from previous session |
| Processing failure | Delete the output file immediately in the failure branch |
| User taps "Start Over" | Delete the output file before resetting state |

**Rule:** Every temp file created by the processing layer must have a documented owner and
deletion path. A file created without a deletion path will accumulate on every run.

---

## Step 6 — URI PERMISSION PERSISTENCE

`OpenDocument` grants a one-time read permission for the lifecycle of the current task.
If your app needs to access the same URI across sessions (e.g., "recent files" feature),
you must explicitly persist the permission.

```kotlin
// Persist (call immediately after receiving the URI from the launcher)
context.contentResolver.takePersistableUriPermission(
    uri,
    Intent.FLAG_GRANT_READ_URI_PERMISSION
)

// Release when no longer needed
context.contentResolver.releasePersistableUriPermission(
    uri,
    Intent.FLAG_GRANT_READ_URI_PERMISSION
)

// Query persisted permissions
context.contentResolver.persistedUriPermissions  // List<UriPermission>
```

**Rule:** For single-session workflows (example_app_two pattern), do NOT call
`takePersistableUriPermission`. The one-time grant is sufficient and persisting it
unnecessarily accumulates permission entries. Only persist when the app will reopen
the URI in a future session.

---

## Step 7 — MIME TYPE RELIABILITY

Content providers are not required to honor MIME type filters in `OpenDocument`. A user
CAN select a non-PDF file even when `arrayOf("application/pdf")` is passed.

**Validation pattern:**

```kotlin
// Check PDF magic bytes before processing
fun isPdf(context: Context, uri: Uri): Boolean {
    return try {
        context.contentResolver.openInputStream(uri)?.use { input ->
            val header = ByteArray(4)
            input.read(header) == 4 && header.contentEquals("%PDF".toByteArray())
        } ?: false
    } catch (e: Exception) { false }
}
```

**Rule:** For any processing that will fail badly on a wrong file type (PdfRenderer throws
on non-PDFs), validate before processing rather than relying on the MIME filter. Surface
`InvalidFile` — never a crash.

---

## Hard Rules

1. Never pass a content URI to `PdfRenderer` or any API requiring a seekable FD. Copy to
   a temp file first via `openInputStream`.
2. Never use a raw `file://` URI in a share intent. FileProvider URI only — Android 7+
   throws `FileUriExposedException` on raw file URIs.
3. Never construct `File(uri.path)` from a content URI. Use `ContentResolver` queries only.
4. Never set FileProvider `exported="true"`. This exposes all declared directories.
5. Never use a fixed temp filename. Always include a timestamp or nonce to prevent parallel
   operation collisions.
6. Never accumulate temp files without a documented cleanup path. Every created file must
   have an owner and a deletion trigger.
7. Never trust the MIME filter alone for security-sensitive file processing. Validate magic
   bytes or attempt to open the file before committing to the processing pipeline.

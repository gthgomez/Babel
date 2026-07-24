<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: Android File Handling (v1.0)

**Category:** Mobile
**Status:** Active
**Pairs with:** `domain_android_kotlin`, `skill_android_saf`
**Activation:** Load for file import/export, sharing, `ContentResolver`, `FileProvider`, temp-file,
or URI-handling tasks.

---

## Purpose

Android file handling fails when apps treat URIs like file paths, work on the main thread, or
leak provider access. This skill defines the modern file-handling path for store-facing apps.

---

## Step 1 — CHOOSE THE FILE MODEL

Use this decision table:

| Need | Correct API |
|------|-------------|
| User picks an existing document | SAF / `ACTION_OPEN_DOCUMENT` or relevant picker |
| User creates or exports a document | SAF / `ACTION_CREATE_DOCUMENT` |
| App shares a file it owns | `FileProvider` URI |
| Temporary internal processing copy | app `cacheDir` or app-private files |

Do not convert a `content://` URI into a guessed filesystem path.

---

## Step 2 — MODERN USAGE PATTERN

Rules:
- open streams through `ContentResolver`
- always close with `.use { }`
- copy external content to a temp file before APIs that require `File`
- keep long-running I/O off the main thread

```kotlin
context.contentResolver.openInputStream(uri)?.use { input ->
    FileOutputStream(tempFile).use { output ->
        input.copyTo(output)
    }
} ?: error("Unable to open input stream")
```

---

## Step 3 — FILEPROVIDER RULES

When sharing app-owned files:
- use `FileProvider`
- provider must be `exported="false"`
- provider must set `grantUriPermissions="true"`
- share only the minimal allowed path surface

Never use raw `file://` URIs.

---

## Step 4 — LIFECYCLE-SAFE PATTERNS

1. Acquire URI-backed resources only when needed.
2. Release streams immediately after copy or processing.
3. Do not keep an open stream across configuration changes.
4. Clean temporary files after export or when the workflow ends.
5. If long-term URI access is needed, take persistable permissions explicitly.

---

## Step 5 — COMMON FAILURE CASES

| Failure | Why it happens | Prevention |
|---------|----------------|-----------|
| `FileNotFoundException` on reused URI | transient grant expired | take persistable permission or reopen within workflow |
| `FileUriExposedException` | raw `file://` sharing | use `FileProvider` |
| Main-thread stalls | file copy or decode on UI thread | move I/O to background dispatcher |
| Broken path assumptions | treating `content://` as filesystem path | use `ContentResolver` and temp copy |
| Overbroad provider exposure | unsafe `file_paths.xml` or exported provider | keep provider private and narrow |

---

## Step 6 — POLICY / COMPLIANCE NOTES

- Do not request legacy storage permissions when SAF or picker flows solve the problem.
- Target SDK 33+ should not reintroduce `READ_EXTERNAL_STORAGE` / `WRITE_EXTERNAL_STORAGE`.
- Sharing and export paths are security-sensitive; provider misconfiguration is a release blocker.

---

## Hard Rules

1. Never treat a `content://` URI as a direct file path.
2. Never share files with raw `file://` URIs.
3. Never perform real file I/O on the main thread.
4. Never broaden FileProvider exposure beyond the minimum needed path set.
5. Always choose the narrowest modern API that satisfies the feature.

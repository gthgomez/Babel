<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
status: ACTIVE
last_verified: 2026-07-03
-->

# Skill: iOS Swift App Sandbox & Document Access (v1.0)

**Category:** Mobile
**Status:** Active
**Pairs with:** `domain_ios_swift`
**Last Verified:** 2026-06-26
**Activation:** Load for Swift/UIKit/SwiftUI tasks targeting the iOS App Sandbox, custom `UIDocumentPickerViewController` callbacks, security-scoped bookmark generation, `NSFileCoordinator` executions, or `BGTask` background scheduling.

---

## Purpose

The iOS operating system runs every app inside an isolated sandbox container. Attempting to read files from external directories (e.g. iCloud, Files app, external drives) directly using standard file path strings results in permission errors or empty reads. Additionally, concurrent reads/writes on shared directories without coordinating file access cause data corruption, and running background calculations past OS time limits triggers immediate process termination.

This skill governs iOS security-scoped document access, coordinated file operations, and background task lifecycle limits.

---

## Step 1 — File Access & Security-Scoped Bookmarks

Files selected via `UIDocumentPickerViewController` are located outside the app's sandbox. The OS yields temporary read access that disappears immediately after the delegate callback returns. To preserve access across app restarts, you must create a persistent Security-Scoped Bookmark.

### Rules
1. **Acquiring Security Scope:** Wrap file reads inside `startAccessingSecurityScopedResource()` and release the lock immediately via a `defer` block:
   ```swift
   import Foundation

   func readFileFromExternalURL(url: URL) -> Data? {
       guard url.startAccessingSecurityScopedResource() else {
           // Failed to acquire security scope permission
           return nil
       }
       defer {
           url.stopAccessingSecurityScopedResource() // Always stop accessing in defer
       }
       
       return try? Data(contentsOf: url)
   }
   ```
2. **Generating Persistent Bookmarks:** Generate and store a bookmark to access the file again during future app sessions:
   ```swift
   func saveBookmarkForURL(url: URL) -> Data? {
       guard url.startAccessingSecurityScopedResource() else { return nil }
       defer { url.stopAccessingSecurityScopedResource() }
       
       return try? url.bookmarkData(
           options: .minimalBookmark,
           includingResourceValuesForKeys: nil,
           relativeTo: nil
       )
   }

   func resolveBookmarkData(bookmarkData: Data) -> URL? {
       var isStale = false
       let url = try? URL(
           resolvingBookmarkData: bookmarkData,
           options: .withSecurityScope,
           relativeTo: nil,
           bookmarkDataIsStale: &isStale
       )
       return url
   }
   ```

---

## Step 2 — `NSFileCoordinator` Concurrency

When writing to shared folders (e.g. App Groups containers) or files accessed by other apps (e.g. external text editors), use `NSFileCoordinator` to prevent race conditions and layout corruptions.

### Rules
1. **Coordinating Reads & Writes:** Never read or write to shared document URLs directly. Execute them inside coordinated operations:
   ```swift
   import Foundation

   func coordinatedWrite(to url: URL, content: String) {
       let coordinator = NSFileCoordinator()
       var error: NSError?
       
       coordinator.coordinate(writingItemAt: url, options: [], error: &error) { writeURL in
           do {
               try content.write(to: writeURL, atomically: true, encoding: .utf8)
           } catch {
               print("Coordinated write failed: \(error)")
           }
       }
   }
   ```

---

## Step 3 — Sandbox Cache & Temp Cleanup

iOS restricts temporary file storage. Large piles of unmanaged files in `tmp/` or `Caches/` trigger disk space alerts and will be silently cleared by the OS, leading to broken app behaviors.

### Rules
1. **Clean Transient Files:** Delete temporary files immediately after use:
   ```swift
   func clearTempDirectory() {
       let fileManager = FileManager.default
       let tempPath = NSTemporaryDirectory()
       do {
           let files = try fileManager.contentsOfDirectory(atPath: tempPath)
           for file in files {
               let filePath = (tempPath as NSString).appendingPathComponent(file)
               try fileManager.removeItem(atPath: filePath)
           }
       } catch {
           print("Failed to clean tmp folder: \(error)")
       }
   }
   ```

---

## Step 4 — Background Task Boundaries

Background tasks (`BGTaskScheduler`) are restricted by system-defined execution budgets (usually under 30 seconds). Exceeding this budget will result in OS termination.

### Rules
1. **Handle Expiration Handler:** Always register an expiration handler to terminate calculations gracefully:
   ```swift
   import BackgroundTasks

   func handleAppRefreshTask(task: BGAppRefreshTask) {
       // Register expiration handler
       task.expirationHandler = {
           // Stop active queues, abort downloads, release file blocks
           cancelActiveOperations()
           task.setTaskCompleted(success: false)
       }
       
       performBackgroundWork { success in
           task.setTaskCompleted(success: success)
       }
   }
   ```

---

## Hard Rules

1. **Always call `stopAccessingSecurityScopedResource()`** in a `defer` block immediately following `startAccessingSecurityScopedResource()`.
2. **Never access external URLs resolved from bookmarks** without setting the `.withSecurityScope` resolution option.
3. **Never perform blocking disk operations** or coordinated file locks on the Main thread.
4. **Always register background tasks** in the app's `Info.plist` under `BGTaskSchedulerPermittedIdentifiers`.
5. **Always call `setTaskCompleted(success:)`** on background tasks before their expiration timer hits.

---

## Boundaries — Do Not Overstep

- This skill dictates iOS Sandbox and File Access mechanics. It does not replace UIKit/SwiftUI programming guidelines, CoreData specs, or Apple Developer Portal certificates setups.
- Sandbox constraints apply to iOS, iPadOS, and tvOS targets. MacOS target sandboxing rules differ.

---

## Failure Behavior of This Skill

- **Read operations return nil or permission denied errors:** Check if the URL is security-scoped. Ensure `startAccessingSecurityScopedResource()` is called and returned `true`.
- **App gets terminated in the background:** Search logs for `task-expired` crashes. Verify that background task handlers override `expirationHandler` and call `setTaskCompleted`.

---

## Strategic Next Move

After every substantial response, end with one strategic next-move question focused on security-scoped URLs, coordinated file read/write scopes, or background task expirations.

---

## References

- `ols-compiler` (`04_Meta_Tools/OLS-MCC/ols-compiler/SKILL.md`) — for Swift structure verification.
- `skill_android_permissions` (`Mobile/Platform/Android-Permissions-v2.md`) — for comparative platform permission boundaries.

---

**OLS-MCC Compliance:** v1.0 compiled and validated for Phase 3 iOS Integration (iOS Sandbox).

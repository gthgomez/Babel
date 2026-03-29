<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: Android Play Store Compliance (v1.0)

**Category:** Mobile
**Status:** Active
**Pairs with:** `domain_android_kotlin`
**Activation:** Load for any task that touches `AndroidManifest.xml`, permissions, accessibility
services, store-visible behavior, or any pre-launch / pre-publish QA pass.

---

## Purpose

Play Store policy violations remove apps. A dangerous permission without justification triggers
review. An accessibility service used for a non-disability purpose is flagged and removed. An app
targeting SDK 35 without edge-to-edge insets support clips UI under the navigation bar for all
Android 15 users.

These failures are not caught by Gradle compilation or unit tests. This skill enforces the
implementation-side compliance checks that surface in manifest review, runtime behavior, or on a
real device.

---

## Step 1 — PERMISSION AUDIT

For every `uses-permission` in `AndroidManifest.xml`, classify and justify:

| Permission | Classification | Required? | Justification |
|------------|---------------|-----------|---------------|
| `[permission]` | [normal / dangerous / special] | [YES / NO] | [exact feature that requires it] |

**Normal permissions** (granted automatically — low risk):
- `INTERNET`, `VIBRATE`, `RECEIVE_BOOT_COMPLETED` — declare only if actually used.

**Dangerous permissions** (user-prompted — require justification in Play Console):
- `READ_MEDIA_IMAGES`, `READ_MEDIA_VIDEO`, `CAMERA`, `RECORD_AUDIO`, etc.
- If the feature can be achieved without the permission, do not declare it.
- Android 14+: `READ_MEDIA_IMAGES` is not needed for the Photo Picker. Do not declare it
  for image selection — use `PickVisualMedia` instead.

**Special-access permissions** (require user to navigate to system settings):
- `SYSTEM_ALERT_WINDOW` (overlay), `BIND_ACCESSIBILITY_SERVICE`, `PACKAGE_USAGE_STATS`
- See Steps 3 and 4 for dedicated guidance.

**Rule:** The manifest audit must confirm `INTERNET`, `READ_EXTERNAL_STORAGE`, and
`WRITE_EXTERNAL_STORAGE` are absent unless there is a documented justification. Their presence
in a utility app triggers Play Store review and is likely a mistake.

---

## Step 2 — PHOTO PICKER COMPLIANCE (Android 14+)

Apps targeting SDK 34+ must use the Android Photo Picker for image selection:

| API | Status | Notes |
|-----|--------|-------|
| `ActivityResultContracts.PickVisualMedia(ImageOnly)` | **REQUIRED** for SDK 34+ | No permission dialog. Compliant with Android 14+ privacy model. |
| `ActivityResultContracts.GetContent()` | **Non-compliant** for new apps | Requires `READ_MEDIA_IMAGES` permission on Android 13+ — unnecessary if Photo Picker is used. |
| `ACTION_PICK` with direct gallery | **Non-compliant** | Deprecated pattern. |

If the plan adds or modifies image selection, it must use `PickVisualMedia`. Never introduce
`GetContent()` for image use cases in new code.

---

## Step 3 — ACCESSIBILITY SERVICE POLICY

**Current policy (2026):** `AccessibilityService` is permitted only for apps whose **core purpose
is to directly assist users with disabilities** (screen readers, switch input, Braille support,
voice control). Google is actively auditing and removing apps that use it for other purposes.

| Use Case | Policy Status |
|----------|--------------|
| Screen reader, switch input, voice control | Permitted — `isAccessibilityTool="true"` eligible |
| Foreground app detection for utility features | **NOT PERMITTED** — utility use case |
| Automation, monitoring, keep-awake features | **NOT PERMITTED** — must use narrower API |
| Content scraping or UI interaction automation | **NEVER PERMITTED** |

**For foreground app detection (example_app_four):**

`UsageStatsManager + PACKAGE_USAGE_STATS` is the policy-durable alternative:

```kotlin
// Permission declaration in Manifest
<uses-permission android:name="android.permission.PACKAGE_USAGE_STATS"
    tools:ignore="ProtectedPermissions"/>

// Check if granted
val appOps = getSystemService(APP_OPS_SERVICE) as AppOpsManager
val mode = appOps.checkOpNoThrow(
    AppOpsManager.OPSTR_GET_USAGE_STATS,
    Process.myUid(),
    packageName
)
val granted = mode == AppOpsManager.MODE_ALLOWED

// Direct user to grant
startActivity(Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS))

// Query foreground app (poll every 1–3 seconds)
val usm = getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager
val now = System.currentTimeMillis()
val stats = usm.queryUsageStats(UsageStatsManager.INTERVAL_DAILY, now - 5000, now)
val foreground = stats?.maxByOrNull { it.lastTimeUsed }?.packageName
```

**Trade-offs vs AccessibilityService:**
- Permission grant requires user to navigate to Settings > Special app access > Usage access
- No real-time event stream — must poll
- More policy-durable; used by digital-wellbeing and parental-control apps without restriction

**Rule:** Any plan for example_app_four that retains `BIND_ACCESSIBILITY_SERVICE` for foreground
detection must include an explicit policy-risk acknowledgment in RISKS. The preferred direction
is migration to `UsageStatsManager`.

---

## Step 4 — ANDROID 15 / SDK 35 BEHAVIORAL CHANGES

Apps targeting SDK 35 must handle these enforced behaviors:

### Edge-to-Edge (enforced by default)

Content draws behind transparent status and navigation bars. Content not protected by insets
will be clipped on Android 15 devices.

**Fix for Compose apps (Material3):**

```kotlin
// In MainActivity.onCreate()
enableEdgeToEdge()

// Scaffold handles insets automatically when using Material3
Scaffold(
    topBar = { TopAppBar(...) },      // insets handled
    bottomBar = { BottomNavBar(...) } // insets handled
) { paddingValues ->
    content(paddingValues)           // always pass paddingValues to content
}

// For custom layouts that need explicit insets:
Modifier.padding(WindowInsets.systemBars.asPaddingValues())
```

**Rule:** Never ignore `paddingValues` from `Scaffold`. Never assume `padding(16.dp)` is
sufficient for content near screen edges on Android 15 devices.

### Predictive Back Gesture (enabled by default on Android 15+)

Android 15 shows system-level back preview animations by default. Apps that intercept
back gestures must declare support.

**For screen-enum navigation (no NavHost):**

```kotlin
// In Composable or Activity
BackHandler(enabled = state.screen != AppScreen.Home) {
    viewModel.onBackPressed()
}
```

Without `BackHandler`, the system back gesture may close the Activity when the intent was
to navigate back one screen level within the enum stack.

**Rule:** Any plan that adds a new screen to the enum navigation must also add or verify
`BackHandler` coverage.

### Background Activity Launch Restrictions

`PendingIntents` no longer implicitly allow activity launches from a background context.
Billing flows must be triggered from a visible, user-interactive context (Activity reference).

**Rule:** `launchBillingFlow(activity, params)` must receive the currently foregrounded
`Activity` reference. Never trigger it from a `Service`, `BroadcastReceiver`, or stale
Activity reference.

---

## Step 5 — ESCALATION BOUNDARY

This skill owns runtime and manifest compliance.

Escalate to:

- `skill_google_play_store` for Play Console policy deadlines, Data Safety, content rating,
  privacy-policy URL rules, store listing metadata, and asset specs
- `skill_android_app_bundle` for AAB packaging, bundletool validation, and store artifact selection

**Rule:** If the task is about what gets uploaded, declared, or shown in the store console, pair
this skill with the store/package skill instead of expanding this file's scope.

---

## Hard Rules

1. Never add a `uses-permission` without declaring the exact feature that requires it. "Might
   be useful later" is not a justification.
2. Never use `GetContent()` for image selection in new code. `PickVisualMedia` only.
3. Never retain `BIND_ACCESSIBILITY_SERVICE` for a non-disability use case without an
   explicit policy-risk entry in RISKS. Prefer `UsageStatsManager` for foreground detection.
4. Never ignore `paddingValues` from `Scaffold` in a targetSdk 35 app.
5. Never treat store listing, Data Safety, or asset-spec work as fully covered by this skill.
   Load the store-specific policy skill too.


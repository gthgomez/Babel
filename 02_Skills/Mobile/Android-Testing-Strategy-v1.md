<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: Android Testing Strategy (v1.0)

**Category:** Mobile
**Status:** Active
**Load order:**
  1. `domain_android_kotlin`
  2. **`skill_android_testing_strategy`** ← this file (load always, load first among test skills)
  3. One or more of: `skill_android_unit_testing`, `skill_android_instrumented_testing`, `skill_android_screenshot_testing`
  4. `skill_android_test_enforcement` (load last — enforces the selected test surfaces)

**Takes precedence when:** Two leaf skills appear to conflict on test placement or dispatcher strategy — this file's routing table is the tie-breaker.

**Pairs with:** All four Android testing skills. This file routes to them; it does not replace them.

**Activation:** Load for any task that writes, modifies, or plans tests in a example_mobile_suite app.
Load before any leaf testing skill. If only one leaf skill is needed, still load this file first.

---

## Purpose

The four leaf testing skills (`unit`, `instrumented`, `screenshot`, `enforcement`) are strong at
the detail level. This file does the job they cannot do for each other: tell you which file applies,
in what order, and how to resolve the three most common wrong-path choices before they cost a build
cycle.

Three wrong paths this file prevents:

1. Writing a ViewModel test without first checking state type (`mutableStateOf` vs `StateFlow`) —
   the entire test strategy differs between them; Turbine on `mutableStateOf` adds complexity for
   zero benefit.
2. Applying the Roborazzi Gradle plugin on AGP ≥ 9.0 — the plugin fails at configuration time with
   a `TestedExtension does not exist` error that requires removing the plugin and reworking setup.
3. Writing instrumented tests for a class with zero `android.*` imports — those tests require an
   emulator for no reason and are 100× slower than they need to be.

---

## Step 1 — ROUTE: Which test type applies?

Run this routing table before writing a single test line.

```
Does the class under test import anything from android.*?
  YES → androidTest/ (instrumented)  →  load skill_android_instrumented_testing
  NO  →
      Does it render Compose UI or need visual regression coverage?
        YES → src/test/ (Roborazzi/screenshot)  →  load skill_android_screenshot_testing
        NO  → src/test/ (JVM unit)              →  load skill_android_unit_testing
```

| Class type | Directory | Skill to load |
|---|---|---|
| Pure Kotlin: domain types, constraint math, sealed results | `src/test/` | `skill_android_unit_testing` |
| ViewModel (with fakes — no android.* imports in VM itself) | `src/test/` | `skill_android_unit_testing` |
| BitmapFactory, ExifInterface, ContentResolver, FileProvider | `src/androidTest/` | `skill_android_instrumented_testing` |
| PdfRenderer, PdfDocument | `src/androidTest/` | `skill_android_instrumented_testing` |
| Compose screen appearance, paywall, error state, dark mode | `src/test/` via Roborazzi | `skill_android_screenshot_testing` |

**Rule:** If the class under test has zero `android.*` imports, it always belongs in `src/test/`.
A ViewModel that takes `Context` as a constructor parameter is an architecture problem, not a reason
to move the test to `androidTest/`.

**Rule:** Load `skill_android_test_enforcement` after selecting the correct test surface. Enforcement
applies to whichever surfaces were selected — it is not surface-specific.

---

## Step 2 — RESOLVE: ViewModel test pattern (check before writing)

Run both checks before opening the ViewModel test file.

### Check A — State type

```bash
grep -n "mutableStateOf\|StateFlow" MainViewModel.kt
```

| Result | Pattern | Detail |
|---|---|---|
| `mutableStateOf` | Direct read after `advanceUntilIdle()` | Step 3A in `skill_android_unit_testing` |
| `StateFlow` | Turbine `test { awaitItem() }` block | Step 3C in `skill_android_unit_testing` |

**Never use Turbine on a ViewModel that uses `mutableStateOf`.** Turbine is for `Flow`/`StateFlow`
emission sequences only. Using it on Compose state adds complexity for zero benefit.

### Check B — Dispatcher in ViewModel launch

```bash
grep -n "launch(Dispatchers\." MainViewModel.kt
```

| Result | Pattern | Detail |
|---|---|---|
| No explicit dispatcher (inherits Main) | `advanceUntilIdle()` controls everything | Standard pattern |
| `launch(Dispatchers.Default)` or `launch(Dispatchers.IO)` | `awaitDefaultDispatch()` — see below | Step 3B in `skill_android_unit_testing` |

When the ViewModel explicitly names `Dispatchers.Default` or `Dispatchers.IO`, those coroutines
run on real threads and are **invisible to the test scheduler**. `advanceUntilIdle()` returns
immediately with state unchanged. The fix:

```kotlin
private fun awaitDefaultDispatch(ms: Long = 200) {
    Thread.sleep(ms)
    testDispatcher.scheduler.advanceUntilIdle()
}
```

Use `awaitDefaultDispatch()` in place of `advanceUntilIdle()` for any action that triggers
a coroutine dispatched to `Dispatchers.Default`.

**Symptom of missing this check:** `advanceUntilIdle()` completes, assertions fail because state
has not updated yet. The coroutine ran after the assertion.

---

## Step 3 — RESOLVE: Screenshot setup (check before touching build files)

Run this check before adding Roborazzi to `build.gradle.kts`.

```bash
grep "agp" gradle/libs.versions.toml
```

| AGP version | Roborazzi mode | What to do |
|---|---|---|
| < 9.0 | Plugin mode | Apply `alias(libs.plugins.roborazzi)` — tasks `recordRoborazziDebug`, `verifyRoborazziDebug` exist |
| ≥ 9.0 | Library-only mode | Do **NOT** apply the plugin — use `testOptions.unitTests.all` property forwarding (see below) |

**example_mobile_suite is on AGP 9.1.0. Always use library-only mode.**

Library-only mode requires forwarding Gradle properties to the test JVM. Without this block,
`-Proborazzi.test.record=true` is parsed by Gradle but never reaches `captureRoboImage()`:

```kotlin
// app/build.gradle.kts — required for AGP ≥ 9.0
android {
    testOptions {
        unitTests {
            isIncludeAndroidResources = true
            all { test ->
                listOf("roborazzi.test.record", "roborazzi.test.verify").forEach { key ->
                    project.findProperty(key)?.let { value ->
                        test.systemProperty(key, value.toString())
                    }
                }
            }
        }
    }
}
```

| Mode | Command |
|---|---|
| Record goldens | `./gradlew :app:testDebugUnitTest -Proborazzi.test.record=true` |
| Verify goldens | `./gradlew :app:testDebugUnitTest -Proborazzi.test.verify=true` |
| Default (record-if-missing) | `./gradlew :app:testDebugUnitTest` |

For example_app_one (dual-flavor), replace `testDebugUnitTest` with `testGooglePlayDebugUnitTest`.

**Never record goldens in CI.** Record is a developer action. CI runs verify only.

---

## Step 4 — RESOLVE: No device available

When no emulator or device is connected, instrumented tests cannot run. This is an infrastructure
constraint, not a test failure.

```bash
# Partial gate — compile only, no execution
./gradlew :app:compileDebugAndroidTestKotlin

# For flavored builds:
./gradlew :app:compileGooglePlayDebugAndroidTestKotlin
```

Record this constraint explicitly in plans:

> "Instrumented tests compile OK (`compileDebugAndroidTestKotlin` passes). Full execution
> requires a connected device. Run when available: `./gradlew :app:connectedDebugAndroidTest`"

Do not treat "no device" as a blocker for unit or screenshot tests — those run on JVM with no device.

---

## Step 5 — LOAD ORDER AND SKILL PAIRING

When a task spans multiple test types (e.g., ViewModel tests + instrumented engine tests + screenshot
coverage for a new UI branch), load skills in this order:

```
domain_android_kotlin
  └─ skill_android_testing_strategy          ← this file, always first
       ├─ skill_android_unit_testing          ← when pure JVM or ViewModel tests are needed
       ├─ skill_android_instrumented_testing  ← when Android framework APIs are under test
       └─ skill_android_screenshot_testing    ← when UI branch or visual regression is in scope
  └─ skill_android_test_enforcement          ← always last; enforces across all selected surfaces
```

The strategy file resolves routing decisions. The leaf files provide implementation detail.
The enforcement file applies after surfaces are selected.

---

## Step 6 — VERIFICATION OUTPUT STANDARD

Every Android behavior-changing plan must end with this block (from `skill_android_test_enforcement`
Step 7, included here for co-location):

```text
TEST ENFORCEMENT

Behavior surfaces changed: [list]
Required test classes: [list]
Why each test is mandatory: [one line each]
CI commands to run: [list]
Any skipped verification: [none or explicit reason]
```

This block is mandatory. If a verification step is skipped, the reason must be stated explicitly
(e.g., "instrumented tests compile but require a connected device — no emulator available").

---

## Anti-Patterns

| Anti-pattern | Root cause | Correct routing |
|---|---|---|
| Turbine on `mutableStateOf` ViewModel | State type not checked before writing tests | Check A in Step 2; use direct read pattern |
| `advanceUntilIdle()` on `Dispatchers.Default` coroutines | Dispatcher not checked before writing tests | Check B in Step 2; use `awaitDefaultDispatch()` |
| Roborazzi plugin applied on AGP ≥ 9.0 | AGP version not checked before build file edit | Step 3; use library-only mode |
| `-Proborazzi.test.record=true` silently ignored | Property forwarding block missing | Step 3; add `testOptions.unitTests.all` block |
| Instrumented test for zero-`android.*` class | Routing table not consulted | Step 1; move to `src/test/` |
| "No device" treated as test failure | Constraint vs. failure not distinguished | Step 4; compile gate + document |

---

## Hard Rules

1. Run Steps 2 and 3 checks before writing ViewModel or screenshot tests. Never assume state type
   or AGP version — grep for them.
2. Never use Turbine on a ViewModel that uses `mutableStateOf`. Check state type first (Step 2A).
3. Never apply the Roborazzi Gradle plugin without checking AGP version. If AGP ≥ 9.0, the plugin
   fails at configuration time. Use library-only mode (Step 3).
4. Never pass `-Proborazzi.test.record=true` without the `testOptions.unitTests.all` forwarding
   block. Without it, the property is silently ignored.
5. Never block a plan on instrumented test execution when no device is available. Use the compile
   gate (Step 4) and record the run command explicitly.
6. Always load `skill_android_test_enforcement` after selecting test surfaces — never before.
   Enforcement must know which surfaces were selected before it can enforce them.
7. Always load this file before any leaf testing skill. Routing decisions made before this file
   is loaded may select the wrong skill.

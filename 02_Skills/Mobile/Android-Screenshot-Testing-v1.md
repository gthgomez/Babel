<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: Android Screenshot Testing (v1.0)

**Category:** Mobile
**Status:** Active
**Load order:** Load after `skill_android_testing_strategy` and after `skill_android_unit_testing` if ViewModel tests are also in scope. Screenshot tests have the highest setup cost and lowest diagnostic value when basic unit and ViewModel tests do not exist yet.
**Load before:** `skill_android_test_enforcement` — enforcement loads last.
**Takes precedence when:** A UI branch change, paywall state, or visual regression is in scope and the screenshot surface is confirmed.

**Pairs with:** `domain_android_kotlin`, `skill_android_testing_strategy`
**Activation:** Load for any task that adds visual regression tests, screenshot golden files,
or Compose preview validation. Load after `skill_android_unit_testing` and
`skill_android_instrumented_testing` — screenshot tests have the highest setup cost and
lowest diagnostic value when basic unit and ViewModel tests do not exist yet.

---

## Purpose

Screenshot tests catch visual regressions that logic tests cannot — a layout clipped under
system bars on Android 15, a paywall UI showing the wrong price, or a dark-mode color that
became unreadable after a theme change. They are the right tool for validating Compose screen
appearance without running the full app.

**Tool choice:** Use **Roborazzi** (recommended) or Paparazzi (acceptable alternative).

| Tool | Rendering engine | Emulator needed | CI speed | Google endorsement |
|------|-----------------|----------------|----------|--------------------|
| **Roborazzi** | Robolectric + real Android rendering | No | Fast | ✅ Used in `nowinandroid` |
| Paparazzi | layoutlib (Square's fork) | No | Fast | — |

Roborazzi is preferred because it uses the real Android rendering stack via Robolectric,
which means edge-to-edge insets, dynamic color, and Material3 theming render more accurately.
Paparazzi is a valid alternative if you already have it set up.

---

## Step 1 — ROBORAZZI SETUP

### AGP Compatibility Warning

**The Roborazzi Gradle plugin is incompatible with AGP ≥ 9.0.**

The plugin uses `TestedExtension`, which was removed in AGP 9.0. Applying it causes:
```
Failed to apply plugin 'io.github.takahirom.roborazzi'.
   > Extension of type 'TestedExtension' does not exist.
```

**Two modes:**

| Mode | AGP requirement | Gradle tasks provided | Use when |
|------|----------------|----------------------|----------|
| **Plugin mode** | AGP < 9.0 | `recordRoborazziDebug`, `verifyRoborazziDebug` | Older projects |
| **Library-only mode** | Any AGP | Manual property forwarding (see below) | AGP ≥ 9.0 |

Check your AGP version in `libs.versions.toml` before choosing a mode.

---

### Library-only mode (required for AGP ≥ 9.0)

Do **not** apply `alias(libs.plugins.roborazzi)` in `build.gradle.kts`.

Instead, forward Roborazzi mode properties from Gradle project properties to the test JVM:

```kotlin
// app/build.gradle.kts
android {
    testOptions {
        unitTests {
            isIncludeAndroidResources = true
            all { test ->
                // Record:  ./gradlew :app:testDebugUnitTest -Proborazzi.test.record=true
                // Verify:  ./gradlew :app:testDebugUnitTest -Proborazzi.test.verify=true
                // Default (neither property set): RECORD_IF_MISSING mode —
                //   captures a new golden if none exists, otherwise compares.
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

Without this `all { test -> ... }` block, the `-P` property is parsed by Gradle but never
forwarded to the test JVM process. `captureRoboImage()` runs in RECORD_IF_MISSING mode
silently regardless of what you pass on the command line.

---

### `libs.versions.toml`

```toml
[versions]
roborazzi = "1.28.0"        # verify latest at github.com/takahirom/roborazzi/releases
robolectric = "4.14.1"      # verify latest at github.com/robolectric/robolectric/releases

[libraries]
roborazzi = { group = "io.github.takahirom.roborazzi", name = "roborazzi", version.ref = "roborazzi" }
roborazzi-compose = { group = "io.github.takahirom.roborazzi", name = "roborazzi-compose", version.ref = "roborazzi" }
robolectric = { group = "org.robolectric", name = "robolectric", version.ref = "robolectric" }
androidx-ui-test-junit4 = { group = "androidx.compose.ui", name = "ui-test-junit4" }
androidx-ui-test-manifest = { group = "androidx.compose.ui", name = "ui-test-manifest" }

# Plugin entry — only add if using plugin mode (AGP < 9.0):
# roborazzi = { id = "io.github.takahirom.roborazzi", version.ref = "roborazzi" }
```

### `app/build.gradle.kts`

```kotlin
plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    // Do NOT apply libs.plugins.roborazzi if AGP >= 9.0 — TestedExtension was removed.
    // Use library-only mode with the testOptions.unitTests.all block above instead.
}

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

dependencies {
    testImplementation(libs.roborazzi)
    testImplementation(libs.roborazzi.compose)
    testImplementation(libs.robolectric)
    testImplementation(platform(libs.androidx.compose.bom))
    testImplementation(libs.androidx.ui.test.junit4)
    debugImplementation(libs.androidx.ui.test.manifest)
}
```

---

## Step 2 — WRITING SCREENSHOT TESTS

Screenshot tests live in `src/test/java/` (JVM — no emulator).

### Composable preview screenshot

```kotlin
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w411dp-h891dp-xxhdpi")  // Pixel 6 logical size
class HomeScreenScreenshotTest {

    @get:Rule
    val composeTestRule = createComposeRule()

    @Test
    fun homeScreen_lightTheme_default() {
        composeTestRule.setContent {
            AppTheme(darkTheme = false) {
                HomeScreen(
                    state = AppUiState(screen = AppScreen.Home),
                    onAction = {}
                )
            }
        }

        composeTestRule.onRoot()
            .captureRoboImage("src/test/snapshots/homeScreen_lightTheme_default.png")
    }

    @Test
    fun homeScreen_darkTheme_default() {
        composeTestRule.setContent {
            AppTheme(darkTheme = true) {
                HomeScreen(
                    state = AppUiState(screen = AppScreen.Home),
                    onAction = {}
                )
            }
        }

        composeTestRule.onRoot()
            .captureRoboImage("src/test/snapshots/homeScreen_darkTheme_default.png")
    }
}
```

### Paywall screenshot (locked vs. unlocked)

```kotlin
@Test
fun proUpsellCard_lockedState() {
    composeTestRule.setContent {
        AppTheme {
            ProUpsellCard(
                isProUnlocked = false,
                onUpgradeClick = {}
            )
        }
    }
    composeTestRule.onRoot()
        .captureRoboImage("src/test/snapshots/proUpsellCard_locked.png")
}

@Test
fun proUpsellCard_unlockedState() {
    composeTestRule.setContent {
        AppTheme {
            ProUpsellCard(
                isProUnlocked = true,
                onUpgradeClick = {}
            )
        }
    }
    composeTestRule.onRoot()
        .captureRoboImage("src/test/snapshots/proUpsellCard_unlocked.png")
}
```

---

## Step 3 — GOLDEN FILE WORKFLOW

### Plugin mode (AGP < 9.0)

| Mode | Command | When to use |
|------|---------|-------------|
| **Record** (generate goldens) | `./gradlew :app:recordRoborazziDebug` | First run; after intentional visual change |
| **Verify** (compare to goldens) | `./gradlew :app:verifyRoborazziDebug` | CI; routine test runs |
| **Compare** (generate diff images) | `./gradlew :app:compareRoborazziDebug` | Review before recording new goldens |

### Library-only mode (AGP ≥ 9.0)

The Gradle plugin tasks (`recordRoborazziDebug`, `verifyRoborazziDebug`) do not exist.
Use project properties forwarded via the `testOptions.unitTests.all` block from Step 1:

| Mode | Command | When to use |
|------|---------|-------------|
| **Record** | `./gradlew :app:testDebugUnitTest -Proborazzi.test.record=true` | First run; after intentional visual change |
| **Verify** | `./gradlew :app:testDebugUnitTest -Proborazzi.test.verify=true` | CI; routine test runs |
| **Default** | `./gradlew :app:testDebugUnitTest` | RECORD_IF_MISSING: captures new goldens, compares existing |

For flavored builds (e.g. example_app_one with googlePlay/amazon flavors), replace
`testDebugUnitTest` with the flavor-specific task: `testGooglePlayDebugUnitTest`.

**Golden file storage:** Commit the `src/test/snapshots/` directory to version control.
Golden images are the source of truth — when a test fails in CI, a diff image is generated
showing exactly what changed.

**Rule:** Never commit updated golden files without reviewing the diff image first.
A "just update the snapshots" habit defeats the purpose of visual regression testing.

---

## Step 4 — DEVICE CONFIGURATION

Roborazzi uses Robolectric qualifiers to control the rendering environment.

```kotlin
// Common configurations to test
@Config(sdk = [35], qualifiers = "w411dp-h891dp-xxhdpi")   // Pixel 6 (phone)
@Config(sdk = [35], qualifiers = "w673dp-h841dp-xhdpi")    // Pixel Tablet
@Config(sdk = [35], qualifiers = "w411dp-h891dp-xxhdpi-night") // Dark mode

// Annotation-level config for the whole test class
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w411dp-h891dp-xxhdpi")
class MyScreenshotTest { ... }
```

For Material3 dynamic color: Robolectric does not simulate device-wallpaper-based dynamic
color. Use a fixed static color scheme in screenshot tests for reproducibility:

```kotlin
composeTestRule.setContent {
    // Use a stable static scheme for screenshots — not dynamicColorScheme()
    MaterialTheme(
        colorScheme = if (darkTheme) darkColorScheme() else lightColorScheme()
    ) {
        ScreenUnderTest(...)
    }
}
```

---

## Step 5 — WHAT TO SCREENSHOT (PRIORITY ORDER)

Don't screenshot everything. Prioritize:

| Priority | What | Why |
|----------|------|-----|
| 1 | Paywall / Pro upsell card | Highest business consequence if broken |
| 2 | Result screen (with processed output metadata) | Most complex layout in utility apps |
| 3 | Home screen — empty state and loaded state | User's first impression |
| 4 | Error states | Often forgotten in visual QA |
| 5 | Every screen in dark mode | Material3 dark theme has different contrast ratios |

---

## Hard Rules

1. Never run screenshot tests before basic unit and ViewModel tests exist. Screenshot failures
   without logic test failures are hard to diagnose — you see the wrong visual but not why.
2. Never update golden files without running compare mode first. Review the diff image.
3. Never use `dynamicColorScheme()` in screenshot tests — wallpaper-based colors are not
   reproducible across machines. Use `lightColorScheme()` / `darkColorScheme()` for goldens.
4. Never store golden images in `src/main/` or `res/`. They belong in `src/test/snapshots/`
   and must be committed to version control.
5. Never run record mode in CI — record is a developer action; CI runs verify only.
6. Never write one screenshot test that covers every state in one image — separate tests per
   state make diffs readable and failures diagnosable.
7. Never apply `alias(libs.plugins.roborazzi)` without checking the AGP version first.
   If AGP ≥ 9.0, the plugin will fail at configuration time with `TestedExtension does not
   exist`. Use library-only mode (Step 1) instead.
8. Never pass `-Proborazzi.test.record=true` without the `testOptions.unitTests.all` property
   forwarding block. Without it, the property is silently ignored and the test runs in
   RECORD_IF_MISSING mode regardless.

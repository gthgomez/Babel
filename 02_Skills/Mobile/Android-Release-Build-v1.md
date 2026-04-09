<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: Android Release Build (v1.0)

**Category:** Mobile
**Status:** Active
**Pairs with:** `domain_android_kotlin`
**Activation:** Load for any task that touches release builds, signing configuration, ProGuard/R8,
MaterialTheme setup, or the transition from debug to production-ready build.

---

## Purpose

Debug builds of an Android app behave differently from release builds in three critical ways:
R8 minification strips unreferenced classes (breaking billing silently without ProGuard rules),
signing is handled by the debug keystore (not valid for Play distribution), and MaterialTheme
is not provided by the framework — it must be explicitly wrapped in the app. These gaps produce
no compilation errors but cause silent failures in production.

This skill converts those silent failure modes into explicit plan requirements.

---

## Step 1 — MATERIAL THEME SETUP

Every Compose app must wrap its root content in a `MaterialTheme` provider. Without it,
`MaterialTheme.colorScheme.*` and `MaterialTheme.typography.*` return fallback baseline values
(generic purple/teal) regardless of what colors are in `themes.xml`.

**Required pattern:**

```kotlin
// ui/theme/Theme.kt
@Composable
fun AppTheme(content: @Composable () -> Unit) {
    val dynamicColor = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
    val colorScheme = if (dynamicColor) {
        dynamicLightColorScheme(LocalContext.current)   // Material You (API 31+)
    } else {
        lightColorScheme(primary = Color(0xFF<YOUR_BRAND_HEX>))  // static fallback
    }
    MaterialTheme(colorScheme = colorScheme, content = content)
}

// MainActivity.kt
setContent {
    AppTheme {
        AppRoot(viewModel)
    }
}
```

**Rules:**
- Dynamic color (`dynamicLightColorScheme`) is the modern Android standard on API 31+. Use it.
- Static fallback must match the app's adaptive icon primary color for visual consistency.
- Dark theme support: optional for V1, add before store listing includes dark screenshots.
- No dark theme in V1 is acceptable — add `darkTheme: Boolean = isSystemInDarkTheme()` param later.

---

## Step 2 — SIGNING CONFIGURATION

Release builds must be signed with a developer-controlled keystore. Debug keystore is not
accepted by Google Play, Samsung Galaxy Store, or Amazon Appstore.

**Required setup in `build.gradle.kts`:**

```kotlin
// Read from environment variables — NEVER hardcode credentials
android {
    signingConfigs {
        create("release") {
            storeFile = file(System.getenv("KEYSTORE_PATH") ?: "")
            storePassword = System.getenv("KEYSTORE_PASSWORD") ?: ""
            keyAlias = System.getenv("KEY_ALIAS") ?: ""
            keyPassword = System.getenv("KEY_PASSWORD") ?: ""
        }
    }
    buildTypes {
        release {
            signingConfig = signingConfigs.getByName("release")
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }
}
```

**Rules:**
- NEVER hardcode signing credentials in `build.gradle.kts`. Use environment variables only.
- NEVER commit `*.jks`, `*.keystore`, or `*.p12` — they must be in `.gitignore`.
- Back up the keystore to a secure location outside the repo (loss = permanent inability to update the app).
- For Google Play: Play App Signing uploads an AAB signed with the upload key; Google re-signs with the app signing key. Keep the upload key safe separately.
- Required signing schemes: v1 (JAR), v2 (APK), v3 (APK) — enable all three. Samsung requires v1+v2. Google Play requires v2+.

---

## Step 3 — PROGUARD / R8 RULES

`isMinifyEnabled = true` runs R8, which strips and obfuscates unreferenced code. Any library
that relies on reflection (including Play Billing and Compose internals) requires explicit keep rules.

**Required rules in `proguard-rules.pro`:**

```proguard
# Google Play Billing Library — must be kept or billing fails silently in release
-keep class com.android.billingclient.api.** { *; }
-keep class com.android.vending.billing.** { *; }

# Kotlin coroutines — required for correct suspend function behavior
-keepnames class kotlinx.coroutines.internal.MainDispatcherFactory {}
-keepnames class kotlinx.coroutines.CoroutineExceptionHandler {}

# Kotlin serialization (if used)
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.AnnotationsKt

# AndroidX — Compose runtime (usually handled by consumer rules, but belt-and-suspenders)
-keep class androidx.compose.** { *; }

# Prevent stripping of data classes used in Parcelable or JSON
-keepclassmembers class * implements android.os.Parcelable {
    static ** CREATOR;
}
```

**Rules:**
- After adding any new dependency, check if it ships consumer ProGuard rules (`build/outputs/mapping/`).
- Upload the mapping file to Play Console (Release → App bundle explorer → mapping.txt) for
  symbolicated crash reports in Play Vitals.
- Test a release build locally before submitting: `./gradlew bundleRelease` or `assembleRelease`.
- Missing Play Billing ProGuard rules is the #1 silent release-only billing failure.

---

## Step 4 — RELEASE BUILD CHECKLIST

Run before every store submission:

| Check | Command / Verification |
|-------|----------------------|
| Release build compiles | `./gradlew bundleRelease` (AAB) or `assembleRelease` (APK) |
| Signing verified | `apksigner verify --verbose app-release.apk` — confirm v1, v2, v3 present |
| ProGuard rules present | Check `proguard-rules.pro` for billing + coroutines keep rules |
| Billing works in release | Install signed APK, tap preset chip → billing dialog appears |
| No debug flags | `BuildConfig.DEBUG == false` in release variant |
| R8 mapping uploaded | Upload `build/outputs/mapping/release/mapping.txt` to Play/Samsung/Amazon |
| `local.properties` NOT in APK | Confirm not committed, not included in assets |

For AAB vs APK selection, bundletool validation, and store-processing differences, load
`skill_android_app_bundle`. This skill owns release hardening; the AAB skill owns packaging and
distribution-path selection.

---

## Step 5 — ONRESUME BILLING LIFECYCLE

The billing service can disconnect while the app is backgrounded. Without an `onResume`
reconnect, `isProUnlocked` may be stale when the user returns.

**Required in `MainActivity`:**

```kotlin
override fun onResume() {
    super.onResume()
    viewModel.onResume()
}
```

**Required in `MainViewModel`:**

```kotlin
fun onResume() {
    viewModelScope.launch {
        try {
            billing.connect()          // isReady guard makes this idempotent
            billing.refreshEntitlement()
        } catch (e: Exception) {
            // Billing unavailable — free tier continues to work
        }
    }
}
```

**Rule:** This pattern is required by the `overlay_example_mobile_suite` billing contract:
"queryPurchasesAsync on every onResume — never rely on cached state."

---

## Hard Rules

1. Never ship a release build without verifying ProGuard keep rules for billing are present.
   Missing rules = silent billing failure in production, working in debug.
2. Never hardcode signing credentials in `build.gradle.kts`. Use environment variables only.
3. Never commit `*.jks` / `*.keystore` / `*.p12`. If committed, rotate the key immediately.
4. Never assume the MaterialTheme system colors are provided by `themes.xml` — Compose requires
   an explicit `MaterialTheme { }` wrapper in `setContent`.
5. Never skip `onResume` billing reconnect. The billing service disconnects in the background;
   the free tier must still work but entitlement must re-verify on every resume.
6. Always upload the R8 mapping file to the store for crash report symbolication.
7. Never treat store artifact selection as covered by this skill alone. Pair with
   `skill_android_app_bundle` when the task touches AABs, bundletool, or cross-store release paths.

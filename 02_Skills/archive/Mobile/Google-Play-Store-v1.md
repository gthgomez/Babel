<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this product layer.
-->

# Skill: Google Play Store (v1.0)

**Category:** Mobile
**Status:** Active
**Pairs with:** `domain_android_kotlin`
**Activation:** Load for any task that touches Google Play submission, Play Console setup,
Play-specific compliance, pre-launch checklist, or the Google Play billing exclusivity policy.

**Research basis:** Google Play Console Help, Android Developers Blog, verified March 2026.
All deadlines are sourced from official Google policy pages with explicit enforcement dates.

---

## Purpose

Google Play has the most rigorous compliance requirements of any Android store and the strictest
enforcement cadence — policies change annually, enforcement dates are hard, and violations result
in app removal or developer account termination. This skill captures the 2025–2026 policy state
including critical deadlines that have already passed and upcoming ones that require action.

---

## Step 1 — TARGET API LEVEL (ENFORCED)

**These deadlines are hard — missed deadlines prevent updates from being published.**

| Requirement | Deadline | Scope |
|-------------|----------|-------|
| New apps must target **API 35** | August 31, 2025 | New app submissions |
| Existing apps must target **API 34+** | August 31, 2025 | All app updates |
| Extension available (request in Play Console) | November 1, 2025 | Per-app extension |
| Apps targeting < API 34 invisible to new users on newer Android versions | Ongoing | Discoverability |

**Consequence of missing deadline:** Apps that do not meet targetSdk requirements are blocked
from publishing updates to users on newer Android versions, even if the app itself is not removed.

**Android 15 behavioral changes that must be handled (targetSdk 35):**
- Predictive back gesture (requires `BackHandler` for screen-enum navigation)
- Edge-to-edge layout enforcement (requires `enableEdgeToEdge()` + inset handling)
- `SCHEDULE_EXACT_ALARM` behavior changes (affects alarm/reminder features)
- Health connect permissions changes (affects fitness/health apps)

---

## Step 2 — BINARY FORMAT (AAB MANDATORY)

**Android App Bundle (.aab) is mandatory for all new app submissions and updates.**

- `.apk` files are not accepted for new apps or updates on Google Play
- AAB requires enrollment in Play App Signing (inseparable)
- Average 15–20% smaller download size vs. universal APK
- Dynamic Feature Delivery and Play Asset Delivery are supported

**Play App Signing:**
- Two-key system: upload key (you hold) + app signing key (Google holds in secure infrastructure)
- Losing your upload key: Google provides a key reset process via support request
- Enrolling is irreversible — once enrolled, Play App Signing cannot be removed
- New apps since 2021 are automatically enrolled; no opt-in required

---

## Step 3 — GOOGLE PLAY BILLING (US POLICY CHANGE, 2025)

**Critical: US billing exclusivity ended September 12, 2025 (Epic Games injunction upheld).**

| Region | Policy |
|--------|--------|
| **United States** | Google Play Billing is no longer exclusively required. Developers may offer alternative payment methods and link to external purchase flows. |
| **EEA (European Economic Area)** | External payment options allowed under DMA obligations (separate program). |
| **All other regions** | Mandatory Google Play Billing (or approved alternative program) remains in effect. |

**Billing Library version requirement (separate from exclusivity):**
- Minimum **Billing Library v7.0.0** required for all apps using IAP — effective August 31, 2025
- Extension to November 1, 2025 available via Play Console
- **v8.0.0 is current (Dec 2025)** — v7 supported but v8 migration recommended before Aug 2026
  - v8 key change: `queryPurchaseHistory*` APIs removed; use `queryPurchasesAsync` for active purchases
- Current project uses v7.1.1 — migration to v8 required before August 31, 2026

---

## Step 4 — PHOTO PICKER POLICY (ENFORCED MAY 28, 2025)

**Non-compliant apps are subject to removal as of May 28, 2025.**

| App type | Policy requirement |
|----------|--------------------|
| Apps needing one-time / infrequent image access | Must use the Android Photo Picker model; broad media permission is not justified |
| Apps needing persistent / broad media library access | Must submit a declaration form in Play Console and pass an access review |

**Timeline:**
- January 22, 2025: Apps without declaration form blocked from updates if requesting broad media permissions
- May 28, 2025: Full enforcement — non-compliant apps subject to removal

Implementation pattern belongs to `skill_android_play_store_compliance`, which carries the concrete
`PickVisualMedia` guidance and manifest audit.

---

## Step 5 — ACCESSIBILITY SERVICE POLICY (ENFORCED JANUARY 28, 2026)

**Non-disability use of `AccessibilityService` is prohibited. Enforcement date: January 28, 2026.**

| Use case | Status |
|----------|--------|
| Screen readers, switch input, Braille, voice control for disabled users | Permitted — `isAccessibilityTool="true"` eligible |
| Foreground app detection, keep-awake, automation, monitoring | **PROHIBITED** — app suspension + possible account termination |
| Content scraping, UI interaction automation | **NEVER PERMITTED** |

**example_app_four impact:** The current `BIND_ACCESSIBILITY_SERVICE` foreground-detection approach
is a policy violation as of January 28, 2026. Migration to `UsageStatsManager +
PACKAGE_USAGE_STATS` is required before any Google Play submission. The concrete migration pattern
lives in `skill_android_play_store_compliance`.

---

## Step 6 — PERMISSIONS POLICY

**Key rules for utility apps:**

| Permission | Policy |
|------------|--------|
| `READ_EXTERNAL_STORAGE` | No-op on API 33+; do not declare for apps targeting API 33+ |
| `WRITE_EXTERNAL_STORAGE` | No-op on API 33+; use `ACTION_CREATE_DOCUMENT` (SAF) instead |
| `READ_MEDIA_IMAGES` | Requires broad access review — use Photo Picker for standard use cases |
| `MANAGE_EXTERNAL_STORAGE` | Restricted; requires Play Console review and documented justification |
| `INTERNET` | Normal permission; declare only if actually used |

Implementation-side manifest audit belongs to `skill_android_play_store_compliance`. This skill owns
the policy threshold and the Play Console consequences.

---

## Step 7 — CONTENT RATING AND DATA SAFETY

**Content Rating (IARC):**
- Complete the IARC questionnaire in Play Console — mandatory for all apps
- Generates simultaneous ratings from ESRB, PEGI, USK, ClassInd, ACB, GSRR, and others
- **January 31, 2026:** All existing apps must complete a re-rating review cycle
- Update rating whenever content or features change materially

**Data Safety section:**
- Mandatory for all apps — no exceptions
- Even apps that collect no data must complete the form declaring that
- Privacy policy URL required: publicly accessible, non-PDF, non-geofenced URL
- Privacy policy must also be accessible within the app itself
- Google uses ML to cross-check declared data vs. SDK runtime behavior — accurate declarations are enforced
- Third-party SDK data collection counts as your collection — declare all SDKs' behavior

**For offline utility apps with no billing SDK (example_app_four pattern):**
- Declare: no data collected or transmitted
- Privacy policy must state "All processing occurs locally on device. No data is collected or transmitted."
- Verify no analytics SDK is linked in the APK (use APK Analyzer in Android Studio)

**For utility apps that include RevenueCat or any billing SDK:**
Local file/image/PDF processing is not collected data — that remains correct. However,
RevenueCat transmits purchase history off-device. RevenueCat's own Play Data Safety
documentation requires declaring **purchase history as collected financial information**.
Apps with RevenueCat cannot answer "No data collected" in the Data Safety form.

| App | Local processing | RevenueCat present | Data Safety answer |
|-----|-----------------|-------------------|--------------------|
| example_app_one (Play flavor) | ✓ local only | ✓ YES | Declare purchase history |
| example_app_two (Play flavor) | ✓ local only | ✓ YES | Declare purchase history |
| example_app_three (Play flavor) | ✓ local only | ✓ YES | Declare purchase history |
| example_app_four | ✓ local only | ✗ NO | "No data collected" (if no other SDK transmits) |

Privacy policy text for billing apps:
> *"All file, image, and PDF processing occurs locally on your device and is never transmitted
> to any server. Purchase transactions are processed by Google Play and RevenueCat in
> accordance with their respective privacy policies."*

**Rule:** Third-party SDK data collection counts as your collection. Audit every SDK in the
APK (including transitive dependencies via APK Analyzer) before completing the Data Safety
form. RevenueCat purchase history is the most commonly missed declaration in this codebase.

---

## Step 8 — ASSET REQUIREMENTS (EXACT SPECS)

| Asset | Dimensions | Format | Limit | Required |
|-------|-----------|--------|-------|---------|
| App icon | **512 × 512 px** | 32-bit PNG with alpha | 1 MB | Yes |
| Feature graphic | **1024 × 500 px** | JPEG or 24-bit PNG (no alpha) | — | Yes |
| Phone screenshots | **1080 × 1920 px** (portrait) or 1920 × 1080 (landscape) | JPEG or PNG | 8 MB each | Min 2, max 8 |
| Tablet screenshots | Min short edge 1080 px; long edge up to 7680 px | JPEG or PNG | 8 MB each | Min 4 (recommended) |
| Short description | 80 characters max | Text | — | Yes |
| Full description | 4000 characters max | Text | — | Yes |

**Icon rules:**
- Do not pre-round corners or add circular backgrounds — export as full-bleed square
- Google Play rounds corners and applies the shape based on device launcher
- Adaptive icon in the APK (`mipmap-anydpi-v26/`) is separate from the store listing icon

For the upload artifact itself, pair with `skill_android_app_bundle`. This skill covers the Play
Console policy side; the AAB skill covers bundle generation and post-bundle validation.

---

## Step 9 — PLAY INTEGRITY API (SAFETYNET SHUT DOWN)

**SafetyNet fully shut down May 20, 2025.** Any app still calling SafetyNet APIs receives errors.

Play Integrity API replaces SafetyNet:
- Returns: `appIntegrity` (unmodified from Play?), `deviceIntegrity`, `accountDetails`
- **Requires server-side validation** — do not evaluate the verdict on-device
- Register app in Play Console (Integrity section) before calling the API
- Hardware-backed security signals now required for `MEETS_STRONG_INTEGRITY` verdict (May 2025)

**For utility apps with no integrity checks:** Not required. Only needed if the app has
anti-tamper requirements or verifies purchases server-side.

---

## Step 10 — NATIVE CODE: 64-BIT AND 16KB PAGE SIZE

| Requirement | Scope | Deadline |
|-------------|-------|----------|
| 64-bit libraries required alongside 32-bit | All apps with native code | Already enforced |
| 16KB page size support | Apps targeting API 35+ with native code | November 1, 2025 |
| Google TV / Android TV 64-bit + 16KB | TV apps with native code | August 2026 |

**Fix for 16KB page size:** Build with NDK r28+ or AGP 8.5.1+ — both enable 16KB alignment
automatically for uncompressed shared libraries. Pure Kotlin/Java apps are unaffected.

---

## Step 11 — CRITICAL DEADLINE SUMMARY

| Date | Requirement | Status |
|------|------------|--------|
| January 22, 2025 | Broad media permissions declaration required | **PASSED** |
| May 20, 2025 | SafetyNet shut down → Play Integrity API mandatory | **PASSED** |
| May 28, 2025 | Photo Picker policy fully enforced | **PASSED** |
| August 31, 2025 | Target API 35 for new/updated apps; Billing Library v7 min | **PASSED** |
| November 1, 2025 | Extension deadline (API 35 + 16KB page size) | **PASSED** |
| January 28, 2026 | AccessibilityService non-disability use enforcement | **PASSED** |
| January 31, 2026 | IARC content rating re-review for all existing apps | **PASSED** |
| **August 2026** | Billing Library v7 EOL → v8 required | **UPCOMING** |
| **September 2026** | Developer identity verification mandatory (initial countries) | **UPCOMING** |
| **August 2026** | Google TV/Android TV 64-bit + 16KB page size | **UPCOMING** |

---

## Hard Rules

1. Never submit a new app or update to Google Play targeting below API 34 — updates will be blocked.
2. Never submit APK format to Google Play for new apps — AAB only.
3. Never use `READ_EXTERNAL_STORAGE` or `WRITE_EXTERNAL_STORAGE` in apps targeting API 33+ — use SAF.
4. Never use `GetContent()` for image selection — Photo Picker (`PickVisualMedia`) only since May 2025.
5. Never use AccessibilityService for non-disability use cases — enforcement was January 28, 2026.
6. Never complete the Data Safety form inaccurately — ML enforcement cross-checks SDK behavior.
7. Never use Play Billing Library below v7.0.0 — blocked as of August 31, 2025.
8. Plan Billing Library v7 → v8 migration before August 31, 2026 — v7 EOL.
9. Never retain SafetyNet API calls — shut down May 20, 2025; calls will error.
10. Always provide a publicly accessible, non-PDF privacy policy URL — required for Data Safety and store listing.
11. Never treat this file as the implementation guide for manifest/runtime compliance. Pair it with
    `skill_android_play_store_compliance` for code-level changes and `skill_android_app_bundle` for
    AAB/release artifact work.

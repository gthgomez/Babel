<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: Amazon Appstore (v1.0)

**Category:** Mobile
**Status:** Active
**Pairs with:** `domain_android_kotlin`
**Activation:** Load for any task that touches Amazon Appstore submission, Amazon IAP integration,
Fire OS compatibility, or multi-store build strategy targeting Amazon.

**Research basis:** Amazon developer portal (developer.amazon.com), verified March 2026.
Key policies sourced from official Amazon documentation updated December 2025 and February 2026.

---

## Purpose

Amazon Appstore is distributed on Fire tablets, Fire TV, and Amazon-branded Android devices across
250+ million devices in 236+ countries. It runs on Fire OS, which is an Android fork — most
standard Android apps port with minimal changes, but there are two hard blockers that catch
developers by surprise:

1. **Google Play Billing CANNOT be used.** Amazon requires its own IAP SDK or the Appstore
   Billing Compatibility SDK for any paid features.
2. **Google services (FCM, Google Sign-In, Maps) are not available.** Each must be replaced
   with an Amazon equivalent or removed.

Every other difference is manageable. These two are ship-blockers.

---

## Step 1 — BINARY FORMAT

**Both APK and AAB are accepted as of 2025.**

| Format | Status | Notes |
|--------|--------|-------|
| APK | Accepted | Classic submission path; still fully supported |
| AAB | Accepted | Amazon uses bundletool 1.11 to convert bundles to optimized APKs |
| Dynamic Feature Modules | NOT supported | Merged into base APK at install time regardless of manifest |
| Non–install-time asset packs | NOT supported | Only install-time asset delivery is processed |
| Instant Apps | NOT supported | |
| App Submission API | AAB NOT supported | Programmatic submission via API still requires APK |

**Recommendation for dual-store (Google Play + Amazon):** Use product flavors to manage
store-specific billing. Build the `amazon` flavor as APK for reliability — AAB is safe but
the App Submission API limitation means manual portal uploads are required regardless.

---

## Step 2 — BILLING: AMAZON IAP (MANDATORY)

**Google Play Billing is not available on Amazon devices. Using it causes a crash.**

Two Amazon IAP options:

| SDK | When to use | Notes |
|-----|-------------|-------|
| **Appstore SDK (native IAP)** | New Amazon-targeted builds | Full control, native Amazon purchase UX |
| **Appstore Billing Compatibility SDK** | Porting from Google Play with minimal code changes | Drop-in replacement layer; wraps Google Play Billing API calls |

**Appstore SDK key classes (native IAP):**

```kotlin
// Gradle dependency (add to amazon flavor only)
implementation("com.amazon.device:appstore-sdk:3.0.5")  // verify current version in portal

// Register listener in Activity.onCreate
PurchasingService.registerListener(context, object : PurchasingListener {
    override fun onUserDataResponse(response: UserDataResponse) { /* get userId */ }
    override fun onProductDataResponse(response: ProductDataResponse) { /* cache ProductData */ }
    override fun onPurchaseResponse(response: PurchaseResponse) {
        if (response.requestStatus == PurchaseResponse.RequestStatus.SUCCESSFUL) {
            // Grant entitlement — MUST call notifyFulfillment after granting
            PurchasingService.notifyFulfillment(response.receipt.receiptId,
                FulfillmentResult.FULFILLED)
        }
    }
    override fun onPurchaseUpdatesResponse(response: PurchaseUpdatesResponse) {
        // Restore purchases — call on every app start and onResume
        response.receipts.forEach { receipt ->
            if (!receipt.isCanceled) { /* restore entitlement */ }
        }
    }
})

// Launch purchase
PurchasingService.purchase(SKU_ID)  // SKU must match Developer Console entry exactly

// Restore on start/resume (equivalent to queryPurchasesAsync)
PurchasingService.getPurchaseUpdates(false) // false = since last call; true = all history
```

**Critical difference from Google Play Billing:**
- Amazon uses `notifyFulfillment()` instead of `acknowledgePurchase()` — same concept, different API.
- Failure to call `notifyFulfillment(FULFILLED)` causes Amazon to treat the purchase as pending.
- Purchase restoration uses `getPurchaseUpdates()` not `queryPurchasesAsync()`.
- SKU IDs are configured in Developer Console (not in code) — must match exactly.

**Billing isolation rule:** The same `BillingGateway` interface pattern applies.
`AmazonIapGateway` implements `BillingGateway`. The ViewModel never imports Amazon IAP directly.

---

## Step 3 — GOOGLE SERVICES REPLACEMENT

Google services do not exist on Fire OS. Apps that call them at runtime will crash.

| Google Service | Amazon Replacement | Notes |
|---------------|-------------------|-------|
| Firebase Cloud Messaging (FCM) | **A3L Messaging SDK** | Amazon's push notification system |
| Google Sign-In | **A3L Authentication SDK** | Amazon Login (Login with Amazon) |
| Google Maps / Location | **A3L Location SDK** | AWS Location Service integration |
| Google Play Billing | Amazon IAP SDK | See Step 2 |
| Google Analytics / Firebase Analytics | Remove or use Amazon alternative | No direct equivalent |
| Firebase Crashlytics | Remove or use alternative (Bugsnag, etc.) | Firebase not available |
| Play Integrity API | Amazon Device Messaging or custom | Different attestation model |

**Recommendation for utility apps with no Google services dependency:**
example_app_one, example_app_two, and example_app_three use no Google services beyond Play Billing.
The only change required is swapping the billing implementation via a product flavor.

---

## Step 4 — UNSUPPORTED FEATURES

These features are not supported on Fire OS and must be absent from the Amazon build:

| Feature | Why unsupported |
|---------|----------------|
| Android Themes/Wallpapers apps | Fire OS system integration not available |
| Custom keyboard apps | Fire OS keyboard API differs |
| Home screen widget apps | Fire OS launcher API differs |
| Lock screen customizations | Not available |
| `disable_keyguard` permission | Blocked |

For utility image/file apps: none of these apply. No changes needed.

---

## Step 5 — ASSET REQUIREMENTS

Submit via Amazon Developer Console (developer.amazon.com).

| Asset | Dimensions | Format | Required |
|-------|-----------|--------|---------|
| Small icon | 114 × 114 px | PNG | Yes |
| Large icon | 512 × 512 px | PNG | Yes |
| Screenshots | Min 1280×720 or 720×1280 (phone) | PNG or JPEG | Min 3 required |
| Promotional image | 1024 × 500 px | PNG or JPEG | Recommended |
| Preview video | Up to 5 min | MP4 | Optional |

**Screenshot notes:**
- Minimum 3 screenshots required
- Amazon recommends showing the app in use on actual device UI
- Screenshots are used for both phone and tablet listings unless separate tablet assets uploaded

**Verify current limits in Developer Console** — Amazon asset requirements have been
updated periodically and may differ from values above.

---

## Step 6 — CONTENT RATING

**Amazon uses its own content rating system** — not IARC.

- Complete Amazon's content questionnaire in Developer Console during submission
- Amazon generates a content rating based on your answers (content descriptors + age rating)
- Ratings apply per country/region
- Inaccurate ratings can result in app removal
- Re-rate whenever content or features change materially

---

## Step 7 — REVIEW PROCESS

| Stage | Typical Timeline |
|-------|----------------|
| Binary validation (automated) | 30–90 minutes (continuous publish cycle) |
| Content/functionality review | 1–3 business days for most apps |
| First submission (new developer) | Up to 5 business days |
| Automated testing (App Testing Service) | Runs in parallel with review |

**Amazon App Testing Service (ATS):**
- Automated test suite runs against your APK/AAB before human review
- Tests for: crashes on launch, basic navigation, payment flows, device compatibility
- ATS failures are common rejection reasons — test on a physical Fire device first
- Use the Fire tablet emulator (available in Android Studio) for basic compatibility testing

**Common rejection reasons:**
- Crashes at launch on Fire OS (often due to missing Google services calls)
- Google Play Billing present (must be replaced for Amazon builds)
- Google services called at runtime (FCM, Maps, Play Integrity)
- Privacy labels not completed
- Metadata mismatch (description promises features not in app)
- Unsupported features in app (custom keyboard, lock screen, etc.)

---

## Step 8 — DUAL-STORE BUILD STRATEGY

For apps targeting both Google Play and Amazon Appstore:

```kotlin
// build.gradle.kts
android {
    flavorDimensions += "store"
    productFlavors {
        create("googlePlay") {
            dimension = "store"
            // default — uses ExampleBillingGateway
        }
        create("amazon") {
            dimension = "store"
            applicationIdSuffix = ""  // keep same package name for Amazon
            // uses AmazonIapGateway
        }
    }
}

// src/googlePlay/java/.../billing/BillingModule.kt  — provides ExampleBillingGateway
// src/amazon/java/.../billing/BillingModule.kt      — provides AmazonIapGateway
// src/main/java/.../billing/BillingGateway.kt       — shared interface (unchanged)
```

**Revenue share:**
- Amazon: 70/30 developer/Amazon for standard apps
- Amazon: **80/20** for developers earning under $1M annually (Amazon's Small Business Accelerator)
- Amazon: subscriptions follow standard 70/30

---

## Hard Rules

1. Never ship an Amazon build with Google Play Billing — it will crash on Fire OS devices
   because Play Store services are not installed.
2. Never call any Google service (FCM, Google Sign-In, Maps, Play Integrity) from the Amazon
   build without confirming Fire OS has an equivalent — it will crash.
3. Never assume AAB dynamic delivery works — all AAB modules are merged to a universal APK;
   test with a real Fire device or emulator, not just a standard Android emulator.
4. Never forget `notifyFulfillment(FULFILLED)` after a successful Amazon IAP — failure to call
   it leaves the purchase in pending state; Amazon may not immediately refund but the UX breaks.
5. Never skip `getPurchaseUpdates()` on app start and every `onResume` — same pattern as
   `queryPurchasesAsync` on Google Play.
6. Minimum 3 screenshots required — fewer will block submission.
7. Always test the Amazon build on a physical Fire device or the Fire OS emulator before
   submission — Fire OS has subtle differences from stock Android that only surface at runtime.


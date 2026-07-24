<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: Samsung Galaxy Store (v1.0)

**Category:** Mobile
**Status:** Active
**Pairs with:** `domain_android_kotlin`
**Activation:** Load for any task that touches Samsung Galaxy Store submission, Samsung IAP
integration, Galaxy Store-specific compliance, or multi-store build strategy.

**Research basis:** Samsung developer portal (developer.samsung.com), verified March 2026.
Deadlines and policy details sourced directly from Samsung developer documentation.

---

## Purpose

Samsung Galaxy Store has its own submission portal (Seller Portal), its own IAP SDK, its own
revenue share terms, and its own compliance requirements that differ from Google Play. A build
that passes Google Play review is not automatically compliant with Galaxy Store.

The most dangerous divergence for monetized apps: **Samsung IAP is optional** — unlike Amazon,
you can use Google Play Billing on Galaxy Store — but Samsung IAP offers better revenue share
and Samsung Rewards integration for Samsung device owners.

---

## Step 1 — BINARY FORMAT

**Both APK and AAB are accepted.**

| Format | Status | Notes |
|--------|--------|-------|
| APK | Accepted | Standard submission path |
| AAB | Accepted | Galaxy Store generates a universal APK from the bundle |
| Play Asset Delivery | NOT supported | AAB asset packs delivered via PAD are not processed |
| Play Feature Delivery | NOT supported | Dynamic feature modules are not supported |

**Signing requirements:**
- APK Signature Scheme v1 (JAR signing) — required
- APK Signature Scheme v2 — required
- v3/v4 — accepted but not required
- Sign with your own developer keystore; do not use the debug keystore

---

## Step 2 — TARGET API LEVEL REQUIREMENTS

| Requirement | Threshold | Enforcement |
|-------------|-----------|-------------|
| Minimum targetSdk | **API 33** | Required for all new and updated app registrations |
| 64-bit binary | At least one 64-bit ABI (`arm64-v8a` or `x86_64`) | Required alongside targetSdk ≥ 33 |
| 16KB page size | Required for Android 15+ apps | **Effective July 1, 2026** — new and updated apps targeting Android 15 |

**16KB page size (July 1, 2026 deadline):**
- Affects only apps with native code (NDK/JNI)
- Fix: Build with NDK r28+ or AGP 8.5.1+ which enables 16KB alignment automatically
- Pure Kotlin/Java apps are unaffected

---

## Step 3 — DATA SAFETY (required since September 24, 2025)

**Mandatory for all new and updated apps as of September 24, 2025.**

Similar to Google Play's Data Safety section:
- Declare what data your app collects, why, and whether it's shared
- Apps that collect no data must still complete the declaration stating that fact
- Failure to provide data safety information blocks new registrations and updates
- Accessible in Seller Portal under the app's listing details

**For offline utility apps (example_app_one pattern):**
- Declare: no data collected or transmitted
- State: 100% offline processing
- Confirm: no analytics SDK, no network calls

---

## Step 4 — IN-APP PURCHASES: SAMSUNG IAP vs GOOGLE PLAY BILLING

**Google Play Billing is allowed on Galaxy Store — Samsung IAP is optional.**

This is the key difference from Amazon. Both IAP systems work on Galaxy Store.

| Option | Revenue Share | Advantages | When to use |
|--------|--------------|------------|-------------|
| Google Play Billing | 70/30 (standard) | Same code as Play build | If shipping Play + Galaxy with one APK |
| Samsung IAP | **80% paid/consumable, 85% subscriptions** (effective May 15, 2025) | Better revenue share, Samsung Rewards integration, local payment methods | Dedicated Galaxy builds or if revenue share matters |

**Samsung IAP integration (if chosen):**
- SDK: Samsung IAP v6+ (download from Samsung Developer portal)
- Unity and Unreal plugins available
- Requires Samsung Account for purchase flow (users without Samsung Account cannot purchase)
- Test with Samsung IAP Sandbox before submission
- Revenue: Samsung processes payment, remits developer share monthly

**Dual-store build strategy:**
```kotlin
// build.gradle.kts — use product flavors to isolate billing implementations
android {
    flavorDimensions += "store"
    productFlavors {
        create("googlePlay") {
            dimension = "store"
            // Uses ExampleBillingGateway
        }
        create("samsung") {
            dimension = "store"
            // Uses SamsungIapGateway (implements same BillingGateway interface)
        }
        create("amazon") {
            dimension = "store"
            // Uses AmazonIapGateway
        }
    }
}
```

**Isolation rule:** Both `SamsungIapGateway` and `ExampleBillingGateway` must implement the same
`BillingGateway` interface. The ViewModel must not know which store flavor is active.

---

## Step 5 — ASSET REQUIREMENTS

Submit via Seller Portal (seller.samsungapps.com).

| Asset | Dimensions | Format | Required |
|-------|-----------|--------|---------|
| App icon | 512 × 512 px | PNG (no alpha for main icon) | Yes |
| Feature image (promo) | 1024 × 500 px | PNG or JPEG | Yes |
| Screenshots | Min 320px / Max 3840px longest side | PNG or JPEG | Min 4, Max 8 |
| Preview video | Up to 2 min | MP4 | Optional |

**Screenshot notes:**
- Minimum 4 screenshots required (vs 2 on Google Play)
- Portrait orientation recommended for phone apps
- Must show actual app UI — no placeholder screens
- Can include both phone and tablet screenshots

**Verify exact limits in Seller Portal** — Samsung occasionally updates asset constraints
without publishing developer blog announcements.

---

## Step 6 — CONTENT RATING

**Samsung uses IARC (International Age Rating Coalition)** — the same system as Google Play.

- Complete the IARC questionnaire in Seller Portal
- Ratings from multiple regional authorities are generated automatically (ESRB, PEGI, USK, etc.)
- All apps must have a content rating — unrated apps cannot be distributed
- Rating must be updated whenever content or features change materially

---

## Step 7 — REVIEW PROCESS

| Stage | Typical Timeline |
|-------|----------------|
| Binary validation (automated) | Minutes–hours |
| Content/policy review (manual) | 1–5 business days |
| First submission (new developer) | Up to 7 business days |
| Update review (established app) | 1–3 business days |

**Common rejection reasons:**
- Missing or incorrect data safety declaration
- Signing issues (unsigned, debug keystore, v1 signature missing)
- Screenshot requirements not met (fewer than 4, or showing incorrect UI)
- Content not matching declared category
- Samsung IAP not integrated when app claims Samsung-native IAP (if that was declared)
- targetSdk below 33

---

## Step 8 — SELLER PORTAL ACCOUNT SETUP

Required before any submission:
1. Create a Samsung Developer account at developer.samsung.com
2. Enroll as a Seller in Seller Portal (seller.samsungapps.com) — separate from developer account
3. For paid apps: complete commercial seller verification (may require business documents)
4. Bank account information required for revenue payouts
5. Revenue threshold for payout: varies by region (check current Seller Portal settings)

---

## Hard Rules

1. Never use the debug keystore for a Galaxy Store submission — sign with your release keystore.
2. Never assume Play Asset Delivery or Play Feature Delivery works — AABs on Galaxy Store
   are converted to universal APKs; dynamic modules are merged at install time.
3. Never skip the data safety declaration — required since September 24, 2025; updates are blocked without it.
4. Never target API below 33 — Galaxy Store rejects new registrations and updates below this threshold.
5. By July 1, 2026: all new/updated apps with native code targeting Android 15+ must be 16KB page-size compliant.
6. If using Samsung IAP: Samsung Account is required for purchases — document this UX difference.
7. Minimum 4 screenshots required — 2 is not sufficient for Galaxy Store (differs from Google Play).

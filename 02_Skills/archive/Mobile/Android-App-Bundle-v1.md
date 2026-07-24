<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: Android App Bundle Packaging (v1.0)

**Category:** Mobile
**Status:** Active
**Pairs with:** `domain_android_kotlin`
**Activation:** Load for any task that touches AAB generation, release packaging, Play App Signing,
bundletool validation, store-specific build outputs, product-flavor distribution, or cross-store
artifact selection.

**Research basis:** Android Developers + bundletool guidance, plus store-processing rules already
captured in the Google Play, Samsung Galaxy Store, and Amazon Appstore mobile skills. Verified
against the Babel mobile stack March 2026.

---

## Purpose

Android App Bundles are not just "another release file format." They change what gets signed,
tested, uploaded, and installed:

- the `.aab` is the source artifact for a store pipeline, not the installable artifact on-device
- Google Play converts the bundle into split APKs and re-signs the delivered artifacts under Play
  App Signing
- Samsung and Amazon accept AABs but do not support the full Play delivery model

The most common AAB failures are operational, not code-level:

- testing only a universal debug APK while shipping an untested `.aab`
- assuming Play-only dynamic delivery works on Samsung or Amazon
- validating an `.aab` with APK-only tooling
- building the wrong flavor and uploading the wrong store contract

This skill converts those packaging failures into explicit release-plan checks.

---

## Step 1 — PACKAGING MODEL

Treat the artifact chain as:

```text
Gradle source -> bundleRelease / bundle<Flavor>Release -> .aab
              -> store processing or bundletool -> APK set / universal APK
              -> device install / review / production rollout
```

**Rules:**

1. `.aab` is the publication artifact. It is not installed directly on a device.
2. Device validation must happen on generated APKs (`bundletool build-apks` / install output), not
   only on the pre-bundle debug variant.
3. Signing differs by surface:
   - Google Play upload: sign the AAB with the upload key
   - Google Play delivery: Play re-signs distributed APKs
   - Samsung/Amazon: store-specific processing still ends in APK delivery; your release signing
     expectations must match that store

---

## Step 2 — STORE ARTIFACT MATRIX

| Store | Primary upload artifact | AAB support | Critical limitation |
|-------|-------------------------|-------------|---------------------|
| Google Play | **AAB** | Mandatory for new apps and updates | Play-only delivery features allowed |
| Samsung Galaxy Store | AAB or APK | Accepted | No Play Asset Delivery / Play Feature Delivery |
| Amazon Appstore | AAB or APK | Accepted | App Submission API still requires APK; no dynamic feature delivery |

**Cross-store rule:** If a build must ship outside Google Play, assume Play-only delivery features
are unavailable until proven otherwise.

That means:

- no Play Feature Delivery assumptions for Samsung/Amazon
- no non-install-time asset pack assumptions for Samsung/Amazon
- smoke-test the generated store-ready APK behavior, not just the bundle output path

---

## Step 3 — BUILD OUTPUTS AND LOCAL VALIDATION

Use the store/variant-specific Gradle task that matches the distribution target:

```text
./gradlew bundleRelease
./gradlew bundleGooglePlayRelease
./gradlew bundleSamsungRelease
./gradlew bundleAmazonRelease
```

**Validation flow:**

1. Build the release bundle for the intended flavor.
2. Convert the bundle to an APK set locally with `bundletool`.
3. Install or extract the generated APKs for device testing.
4. Verify the expected billing/store flavor actually compiled into that build.

Example:

```text
bundletool build-apks --bundle app-googlePlay-release.aab --output app.apks --ks <keystore>
bundletool install-apks --apks app.apks
```

**Rule:** A release plan that changes packaging, flavors, or store targets is incomplete unless it
states which Gradle bundle task and which post-bundle validation path will be used.

---

## Step 4 — FLAVOR AND DISTRIBUTION BOUNDARY

When multiple stores are involved, the packaging boundary must be explicit:

```text
src/main/         -> shared app code and shared BillingGateway interface
src/googlePlay/   -> Play-specific billing/configuration
src/samsung/      -> Samsung-specific billing/configuration
src/amazon/       -> Amazon-specific billing/configuration
```

**Checks:**

- Does the selected flavor produce the correct billing implementation?
- Does the selected flavor produce the correct manifest declarations for that store?
- Is the output artifact named clearly enough to prevent the wrong upload?
- Is the package name/application ID strategy correct for that store?

**Rule:** Never write a release plan that says only "build the app" when flavors or stores exist.
The plan must name the exact variant and upload target.

---

## Step 5 — SIDE ARTIFACTS

Bundle publishing often fails because the main artifact is ready but the supporting artifacts are
missing.

Verify whether the release flow also needs:

- `mapping.txt` for R8/ProGuard symbolication
- native debug symbols if the app includes native code
- privacy/data-safety declarations aligned with the actual packaged SDK set
- screenshot/asset updates that match the shipped variant

**Rule:** Treat the release artifact, mapping file, and store metadata as one deploy unit. A bundle
is not "ready" if the side artifacts required by the store are missing.

---

## Hard Rules

1. Never treat an `.aab` as a directly installable artifact. Validate the generated APK output.
2. Never assume Play Feature Delivery or Play Asset Delivery works on Samsung or Amazon.
3. Never upload a generic release artifact when store flavors exist. Name the exact bundle task and
   store target.
4. Never validate a cross-store release using only the Google Play path. Samsung and Amazon have
   different post-bundle processing rules.
5. Never call a release task complete without bundletool or store-equivalent validation of the
   produced APK behavior.

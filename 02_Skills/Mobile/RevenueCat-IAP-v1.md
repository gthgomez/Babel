<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: RevenueCat IAP (v1.0)

**Category:** Mobile
**Status:** Active
**Pairs with:** `domain_android_kotlin`
**Activation:** Load when integrating RevenueCat as the IAP backend for Android apps targeting
Google Play and/or Amazon Appstore behind a shared `BillingGateway` interface abstraction.
Also load when migrating from a single-store billing implementation to RevenueCat.

**Research basis:** RevenueCat Android SDK documentation and changelog (rev.cat/docs), verified
March 2026. API surface verified against RC SDK 8.x. Cross-referenced against
`skill_amazon_appstore` Step 2 and `skill_google_play_billing`.

---

## Purpose

RevenueCat is a cross-platform SDK that routes IAP through Google Play Billing (on Play
devices) or Amazon IAP (on Fire OS devices) using a unified entitlement model. When an app
targets both stores, RevenueCat replaces two separate billing implementations with one SDK
call surface — but the artifact split, the configuration class difference, and the dashboard
wiring sequence mean the integration is not as automatic as it appears.

The main risk zones:

- **Artifact confusion**: `purchases` (Play) and `purchases-amazon` (Amazon) are separate
  artifacts. Both in the same APK causes a runtime conflict.
- **Dashboard misconfiguration**: A product not attached to its entitlement causes purchases
  to succeed but `isActive` to stay `false` — no error, just permanently unlocked-looking
  purchases that don't grant access.
- **ProGuard gap**: RC does not ship consumer ProGuard rules. Silent failure in minified builds.

This skill converts those silent failure modes into explicit plan requirements.

---

## Step 1 — SDK ARTIFACT SPLIT (v9+)

**v9 architecture changed from v8.** The Amazon build now requires both core + store adapter.
Never cross-contaminate flavors.

| Role | Artifact | Flavor scope |
|------|----------|-------------|
| RC core (required by both stores) | `purchases` | `amazonImplementation` + `googlePlayImplementation` |
| Amazon store adapter | `purchases-store-amazon` | `amazonImplementation` only |
| *(Google Play is built into core — no separate Google adapter needed)* | — | — |

**Amazon artifact rename**: `purchases-amazon` → `purchases-store-amazon` in v9.
`purchases-amazon` no longer exists on Maven Central and will fail to resolve.

**Why Amazon needs both**: `purchases-store-amazon` declares `purchases` core as `runtime`
scope only (not API). Without explicitly adding `purchases`, `Purchases`, `CustomerInfo`, and
`PurchaseParams` are missing from the compile classpath. Add both explicitly.

**Play Billing in the Amazon AAR**: `purchases` core depends on `billing` (Play Billing).
Play Billing classes will be present in the Amazon APK/AAB — this is by design in v9.
RC routes to Amazon IAP because you configure with `AmazonConfiguration`, not because
Play Billing is absent. Fire OS does not call Play Billing code when using `AmazonConfiguration`.

```toml
# gradle/libs.versions.toml
[versions]
revenuecat = "9.28.1"  # verified 2026-03-28; check github.com/RevenueCat/purchases-android/releases

[libraries]
revenuecat         = { group = "com.revenuecat.purchases", name = "purchases",              version.ref = "revenuecat" }
revenuecat-amazon  = { group = "com.revenuecat.purchases", name = "purchases-store-amazon", version.ref = "revenuecat" }
```

```kotlin
// app/build.gradle.kts
"amazonImplementation"(libs.revenuecat)        // RC core — required for Purchases/CustomerInfo compile
"amazonImplementation"(libs.revenuecat.amazon) // Amazon store adapter
"googlePlayImplementation"(libs.billing)       // Direct Play Billing — no RC needed on Play flavor
```

**Rule**: `"googlePlayImplementation"` and `"amazonImplementation"` require product flavors
to be declared first (`flavorDimensions += "store"`). See `skill_amazon_appstore` Step 8
for the full dual-store flavor skeleton.

---

## Step 2 — DASHBOARD SETUP (order matters)

Complete before testing any real purchase. Entitlements are non-functional until fully wired.

| Step | Action | Where |
|------|--------|-------|
| 1 | Create a project | app.revenuecat.com → New Project |
| 2 | Add app → select store → copy **Public API key** | Project → Apps → Amazon Appstore / Google Play |
| 3 | Create Entitlement → set identifier (e.g. `pro_access`) | Project → Entitlements → Add |
| 4 | Create Product → identifier must match store SKU exactly | Project → Products → Add |
| 5 | Attach product to entitlement | Entitlement detail page → Attach |

**Step 5 is the most commonly missed.** Product exists, purchase succeeds, receipt verified —
but `customerInfo.entitlements["pro_access"]?.isActive` is `false`. Root cause: product not
attached to the entitlement. Fix: attach in dashboard, no code change needed.

**Public API key security**: The RevenueCat public API key is NOT a secret. It is safe to
ship in the APK/AAB. It is scoped read-only to your storefront and cannot modify purchases.

---

## Step 3 — CONFIGURATION BY STORE

The configuration class lives in its artifact. Each flavor's `BillingGateway` implementation
imports only its store's class.

```kotlin
// amazon flavor — src/amazon/java/.../billing/RevenueCatBillingGateway.kt
import com.revenuecat.purchases.Purchases
import com.revenuecat.purchases.amazon.AmazonConfiguration  // purchases-store-amazon artifact

override suspend fun connect() {
    if (Purchases.isConfigured) return  // idempotent guard — safe on every onResume
    Purchases.configure(
        AmazonConfiguration.Builder(context, BillingConfig.REVENUECAT_API_KEY).build()
    )
}

// googlePlay flavor — src/googlePlay/java/.../billing/RevenueCatBillingGateway.kt
import com.revenuecat.purchases.Purchases
import com.revenuecat.purchases.PurchasesConfiguration  // purchases artifact

override suspend fun connect() {
    if (Purchases.isConfigured) return
    Purchases.configure(
        PurchasesConfiguration.Builder(context, BillingConfig.REVENUECAT_API_KEY).build()
    )
}
```

`connect()` is synchronous — RC configuration does not block on network. The `suspend`
modifier in the `BillingGateway` contract is satisfied immediately; background entitlement
sync starts after.

---

## Step 4 — BILLINGGATEWAY WRAPPER PATTERN

RC must NOT be imported outside the `billing/` flavor source set.
The `BillingGateway` interface (in `src/main`) is the contract boundary.

```
src/main/java/.../billing/BillingGateway.kt              — shared interface (never touch)
src/amazon/java/.../billing/RevenueCatBillingGateway.kt  — RC impl, amazon flavor only
src/amazon/java/.../billing/BillingConfig.kt             — API key + entitlement + SKU constants
src/amazon/java/.../BillingModule.kt                     — factory: returns RevenueCatBillingGateway
src/googlePlay/java/.../BillingModule.kt                 — factory: returns ExampleBillingGateway (or RC Play impl)
```

`MainActivity` calls `BillingModule.create(context)`. Flavor source set determines which
class compiles in. ViewModel and UI never import RC classes.

**Isolation check before any billing plan:**
- `domain/` imports any RC class? → FAIL
- `processing/` imports any RC class? → FAIL
- ViewModel exposes `Purchases` or `CustomerInfo`? → FAIL
- ViewModel exposes `isProUnlocked: StateFlow<Boolean>` and `buyPro(activity)`? → PASS

---

## Step 5 — LIFECYCLE IMPLEMENTATION (v9 await* API)

RC v9 removed the two-param lambda callbacks (`getCustomerInfo { result, error -> }`).
Use the `await*` coroutine extension functions instead — they are cleaner and compile-safe.

**Import package changes in v9**:
- `PurchaseParams` moved from `com.revenuecat.purchases.models.PurchaseParams`
  → `com.revenuecat.purchases.PurchaseParams`
- Lambda callbacks removed; use `awaitCustomerInfo()`, `awaitOfferings()`, `awaitPurchaseResult()`

### connect() — configure once

```kotlin
override suspend fun connect() {
    if (Purchases.isConfigured) return
    Purchases.configure(AmazonConfiguration.Builder(context, apiKey).build())
}
```

### refreshEntitlement() — entitlement check + offering pre-fetch

Must be called on every `connect()` and every `onResume`.

```kotlin
override suspend fun refreshEntitlement() {
    if (!Purchases.isConfigured) return

    // 1. Check current entitlement state (also performs Amazon getPurchaseUpdates restore)
    try {
        val customerInfo = Purchases.sharedInstance.awaitCustomerInfo()
        _isProUnlocked.value =
            customerInfo.entitlements[ENTITLEMENT_ID]?.isActive == true
    } catch (_: PurchasesException) {
        // Network/RC error — keep current _isProUnlocked; free tier continues
    }

    // 2. Pre-fetch offering so launchPurchase() has a Package ready
    try {
        val offerings = Purchases.sharedInstance.awaitOfferings()
        cachedPackage = offerings.current?.availablePackages
            ?.firstOrNull { it.product.id == PRODUCT_ID }
    } catch (_: PurchasesException) {
        // Error — cachedPackage stays null; launchPurchase() no-ops safely
    }
}
```

### launchPurchase() — non-suspending, launches coroutine internally

`launchPurchase()` is non-suspending in the `BillingGateway` interface contract.
Use `scope.launch { }` (a `MainScope()` created in the gateway) to call `awaitPurchaseResult`.
`awaitPurchaseResult` returns `Result<PurchaseResult>` — user cancel is encoded as `null`, no throw.

```kotlin
// Field: private val scope = MainScope()

override fun launchPurchase(activity: Activity) {
    val pkg = cachedPackage ?: return  // not ready — no-op; retries on next onResume
    scope.launch {
        val result = Purchases.sharedInstance.awaitPurchaseResult(
            PurchaseParams.Builder(activity, pkg).build()
        )
        result.getOrNull()?.let { purchaseResult ->
            _isProUnlocked.value =
                purchaseResult.customerInfo.entitlements[ENTITLEMENT_ID]?.isActive == true
        }
        // null = user cancelled or IAP error — isProUnlocked unchanged
    }
}
```

**Threading**: `awaitCustomerInfo`, `awaitOfferings`, and `awaitPurchaseResult` resume
on the calling coroutine's dispatcher. `MainScope` uses `Dispatchers.Main`. Updating
`MutableStateFlow.value` from these callbacks is safe.

### dispose() — cancel the scope

```kotlin
override fun dispose() {
    scope.cancel()  // cancels any in-flight launchPurchase() coroutine
    // RC manages its own connection lifecycle — no endConnection equivalent
}
```

**Amazon-specific**: RC calls `notifyFulfillment(FULFILLED)` internally after a successful
purchase — the Amazon IAP equivalent of `acknowledgePurchase` on Google Play. You do not
need to call it manually when using RC.

---

## Step 6 — PROGUARD RULES

RC does not ship consumer ProGuard rules that cover all internal classes.
Missing rules → silent billing failure in minified release builds, working in debug.

```proguard
# RevenueCat Purchases SDK
-keep class com.revenuecat.purchases.** { *; }

# Amazon IAP SDK — transitive dependency of purchases-amazon
-keep class com.amazon.device.iap.** { *; }
```

Add to `app/proguard-rules.pro`. Re-verify after each RC major version upgrade —
internal class names may change between major versions.

---

## Hard Rules

1. The Amazon flavor REQUIRES both `purchases` (core) and `purchases-store-amazon` (store adapter).
   `purchases-store-amazon` declares `purchases` as `runtime` scope only — without adding `purchases`
   explicitly, `Purchases`, `CustomerInfo`, and `PurchaseParams` are absent from the compile classpath.
   The old v8 rule "never include both" applied to the old standalone `purchases-amazon` artifact, which
   no longer exists. In v9, both artifacts in the Amazon flavor is correct and required.
2. Never call `Purchases.configure()` without the `Purchases.isConfigured` guard.
   Calling configure twice throws `IllegalStateException`.
3. Never expose `Purchases`, `CustomerInfo`, `Package`, or any RC class outside `billing/`.
   The isolation contract is the `BillingGateway` interface — ViewModel imports nothing from RC.
4. Never call `launchPurchase()` without a prior `refreshEntitlement()` call.
   `cachedPackage` will be null and the purchase silently no-ops.
5. Never treat `awaitPurchaseResult` success as the only entitlement source of truth.
   Always call `awaitCustomerInfo()` on app start and every `onResume` for restore and cross-device sync.
6. Never skip Step 5 of dashboard setup (attaching product to entitlement).
   Purchase succeeds, receipt verifies, but `isActive` stays false. No error surfaces in-app.
7. Never ship a release build without verifying RC ProGuard rules are present.
   RC billing fails silently in minified builds. Works in debug. Broken in production.


<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: Google Play Billing Contract (v1.0)

**Category:** Mobile
**Status:** Active
**Pairs with:** `domain_android_kotlin`
**Last Verified:** 2026-04-25
**Activation:** Load for any task that touches billing, IAP entitlement, product IDs, purchase
acknowledgment, or the `billing/` layer of any monetized Android app.

---

## Purpose

Google Play Billing is the highest-risk zone in a monetized Android app. A missing
`acknowledgePurchase` call silently refunds users after 3 days. A wrong product ID produces
no error at dev time but breaks IAP in production. An unprotected billing flow in a release
build with `isMinifyEnabled = true` can lose all purchases silently if ProGuard rules are
missing.

This skill converts those silent failure modes into explicit plan requirements.

---

## Version Verification

Before recommending a Billing Library version or migration deadline:

1. Read the target project's declared dependency version.
2. Verify supported versions and release requirements in current official Google
   Play Billing documentation.
3. Cite the verification date and source.
4. Treat missing project evidence as an assumption, not as an inferred migration.

When the verified target version requires these APIs, check:

1. **Pending Purchases**: Explicitly opt-in to one-time products.
2. **Auto-Reconnection**: Use `enableAutoServiceReconnection()`.
3. **Query Parameters**: Transition from type-only queries to typed `QueryPurchasesParams`.

```kotlin
// Example initialization; verify against the target dependency version.
val pendingParams = PendingPurchasesParams.newBuilder()
    .enableOneTimeProducts()
    .build()

BillingClient.newBuilder(context)
    .enablePendingPurchases(pendingParams)
    .enableAutoServiceReconnection()
    .setListener(this)
    .build()

// 2026 Standard Query
val queryParams = QueryPurchasesParams.newBuilder()
    .setProductType(BillingClient.ProductType.INAPP)
    .build()
billingClient.queryPurchasesAsync(queryParams, listener)
```

**Key Changes in v8.x:**
- **Use `queryProductDetailsAsync`**: Do not add new `SkuDetails`-based flows.
- **External payments / alternative billing programs**: v8.2+ and v8.3 add program-specific APIs. Verify regional eligibility and policy requirements before enabling them.
- **Improved Lifecycle**: `enableAutoServiceReconnection()` handles transient service disconnects. Remove manual reconnect loops in `onBillingServiceDisconnected` when this option is enabled.


---

## Step 1 — BILLING LIFECYCLE AUDIT

Before writing any billing-related plan, verify each lifecycle step is covered:

| Step | Required Call | Risk if Missing |
|------|--------------|----------------|
| 1. Build client | `BillingClient.newBuilder(ctx).setListener(this).enablePendingPurchases(...).build()` | Crashes at connection without `enablePendingPurchases` |
| 2. Connect | `startConnection(BillingClientStateListener)` | No purchases possible without connection |
| 3. Restore entitlement | `queryPurchasesAsync(INAPP)` on every connect + onResume | User loses unlock after reinstall or device change |
| 4. Pre-fetch product details | `queryProductDetailsAsync` after connect | `launchBillingFlow` returns `BillingResponseCode.DEVELOPER_ERROR` if details not cached |
| 5. Launch purchase | `launchBillingFlow(activity, params)` with cached `ProductDetails` | Cannot launch without valid product details |
| 6. Handle result | `onPurchasesUpdated(result, purchases)` | Purchase silently dropped if not handled |
| 7. Acknowledge | `acknowledgePurchase(token)` within 3 days of purchase | Google auto-refunds unacknowledged purchases |
| 8. Disconnect | `endConnection()` in `onCleared()` | Resource leak; `BillingServiceDisconnected` on next launch |

**Rule:** Steps 3 and 7 are the most commonly broken. A plan that modifies billing must confirm
both are present and untouched.

---

## Step 2 — ISOLATION CONTRACT CHECK

Before writing any plan that touches billing, verify the isolation contract is preserved:

| Check | Pass condition |
|-------|---------------|
| `domain/` imports billing? | FAIL if any `import com.android.billingclient.*` found |
| `processing/` imports billing? | FAIL — same rule |
| ViewModel exposes raw `BillingClient`? | FAIL — only the interface is exposed |
| ViewModel exposes `isProUnlocked: StateFlow<Boolean>`? | PASS |
| ViewModel exposes `buyPro(activity: Activity)`? | PASS |
| UI calls billing methods directly? | FAIL — UI calls ViewModel only |

If any check fails, the isolation contract is broken. Fix the boundary before writing the plan.

---

## Step 3 — PRODUCT ID CONTRACT

`PRO_PRODUCT_ID` must match the product ID created in Play Console > Monetize > Products **exactly**.

| Risk | Description |
|------|-------------|
| Case mismatch | `"Pro_Unlock"` vs `"pro_unlock"` — no error at dev time, billing fails silently |
| Trailing space | `"pro_unlock "` — no error at build time |
| Wrong app product ID | Copy-paste from another app's constant — fails silently in Play Console sandbox |
| ID not yet created in Play Console | Billing returns `ITEM_UNAVAILABLE` — appears as billing unavailable, not configuration error |

**Rule:** Never change `PRO_PRODUCT_ID` without verifying the exact string in Play Console.
Treat product ID changes as `BREAKING` under BCDP — all consumers (billing gateway, Play Console,
any server-side verification) must be updated atomically.

---

## Step 4 — PROGUARD RULES

Release builds use `isMinifyEnabled = true`. Play Billing Library does not ship consumer
ProGuard rules. Missing rules cause billing calls to fail silently in production while
working correctly in debug builds.

Verify `proguard-rules.pro` contains:

```proguard
-keep class com.android.billingclient.api.** { *; }
-keep class com.android.vending.billing.** { *; }
```

If these rules are absent and `isMinifyEnabled = true`, the plan must add them before any
other billing work proceeds. A billing fix that ships without ProGuard rules is not fixed.

---

## Step 5 — ENTITLEMENT MODEL CLASSIFICATION

| Model | When appropriate | Risk |
|-------|-----------------|------|
| Client-side only | Low-value one-time unlock (< $5), no subscriptions, single device | Spoofable via APK modification; acceptable for simple utility apps |
| Server-side verification | Subscriptions, high-value unlocks (> $5), cross-device entitlement | Required: send `purchaseToken` to backend, call `Purchases.products:get` or `Purchases.subscriptionsv2:get`, grant entitlement only on `PURCHASED` state |

**Current apps use client-side only.** This is acceptable for the current one-time unlock
price tier. If a new app adds subscriptions or a higher-value unlock, the plan must include
server-side verification design using the Google Play Developer API v3 and a service account.

---

## Hard Rules

1. Never remove `acknowledgePurchase`. Never make it conditional on anything other than
   `!purchase.isAcknowledged`. It is not optional.
2. Never call `launchBillingFlow` without pre-fetched `ProductDetails`. The call fails with
   `DEVELOPER_ERROR` and there is no automatic retry.
3. Never cache entitlement state in memory across app restarts. Always call
   `queryPurchasesAsync` on every billing client connect and on every `onResume`.
4. Never change `PRO_PRODUCT_ID` without updating Play Console first. The constant is
   meaningless without a matching product in the console.
5. Never ship a release build with billing changes without verifying ProGuard rules are in place.
6. `enableAutoServiceReconnection()` handles transient network drops — it does NOT replace
   the `onResume → connect() → queryPurchasesAsync()` sequence. Both are required and serve
   different purposes. The ViewModel must still call `connect()` on `onResume`.
7. When adding `enableAutoServiceReconnection()`, remove any manual retry loop that was
   previously in `onBillingServiceDisconnected`. Keeping both fires duplicate
   `queryPurchasesAsync` calls on reconnect and creates race conditions in billing state.

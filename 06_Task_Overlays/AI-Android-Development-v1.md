<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Task Overlay: AI-Assisted Android Development (v1.0)

**Category:** Task Overlay
**Status:** Active
**Layer:** 06_Task_Overlays
**Pairs with:** `domain_android_kotlin`
**Activation:** Load for any session where an LLM is generating, reviewing, or modifying Kotlin /
Compose / billing / processing code. Provides prompt anchors and review gates that prevent the
most common AI-generated Android mistakes.

**Research basis:** Multi-LLM synthesis (ChatGPT o3, Gemini 2.5 Pro, Grok 3) cross-verified
against official Android, Kotlin, and Play documentation — March 30, 2026.

---

## Purpose

LLMs trained on Android code before 2024 default to stale patterns: NavHost navigation,
`collectAsState()`, DI frameworks, `WakeLock` for screen-keep. For this specific monorepo
stack, those defaults are all wrong. This overlay corrects them at prompt-assembly time
instead of during review.

---

## Step 1 — MANDATORY CONTEXT BLOCK

Prepend this block to every AI code-generation session for this monorepo:

```
Stack (do not suggest anything outside these versions):
- Kotlin 2.3.20, AGP 9.1.0, Compose BOM 2026.03.01, Material3
- Min SDK 26, Target SDK 35
- Single-Activity, ViewModel + StateFlow, screen enum in AppUiState — NO NavHost
- Manual constructor injection in MainActivity — NO Hilt, Dagger, Koin
- NO Room, NO local database — apps are stateless utilities
- collectAsStateWithLifecycle() always — never collectAsState()

Architecture invariants (hard rules — never violate):
- domain/ and processing/ layers: zero billing imports
- ViewModel: exposes isProUnlocked: StateFlow<Boolean> and buyPro(activity) only
- Navigation: when(state.currentScreen) { ... } — no NavController
- State mutations: state.copy(...) named parameters only
- Large objects (ByteArray, Bitmap, ProcessedImage): live in AppUiState — never in nav args
```

---

## Step 2 — PROMPT ANCHORS BY TASK TYPE

### Composable UI generation

Add to every Compose generation prompt:

> *"Do not generate NavHost, NavController, Fragment, Hilt, Dagger, or Room code.
> Screen navigation is enum-based: `when(state.currentScreen) { ... }`.
> Use `collectAsStateWithLifecycle()` — not `collectAsState()`.
> State mutations use `state.copy(...)` with named parameters.
> Apply `PaddingValues` from Scaffold — never ignore `paddingValues`."*

Additionally: paste the current `AppUiState` data class and `AppScreen` enum so the model
produces correct `state.copy()` calls and correct screen enum references.

### Billing code generation

Add to every billing task:

> *"Billing invariants (non-negotiable):
> (1) Call acknowledgePurchase for every INAPP purchase in onPurchasesUpdated — not optional.
> (2) Call queryPurchasesAsync on every BillingClient connection AND every onResume — not just first launch.
> (3) If enableAutoServiceReconnection() is present, remove any manual retry loop from onBillingServiceDisconnected — keeping both causes duplicate queryPurchasesAsync race conditions.
> (4) Grant entitlement only when PurchaseState == PURCHASED — never while PENDING.
> (5) Billing state lives exclusively in ViewModel — domain/ and processing/ have zero billing imports."*

### Image / PDF / EXIF processing code generation

Add to every processing task:

> *"Processing invariants:
> Use only AndroidX APIs available in minSdk 26.
> Never use deprecated Bitmap methods.
> Bounds-decode first (inJustDecodeBounds = true) before full decode — prevents OOM.
> Read EXIF rotation before any crop or resize math.
> Use androidx.exifinterface:exifinterface, not android.media.ExifInterface.
> Close all streams with .use { }.
> List the exact APIs you intend to use before emitting code."*

### Kotlin language features (this stack)

> *"Kotlin 2.3.x stable features to use: guard conditions in when.
> Do not use: context parameters (experimental, 2.3.20 has overload-resolution breaking changes),
> explicit backing fields (experimental), or any feature requiring an opt-in compiler flag."*

---

## Step 3 — AI CODE REVIEW CHECKLIST

Embed this checklist in every AI-driven code review prompt:

```
Review this Kotlin/Compose code against the following checklist.
Flag every violation — do not skip items.

Architecture:
[ ] No NavHost, NavController, DI framework, Room, or Fragment imports
[ ] No ByteArray or large objects in navigation arguments
[ ] Business state in ViewModel only — not in Composable remember blocks
[ ] collectAsStateWithLifecycle() used — not collectAsState()

Compose:
[ ] paddingValues from Scaffold applied to content — not ignored
[ ] LaunchedEffect keys match the values the effect depends on
[ ] No expensive work computed directly in composition body
[ ] Unstable lambdas in performance-sensitive lists wrapped in remember

Billing:
[ ] PendingPurchasesParams.newBuilder().enableOneTimeProducts() in BillingClient builder
[ ] QueryPurchasesParams used — not the removed String-type overload
[ ] acknowledgePurchase present and unconditional (only guard: !purchase.isAcknowledged)
[ ] queryPurchasesAsync called on every connect + onResume
[ ] No manual onBillingServiceDisconnected retry loop alongside enableAutoServiceReconnection()
[ ] Entitlement not granted while PurchaseState == PENDING

Security / Compliance:
[ ] No org.jetbrains.kotlin.android plugin declared alongside kotlin.compose (AGP 9.x)
[ ] FileProvider: exported=false, grantUriPermissions=true, no root-path entries
[ ] No raw file:// URIs — FileProvider URI only
[ ] No READ_EXTERNAL_STORAGE or WRITE_EXTERNAL_STORAGE on targetSdk 33+
[ ] Image selection uses PickVisualMedia (Google Play) — not GetContent
```

---

## Step 4 — TESTING ROI ORDER

When adding tests to this codebase (currently no test suite), build in this order:

| Priority | Test type | Why |
|----------|-----------|-----|
| 1 | Unit tests on processing logic (image/PDF/EXIF) | Pure Kotlin, no Android deps, highest correctness risk, easiest to AI-generate |
| 2 | ViewModel state tests chosen by exposed state type | Use direct snapshot / mutation assertions for `mutableStateOf` ViewModels, and use `Turbine` only for `StateFlow` / `Flow` surfaces. All three current `example_mobile_suite` app ViewModels use `mutableStateOf`, so their main ViewModel tests do **not** use Turbine. |
| 3 | Screenshot tests with **Roborazzi** (JVM, no emulator) — community standard in 2026 | Visual regression; only after 1+2 are stable. See `skill_android_screenshot_testing`. |
| 4 | Compose UI tests (paywall, billing unlock flow) | Highest business value; use `FakeBillingGateway` per `skill_jetpack_compose` Step 8 |
| Skip | Espresso full-app UI tests | Low ROI until processing + ViewModel coverage is solid |

**When asking an AI to generate tests:** Show one existing example test (or the function
contract) and pin the exact API being tested. AI scaffolds test fixtures well from a model —
without one, it invents test patterns incompatible with the actual architecture.

---

## Step 5 — AGENTIC WORKFLOW PATTERN

For feature additions or multi-file changes:

```
Load order for every agent session:
1. Example-Mobile-Suite-Context.md         — exact versions, invariants, high-risk zones
2. <App>/PROJECT_CONTEXT.md or QA_CHECKLIST.md — per-app constraints
3. skill_android_testing_strategy    — load first when any test planning or test writing is in scope
4. Target files (AppUiState, ViewModel, the specific screen or gateway)
5. Relevant leaf skills (billing, Compose, unit/instrumented/screenshot testing, compliance — per domain architect routing)

For UI audit / critique tasks, add `skill_android_ui_audit_review` before drafting findings or
recommended changes so the review stays grounded in the real screen inventory and returns a finished
audit deliverable instead of an evidence-only reading list.

Agent task structure:
1. PLAN — name every file to change + invariants to preserve
2. ACT — implement only those files
3. SELF-REVIEW — run the Step 3 checklist above
4. VERIFY — ./gradlew assembleDebug + manual QA_CHECKLIST.md items

Agent failure modes to guard against:
- Architectural drift: NavHost, Hilt, Room injected unprompted → enforce Step 1 context
- Stale API defaults: v7 billing patterns, deprecated Bitmap APIs → enforce Step 2 anchors
- Scope creep: agent refactors unrelated code → constrain to named files in PLAN
- Policy blindspot: accessibility, overlay, storage permissions changed without compliance check
  → require Step 3 checklist output before marking work complete
```

---

## Hard Rules

1. Never accept AI-generated billing code without verifying the Step 3 billing checklist items.
   Billing omission bugs (missing `acknowledgePurchase`, no `onResume` query) produce no compile
   error and no runtime error until money is refunded or entitlement is lost.
2. Never accept AI-generated Compose code that imports `NavHost` or any DI framework without
   an explicit architectural discussion. The enum-screen pattern is intentional.
3. Never trust an LLM's claim about Kotlin feature stability without checking the official
   Kotlin language features and proposals page. Grok stated explicit backing fields were stable
   in 2.3.x — they are experimental. Gemini stated context parameters were stable — they are
   experimental.
4. Never accept AI-generated Data Safety guidance that says "local processing = no data collected"
   without first verifying no billing or analytics SDK transmits data off-device. RevenueCat
   requires declaring purchase history as collected financial information.

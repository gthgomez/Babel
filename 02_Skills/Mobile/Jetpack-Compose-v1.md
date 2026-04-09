<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: Jetpack Compose (v1.0)

**Category:** Mobile
**Status:** Active
**Pairs with:** `domain_android_kotlin`
**Activation:** Load for any task that touches UI, Composables, screen layout, state,
side effects, or ViewModel-to-UI wiring.

---

## Purpose

Jetpack Compose is declarative but has specific failure modes that are non-obvious and
produce no compile-time errors: state held in the wrong place triggers stale UI; a
`LaunchedEffect` with the wrong key re-runs on every recomposition; ignoring `paddingValues`
from `Scaffold` clips content on Android 15; and an unstable lambda causes the entire
subtree to recompose on every parent state change.

This skill enforces the patterns that prevent those failures.

---

## Step 1 — STATE MODEL

### Where state lives

| State type | Location | API |
|-----------|----------|-----|
| UI state (screen, inputs, results, flags) | `AppUiState` data class in ViewModel | `var uiState by mutableStateOf(AppUiState())` |
| Billing entitlement | ViewModel, observed from `BillingGateway` | `StateFlow<Boolean>` → `collectAsStateWithLifecycle()` |
| Long-lived async state | ViewModel `StateFlow` | `collectAsStateWithLifecycle()` in Composable |
| Transient UI state (keyboard focus, dropdown open) | Composable-local | `remember { mutableStateOf(...) }` |
| State that must survive configuration change | Composable-local but durable | `rememberSaveable { mutableStateOf(...) }` |

**Rule:** Business state and domain results belong in the ViewModel, not in Composable
`remember` blocks. A Composable that holds business logic state will lose it on configuration
change (rotation, system font size change, language change).

### `collectAsStateWithLifecycle` vs `collectAsState`

Always use `collectAsStateWithLifecycle()` (from `lifecycle-runtime-compose`) for
`StateFlow` and `Flow` values in Composables. It stops collecting when the lifecycle is
below `STARTED`, preventing updates to a Composable that is no longer visible.
`collectAsState()` does not respect the lifecycle — it keeps collecting in the background.

```kotlin
// Correct
val uiState = viewModel.uiState  // mutableStateOf — read directly
val isProUnlocked by viewModel.isProUnlocked.collectAsStateWithLifecycle()

// Wrong
val isProUnlocked by viewModel.isProUnlocked.collectAsState()  // ignores lifecycle
```

---

## Step 2 — STATE HOISTING

A Composable is "hoisted" when its state is owned by the caller, not internally.

**Rule:** Hoist state to the lowest common ancestor that needs it. Do not hoist higher
than necessary — unnecessary hoisting increases coupling and recomposition scope.

```kotlin
// Wrong — state owned in leaf Composable, cannot be read by sibling or parent
@Composable
fun SearchBar() {
    var query by remember { mutableStateOf("") }  // lost when SearchBar leaves composition
    // ...
}

// Correct — state hoisted to caller; leaf is stateless
@Composable
fun SearchBar(query: String, onQueryChange: (String) -> Unit) {
    // ...
}
```

**When NOT to hoist:** Purely local transient state (whether a dropdown is expanded,
whether a tooltip is showing) does not need to be hoisted. Hoist only when the parent or
a sibling needs to read or change the state.

### When the single `AppUiState` pattern breaks down

The single `AppUiState` data class + `StateFlow` + enum screen pattern works well for small
utility apps. Watch for these signals that it is time to split:

| Signal | What it means |
|--------|--------------|
| One screen change invalidates unrelated screens | State is too wide — split per-screen slices |
| `state.copy()` blocks are long and touch unrelated fields | Reducer scope is too broad |
| `derivedStateOf {}` used frequently just to throttle recomposition | State changes at different frequencies; split by change rate |
| "UI-only" fields (dialog visibility, focus state) accumulating in top-level state | Local state leaking into global state; move it back to Composable-local |

**Rule:** Keep a root state only for truly shared app-level concerns (screen enum, billing
entitlement, processing result). Give each screen its own state slice when its fields
change independently of the others.

---

## Step 3 — SIDE EFFECTS

Use the correct side-effect API for the job:

| API | When to use | Key behavior |
|-----|-------------|-------------|
| `LaunchedEffect(key)` | Launch a coroutine scoped to a Composable | Re-runs when `key` changes. Cancels previous coroutine. Use `Unit` as key for run-once. |
| `SideEffect` | Synchronize Compose state to non-Compose code | Runs on every successful recomposition. Not a coroutine. |
| `DisposableEffect(key)` | Set up and tear down a non-coroutine resource | `onDispose {}` called when key changes or Composable leaves. Use for listeners, callbacks, sensors. |
| `rememberCoroutineScope()` | Launch a coroutine from an event handler (button click) | Scope tied to Composable's lifecycle. Use for user-triggered one-shots. |

**Common mistakes:**

```kotlin
// Wrong — LaunchedEffect with Unit key, but depends on a value that changes
LaunchedEffect(Unit) {
    viewModel.loadData(userId)  // userId may change — this only runs once
}

// Correct — key is the value the effect depends on
LaunchedEffect(userId) {
    viewModel.loadData(userId)
}

// Wrong — coroutine launched from event handler using LaunchedEffect
LaunchedEffect(buttonClicked) {  // triggers on every recomposition when true
    if (buttonClicked) doWork()
}

// Correct — coroutine launched from event handler using rememberCoroutineScope
val scope = rememberCoroutineScope()
Button(onClick = { scope.launch { doWork() } }) { ... }
```

---

## Step 4 — SCREEN-ENUM NAVIGATION

This project uses a screen enum in `AppUiState` instead of `NavHost`. The root Composable
resolves the current screen with `when(state.screen)`.

**Rules:**
- Never introduce `NavHost` or `NavController` without explicit discussion. The enum pattern
  avoids `ByteArray` serialization bugs and keeps all state in the ViewModel.
- Never pass a result (`ByteArray`, `ProcessedImage`, large object) through a navigation
  argument. The processed result stays in `AppUiState.result` and is read by the result
  screen from ViewModel state.
- Every screen transition that creates a back-stack expectation must have a `BackHandler`.

```kotlin
// Root Composable pattern
@Composable
fun AppRoot(viewModel: MainViewModel) {
    val state = viewModel.uiState

    BackHandler(enabled = state.screen != AppScreen.Home) {
        viewModel.onBackPressed()
    }

    when (state.screen) {
        AppScreen.Home   -> HomeScreen(state, viewModel::onAction)
        AppScreen.Edit   -> EditScreen(state, viewModel::onAction)
        AppScreen.Result -> ResultScreen(state, viewModel::onAction)
    }
}
```

---

## Step 5 — MATERIAL3 AND INSETS (Android 15 / SDK 35)

**Edge-to-edge is enforced when targeting SDK 35.** Content drawn without inset handling
is clipped under the status and navigation bars on Android 15 devices.

```kotlin
// MainActivity.onCreate()
enableEdgeToEdge()
setContent { AppTheme { AppRoot(viewModel) } }

// Scaffold — always pass paddingValues
Scaffold(
    topBar    = { TopAppBar(title = { Text("App") }) },
    bottomBar = { /* optional */ }
) { paddingValues ->
    // paddingValues MUST be consumed — never ignored
    Column(modifier = Modifier.padding(paddingValues)) {
        ScreenContent()
    }
}
```

**Rule:** If a Composable receives `PaddingValues` as a parameter, it must apply them.
Discarding `paddingValues` is the most common source of content clipping on Android 15.

---

## Step 6 — RECOMPOSITION DISCIPLINE

Unnecessary recomposition is the most common Compose performance problem in non-trivial UIs.

**Rules:**

1. **Avoid reading ViewModel state at the root level unnecessarily.** Only read the state
   fields a Composable actually uses — the entire Composable recomposes when any read field
   changes.

2. **Use `derivedStateOf` for derived values** that are expensive to compute or that change
   less often than their inputs:

   ```kotlin
   // Wrong — recomputes isValid on every keystroke in any field
   val isValid = name.isNotBlank() && email.contains("@")

   // Correct — only triggers recomposition when the derived Boolean changes
   val isValid by remember(name, email) { derivedStateOf { name.isNotBlank() && email.contains("@") } }
   ```

3. **Unstable lambdas cause recomposition.** Lambdas that capture state or ViewModel
   references are considered unstable by the Compose compiler. For performance-sensitive
   lists, wrap lambdas in `remember`:

   ```kotlin
   val onItemClick = remember(viewModel) { { item: Item -> viewModel.onItemClick(item) } }
   ```

4. **`key()` for list items with identity.** Use `key(item.id)` in `LazyColumn` to help
   Compose track item identity across reordering:

   ```kotlin
   LazyColumn {
       items(items, key = { it.id }) { item -> ItemRow(item) }
   }
   ```

---

## Step 7 — ICONS: REMOVE `material-icons-extended`

`material-icons-extended` is a large artifact (~5 MB added to APK). The entire icon set is
included even if only a few icons are used. For utility apps, remove it.

**Recommended approach for 2026:**

1. Remove `implementation(libs.androidx.material.icons.extended)` from `build.gradle.kts`
2. For each icon previously used from the extended set, import it as a vector drawable:
   - Android Studio → New → Vector Asset → select the icon
   - Or download SVG from fonts.google.com/icons (Material Symbols) and import
3. Call via `Icon(painterResource(R.drawable.ic_name), contentDescription = "...")`

**Going forward:** Use **Material Symbols** (fonts.google.com/icons) for any new icons.
They support variable font axes (weight, grade, optical size) and auto-mirroring via the
`autoMirror` parameter — more capable than the old filled/outlined icon set.

**Exception:** If the app genuinely uses 30+ icons from the extended set, ProGuard shrinking
reduces the impact. Keep the dependency only in that case and verify with APK Analyzer.

---

## Step 8 — COMPOSE UI TESTING

The billing paywall and screen transitions should have automated Compose UI test coverage.

```kotlin
// Setup
androidTestImplementation("androidx.compose.ui:ui-test-junit4")
debugImplementation("androidx.compose.ui:ui-test-manifest")

// Inject fake BillingGateway via the existing interface
class FakeBillingGateway : BillingGateway {
    private val _isProUnlocked = MutableStateFlow(false)
    override val isProUnlocked: StateFlow<Boolean> = _isProUnlocked.asStateFlow()
    fun simulatePurchase() { _isProUnlocked.value = true }
    override suspend fun connect() {}
    override suspend fun refreshEntitlement() {}
    override fun launchPurchase(activity: Activity) { simulatePurchase() }
    override fun dispose() {}
}

// Test paywall unlock flow
@Test
fun lockedPreset_unlocksAfterPurchase() {
    val fakeBilling = FakeBillingGateway()
    composeTestRule.setContent {
        val vm = MainViewModel(FakeEngine(), fakeBilling)
        AppRoot(vm)
    }
    composeTestRule.onNodeWithTag("preset_locked").assertIsDisplayed()
    composeTestRule.onNodeWithTag("preset_locked").performClick()
    fakeBilling.simulatePurchase()
    composeTestRule.onNodeWithTag("preset_locked").assertDoesNotExist()
}
```

**Rule:** The paywall transition (locked → purchase → unlocked) must have a UI test before
any billing or paywall Composable is refactored. This is the highest-ROI test in the app.

---

## Hard Rules

1. Never hold business state or domain results in Composable `remember` blocks.
   They are lost on configuration change.
2. Never use `collectAsState()` for `StateFlow`. Use `collectAsStateWithLifecycle()`.
3. Never ignore `paddingValues` from `Scaffold` in an app targeting SDK 35.
4. Never pass large objects (`ByteArray`, `Bitmap`, processed results) through navigation
   arguments. Hold them in `AppUiState`.
5. Never use `LaunchedEffect(Unit)` if the effect depends on a value that can change.
   The key must be the value(s) the effect depends on.
6. Never introduce `NavHost` without explicit architectural discussion. The screen-enum
   pattern is intentional.

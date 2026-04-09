<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: Android Unit Testing (v1.0)

**Category:** Mobile
**Status:** Active
**Load order:** Load after `skill_android_testing_strategy`. That file routes to this one — do not load this file without the strategy file unless the routing decision is already resolved.
**Load before:** `skill_android_test_enforcement` — enforcement loads last.
**Takes precedence when:** Pure JVM tests are confirmed as the correct surface (routing already done).

**Pairs with:** `domain_android_kotlin`, `skill_android_testing_strategy`
**Activation:** Load for any task that adds or modifies tests in `src/test/` — pure JVM tests
that do not require a device or emulator. Covers: processing logic tests, ViewModel state
tests with Turbine, coroutine dispatch testing, and fake injection patterns.

**Companion skill:** `skill_android_instrumented_testing` — use that for tests in
`src/androidTest/` that require Context, ContentResolver, PdfRenderer, or FileProvider.

---

## Purpose

The highest-ROI tests in a utility app are pure JVM tests: they run in milliseconds, require
no emulator, and cover the two surfaces most likely to have correctness bugs — processing
algorithm logic and ViewModel state transitions.

Three failure modes this skill prevents:

1. Writing ViewModel tests without `Dispatchers.setMain` — `StateFlow` updates from coroutines
   run on `Dispatchers.Main` by default; without injecting a test dispatcher, `awaitItem()`
   hangs forever or misses emissions.
2. Testing ViewModel state by reading `uiState.value` directly — this misses interleaved
   emissions and gives false confidence. Turbine captures the full emission sequence.
3. Putting processing logic that has no `android.*` imports in `androidTest/` — those tests
   require an emulator for no reason and are 100× slower than they need to be.

**Pre-flight check before writing ViewModel tests:**

```
1. grep -n "mutableStateOf\|StateFlow" ViewModel.kt
   → mutableStateOf → read state directly after advanceUntilIdle(); Turbine is not needed
   → StateFlow      → use Turbine's test {} block

2. grep -n "launch(Dispatchers\." ViewModel.kt
   → launch(Dispatchers.Default/IO) → setMain() does NOT affect these coroutines (see Step 3B)
   → launch() or launch(Dispatchers.Main) → setMain() controls these correctly
```

---

## Step 1 — GRADLE SETUP

Add to `app/build.gradle.kts` (all test dependencies go in `testImplementation`):

```kotlin
dependencies {
    // Coroutines test utilities — runTest, TestCoroutineScheduler, Dispatchers.setMain
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.9.0")

    // Turbine — StateFlow / Flow emission testing
    testImplementation("app.cash.turbine:turbine:1.2.0")

    // JUnit 5 (recommended over JUnit 4 for new test suites)
    testImplementation("org.junit.jupiter:junit-jupiter:5.11.0")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")

    // Or JUnit 4 if you prefer the existing Android test style:
    // testImplementation("junit:junit:4.13.2")
}

// Required for JUnit 5 on Android
tasks.withType<Test> {
    useJUnitPlatform()
}
```

Version catalog entries:

```toml
[versions]
coroutinesTest = "1.9.0"
turbine = "1.2.0"
junitJupiter = "5.11.0"

[libraries]
coroutines-test = { group = "org.jetbrains.kotlinx", name = "kotlinx-coroutines-test", version.ref = "coroutinesTest" }
turbine = { group = "app.cash.turbine", name = "turbine", version.ref = "turbine" }
junit-jupiter = { group = "org.junit.jupiter", name = "junit-jupiter", version.ref = "junitJupiter" }
```

---

## Step 2 — WHAT BELONGS IN `test/` vs `androidTest/`

**Decision rule:** If the class under test has zero `import android.*` statements, it belongs
in `test/` and runs on the JVM. If it imports anything from the Android framework, it belongs
in `androidTest/` and requires a device or emulator.

| Class | Directory | Why |
|-------|-----------|-----|
| `FixConstraints.kt`, `FixResult.kt`, domain math | `test/` | Pure Kotlin data types |
| JPEG quality sweep algorithm (if extracted from Bitmap ops) | `test/` | Pure Kotlin logic |
| `MainViewModel.kt` (with fakes) | `test/` | ViewModel itself has no android.* imports |
| `BitmapFactory` / `ExifInterface` processing | `androidTest/` | Android framework APIs |
| `PdfRenderer` / `PdfDocument` processing | `androidTest/` | Android framework APIs |
| `FileProvider` / `ContentResolver` | `androidTest/` | Android framework APIs |

---

## Step 3A — VIEWMODEL STATE TESTS: `mutableStateOf` (Compose state)

When the ViewModel uses `var uiState by mutableStateOf(...)` (not `StateFlow`), state is
read directly — no Turbine needed. The test pattern is simpler:

```kotlin
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class MainViewModelTest {

    private val testDispatcher = StandardTestDispatcher()

    @Before fun setUp() { Dispatchers.setMain(testDispatcher) }
    @After  fun tearDown() { Dispatchers.resetMain() }

    @Test
    fun `processing succeeds and navigates to result screen`() = runTest(testDispatcher) {
        val engine = FakeEngine().apply { result = FixResult.Success(fakeImage()) }
        val vm = MainViewModel(engine, FakeBillingGateway())

        vm.onPhotoPicked(fakeUri)
        vm.onProcessClick()
        advanceUntilIdle()

        assertEquals(AppScreen.Result, vm.uiState.screen)
        assertNotNull(vm.uiState.result)
        assertFalse(vm.uiState.isProcessing)
    }
}
```

**Rule:** `advanceUntilIdle()` must be called after every action that launches a coroutine.
Never assert state before `advanceUntilIdle()` completes — the coroutine has not run yet.

---

## Step 3B — VIEWMODEL COROUTINES DISPATCHED TO `Dispatchers.Default`

`Dispatchers.setMain(testDispatcher)` only redirects coroutines that inherit `Main` (e.g.,
`viewModelScope.launch { }` with no explicit dispatcher). If the ViewModel explicitly names
a different dispatcher — `viewModelScope.launch(Dispatchers.Default)` — those coroutines
run on real threads and are **invisible to the test scheduler**.

**Symptom:** `advanceUntilIdle()` returns immediately, state has not changed yet, assertions fail.

**Detection:**
```
grep -n "launch(Dispatchers\." MainViewModel.kt
```

**Fix:** Add a brief real-thread wait, then drain remaining test-scheduled work:

```kotlin
/**
 * Synchronizes with coroutines dispatched to Dispatchers.Default by the ViewModel.
 * Thread.sleep gives the real thread time to complete; advanceUntilIdle() drains any
 * remaining work on the test scheduler (e.g. StateFlow/billing collection).
 */
private fun awaitDefaultDispatch(ms: Long = 200) {
    Thread.sleep(ms)
    testDispatcher.scheduler.advanceUntilIdle()
}
```

Usage:
```kotlin
vm.onPhotosPicked(listOf(testUri))
awaitDefaultDispatch()  // not advanceUntilIdle()
assertEquals(AppScreen.Preview, vm.uiState.screen)
```

**Preferred long-term fix:** Inject the dispatcher into the ViewModel constructor so tests can
substitute it. This is a production-code change — coordinate with the plan before doing it.

---

## Step 3C — VIEWMODEL STATE TESTS WITH TURBINE

**Only use Turbine when the ViewModel exposes `StateFlow`. If it uses `mutableStateOf`, use
Step 3A instead — Turbine adds complexity for zero benefit with Compose state.**

Turbine exposes a `test {}` block on any `Flow` or `StateFlow`. Inside the block, `awaitItem()`
suspends until the next emission. This captures the full state transition sequence, not just
the final value.

### Test dispatcher setup (required for StateFlow + coroutines)

```kotlin
// Extension for cleaner setup in JUnit 5 test classes
@OptIn(ExperimentalCoroutinesApi::class)
class MainViewModelTest {

    private val testDispatcher = StandardTestDispatcher()

    @BeforeEach
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
    }

    @AfterEach
    fun tearDown() {
        Dispatchers.resetMain()
    }
}
```

### ViewModel state transition test

```kotlin
@Test
fun `processing action emits loading then result screen`() = runTest {
    val engine = FakeEngine()
    val billing = FakeBillingGateway()
    val vm = MainViewModel(engine, billing)

    vm.uiState.test {
        // Initial state
        val initial = awaitItem()
        assertEquals(AppScreen.Home, initial.screen)
        assertFalse(initial.isProcessing)

        // Trigger action
        vm.onAction(UiAction.StartProcessing(fakeUri))
        testDispatcher.advanceUntilIdle()

        // Expect loading state
        val loading = awaitItem()
        assertTrue(loading.isProcessing)

        // Engine completes successfully
        testDispatcher.advanceUntilIdle()

        // Expect result screen
        val result = awaitItem()
        assertEquals(AppScreen.Result, result.screen)
        assertNotNull(result.result)
        assertFalse(result.isProcessing)

        cancelAndIgnoreRemainingEvents()
    }
}
```

### Billing entitlement state test

```kotlin
@Test
fun `purchase unlocks pro flag in ViewModel state`() = runTest {
    val billing = FakeBillingGateway()
    val vm = MainViewModel(FakeEngine(), billing)

    // Initially locked
    assertFalse(vm.uiState.value.isProUnlocked)

    // Simulate purchase
    billing.simulatePurchase()
    testDispatcher.advanceUntilIdle()

    // ViewModel reflects the unlock
    assertTrue(vm.uiState.value.isProUnlocked)
}
```

---

## Step 4 — PROCESSING LOGIC TESTS (PURE KOTLIN)

For processing logic that can be extracted from Android-specific code:

### Testing constraint math (example_app_one example)

```kotlin
class FixConstraintsTest {

    @Test
    fun `portrait image within bounds returns same dimensions`() {
        val result = FixConstraints(width = 400, height = 600).normalize(
            sourceWidth = 400, sourceHeight = 600
        )
        assertEquals(400, result.width)
        assertEquals(600, result.height)
    }

    @Test
    fun `landscape image is rotated to portrait to meet portrait constraints`() {
        val result = FixConstraints(width = 400, height = 600).normalize(
            sourceWidth = 800, sourceHeight = 400 // landscape input
        )
        // should rotate and scale to fit portrait target
        assertTrue(result.height > result.width)
    }

    @Test
    fun `quality floor is never below 35`() {
        val quality = JpegQualitySweep.findQuality(
            targetBytes = 1L,  // impossibly small target
            encode = { q -> ByteArray(q * 1000) }  // fake: size proportional to quality
        )
        assertTrue(quality >= 35)
    }
}
```

### Testing sealed result types

```kotlin
class FixResultTest {

    @Test
    fun `success carries processed image`() {
        val bytes = ByteArray(100)
        val result: FixResult = FixResult.Success(ProcessedImage(bytes, 200, 300))
        assertTrue(result is FixResult.Success)
        assertEquals(100, (result as FixResult.Success).image.bytes.size)
    }

    @Test
    fun `failure carries correct failure reason`() {
        val result: FixResult = FixResult.Failure(FixFailure.FileTooLarge)
        assertTrue(result is FixResult.Failure)
        assertEquals(FixFailure.FileTooLarge, (result as FixResult.Failure).reason)
    }
}
```

---

## Step 5 — FAKE IMPLEMENTATIONS

Fakes belong in `src/test/java/com.<app>/fakes/`. They implement the real interface and
expose control methods for tests.

```kotlin
// src/test/java/com.example_app_one/fakes/FakeExactUploadEngine.kt
class FakeExactUploadEngine : ExactUploadEngine {
    var result: FixResult = FixResult.Failure(FixFailure.ProcessingFailed)
    var processCallCount = 0

    override suspend fun process(
        context: Context,   // may be unused in fake
        uri: Uri,
        constraints: FixConstraints,
        onProgress: (Float) -> Unit
    ): FixResult {
        processCallCount++
        onProgress(1f)
        return result
    }
}

// src/test/java/com.example_app_one/fakes/FakeBillingGateway.kt
class FakeBillingGateway : BillingGateway {
    private val _isProUnlocked = MutableStateFlow(false)
    override val isProUnlocked: StateFlow<Boolean> = _isProUnlocked.asStateFlow()

    var connectCallCount = 0

    fun simulatePurchase() { _isProUnlocked.value = true }
    fun simulateRevoke() { _isProUnlocked.value = false }

    override suspend fun connect() { connectCallCount++ }
    override suspend fun refreshEntitlement() {}
    override fun launchPurchase(activity: Activity) { simulatePurchase() }
    override fun dispose() {}
}
```

**Note on `Context` in fakes:** If the ViewModel passes `Context` to the engine (which is
wrong — see architecture rules), the fake can accept it and ignore it. The preferred fix is to
remove `Context` from engine calls and pass only the URI or resolved byte streams.

---

## Step 6 — TEST NAMING CONVENTION

Use backtick names that describe behavior, not implementation:

```kotlin
// Good — describes behavior contract
fun `processing fails with constraint error when source is too small`()
fun `pro preset is gated behind billing unlock`()
fun `back press from result screen returns to home screen`()

// Bad — describes implementation
fun `testProcessReturnsFalse`()
fun `checkIsProFlagSetCorrectly`()
```

Group related tests by scenario, not by method:

```kotlin
@Nested
inner class `when processing succeeds` {
    @Test fun `screen transitions to result`() { ... }
    @Test fun `result holds processed image bytes`() { ... }
    @Test fun `processing flag is cleared`() { ... }
}

@Nested
inner class `when processing fails` {
    @Test fun `screen stays on home`() { ... }
    @Test fun `error message is shown`() { ... }
}
```

---

## Hard Rules

1. Never test ViewModel state by reading `uiState.value` directly after a coroutine-triggering
   action — the coroutine may not have completed. Use `testDispatcher.advanceUntilIdle()` and
   then read, or use Turbine's `awaitItem()` to wait for the emission.
2. Never omit `Dispatchers.setMain(testDispatcher)` in ViewModel tests. Without it, StateFlow
   emissions from `Dispatchers.Main` coroutines do not arrive in the test thread.
3. Never forget `cancelAndIgnoreRemainingEvents()` at the end of Turbine blocks. Without it,
   Turbine asserts no unconsumed events remain — a passing test can break later when a new
   emission is added.
4. Never put Android-framework-dependent code in `test/`. It compiles silently and throws
   `RuntimeException("Stub!")` at runtime with no useful error.
5. Never test the real engine via a fake — use fakes only for the ViewModel layer. Engine
   correctness tests use the real implementation in `androidTest/`.
6. Never create fakes in `src/main/` — they belong in `src/test/` only and must not ship
   in production APKs.
7. Never assume `Dispatchers.setMain()` controls all coroutines in the ViewModel. Run
   `grep -n "launch(Dispatchers\."` on the ViewModel first. Any explicit dispatcher other than
   `Main` bypasses the test scheduler — use `awaitDefaultDispatch()` (Step 3B) for those.
8. Never pull in Turbine for a ViewModel that uses `mutableStateOf`. Check state type first
   (Step 3A pre-flight). Turbine only applies to `StateFlow`/`Flow`.

<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: Android Instrumented Testing (v1.0)

**Category:** Mobile
**Status:** Active
**Load order:** Load after `skill_android_testing_strategy`. That file confirms whether `androidTest/` is the correct surface — do not load this file without the strategy file unless the routing decision is already resolved.
**Load before:** `skill_android_test_enforcement` — enforcement loads last.
**Takes precedence when:** The class under test imports `android.*` and instrumented placement is confirmed.

**Pairs with:** `domain_android_kotlin`, `skill_android_testing_strategy`
**Activation:** Load for any task that writes or modifies tests in `androidTest/`, tests that
use Android APIs (Context, ContentResolver, PdfRenderer, ActivityScenario), or any task
verifying processing engine correctness, billing flows, or Compose UI behavior.

---

## Purpose

Android instrumented tests (`androidTest/`) run on a real device or emulator and have access
to the full Android framework. They are the only way to test code that uses `Context`,
`ContentResolver`, `PdfRenderer`, `PdfDocument`, `FileProvider`, or any platform API.

Three failure modes this skill prevents:

1. Writing processor tests in `test/` (pure JVM) and having them compile but silently
   skip — Android APIs throw `RuntimeException("Stub!")` outside the Android runtime.
2. Using `context.filesDir` in tests and wondering why the test fails — the correct
   context is `InstrumentationRegistry.getInstrumentation().targetContext`, not the
   instrumentation runner's own context.
3. Forgetting to delete test-created files in `@After`, causing intermittent test failures
   when stale files from a prior run affect the next run.

---

## Step 0 — NO DEVICE AVAILABLE: PARTIAL VERIFICATION GATE

When no device or emulator is connected, instrumented tests cannot run. This is a hard
infrastructure constraint, not a test failure. The acceptable partial gate is:

```bash
# Verify instrumented tests compile without errors — catches import mistakes,
# missing dependencies, type errors. Does NOT run the tests.
./gradlew :app:compileDebugAndroidTestKotlin

# For flavored builds:
./gradlew :app:compileGooglePlayDebugAndroidTestKotlin
```

**When to use this gate:**
- CI environments without an emulator
- Local development when recording that tests are written but not yet runnable
- Unblocking dependent tasks (e.g. screenshot tests) that don't need a device

**How to record the constraint explicitly in plans and tickets:**
> "Instrumented tests compile OK (`compileDebugAndroidTestKotlin` passes). Full execution
> requires a connected device. Run command when available:
> `./gradlew :app:connectedDebugAndroidTest`"

**Starting an emulator in GitHub Actions (reference):**
```yaml
- uses: reactivecircus/android-emulator-runner@v2
  with:
    api-level: 35
    script: ./gradlew :app:connectedDebugAndroidTest
```

---

## Step 1 — PLACEMENT: `androidTest/` vs `test/` vs Robolectric

| Test type | Directory | Runtime | Use when |
|-----------|-----------|---------|----------|
| Instrumented | `src/androidTest/java/` | Real device / emulator | Anything using Android APIs, filesystem, ContentResolver, billing, PDF rendering |
| JVM unit | `src/test/java/` | JVM (no Android framework) | Pure Kotlin logic: data class transforms, parsers, domain math, algorithm correctness |
| Robolectric | `src/test/java/` with `@RunWith(RobolectricTestRunner::class)` | Simulated Android on JVM | Context-dependent but emulator-free; slower setup, not all APIs simulated accurately |

**Decision rule:** If the class under test imports anything from `android.*`, it belongs in
`androidTest/`. If it is pure Kotlin with no `android.*` imports, it belongs in `test/`.
Do not use Robolectric to avoid setting up an emulator — instrumented tests on an emulator
are the authoritative test surface for Android apps.

---

## Step 2 — CONTEXT HANDLING

Two contexts exist in the test runtime. They are not interchangeable.

| Context | How to obtain | Use for |
|---------|--------------|---------|
| `targetContext` | `InstrumentationRegistry.getInstrumentation().targetContext` | Your app's Context — cacheDir, filesDir, packageName, ContentResolver, FileProvider |
| `instrumentationContext` | `InstrumentationRegistry.getInstrumentation().context` | The test runner's own APK context — rarely needed |

```kotlin
// Correct
@Before
fun setUp() {
    context = InstrumentationRegistry.getInstrumentation().targetContext
}

// Wrong — uses the instrumentation runner's context, not your app's
context = InstrumentationRegistry.getInstrumentation().context
```

**Rule:** Always use `targetContext` when your class under test uses `context.cacheDir`,
`context.packageName`, `context.contentResolver`, or `FileProvider`.

---

## Step 3 — FIXTURE FILE CREATION

Tests that need real files (PDFs, images, documents) should create them programmatically
in `setUp()` using the same platform APIs the production code uses. This avoids binary
fixtures in the repo and keeps tests self-contained.

**Creating a fixture PDF with `PdfDocument`:**

```kotlin
private fun buildTestPdf(
    context: Context,
    pageCount: Int,
    widthPts: Int = 595,   // A4 width in PostScript points
    heightPts: Int = 842   // A4 height in PostScript points
): File {
    val doc = PdfDocument()
    for (i in 1..pageCount) {
        val pageInfo = PdfDocument.PageInfo.Builder(widthPts, heightPts, i).create()
        val page = doc.startPage(pageInfo)
        // Draw minimal content so the page is not trivially empty
        page.canvas.drawRect(
            10f, 10f,
            (widthPts - 10).toFloat(), (heightPts - 10).toFloat(),
            Paint().apply { style = Paint.Style.STROKE }
        )
        doc.finishPage(page)
    }
    val file = File(context.cacheDir, "fixture_${System.nanoTime()}.pdf")
    file.outputStream().use { doc.writeTo(it) }
    doc.close()
    return file
}
```

**Exposing a fixture file as a content URI via FileProvider:**

```kotlin
private fun fileToUri(context: Context, file: File): Uri =
    FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
```

**This works in instrumented tests** because the test APK is installed alongside the app APK,
and the app's FileProvider is active and uses `targetContext.packageName`.

---

## Step 4 — TEST LIFECYCLE AND CLEANUP

Fixture files created in `@Before` or inside test methods must be deleted in `@After`.
A stale temp file from a previous run can cause false negatives (file already exists) or
false positives (leftover valid output matches expected state).

```kotlin
@RunWith(AndroidJUnit4::class)
class MyProcessorTest {

    private lateinit var context: Context
    private val tempFiles = mutableListOf<File>()  // track all created files

    @Before
    fun setUp() {
        context = InstrumentationRegistry.getInstrumentation().targetContext
    }

    @After
    fun tearDown() {
        tempFiles.forEach { it.delete() }  // always clean up
    }

    // Register every created file for cleanup
    private fun track(file: File): File = file.also { tempFiles.add(it) }
}
```

**Rule:** Every `File` created in a test — fixture inputs AND output files from the class
under test — must be added to the cleanup list. Output files are returned by the class
under test and must be tracked explicitly.

---

## Step 5 — COROUTINE TESTING IN INSTRUMENTED TESTS

`suspend` functions must be called from a coroutine context. In instrumented tests, use
`kotlinx.coroutines.test.runTest` (preferred) or `runBlocking` (acceptable for simple cases).

```kotlin
// Preferred — uses TestCoroutineScheduler, respects virtual time, faster
@Test
fun compress_outputMeetsTarget() = runTest {
    val result = processor.compress(context, uri, 5L * 1024 * 1024, onProgress = {})
    assertTrue(result is PdfEngineResult.Success)
}

// Acceptable — blocks the thread, no virtual time, simpler setup
@Test
fun compress_outputMeetsTarget() = runBlocking {
    val result = processor.compress(context, uri, 5L * 1024 * 1024, onProgress = {})
    assertTrue(result is PdfEngineResult.Success)
}
```

**For `Dispatchers.IO` in the class under test:**
`runBlocking` + `Dispatchers.IO` in the implementation works correctly in instrumented tests —
IO dispatch is real and the test waits for the coroutine to complete.

**Rule:** Do not use `runBlocking` with `withTimeout` to gate test execution — the emulator
can be slow. Set a generous timeout at the test class level if needed, but do not treat
slow-emulator behavior as a test failure.

---

## Step 6 — FAKE INJECTION PATTERNS

The processing engine and billing gateway are both interfaces. Inject fakes in tests to
isolate the class under test.

**Fake engine (for ViewModel tests):**

```kotlin
class FakePdfEngine : PdfEngine {
    var compressResult: PdfEngineResult = PdfEngineResult.Failure(PdfFailure.ProcessingFailed)
    var mergeResult: PdfEngineResult = PdfEngineResult.Failure(PdfFailure.ProcessingFailed)

    override suspend fun compress(
        context: Context, uri: Uri, targetMaxBytes: Long, onProgress: (Float) -> Unit
    ): PdfEngineResult = compressResult

    override suspend fun merge(
        context: Context, uris: List<Uri>, onProgress: (Float) -> Unit
    ): PdfEngineResult = mergeResult

    override fun getPageCount(context: Context, uri: Uri): Int = 1
    override fun getFileSizeBytes(context: Context, uri: Uri): Long = 1024L
}
```

**Fake billing gateway:**

```kotlin
class FakeBillingGateway : BillingGateway {
    private val _isProUnlocked = MutableStateFlow(false)
    override val isProUnlocked: StateFlow<Boolean> = _isProUnlocked.asStateFlow()

    fun simulatePurchase() { _isProUnlocked.value = true }

    override suspend fun connect() {}
    override suspend fun refreshEntitlement() {}
    override fun launchPurchase(activity: Activity) { simulatePurchase() }
    override fun dispose() {}
}
```

**Rule:** Never test the `PdfProcessor` implementation via a fake engine — that tests nothing
real. Use real `PdfProcessor` for instrumented processor tests. Use fakes only when testing
the ViewModel or UI layer in isolation from the engine.

---

## Step 7 — COMPOSE UI TESTING

Compose UI tests require specific test artifacts added to `build.gradle.kts`:

```kotlin
androidTestImplementation("androidx.compose.ui:ui-test-junit4")
debugImplementation("androidx.compose.ui:ui-test-manifest")
```

**Rule:** Compose UI tests belong in `androidTest/` and use `createComposeRule()`:

```kotlin
@get:Rule
val composeTestRule = createComposeRule()

@Test
fun proUpsellCard_visibleWhenNotPro() {
    val fakeBilling = FakeBillingGateway()
    val vm = MainViewModel(FakePdfEngine(), fakeBilling, context)
    composeTestRule.setContent { example_app_twoApp(vm) }

    composeTestRule.onNodeWithText("Get Pro").assertIsDisplayed()
    fakeBilling.simulatePurchase()
    composeTestRule.onNodeWithText("Get Pro").assertDoesNotExist()
}
```

**Use `testTag` for nodes that don't have stable text:**

```kotlin
// In Composable:
Modifier.testTag("compress_cta")

// In test:
composeTestRule.onNodeWithTag("compress_cta").assertIsEnabled()
```

---

## Hard Rules

1. Never place tests that use `android.*` APIs in `src/test/`. They compile but throw
   `RuntimeException("Stub!")` at runtime. Place them in `src/androidTest/`.
2. Never use the instrumentation runner's own context. Always use
   `InstrumentationRegistry.getInstrumentation().targetContext`.
3. Never leave test-created files without a cleanup path in `@After`. Register every
   created `File` in a cleanup list immediately after creation.
4. Never test `PdfProcessor` with a fake engine. Use the real implementation and a
   programmatically generated fixture PDF.
5. Never use `runBlocking` with tight timeouts on emulator tests. Emulators are slower
   than devices; generous or no timeouts are correct.
6. Never add test artifacts (`ui-test-junit4`, `espresso-core`) to `implementation`
   scope. They must be `androidTestImplementation` only.
7. Never block a plan on instrumented test execution when no device is available. Use
   `compileDebugAndroidTestKotlin` as the partial gate (Step 0) and record the full
   run command. Never treat "no device" as a test failure.

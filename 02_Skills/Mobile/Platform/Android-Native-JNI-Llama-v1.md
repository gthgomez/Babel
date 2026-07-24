<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
status: ACTIVE
last_verified: 2026-07-03
-->

# Skill: Android Native JNI & Llama.cpp Inference (v1.0)

**Category:** Mobile
**Status:** Active
**Pairs with:** `domain_android_kotlin`
**Last Verified:** 2026-06-26
**Activation:** Load for tasks touching Kotlin-C++ JNI bridges, `libllmhost`, custom CMakeLists.txt modifications, llama.cpp integrations, and Android memory trim events.

---

## Purpose

Android native C++ execution has strict platform bounds. Hallucinated JNI types, unreleased local references, multithreaded callback synchronization errors, and heap allocation of GGUF model files trigger immediate, silent application crashes (`SIGSEGV` or `SIGABRT`) that Android's JVM cannot catch.

This skill enforces JNI safety boundaries and memory-governance rules for local LLM inference on Android devices.

---

## Step 1 — JNI Thread & Mutex Discipline

Native engines like `llama.cpp` run inference loops on background threads. Executing JNI calls from un-registered native threads will crash the app instantly.

### Rules
1. **The Native Mutex Lock:** Every JNI entry point modifying native engine state must acquire a C++ mutex lock:
   ```cpp
   #include <mutex>
   std::mutex g_engine_mutex;

   JNIEXPORT jboolean JNICALL
   Java_com_example_llmhost_NativeLlmBridge_loadModel(JNIEnv* env, jobject thiz, jstring path) {
       std::lock_guard<std::mutex> lock(g_engine_mutex);
       // Safely initialize model...
   }
   ```
2. **Attaching Native Threads:** Before calling Java methods or resolving class references from a native thread, check the JVM attachment state:
   ```cpp
   JavaVM* jvm; // Stored globally at JNI_OnLoad
   JNIEnv* env;
   bool is_attached = false;

   jint res = jvm->GetEnv((void**)&env, JNI_VERSION_1_6);
   if (res == JNI_EDETACHED) {
       if (jvm->AttachCurrentThread(&env, nullptr) == JNI_OK) {
           is_attached = true;
       }
   }

   // Perform Java callbacks here...

   if (is_attached) {
       jvm->DetachCurrentThread();
   }
   ```

---

## Step 2 — Reference Leak Avoidance

JNI local references do not get garbage collected automatically until the JNI boundary returns. Creating strings or buffers inside high-frequency loops quickly exceeds the Android local reference limit (typically 512) and aborts the VM.

### Rules
1. **Explicit Deletion:** Call `DeleteLocalRef` for all transient JNI objects (especially JNI strings and byte arrays) inside loops:
   ```cpp
   for (int i = 0; i < token_count; i++) {
       jstring token_str = env->NewStringUTF(tokens[i].c_str());
       env->CallVoidMethod(callback_obj, emit_method, token_str);
       env->DeleteLocalRef(token_str); // Prevent reference table overflow
   }
   ```
2. **Release Native Buffers:** Always call matching Release methods for retrieved arrays and strings in `finally` blocks:
   ```cpp
   const char* path_chars = env->GetStringUTFChars(path, nullptr);
   if (path_chars != nullptr) {
       try {
           engine_load(path_chars);
       } catch (...) {
           env->ReleaseStringUTFChars(path, path_chars);
           throw;
       }
       env->ReleaseStringUTFChars(path, path_chars);
   }
   ```

---

## Step 3 — Stream & Flow Normalization

The native bridge must stream generation chunks back to Kotlin as a non-blocking Flow.

### Rules
1. **The Native Generation Loop:** Native code must check a volatile cancellation flag on every token step:
   ```cpp
   // Kotlin
   @Keep
   data class GenerationChunk(
       val token: String,
       val isFinished: Boolean,
       val errorCode: Int = 0
   )

   // Native callback execution
   if (cancelled_volatile) {
       // Emit final terminal chunk
       return;
   }
   ```
2. **Non-blocking Flow Wrapping:** Wrap the JNI streaming listener in a thread-safe callbackFlow:
   ```kotlin
   fun generateText(prompt: String): Flow<GenerationChunk> = callbackFlow {
       val listener = object : NativeGenerationListener {
           override fun onToken(token: String) {
               trySend(GenerationChunk(token, isFinished = false))
           }
           override fun onComplete() {
               trySend(GenerationChunk("", isFinished = true))
               channel.close()
           }
           override fun onError(code: Int) {
               trySend(GenerationChunk("", isFinished = true, errorCode = code))
               channel.close()
           }
       }
       val jobId = startNativeGeneration(prompt, listener)
       awaitClose {
           cancelNativeGeneration(jobId)
       }
   }.flowOn(Dispatchers.IO)
   ```

---

## Step 4 — Memory Mapping GGUF via SAF (Storage Access Framework)

Loading large model binaries (e.g. 1GB–4GB GGUF models) directly into Java memory triggers immediate Out-Of-Memory (OOM) crashes. The engine must memory-map the file using a File Descriptor passed from Kotlin.

### Rules
1. **Retrieving File Descriptor:** Resolve the URI from the document picker, query its file descriptor, and pass it to JNI:
   ```kotlin
   val parcelFileDescriptor = context.contentResolver.openFileDescriptor(uri, "r")
   val fd = parcelFileDescriptor?.detachFd() ?: throw IOException("Failed to obtain FD")
   nativeLoadModelFromFd(fd)
   ```
2. **Native Memory Mapping (`mmap`):** Utilize the native file descriptor inside `llama.cpp` to perform an `mmap` call rather than copying buffers:
   ```cpp
   // C++
   #include <sys/mman.h>
   #include <unistd.h>

   void load_gguf_from_fd(int fd) {
       off_t size = lseek(fd, 0, SEEK_END);
       void* addr = mmap(nullptr, size, PROT_READ, MAP_SHARED, fd, 0);
       if (addr == MAP_FAILED) {
           close(fd);
           throw std::runtime_error("mmap failed");
       }
       // Pass addr and size to llama_model_loader...
       close(fd); // Safe to close after mmap is established
   }
   ```

---

## Step 5 — Memory Trim Hooks

Android systems throttle background apps and terminate them under memory pressure. The application must catch memory warnings and communicate them to the native C++ engine.

### Rules
1. **ViewModel Memory Warning Capture:** Override `onTrimMemory` in the MainActivity or Application, and bind it to the model governor:
   ```kotlin
   class MainApplication : Application() {
       override fun onTrimMemory(level: Int) {
           super.onTrimMemory(level)
           if (level >= TRIM_MEMORY_RUNNING_CRITICAL || level == TRIM_MEMORY_COMPLETE) {
               NativeLlmBridge.signalLowMemory()
           }
       }
   }
   ```
2. **Native Cancellation Trigger:** When low memory is signaled, the native engine must abort active generation contexts, flush temporary caches, and notify the Java layer:
   ```cpp
   void on_low_memory() {
       std::lock_guard<std::mutex> lock(g_engine_mutex);
       // Stop active token generation
       cancelled_volatile = true;
       // Clear evaluation context cache (llama_kv_cache_clear)
   }
   ```

---

## Hard Rules

1. **Never allocate large memory buffers in Java/Kotlin** for model files. Always pass file descriptors and use `mmap` on the native side.
2. **Never invoke JNI calls from native threads** without verifying or executing `AttachCurrentThread`.
3. **Never omit `DeleteLocalRef` inside loops** that produce transient JNI objects.
4. **Never compile JNI code without checking return codes** of string allocations or file operations.
5. **Always release resources in `finally` or `onDispose` blocks** (e.g. `ReleaseStringUTFChars`, `close()` on file descriptors).

---

## Boundaries — Do Not Overstep

- This skill details Android JNI and native memory boundary conventions. It does not replace the official Android NDK guide, JNI specifications, or `llama.cpp` documentation.
- Target ABI compatibility and 16 KB page alignment checks must be validated against the active NDK toolchain (`27.1.12297006` or newer).

---

## Failure Behavior of This Skill

- **JNI crashes or SEGFAULTs observed in logcat:** Immediate Halt. Check for missing pointer releases, incorrect JNI signatures, or thread attachment errors.
- **Out of Memory (OOM) during model import:** Halt. Verify that the file descriptor is detached correctly and that the native loader utilizes `MAP_SHARED` mapping.

---

## Strategic Next Move

After every substantial response, end with one strategic next-move question focused on checking the logcat output or compiler warning logs.

---

## References

- `ols-compiler` (`04_Meta_Tools/OLS-MCC/ols-compiler/SKILL.md`) — for verifying native structure rules.
- `skill_android_permissions` (`Mobile/Platform/Android-Permissions-v2.md`) — for storage access permissions required to read model files.

---

**OLS-MCC Compliance:** v1.0 compiled and validated for Phase 1 Native Integration (JNI/Llama).

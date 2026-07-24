<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
status: ACTIVE
last_verified: 2026-07-03
-->

# Skill: Android Native Oboe Audio & Emulator Scheduling (v1.0)

**Category:** Mobile
**Status:** Active
**Pairs with:** `domain_android_kotlin`
**Last Verified:** 2026-06-26
**Activation:** Load for tasks touching emulator cores, cycle-accurate timing loops, AAudio/OpenSL ES audio pipelines via Oboe C++, direct ByteBuffer transfers, or C++ JNI performance optimizations.

---

## Purpose

Emulator pipelines running on Android suffer from two critical latency bottlenecks: JNI call overhead during high-frequency cycles, and audio buffer starvation causing sound stuttering. 

This skill governs cycle-accurate timing scheduling, low-latency audio stream configurations via Google's Oboe library, and memory-copy-free framebuffer transfers via JNI.

---

## Step 1 — Cycle-Accurate Execution Scheduler

Emulators (e.g. GBA Emulator Core) must execute instructions in strict timing sync with the simulated hardware clock (typically 16.78 MHz for GBA, ~59.73 FPS).

### Rules
1. **The High-Precision Main Loop:** Implement scheduling using monotonic clocks to prevent drift. Run the core loop in a native thread, not the JVM main thread:
   ```cpp
   #include <chrono>
   #include <thread>

   void Emulator::run() {
       auto target_frame_duration = std::chrono::microseconds(16738); // ~59.73 Hz
       while (m_running) {
           auto start_time = std::chrono::steady_clock::now();
           
           // Run core clock cycles for one frame
           run_frame_cycles();
           
           auto end_time = std::chrono::steady_clock::now();
           auto elapsed = std::chrono::duration_cast<std::chrono::microseconds>(end_time - start_time);
           
           if (elapsed < target_frame_duration) {
               std::this_thread::sleep_for(target_frame_duration - elapsed);
           } else {
               // Frameskip calculation if system lags
               m_frameskip_count++;
           }
       }
   }
   ```
2. **Synchronized Clock Schedulers:** Emulator sub-components (Timer, CPU, DMA) must update their cycle registers in lockstep. Never use floating-point divisions for clock math; use integer cycle counters:
   ```cpp
   uint64_t accumulated_cycles = 0;
   void step_cycles(uint32_t cycles) {
       accumulated_cycles += cycles;
       while (accumulated_cycles >= CYCLES_PER_TIMER_TICK) {
           update_timers();
           accumulated_cycles -= CYCLES_PER_TIMER_TICK;
       }
   }
   ```

---

## Step 2 — Oboe Audio Stream Writing

Oboe is Google's C++ library for low-latency audio. It selects AAudio on modern APIs (SDK 26+) and falls back to OpenSL ES on older systems.

### Rules
1. **Oboe Stream Initialization:** Configure the stream builder for low latency, sharing mode, and matching sample rates:
   ```cpp
   #include <oboe/Oboe.h>

   class AudioEngine : public oboe::AudioStreamDataCallback {
   public:
       void init() {
           oboe::AudioStreamBuilder builder;
           builder.setFormat(oboe::AudioFormat::I16) // 16-bit PCM
                  .setChannelCount(oboe::ChannelCount::Stereo)
                  .setSampleRate(44100)
                  .setPerformanceMode(oboe::PerformanceMode::LowLatency)
                  .setSharingMode(oboe::SharingMode::Exclusive)
                  .setDataCallback(this)
                  .openStream(m_stream);
           
           m_stream->requestStart();
       }

       oboe::DataCallbackResult onAudioReady(
           oboe::AudioStream* oboeStream, 
           void* audioData, 
           int32_t numFrames
       ) override {
           int16_t* output_buffer = static_cast<int16_t*>(audioData);
           // Pull numFrames samples from emulator audio ring buffer
           read_emulator_samples(output_buffer, numFrames * 2);
           return oboe::DataCallbackResult::Continue;
       }
   private:
       std::shared_ptr<oboe::AudioStream> m_stream;
   };
   ```
2. **Buffer Starvation (Underrun) Control:** Never perform heavy calculations, disk I/O, or JNI operations inside `onAudioReady`. Use a lock-free circular buffer (e.g. `oboe::FifoBuffer`) to transfer audio from the emulator thread to the audio thread:
   ```cpp
   // Emulator thread
   m_fifo->write(emulator_audio_output, frames_generated);
   
   // Audio callback thread (onAudioReady)
   int32_t frames_read = m_fifo->read(audioData, numFrames);
   if (frames_read < numFrames) {
       // Starvation/Underrun happened - fill remainder with silence
       memset(static_cast<int16_t*>(audioData) + (frames_read * 2), 0, (numFrames - frames_read) * 4);
   }
   ```

---

## Step 3 — Memory-Copy-Free JNI Framebuffer Transfer

Passing display buffers (e.g. $240 \times 160$ pixels for GBA, 60 times per second) from native memory to Kotlin using standard byte arrays (`jbyteArray`) causes GC pressure and slow memory copies.

### Rules
1. **Direct ByteBuffer Allocation:** Create a direct `ByteBuffer` from Kotlin and share it with C++. The JVM maps the memory address directly, allowing C++ to write to it without copies:
   ```kotlin
   // Kotlin
   val bufferSize = 240 * 160 * 2 // 16-bit color depth (RGB565)
   val directBuffer: ByteBuffer = ByteBuffer.allocateDirect(bufferSize)
   NativeLlmBridge.registerFrameBuffer(directBuffer)
   ```
2. **Native Pointer Mapping:** Resolve the direct buffer address in JNI and write directly to it:
   ```cpp
   // JNI
   uint16_t* g_framebuffer_ptr = nullptr;

   JNIEXPORT void JNICALL
   Java_com_example_llmhost_NativeLlmBridge_registerFrameBuffer(JNIEnv* env, jobject thiz, jobject buffer) {
       g_framebuffer_ptr = static_cast<uint16_t*>(env->GetDirectBufferAddress(buffer));
   }

   // Core emulator frame flush
   void Emulator::present_frame(const uint16_t* internal_buffer) {
       if (g_framebuffer_ptr != nullptr) {
           // Fast memory copy directly into Kotlin-accessible address
           memcpy(g_framebuffer_ptr, internal_buffer, 240 * 160 * 2);
       }
   }
   ```

---

## Hard Rules

1. **Never make JNI calls** inside the high-frequency emulator CPU loop or the `onAudioReady` callback thread.
2. **Never allocate standard Java arrays** for framebuffer transfers. Always use direct ByteBuffers (`NewDirectByteBuffer` / `allocateDirect`).
3. **Never block the Oboe audio thread** with locks or operations that take longer than 1 millisecond.
4. **Never use floating-point timers** for clock synchronization. Use integer clock cycles.
5. **Always stop and close Oboe audio streams** on app pause or background events to release low-level audio hardware.

---

## Boundaries — Do Not Overstep

- This skill details Low-Latency Audio and Scheduler boundary conditions. It does not replace the official Oboe repository documentation, AAudio specifications, or emulator scheduling algorithms.
- C++ compilation flags (CMake configurations, NEON optimizations) must align with the active NDK toolchain definition.

---

## Failure Behavior of This Skill

- **Audio stutters or drops out during emulation:** Halt. Scan logcat for Oboe underruns (`buffer size too small`). Ensure no JNI calls or locks are blocking `onAudioReady`.
- **SEGFAULT during frame presentation:** Halt. Verify that the Direct ByteBuffer wasn't garbage collected on the Kotlin side while C++ was writing to it. Use `@Keep` annotations and store strong references.

---

## Strategic Next Move

After every substantial response, end with one strategic next-move question focused on buffer capacity configuration, JNI Direct Buffer lifecycle, or clock latency logs.

---

## References

- `ols-compiler` (`04_Meta_Tools/OLS-MCC/ols-compiler/SKILL.md`) — for emulator core architecture guidelines.
- `skill_android_jni_llama` (`Mobile/Platform/Android-Native-JNI-Llama-v1.md`) — for thread-attachment rules in callback structures.

---

**OLS-MCC Compliance:** v1.0 compiled and validated for Phase 1 Native Integration (Audio/Emulator).

/**
 * VoiceStreamManager — Central orchestrator for the voice dictation pipeline.
 *
 * Runs on the main V8 thread. Owns all sub-components and routes data between:
 *   - Audio capture Worker Thread (SharedArrayBuffer ring buffer)
 *   - VAD filter Worker Thread (speech detection events)
 *   - STT WebSocket client (streaming transcription)
 *   - LLM refiner (optional polish pass)
 *   - CodeTrie (local snippet expansion)
 *   - TuiStateInjector (PromptInput text injection)
 *   - DualPhaseStateMachine (pipeline state engine)
 *   - VoicePipelineMetrics (observability)
 *
 * Workers are spawned once and kept alive across voice sessions.
 * STT WebSocket connection is persistent.
 *
 * @module voice/voice-stream-manager
 */

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  VoicePhase,
  DEFAULT_VOICE_CONFIG,
  type VoiceConfig,
  type VoiceSession,
  type AudioChunk,
  type VadResult,
  type SttToken,
  type SttFinalResult,
  type LlmRefinementResult,
} from './types.js';
import { DualPhaseStateMachine, type VoiceCommand } from './dual-phase-state-machine.js';
import { createRingBufferPair, type RingBufferWriter, type RingBufferReader } from './audio-ring-buffer.js';
import { TuiStateInjector } from './tui-state-injector.js';
import { SttClient } from './stt-client.js';
import { LlmRefiner } from './llm-refiner.js';
import { CodeTrie } from './code-trie.js';
import { VoicePipelineMetrics } from './voice-pipeline-metrics.js';
import type { PromptInput } from '../ui/promptInput.js';

// ── Constants ───────────────────────────────────────────────────────────────

/** Interval (ms) for the main thread ring buffer polling loop. */
const POLL_INTERVAL_MS = 10;

/** Default ring buffer duration (ms) — 2 seconds at 16kHz. */
const RING_BUFFER_DURATION_MS = 2000;

// ── VoiceStreamManager ──────────────────────────────────────────────────────

export class VoiceStreamManager {
  private config: VoiceConfig;
  private stateMachine: DualPhaseStateMachine;
  private injector: TuiStateInjector;
  private sttClient: SttClient;
  private llmRefiner: LlmRefiner | null = null;
  private trie: CodeTrie;
  private metrics: VoicePipelineMetrics;

  // Worker threads
  private captureWorker: Worker | null = null;
  private vadWorker: Worker | null = null;

  // Ring buffer
  private ringBuffer: {
    sab: SharedArrayBuffer;
    writer: RingBufferWriter;
    reader: RingBufferReader;
  } | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  // State
  private currentPromptInput: PromptInput | null = null;
  private shutdownRequested = false;

  // STT callback unsubscription handles (prevents callback accumulation across sessions)
  private unsubToken: (() => void) | null = null;
  private unsubComplete: (() => void) | null = null;
  private unsubError: (() => void) | null = null;

  // Monotonic audio chunk sequence counter
  private audioSeq = 0;

  constructor(config: Partial<VoiceConfig> = {}) {
    this.config = { ...DEFAULT_VOICE_CONFIG, ...config } as VoiceConfig;
    this.stateMachine = new DualPhaseStateMachine();
    this.injector = new TuiStateInjector();
    this.trie = CodeTrie.createDefault();
    this.metrics = new VoicePipelineMetrics();

    // Initialise STT client if cloud config provided
    this.sttClient = new SttClient(this.config.stt);

    // Initialise LLM refiner if config provided
    if (this.config.llm) {
      this.llmRefiner = new LlmRefiner(this.config.llm);
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  /**
   * Start a voice capture session.
   * Called when the push-to-talk hotkey is pressed.
   */
  async startCapture(promptInput: PromptInput): Promise<void> {
    if (this.stateMachine.isActive()) return;
    if (this.shutdownRequested) return;

    this.currentPromptInput = promptInput;

    // Spawn workers on first use (lazy initialisation)
    if (!this.captureWorker) {
      await this.spawnWorkers();
    }

    // Attach injector to PromptInput
    this.injector.attach(promptInput);

    // Transition state machine
    const { commands } = this.stateMachine.start();
    await this.executeCommands(commands);

    // Start ring buffer polling
    this.startPolling();

    // Start STT connection if not already connected
    try {
      await this.sttClient.connect();
    } catch (err) {
      console.error('[VoiceStreamManager] STT connection failed:', err);
      // Bug 2 fix: abort the state machine to avoid a stuck CAPTURING session
      const { commands } = this.stateMachine.abort('STT connection failed');
      await this.executeCommands(commands);
      return;
    }
  }

  /**
   * Stop the current voice capture session.
   * Called when the push-to-talk hotkey is released.
   */
  async stopCapture(): Promise<void> {
    if (!this.stateMachine.isActive()) return;

    // Finalise STT stream
    this.sttClient.finalize();
  }

  /**
   * Shutdown all workers and connections. Called on app exit.
   */
  async shutdown(): Promise<void> {
    this.shutdownRequested = true;

    // Stop polling
    this.stopPolling();

    // Abort any active session
    if (this.stateMachine.isActive()) {
      this.stateMachine.abort('app shutdown');
    }

    // Detach injector
    this.injector.detach();

    // Unregister STT callbacks before disconnecting
    this.unsubToken?.();
    this.unsubComplete?.();
    this.unsubError?.();
    this.unsubToken = null;
    this.unsubComplete = null;
    this.unsubError = null;

    // Disconnect STT
    this.sttClient.disconnect();

    // Terminate workers
    if (this.captureWorker) {
      this.captureWorker.postMessage({ type: 'shutdown' });
      await this.captureWorker.terminate();
      this.captureWorker = null;
    }
    if (this.vadWorker) {
      this.vadWorker.postMessage({ type: 'shutdown' });
      await this.vadWorker.terminate();
      this.vadWorker = null;
    }

    this.ringBuffer = null;
    this.currentPromptInput = null;
  }

  // ── PromptInput integration ────────────────────────────────────────────

  /**
   * Called when the user types manually during a voice session.
   * Forwards to the state machine for collision handling.
   */
  notifyUserActivity(): void {
    this.injector.notifyUserKeypress();
    const collision = this.injector.detectCollision();

    if (collision.type !== 'none') {
      const { commands } = this.stateMachine.onUserActivity();
      this.executeCommands(commands);
    }
  }

  // ── Status queries ─────────────────────────────────────────────────────

  getCurrentPhase(): VoicePhase {
    return this.stateMachine.getSession()?.phase ?? VoicePhase.Idle;
  }

  getSession(): VoiceSession | null {
    return this.stateMachine.getSession();
  }

  isActive(): boolean {
    return this.stateMachine.isActive();
  }

  // ── Configuration ──────────────────────────────────────────────────────

  /** Hot-reload trie entries from a config. */
  reloadTrie(config: { entries: Array<{ key: string; expansion: string }> }): void {
    this.trie = CodeTrie.fromConfig(config);
  }

  /** Get a reference to the current trie for inspection. */
  getTrie(): CodeTrie {
    return this.trie;
  }

  /** Get pipeline metrics for observability. */
  getMetrics(): VoicePipelineMetrics {
    return this.metrics;
  }

  // ── Worker lifecycle ───────────────────────────────────────────────────

  private async spawnWorkers(): Promise<void> {
    const voiceDir = dirname(fileURLToPath(import.meta.url));

    // Create ring buffer
    this.ringBuffer = createRingBufferPair(RING_BUFFER_DURATION_MS);

    // Spawn audio capture worker
    const captureWorkerPath = join(voiceDir, 'audio-capture-worker.mjs');
    this.captureWorker = new Worker(captureWorkerPath);

    // Set up capture event handling
    this.captureWorker.on('message', (msg: { type: string }) => {
      if (msg.type === 'error') {
        console.error('[VoiceStreamManager] Audio capture error:', msg);
      }
    });
    this.captureWorker.on('error', (err) => {
      console.error('[VoiceStreamManager] Capture worker error:', err);
    });

    // Spawn VAD worker
    const vadWorkerPath = join(voiceDir, 'vad-worker.mjs');
    this.vadWorker = new Worker(vadWorkerPath);

    // Set up VAD event handling
    this.vadWorker.on('message', (event: { type: string; result?: VadResult }) => {
      if (event.type === 'vad_result' && event.result) {
        this.handleVadResult(event.result);
      } else if (event.type === 'vad_ready') {
        // VAD worker is ready
      } else if (event.type === 'error') {
        console.error('[VoiceStreamManager] VAD error:', event);
      }
    });
    this.vadWorker.on('error', (err) => {
      console.error('[VoiceStreamManager] VAD worker error:', err);
    });

    // Start both workers with the same ring buffer
    this.captureWorker.postMessage({
      type: 'start',
      ringBuffer: this.ringBuffer.sab,
    });

    this.vadWorker.postMessage({
      type: 'start',
      ringBuffer: this.ringBuffer.sab,
    });
  }

  // ── Ring buffer polling ────────────────────────────────────────────────

  private startPolling(): void {
    if (this.pollTimer) return;

    this.pollTimer = setInterval(() => {
      this.pollRingBuffer();
    }, POLL_INTERVAL_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private pollRingBuffer(): void {
    if (!this.ringBuffer) return;

    const available = this.ringBuffer.reader.available();
    if (available < 320) return; // Less than one 20ms frame

    // Read a chunk for STT forwarding
    const chunk = new Int16Array(Math.min(available, 320));
    const read = this.ringBuffer.reader.readInt16(chunk);
    if (read === 0) return;

    // Forward to STT if connected
    if (this.sttClient) {
      const audioChunk: AudioChunk = {
        seq: this.audioSeq++,
        capturedAt: performance.now(),
        data: chunk.subarray(0, read),
        sampleCount: read,
      };
      this.sttClient.sendAudio(audioChunk);
    }
  }

  // ── VAD event handling ─────────────────────────────────────────────────

  private handleVadResult(result: VadResult): void {
    switch (result.state) {
      case 'speech_start':
        // Speech detected — STT is already streaming
        break;
      case 'speech_end':
        // Speech ended — trigger STT finalisation
        this.sttClient.finalize();
        break;
      case 'speech_ongoing':
      case 'silence':
        // No action needed
        break;
    }
  }

  // ── STT event handling ─────────────────────────────────────────────────

  private setupSttHandlers(): void {
    // Unregister previous session's callbacks to prevent accumulation
    this.unsubToken?.();
    this.unsubComplete?.();
    this.unsubError?.();

    this.unsubToken = this.sttClient.onToken((token: SttToken) => {
      // Check trie for expansion
      let text = token.text;
      if (this.config.enableTrie) {
        const match = this.trie.searchLongestMatch(text);
        if (match) {
          text = text.replace(
            new RegExp(match.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
            match.expansion,
          );
        }
      }

      const { commands } = this.stateMachine.onSttToken({
        ...token,
        text,
      });
      this.executeCommands(commands);
    });

    this.unsubComplete = this.sttClient.onComplete((result: SttFinalResult) => {
      // Check trie on final result
      let text = result.text;
      if (this.config.enableTrie) {
        const match = this.trie.searchLongestMatch(text);
        if (match) {
          text = text.replace(
            new RegExp(match.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
            match.expansion,
          );
        }
      }

      this.metrics.recordSttComplete();
      const { commands } = this.stateMachine.onSttComplete({
        ...result,
        text,
      });
      this.executeCommands(commands);
    });

    this.unsubError = this.sttClient.onError((error: Error) => {
      console.error('[VoiceStreamManager] STT error:', error);
      this.metrics.recordAbort(`STT error: ${error.message}`);
      // Bug 3 fix: capture and execute abort commands so polling and injector are cleaned up
      const { commands: abortCommands } = this.stateMachine.abort(`STT error: ${error.message}`);
      this.executeCommands(abortCommands);
    });
  }

  // ── LLM refinement ─────────────────────────────────────────────────────

  private async requestLlmRefinement(rawText: string, context: string): Promise<void> {
    if (!this.llmRefiner) {
      // No LLM refiner configured — complete with raw text
      const { commands } = this.stateMachine.onLlmResult({
        refinedText: rawText,
        changed: false,
        latencyMs: 0,
      });
      this.executeCommands(commands);
      return;
    }

    this.metrics.recordLlmStart();

    try {
      const result: LlmRefinementResult = await this.llmRefiner.refine(rawText, context);
      this.metrics.recordLlmComplete();

      const { commands } = this.stateMachine.onLlmResult(result);
      this.executeCommands(commands);
    } catch {
      // Refinement failed — keep raw text
      this.metrics.recordLlmComplete();
      const { commands } = this.stateMachine.onLlmResult({
        refinedText: rawText,
        changed: false,
        latencyMs: 0,
      });
      this.executeCommands(commands);
    }
  }

  // ── Command execution ──────────────────────────────────────────────────

  private async executeCommands(commands: VoiceCommand[]): Promise<void> {
    for (const cmd of commands) {
      await this.executeCommand(cmd);
    }
  }

  private async executeCommand(cmd: VoiceCommand): Promise<void> {
    switch (cmd.type) {
      case 'start_audio_capture':
        // Worker already started in spawnWorkers
        this.metrics.startSpan(this.stateMachine.getSession()?.id ?? '');
        this.metrics.recordPhaseTransition(VoicePhase.Capturing);
        this.sttClient.reset();
        this.audioSeq = 0; // Reset monotonic sequence counter for new session
        // Re-register STT handlers (they persist, but we ensure fresh state)
        this.setupSttHandlers();
        break;

      case 'stop_audio_capture':
        this.stopPolling();
        this.metrics.recordAudioCaptureEnd();
        if (this.captureWorker) {
          this.captureWorker.postMessage({ type: 'stop' });
        }
        break;

      case 'inject_raw_text':
        this.metrics.recordRawInjection();
        this.injector.injectRaw(cmd.text);
        break;

      case 'replace_with_refined':
        this.metrics.recordRefinedInjection();
        this.injector.replaceWithRefined(cmd.newText);
        break;

      case 'request_llm_refinement':
        await this.requestLlmRefinement(cmd.rawText, cmd.context);
        break;

      case 'notify_phase_change':
        this.metrics.recordPhaseTransition(cmd.phase);
        if (cmd.phase === VoicePhase.Completed || cmd.phase === VoicePhase.Aborted) {
          this.metrics.finalizeSpan();
          this.injector.detach();
        }
        break;

      case 'notify_error':
        console.warn(`[VoiceStreamManager] ${cmd.message}`);
        this.metrics.recordAbort(cmd.message);
        break;
    }
  }
}

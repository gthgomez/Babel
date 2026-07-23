/**
 * Voice Input — Shared type definitions for the Babel TUI voice dictation pipeline.
 *
 * This module defines all interfaces, enums, and type unions used across
 * the voice subsystem: audio pipeline, VAD, STT, LLM refinement, state
 * machine, Worker Thread protocols, trie, metrics, and configuration.
 *
 * @module voice/types
 */

// ── Audio Pipeline ──────────────────────────────────────────────────────────

/** PCM audio format used throughout the voice pipeline. */
export interface AudioFormat {
  readonly sampleRate: 16000;
  readonly channels: 1;
  readonly bitDepth: 16;
  /** Samples per 20ms frame at 16kHz = 320 samples → 640 bytes. */
  readonly frameSize: 320;
}

/** Default audio format constants. */
export const DEFAULT_AUDIO_FORMAT: AudioFormat = {
  sampleRate: 16000,
  channels: 1,
  bitDepth: 16,
  frameSize: 320,
} as const;

/** A chunk of raw PCM audio with timing metadata. */
export interface AudioChunk {
  /** Monotonically increasing chunk sequence number. */
  seq: number;
  /** Timestamp from performance.now() when captured. */
  capturedAt: number;
  /** Raw PCM data (Int16Array view into SharedArrayBuffer). */
  readonly data: Int16Array;
  /** Number of valid samples (may be less than data.length at end of utterance). */
  sampleCount: number;
}

// ── VAD ─────────────────────────────────────────────────────────────────────

/** Result of a single VAD inference frame. */
export interface VadResult {
  seq: number;
  /** Probability of speech [0, 1]. */
  speechProbability: number;
  /** VAD state transition. */
  state: 'speech_start' | 'speech_ongoing' | 'speech_end' | 'silence';
  /** Timestamp when VAD processing completed (performance.now()). */
  processedAt: number;
}

// ── STT ─────────────────────────────────────────────────────────────────────

/** A streaming token from the STT engine. */
export interface SttToken {
  /** Raw partial token text. */
  text: string;
  /** Whether this is a final (committed) or interim (partial) result. */
  isFinal: boolean;
  /** Monotonic token sequence number. */
  seq: number;
  /** STT confidence [0, 1] if the provider reports it. */
  confidence?: number;
}

/** Final result after STT completes processing the audio stream. */
export interface SttFinalResult {
  /** Complete transcribed text. */
  text: string;
  /** Total audio duration processed (ms). */
  audioDurationMs: number;
  /** Provider-reported latency metrics. */
  latency: { ttftMs: number; totalMs: number };
}

// ── LLM Refinement ──────────────────────────────────────────────────────────

/** Result of LLM cleanup/formatting pass. */
export interface LlmRefinementResult {
  /** Polished/cleaned text. */
  refinedText: string;
  /** Whether the refinement changed the raw text. */
  changed: boolean;
  /** LLM inference latency in ms. */
  latencyMs: number;
}

// ── State Machine ───────────────────────────────────────────────────────────

/** Phases of the voice dictation pipeline. */
export enum VoicePhase {
  Idle = 'IDLE',
  Capturing = 'CAPTURING',
  RawStreaming = 'RAW_STREAMING',
  Refining = 'REFINING',
  Completed = 'COMPLETED',
  Aborted = 'ABORTED',
}

/** Active voice dictation session state. */
export interface VoiceSession {
  /** Unique session identifier (crypto.randomUUID()). */
  id: string;
  /** Current pipeline phase. */
  phase: VoicePhase;
  /** performance.now() when capture began. */
  startedAt: number;
  /** Accumulated raw STT transcript. */
  rawText: string;
  /** LLM-refined text (null until refinement completes). */
  refinedText: string | null;
  /** Number of characters in the raw text block injected into PromptInput. */
  rawCharCount: number;
  /** Number of audio chunks processed. */
  chunksProcessed: number;
}

// ── Worker Thread Protocols ─────────────────────────────────────────────────

/** Messages FROM main thread TO audio-capture worker. */
export type AudioCaptureCommand =
  | { type: 'start'; ringBuffer: SharedArrayBuffer }
  | { type: 'stop' }
  | { type: 'shutdown' };

/** Messages FROM audio-capture worker TO main thread. */
export type AudioCaptureEvent =
  | {
      type: 'started';
      deviceInfo: { name: string; sampleRate: number; channels: number };
    }
  | { type: 'chunk_ready'; seq: number; sampleCount: number }
  | { type: 'error'; message: string; code: string }
  | { type: 'stopped' };

/** Messages FROM main thread TO VAD worker. */
export type VadCommand =
  | { type: 'start'; ringBuffer: SharedArrayBuffer }
  | { type: 'process_chunk'; seq: number; sampleCount: number }
  | { type: 'stop' }
  | { type: 'shutdown' };

/** Messages FROM VAD worker TO main thread. */
export type VadEvent =
  | { type: 'vad_result'; result: VadResult }
  | { type: 'vad_ready' }
  | { type: 'error'; message: string };

// ── Trie ────────────────────────────────────────────────────────────────────

/** Node in the prefix trie for snippet expansion. */
export interface TrieNode {
  children: Map<string, TrieNode>;
  /** Non-null = terminal node with expansion text. */
  expansion: string | null;
}

/** Serialisable trie configuration. */
export interface TrieConfig {
  entries: Array<{ key: string; expansion: string }>;
}

// ── PromptInput Collision ───────────────────────────────────────────────────

/** Types of user edit collisions detected during voice pipeline. */
export type UserEditCollision =
  | { type: 'none' }
  | { type: 'user_typed_during_refinement'; affectedText: string }
  | { type: 'user_cleared_buffer' }
  | { type: 'user_moved_cursor'; newLine: number; newCol: number };

// ── Metrics ─────────────────────────────────────────────────────────────────

/** A complete voice dictation trace span for observability. */
export interface VoicePipelineSpan {
  spanId: string;
  sessionId: string;
  audioCaptureStart: number;
  audioCaptureEnd: number;
  firstSttTokenAt: number;
  sttCompleteAt: number;
  llmStartAt: number;
  llmCompleteAt: number;
  rawInjectedAt: number;
  refinedInjectedAt: number;
  phaseTransitions: Array<{ phase: VoicePhase; at: number }>;
  abortReason?: string;
}

/** OpenTelemetry-compatible span representation. */
export interface OtelSpan {
  traceId: string;
  spanId: string;
  name: 'voice.dictation';
  startTime: number;
  endTime: number;
  attributes: Record<string, string | number>;
  events: Array<{
    name: string;
    timestamp: number;
    attributes?: Record<string, string | number>;
  }>;
}

// ── Configuration ───────────────────────────────────────────────────────────

/** STT engine configuration. */
export interface SttEngineConfig {
  mode: 'local' | 'cloud';
  /** Path to whisper.cpp binary (local mode). */
  localBinary?: string;
  /** Path to whisper model file (local mode). */
  localModelPath?: string;
  /** Cloud STT WebSocket endpoint. */
  cloudEndpoint?: string;
  /** Cloud STT API key. */
  cloudApiKey?: string;
  /** Language hint for STT (e.g. 'en'). */
  language?: string;
}

/** LLM refinement provider configuration. */
export interface LlmRefinerConfig {
  provider: 'cerebras' | 'groq' | 'gemini' | 'local';
  apiKey: string;
  model: string;
  endpoint: string;
  /** Tight cap — ~150 tokens for typical dictation. */
  maxTokens: number;
  /** Deterministic output for grammar cleanup. */
  temperature: 0.0;
}

/** Top-level voice subsystem configuration. */
export interface VoiceConfig {
  stt: SttEngineConfig;
  llm?: LlmRefinerConfig;
  /** Keyboard shortcut (default 'Ctrl+Shift+V'). */
  keyboardShortcut: string;
  /** Silero VAD threshold [0, 1], default 0.5. */
  vadThreshold: number;
  /** Enable local trie expansion bypass. */
  enableTrie: boolean;
  /** Safety cutoff for maximum capture duration (ms). */
  maxCaptureDurationMs: number;
}

/** Default voice configuration. */
export const DEFAULT_VOICE_CONFIG: Partial<VoiceConfig> = {
  keyboardShortcut: 'Ctrl+Shift+V',
  vadThreshold: 0.5,
  enableTrie: true,
  maxCaptureDurationMs: 30_000,
};

// ── Audio Device ────────────────────────────────────────────────────────────

/** Information about an audio input device. */
export interface AudioDeviceInfo {
  name: string;
  deviceId: string;
  sampleRate: number;
  channels: number;
  isDefault: boolean;
}

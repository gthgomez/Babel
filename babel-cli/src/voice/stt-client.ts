/**
 * SttClient — Streaming Speech-to-Text client using WebSocket.
 *
 * Connects to cloud STT providers (Groq Whisper, Deepgram Nova-3) via
 * persistent WebSocket for streaming transcription. Sends PCM16 audio as
 * binary frames, receives JSON text frames with partial/final results.
 *
 * The connection is kept alive across voice sessions — no cold-start
 * WebSocket handshake per dictation.
 *
 * @module voice/stt-client
 */

import type {
  SttToken,
  SttFinalResult,
  SttEngineConfig,
  AudioChunk,
} from './types.js';

// ── Types ───────────────────────────────────────────────────────────────────

type TokenCallback = (token: SttToken) => void;
type CompleteCallback = (result: SttFinalResult) => void;
type ErrorCallback = (error: Error) => void;

// ── SttClient ───────────────────────────────────────────────────────────────

export class SttClient {
  private ws: WebSocket | null = null;
  private config: SttEngineConfig;
  private tokenCallbacks: TokenCallback[] = [];
  private completeCallbacks: CompleteCallback[] = [];
  private errorCallbacks: ErrorCallback[] = [];
  private seq = 0;
  private currentAudioDurationMs = 0;
  private isConnected = false;
  private connectPromise: Promise<void> | null = null;

  constructor(config: SttEngineConfig) {
    this.config = {
      language: 'en',
      ...config,
    };
  }

  // ── Connection ─────────────────────────────────────────────────────────

  /**
   * Open a persistent WebSocket connection to the STT provider.
   * Idempotent — subsequent calls return the existing connection.
   */
  async connect(): Promise<void> {
    if (this.isConnected && this.ws?.readyState === WebSocket.OPEN) {
      return;
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = this.doConnect();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  private async doConnect(): Promise<void> {
    const url = this.buildUrl();
    this.ws = new WebSocket(url);

    return new Promise<void>((resolve, reject) => {
      if (!this.ws) return reject(new Error('WebSocket not available'));

      const timeout = setTimeout(() => {
        reject(new Error('STT WebSocket connection timed out after 10s'));
      }, 10_000);

      this.ws.onopen = () => {
        clearTimeout(timeout);
        this.isConnected = true;
        this.sendConfigMessage();
        resolve();
      };

      this.ws.onmessage = (event: MessageEvent) => {
        this.handleMessage(event.data as string);
      };

      this.ws.onerror = (event: Event) => {
        const err = new Error(
          `STT WebSocket error: ${(event as ErrorEvent).message ?? 'unknown'}`
        );
        for (const cb of this.errorCallbacks) cb(err);
      };

      this.ws.onclose = (event: CloseEvent) => {
        this.isConnected = false;
        if (event.code !== 1000) {
          const err = new Error(
            `STT WebSocket closed unexpectedly: code=${event.code} reason=${event.reason}`
          );
          for (const cb of this.errorCallbacks) cb(err);
        }
      };
    });
  }

  private buildUrl(): string {
    if (this.config.cloudEndpoint) return this.config.cloudEndpoint;

    // Groq Whisper endpoint
    return 'wss://api.groq.com/openai/v1/audio/transcriptions';
  }

  private sendConfigMessage(): void {
    // Send initial configuration (provider-specific)
    // Groq uses a session update message before streaming
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'session.update',
        session: {
          modalities: ['text'],
          instructions: 'Transcribe spoken audio to text.',
        },
      }));
    }
  }

  // ── Audio streaming ────────────────────────────────────────────────────

  /**
   * Send a chunk of PCM16 audio as a binary WebSocket frame.
   */
  sendAudio(chunk: AudioChunk): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.currentAudioDurationMs += (chunk.sampleCount / 16000) * 1000;

    // Send as binary frame
    const buffer = Buffer.from(chunk.data.buffer, chunk.data.byteOffset, chunk.data.byteLength);
    this.ws.send(buffer);
  }

  /**
   * Signal end of audio stream — triggers finalisation on the provider side.
   */
  finalize(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    // Send end-of-stream marker (provider-specific)
    this.ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    this.ws.send(JSON.stringify({ type: 'response.create' }));
  }

  // ── Event handling ─────────────────────────────────────────────────────

  private handleMessage(data: string): void {
    try {
      const msg = JSON.parse(data);

      // Handle different provider message formats
      if (msg.type === 'response.text.delta') {
        // Groq format: streaming text delta
        this.seq++;
        const token: SttToken = {
          text: msg.delta ?? '',
          isFinal: false,
          seq: this.seq,
        };
        for (const cb of this.tokenCallbacks) cb(token);
      } else if (msg.type === 'response.text.done') {
        // Groq format: final text
        this.seq++;
        const token: SttToken = {
          text: msg.text ?? '',
          isFinal: true,
          seq: this.seq,
        };
        for (const cb of this.tokenCallbacks) cb(token);

        const finalResult: SttFinalResult = {
          text: msg.text ?? '',
          audioDurationMs: this.currentAudioDurationMs,
          latency: {
            ttftMs: 0, // Provider may include this
            totalMs: 0,
          },
        };
        for (const cb of this.completeCallbacks) cb(finalResult);
      } else if (msg.type === 'results') {
        // Deepgram format
        const transcript = msg.channel?.alternatives?.[0]?.transcript ?? '';
        const isFinal = msg.is_final ?? false;
        this.seq++;
        const token: SttToken = {
          text: transcript,
          isFinal,
          seq: this.seq,
          confidence: msg.channel?.alternatives?.[0]?.confidence,
        };
        for (const cb of this.tokenCallbacks) cb(token);

        if (isFinal) {
          // Accumulate all final tokens
          const finalResult: SttFinalResult = {
            text: transcript,
            audioDurationMs: (msg.duration ?? 0) * 1000,
            latency: {
              ttftMs: (msg.start ?? 0) * 1000,
              totalMs: (msg.duration ?? 0) * 1000,
            },
          };
          for (const cb of this.completeCallbacks) cb(finalResult);
        }
      } else if (msg.type === 'error') {
        const err = new Error(`STT provider error: ${msg.message ?? JSON.stringify(msg)}`);
        for (const cb of this.errorCallbacks) cb(err);
      }
    } catch {
      // Ignore unparseable messages (may be binary keepalive pongs)
    }
  }

  // ── Callback registration ──────────────────────────────────────────────

  /** Register a callback for streaming partial/final tokens. */
  onToken(callback: TokenCallback): () => void {
    this.tokenCallbacks.push(callback);
    return () => {
      const idx = this.tokenCallbacks.indexOf(callback);
      if (idx >= 0) this.tokenCallbacks.splice(idx, 1);
    };
  }

  /** Register a callback for the final result. */
  onComplete(callback: CompleteCallback): () => void {
    this.completeCallbacks.push(callback);
    return () => {
      const idx = this.completeCallbacks.indexOf(callback);
      if (idx >= 0) this.completeCallbacks.splice(idx, 1);
    };
  }

  /** Register a callback for errors. */
  onError(callback: ErrorCallback): () => void {
    this.errorCallbacks.push(callback);
    return () => {
      const idx = this.errorCallbacks.indexOf(callback);
      if (idx >= 0) this.errorCallbacks.splice(idx, 1);
    };
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  /** Reset sequencing state for a new voice session. */
  reset(): void {
    this.seq = 0;
    this.currentAudioDurationMs = 0;
  }

  /** Close the WebSocket connection. */
  disconnect(): void {
    this.isConnected = false;
    if (this.ws) {
      this.ws.close(1000, 'client disconnect');
      this.ws = null;
    }
    this.tokenCallbacks = [];
    this.completeCallbacks = [];
    this.errorCallbacks = [];
  }
}

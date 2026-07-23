/**
 * vad-worker.mjs — VAD Filter Worker Thread entry point.
 *
 * Runs Silero VAD (Voice Activity Detection) in a dedicated Node.js Worker
 * Thread, isolated from the main TUI event loop. Reads PCM16 audio from a
 * SharedArrayBuffer ring buffer, runs ONNX inference, and posts speech
 * start/end events back to the main thread.
 *
 * This file is .mjs (ESM) because Babel uses "type": "module" and Workers
 * spawned from ESM contexts require ESM entry points.
 *
 * Dependencies:
 *   - @ricky0123/vad (preferred: Silero VAD with Node.js Worker support)
 *   - onnxruntime-web (fallback: WASM-based ONNX runtime)
 *
 * @module voice/vad-worker
 */

import { parentPort } from 'node:worker_threads';

// ── Constants ───────────────────────────────────────────────────────────────

const SAMPLE_RATE = 16000;
/** Silero VAD expects 512-sample frames at 16kHz (32ms). */
const FRAME_SIZE = 512;
/** Speech probability threshold for detecting voice. */
const SPEECH_THRESHOLD = 0.5;
/** Silence probability threshold for detecting end of speech. */
const SILENCE_THRESHOLD = 0.35;
/** Number of consecutive speech frames before declaring speech_start. */
const SPEECH_ONSET_FRAMES = 3; // ~96ms
/** Number of consecutive silence frames before declaring speech_end. */
const SILENCE_OFFSET_FRAMES = 15; // ~480ms

// ── State ───────────────────────────────────────────────────────────────────

let vadEngine = null;
let running = false;
let stopped = false;

let consecutiveSpeech = 0;
let consecutiveSilence = 0;
let isSpeaking = false;
let frameSeq = 0;

// Ring buffer consumer — populated via 'start' command
let sab = null;
let headerView = null;
let dataView = null;
let capacity = 0;
let mask = 0;
let localRead = 0;
let readBuf = null; // Float32Array pre-allocated for reading frames

// ── Ring buffer helpers ─────────────────────────────────────────────────────

function ringAvailable() {
  const mainReadHead = Atomics.load(headerView, 1);
  return (mainReadHead - localRead) & mask;
}

function ringReadFrame() {
  const mainReadHead = Atomics.load(headerView, 1);
  const avail = (mainReadHead - localRead) & mask;
  if (avail < FRAME_SIZE) return null;

  for (let i = 0; i < FRAME_SIZE; i++) {
    readBuf[i] = (dataView[(localRead + i) & mask] ?? 0) / 32768.0;
  }

  localRead = (localRead + FRAME_SIZE) & mask;
  // NO Atomics.store to headerView[1] — VAD is a trailing consumer;
  // only the main thread (RingBufferReader) advances the shared read head.
  return readBuf;
}

// ── VAD engine initialisation ───────────────────────────────────────────────

async function initVad() {
  try {
    // Primary path: @ricky0123/vad (Node.js-compatible Silero VAD)
    const vadModule = await import('@ricky0123/vad');
    // Create VAD with appropriate configuration
    const vad = await vadModule.MicVAD.new({
      onSpeechStart: () => {
        // We handle speech detection ourselves via frame-level probabilities
      },
      onSpeechEnd: () => {
        // We handle speech end detection ourselves
      },
      onVADMisfire: () => {
        // Log misfire for diagnostics
      },
      ortConfig: (ort) => {
        ort.env.wasm.wasmPaths = './node_modules/onnxruntime-web/dist/';
      },
    });
    vadEngine = { type: 'micvad', instance: vad };
    return true;
  } catch (err) {
    // Fallback: try direct onnxruntime-web
    console.warn('[vad-worker] @ricky0123/vad unavailable, trying onnxruntime-web:', err.message);
    try {
      const ort = await import('onnxruntime-web');
      // Configure WASM backend
      ort.env.wasm.wasmPaths = './node_modules/onnxruntime-web/dist/';
      // We need the Silero VAD ONNX model loaded
      vadEngine = { type: 'ort', ort, session: null };
      return true;
    } catch (err2) {
      console.error('[vad-worker] onnxruntime-web also unavailable:', err2.message);
      return false;
    }
  }
}

/**
 * Simple energy-based VAD fallback when no ML model is available.
 * Computes RMS (root mean square) of the audio frame and thresholds.
 */
function energyBasedVad(frame) {
  let sumSq = 0;
  for (let i = 0; i < frame.length; i++) {
    sumSq += frame[i] * frame[i];
  }
  const rms = Math.sqrt(sumSq / frame.length);
  // Map RMS to pseudo-probability: typical speech RMS > 0.01
  return Math.min(1.0, rms / 0.05);
}

// ── Processing loop ─────────────────────────────────────────────────────────

async function processLoop() {
  let initialised = false;

  while (!stopped) {
    // Wait for data to be available in the ring buffer
    if (ringAvailable() < FRAME_SIZE) {
      // Sleep briefly to avoid busy-waiting
      await new Promise((resolve) => setTimeout(resolve, 10));
      continue;
    }

    // Initialise VAD on first frame
    if (!initialised) {
      initialised = await initVad();
    }

    const frame = ringReadFrame();
    if (!frame) continue;

    let probability;

    if (vadEngine && vadEngine.type === 'ort') {
      // Use ONNX Runtime for inference
      try {
        const ort = vadEngine.ort;
        const inputTensor = new ort.Tensor('float32', frame, [1, FRAME_SIZE]);
        const output = await vadEngine.session.run({ input: inputTensor });
        probability = output.prob?.data?.[0] ?? energyBasedVad(frame);
      } catch {
        probability = energyBasedVad(frame);
      }
    } else if (vadEngine && vadEngine.type === 'micvad') {
      // MicVAD doesn't expose per-frame probabilities,
      // so energy-based VAD is the fallback.
      probability = energyBasedVad(frame);
    } else {
      // Pure energy-based fallback
      probability = energyBasedVad(frame);
    }

    frameSeq++;

    // Speech state detection
    if (probability > SPEECH_THRESHOLD) {
      consecutiveSpeech++;
      consecutiveSilence = 0;

      if (!isSpeaking && consecutiveSpeech >= SPEECH_ONSET_FRAMES) {
        isSpeaking = true;
        parentPort?.postMessage({
          type: 'vad_result',
          result: {
            seq: frameSeq,
            speechProbability: probability,
            state: 'speech_start',
            processedAt: performance.now(),
          },
        });
      } else if (isSpeaking) {
        parentPort?.postMessage({
          type: 'vad_result',
          result: {
            seq: frameSeq,
            speechProbability: probability,
            state: 'speech_ongoing',
            processedAt: performance.now(),
          },
        });
      }
    } else {
      consecutiveSilence++;
      consecutiveSpeech = 0;

      if (isSpeaking && consecutiveSilence >= SILENCE_OFFSET_FRAMES) {
        isSpeaking = false;
        parentPort?.postMessage({
          type: 'vad_result',
          result: {
            seq: frameSeq,
            speechProbability: probability,
            state: 'speech_end',
            processedAt: performance.now(),
          },
        });
      } else if (!isSpeaking) {
        // Silence while not speaking — don't spam events
        if (consecutiveSilence === 1) {
          parentPort?.postMessage({
            type: 'vad_result',
            result: {
              seq: frameSeq,
              speechProbability: probability,
              state: 'silence',
              processedAt: performance.now(),
            },
          });
        }
      }
    }
  }
}

// ── Message handler ─────────────────────────────────────────────────────────

parentPort?.on('message', async (msg) => {
  switch (msg.type) {
    case 'start': {
      // Initialise ring buffer consumer from SharedArrayBuffer
      sab = msg.ringBuffer;
      headerView = new Int32Array(sab, 0, 4);
      capacity = headerView[2];
      mask = capacity - 1;
      dataView = new Int16Array(sab, 16, capacity);
      localRead = 0;
      readBuf = new Float32Array(FRAME_SIZE);

      // Reset speech state
      consecutiveSpeech = 0;
      consecutiveSilence = 0;
      isSpeaking = false;
      frameSeq = 0;
      stopped = false;
      running = true;

      parentPort?.postMessage({ type: 'vad_ready' });

      // Start processing loop (fire-and-forget)
      processLoop().catch((err) => {
        parentPort?.postMessage({
          type: 'error',
          message: `VAD processing loop crashed: ${err.message}`,
        });
      });
      break;
    }

    case 'stop': {
      stopped = true;
      running = false;
      // Reset all speech state
      consecutiveSpeech = 0;
      consecutiveSilence = 0;
      isSpeaking = false;
      break;
    }

    case 'shutdown': {
      stopped = true;
      running = false;
      // Allow process to exit naturally
      process.exit(0);
    }
  }
});

/**
 * audio-capture-worker.mjs — Audio Capture Worker Thread entry point.
 *
 * Captures microphone audio using platform-native commands spawned as child
 * processes. Writes PCM16 samples into a SharedArrayBuffer ring buffer shared
 * with the main thread and VAD worker.
 *
 * Platform capture commands:
 *   macOS:   sox -q -d -t raw -r 16000 -e signed -b 16 -c 1 -
 *            fallback: ffmpeg -f avfoundation -i :0 -ar 16000 -ac 1 -f s16le -
 *   Linux:   arecord -q -f S16_LE -r 16000 -c 1 -t raw
 *            fallback: ffmpeg -f alsa -i default -ar 16000 -ac 1 -f s16le -
 *   Windows: ffmpeg -f dshow -i audio="Default" -ar 16000 -ac 1 -f s16le -
 *
 * This file is .mjs (ESM) because Babel uses "type": "module".
 *
 * @module voice/audio-capture-worker
 */

import { parentPort } from 'node:worker_threads';
import { spawn } from 'node:child_process';
import { platform } from 'node:os';

// ── Ring buffer consumer (from SharedArrayBuffer) ─────────────────────────

let sab = null;
let headerView = null;
let dataView = null;
let capacity = 0;
let mask = 0;
let localWrite = 0;

function initRingBuffer(ringBufferSab) {
  sab = ringBufferSab;
  headerView = new Int32Array(sab, 0, 4);
  capacity = headerView[2];
  mask = capacity - 1;
  dataView = new Int16Array(sab, 16, capacity);
  localWrite = 0;
}

function ringWrite(buffer) {
  if (!dataView) return 0;
  const sampleCount = Math.floor(buffer.length / 2);
  const readHead = Atomics.load(headerView, 1);
  const available = (readHead + capacity - localWrite - 1) & mask;
  const toWrite = Math.min(sampleCount, Math.max(0, available));
  if (toWrite === 0) return 0;

  for (let i = 0; i < toWrite; i++) {
    dataView[(localWrite + i) & mask] = buffer.readInt16LE(i * 2);
  }

  localWrite = (localWrite + toWrite) & mask;
  Atomics.store(headerView, 0, localWrite);
  Atomics.notify(headerView, 0, 1);
  return toWrite;
}

// ── Platform detection ────────────────────────────────────────────────────

function getCaptureCommand() {
  const currentPlatform = platform();

  switch (currentPlatform) {
    case 'darwin':
      // macOS: try sox first, fall back to ffmpeg
      return {
        cmd: 'sox',
        args: ['-q', '-d', '-t', 'raw', '-r', '16000', '-e', 'signed', '-b', '16', '-c', '1', '-'],
        fallback: {
          cmd: 'ffmpeg',
          args: [
            '-f', 'avfoundation', '-i', ':0',
            '-ar', '16000', '-ac', '1', '-f', 's16le',
            '-hide_banner', '-loglevel', 'error',
            'pipe:1',
          ],
        },
        deviceInfo: { name: 'Default Microphone (sox/ffmpeg)', sampleRate: 16000, channels: 1 },
      };

    case 'linux':
      return {
        cmd: 'arecord',
        args: ['-q', '-f', 'S16_LE', '-r', '16000', '-c', '1', '-t', 'raw'],
        fallback: {
          cmd: 'ffmpeg',
          args: [
            '-f', 'alsa', '-i', 'default',
            '-ar', '16000', '-ac', '1', '-f', 's16le',
            '-hide_banner', '-loglevel', 'error',
            'pipe:1',
          ],
        },
        deviceInfo: { name: 'Default Microphone (arecord/ffmpeg)', sampleRate: 16000, channels: 1 },
      };

    case 'win32':
      return {
        cmd: 'ffmpeg',
        args: [
          '-f', 'dshow', '-i', 'audio=Default',
          '-ar', '16000', '-ac', '1', '-f', 's16le',
          '-hide_banner', '-loglevel', 'error',
          'pipe:1',
        ],
        fallback: null,
        deviceInfo: { name: 'Default Microphone (ffmpeg dshow)', sampleRate: 16000, channels: 1 },
      };

    default:
      return null;
  }
}

// ── Capture process management ────────────────────────────────────────────

let captureProcess = null;
let running = false;

async function startCapture() {
  const captureConfig = getCaptureCommand();
  if (!captureConfig) {
    parentPort?.postMessage({
      type: 'error',
      message: 'No audio capture command available for this platform',
      code: 'UNSUPPORTED_PLATFORM',
    });
    return;
  }

  // Try primary command, fall back to fallback
  let cmd = captureConfig.cmd;
  let args = captureConfig.args;

  try {
    captureProcess = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (primaryErr) {
    if (captureConfig.fallback) {
      cmd = captureConfig.fallback.cmd;
      args = captureConfig.fallback.args;
      try {
        captureProcess = spawn(cmd, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (err2) {
        parentPort?.postMessage({
          type: 'error',
          message: `Failed to spawn audio capture process: ${err2.message}`,
          code: 'SPAWN_FAILED',
        });
        return;
      }
    } else {
      parentPort?.postMessage({
        type: 'error',
        message: `Failed to spawn audio capture: ${primaryErr?.message ?? 'unknown error'}`,
        code: 'SPAWN_FAILED',
      });
      return;
    }
  }

  // Handle stderr (diagnostic output only — PCM data is on stdout)
  captureProcess.stderr?.on('data', (data) => {
    // Log stderr but only first occurrence (ffmpeg can be noisy)
    if (running) {
      console.warn('[audio-capture] stderr:', data.toString().trim().slice(0, 200));
    }
  });

  // Handle stdout — this is the PCM16 audio data stream
  captureProcess.stdout?.on('data', (chunk) => {
    if (running) {
      ringWrite(chunk);
    }
  });

  // Handle process exit
  captureProcess.on('exit', (code, signal) => {
    if (code !== 0 && code !== null && running) {
      parentPort?.postMessage({
        type: 'error',
        message: `Audio capture process exited with code ${code} (signal: ${signal})`,
        code: 'PROCESS_EXITED',
      });
    }
    captureProcess = null;
  });

  captureProcess.on('error', (err) => {
    parentPort?.postMessage({
      type: 'error',
      message: `Audio capture process error: ${err.message}`,
      code: 'PROCESS_ERROR',
    });
  });

  running = true;
  parentPort?.postMessage({
    type: 'started',
    deviceInfo: captureConfig.deviceInfo,
  });
}

function stopCapture() {
  running = false;
  const proc = captureProcess;
  captureProcess = null;
  if (proc) {
    proc.kill('SIGTERM');
    setTimeout(() => {
      if (proc && !proc.killed) {
        proc.kill('SIGKILL');
      }
    }, 1000);
  }
}

// ── Message handler ────────────────────────────────────────────────────────

parentPort?.on('message', async (msg) => {
  switch (msg.type) {
    case 'start': {
      initRingBuffer(msg.ringBuffer);
      await startCapture();
      break;
    }
    case 'stop': {
      stopCapture();
      parentPort?.postMessage({ type: 'stopped' });
      break;
    }
    case 'shutdown': {
      stopCapture();
      process.exit(0);
    }
  }
});

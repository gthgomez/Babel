/**
 * AudioRingBuffer — Lock-free SPSC (Single-Producer, Single-Consumer) ring
 * buffer for PCM16 audio samples, backed by SharedArrayBuffer.
 *
 * Uses Atomics.store / Atomics.load for coordination — no mutexes, no
 * syscalls, zero-copy concurrent access between Worker Threads.
 *
 * SharedArrayBuffer layout:
 *   Offset  Size   Field       Description
 *   0       4 B    writeHead   Producer cursor (Int32, atomically updated)
 *   4       4 B    readHead    Consumer cursor (Int32, atomically updated)
 *   8       4 B    capacity    Max number of Int16 samples
 *   12      4 B    reserved    Cache-line padding
 *   16      N*2 B  data        Int16Array PCM samples (capacity * 2 bytes)
 *
 * Default capacity: 32,000 samples (~2 seconds at 16kHz) = 64 KB + 16 B header.
 *
 * @module voice/audio-ring-buffer
 */

// ── Constants ───────────────────────────────────────────────────────────────

/** Number of 32-bit header fields before the PCM data. */
const HEADER_INTS = 4;

/** Index of the write-head field in the header. */
const IDX_WRITE = 0;

/** Index of the read-head field in the header. */
const IDX_READ = 1;

/** Index of the capacity field in the header. */
const IDX_CAPACITY = 2;

/** Byte offset where PCM sample data begins. */
const DATA_OFFSET_BYTES = HEADER_INTS * 4;

// ── Buffer creation ─────────────────────────────────────────────────────────

/**
 * Compute the SharedArrayBuffer size needed for a ring buffer of the given
 * capacity.
 */
export function ringBufferByteLength(capacitySamples: number): number {
  return DATA_OFFSET_BYTES + capacitySamples * 2; // Int16 = 2 bytes each
}

/**
 * Create a new SharedArrayBuffer pre-initialised as an empty ring buffer.
 * Capacity is rounded up to the nearest power of 2.
 */
export function createRingBuffer(capacitySamples: number): SharedArrayBuffer {
  // Round up to power of 2 for efficient modulo via bitmask
  const pow2 = 1 << Math.ceil(Math.log2(Math.max(2, capacitySamples)));
  const byteLength = ringBufferByteLength(pow2);
  const sab = new SharedArrayBuffer(byteLength);
  const header = new Int32Array(sab, 0, HEADER_INTS);
  header[IDX_WRITE] = 0;
  header[IDX_READ] = 0;
  header[IDX_CAPACITY] = pow2;
  return sab;
}

// ── RingBufferWriter (Producer) ─────────────────────────────────────────────

/**
 * Producer-side writer for the ring buffer.
 *
 * Writes PCM16 samples into the buffer and atomically advances the write-head.
 * Used by the audio capture Worker Thread (or main thread during child-process
 * stdout handling).
 */
export class RingBufferWriter {
  private readonly header: Int32Array;
  private readonly data: Int16Array;
  private readonly mask: number;
  private localWrite: number;

  constructor(sab: SharedArrayBuffer) {
    this.header = new Int32Array(sab, 0, HEADER_INTS);
    const capacity = this.header[IDX_CAPACITY] ?? 0;
    this.data = new Int16Array(sab, DATA_OFFSET_BYTES, capacity);
    this.mask = capacity - 1;
    this.localWrite = this.header[IDX_WRITE] ?? 0;
  }

  /** The capacity of the ring buffer in samples. */
  get capacity(): number {
    return this.header[IDX_CAPACITY] ?? 0;
  }

  /**
   * Write PCM16 samples from a Buffer (raw little-endian 16-bit bytes).
   * Non-blocking — returns the number of samples actually written.
   *
   * @returns Number of samples written (0 if buffer is full).
   */
  writeFromBuffer(buffer: Buffer): number {
    const sampleCount = Math.floor(buffer.length / 2);
    const readHead = Atomics.load(this.header, IDX_READ);
    const available = (readHead + this.capacity - this.localWrite - 1) & this.mask;
    const toWrite = Math.min(sampleCount, Math.max(0, available));

    if (toWrite === 0) return 0;

    for (let i = 0; i < toWrite; i++) {
      this.data[(this.localWrite + i) & this.mask] = buffer.readInt16LE(i * 2);
    }

    this.localWrite = (this.localWrite + toWrite) & this.mask;
    Atomics.store(this.header, IDX_WRITE, this.localWrite);
    Atomics.notify(this.header, IDX_WRITE, 1);

    return toWrite;
  }

  /**
   * Write PCM16 samples from an Int16Array.
   * Non-blocking — returns the number of samples actually written.
   */
  writeFromInt16(samples: Int16Array): number {
    const readHead = Atomics.load(this.header, IDX_READ);
    const available = (readHead + this.capacity - this.localWrite - 1) & this.mask;
    const toWrite = Math.min(samples.length, Math.max(0, available));

    if (toWrite === 0) return 0;

    for (let i = 0; i < toWrite; i++) {
      this.data[(this.localWrite + i) & this.mask] = samples[i] ?? 0;
    }

    this.localWrite = (this.localWrite + toWrite) & this.mask;
    Atomics.store(this.header, IDX_WRITE, this.localWrite);
    Atomics.notify(this.header, IDX_WRITE, 1);

    return toWrite;
  }

  /** Get the current write-head position. */
  getWriteHead(): number {
    return this.localWrite;
  }

  /** Reset the buffer to empty (consumer must also reset). */
  reset(): void {
    this.localWrite = 0;
    Atomics.store(this.header, IDX_WRITE, 0);
  }
}

// ── RingBufferReader (Consumer) ─────────────────────────────────────────────

/**
 * Consumer-side reader for the ring buffer.
 *
 * Reads PCM16 samples from the buffer and atomically advances the read-head.
 * Used by the VAD Worker Thread (or main thread for STT forwarding).
 */
export class RingBufferReader {
  private readonly header: Int32Array;
  private readonly data: Int16Array;
  private readonly mask: number;
  private localRead: number;

  constructor(sab: SharedArrayBuffer) {
    this.header = new Int32Array(sab, 0, HEADER_INTS);
    const capacity = this.header[IDX_CAPACITY] ?? 0;
    this.data = new Int16Array(sab, DATA_OFFSET_BYTES, capacity);
    this.mask = capacity - 1;
    this.localRead = this.header[IDX_READ] ?? 0;
  }

  /** The capacity of the ring buffer in samples. */
  get capacity(): number {
    return this.header[IDX_CAPACITY] ?? 0;
  }

  /** Number of samples currently available to read. */
  available(): number {
    const writeHead = Atomics.load(this.header, IDX_WRITE);
    return (writeHead - this.localRead) & this.mask;
  }

  /**
   * Read available PCM16 samples into an Int16Array.
   * Non-blocking — returns the number of samples actually read.
   *
   * @param out  Destination buffer.
   * @returns Number of samples read (0 if buffer is empty).
   */
  readInt16(out: Int16Array): number {
    const writeHead = Atomics.load(this.header, IDX_WRITE);
    const avail = (writeHead - this.localRead) & this.mask;
    const toRead = Math.min(out.length, avail);

    if (toRead === 0) return 0;

    for (let i = 0; i < toRead; i++) {
      out[i] = this.data[(this.localRead + i) & this.mask] ?? 0;
    }

    this.localRead = (this.localRead + toRead) & this.mask;
    Atomics.store(this.header, IDX_READ, this.localRead);

    return toRead;
  }

  /**
   * Read available PCM16 samples as a Float32Array normalised to [-1.0, 1.0].
   * This is the format expected by Silero VAD and most ML inference engines.
   *
   * @param out  Destination buffer.
   * @returns Number of samples read (0 if buffer is empty).
   */
  readFloat32(out: Float32Array): number {
    const writeHead = Atomics.load(this.header, IDX_WRITE);
    const avail = (writeHead - this.localRead) & this.mask;
    const toRead = Math.min(out.length, avail);

    if (toRead === 0) return 0;

    for (let i = 0; i < toRead; i++) {
      // Normalise Int16 [-32768, 32767] to Float32 [-1.0, 1.0]
      out[i] = (this.data[(this.localRead + i) & this.mask] ?? 0) / 32768;
    }

    this.localRead = (this.localRead + toRead) & this.mask;
    Atomics.store(this.header, IDX_READ, this.localRead);

    return toRead;
  }

  /**
   * Block until new data is available, or timeout expires.
   * Uses Atomics.wait for efficient blocking without polling.
   *
   * @param timeoutMs  Maximum wait time in ms (default: 100).
   * @returns true if data is available, false if timed out.
   */
  waitForData(timeoutMs: number = 100): boolean {
    const currentWrite = Atomics.load(this.header, IDX_WRITE);
    if (currentWrite !== this.localRead) return true;
    Atomics.wait(this.header, IDX_WRITE, currentWrite, timeoutMs);
    return this.localRead !== Atomics.load(this.header, IDX_WRITE);
  }

  /** Reset the buffer to empty (producer must also reset). */
  reset(): void {
    this.localRead = 0;
    Atomics.store(this.header, IDX_READ, 0);
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a new ring buffer and return both reader and writer handles.
 * Both share the same SharedArrayBuffer.
 *
 * @param durationMs  Buffer duration in milliseconds (default: 2000).
 * @param sampleRate  Sample rate in Hz (default: 16000).
 */
export function createRingBufferPair(durationMs: number = 2000, sampleRate: number = 16000): {
  sab: SharedArrayBuffer;
  writer: RingBufferWriter;
  reader: RingBufferReader;
} {
  const capacitySamples = Math.ceil((sampleRate * durationMs) / 1000);
  const sab = createRingBuffer(capacitySamples);
  return {
    sab,
    writer: new RingBufferWriter(sab),
    reader: new RingBufferReader(sab),
  };
}

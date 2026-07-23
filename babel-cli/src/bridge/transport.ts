/**
 * Transport implementations for the Babel IDE Bridge.
 *
 * Provides:
 *   - NDJSON framing utilities for child-process and socket communication.
 *   - InProcessTransport     — in-process direct message passing.
 *   - WebSocketTransport     — wraps a raw TCP socket after HTTP upgrade
 *                              (RFC 6455), implementing text frame encoding
 *                              and decoding on top of `node:net.Socket`.
 *   - createTransport        — factory for creating transports by type.
 */

import { once } from 'node:events';
import type { Socket } from 'node:net';
import { createHash } from 'node:crypto';

import type { BridgeMessage, BridgeTransport } from './types.js';

// ─── Constants ─────────────────────────────────────────────────────────────────

/** WebSocket magic GUID for the accept-key calculation (RFC 6455 Section 4.2.2). */
const WS_MAGIC_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Opcode for a text frame. */
const OPCODE_TEXT = 0x01;

/** Opcode for a close frame. */
const OPCODE_CLOSE = 0x08;

/** Opcode for a ping frame. */
const OPCODE_PING = 0x09;

/** Opcode for a pong frame. */
const OPCODE_PONG = 0x0a;

/** Max frame payload for the 7-bit length field. */
const PAYLOAD_LENGTH_7 = 125;

/** Marker for 16-bit extended length. */
const PAYLOAD_LENGTH_16 = 126;

/** Marker for 64-bit extended length. */
const PAYLOAD_LENGTH_64 = 127;

// ─── NDJSON framing ────────────────────────────────────────────────────────────

/**
 * Encode a BridgeMessage as an NDJSON line.
 * Appends a trailing newline for stream delimiting.
 */
export function encodeNdjson(message: BridgeMessage): string {
  return JSON.stringify(message) + '\n';
}

/**
 * Try to parse a BridgeMessage from an NDJSON buffer.
 * Returns the parsed message and the remaining buffer, or null if
 * no complete line is yet available.
 */
export function tryParseNdjson(
  buffer: string,
): { message: BridgeMessage; remainder: string } | null {
  const newlineIdx = buffer.indexOf('\n');
  if (newlineIdx === -1) return null;
  const line = buffer.slice(0, newlineIdx);
  const remainder = buffer.slice(newlineIdx + 1);
  try {
    const parsed = JSON.parse(line) as unknown;
    return { message: parsed as BridgeMessage, remainder };
  } catch {
    // Skip malformed lines and continue
    return { message: { type: 'error' as const, message: 'Malformed NDJSON line', sessionId: '' }, remainder };
  }
}

// ─── WebSocket frame helpers (RFC 6455) ───────────────────────────────────────

/**
 * Compute the Sec-WebSocket-Accept value from the client's key.
 *
 * @param key - The Sec-WebSocket-Key header value from the client.
 * @returns The base64-encoded SHA-1 hash for the upgrade response.
 */
export function computeWsAcceptKey(key: string): string {
  return createHash('sha1').update(key + WS_MAGIC_GUID, 'utf8').digest('base64');
}

/** Internal result from parsing a WebSocket frame header. */
interface FrameHeader {
  opcode: number;
  mask: boolean;
  payloadLength: number;
  maskingKey?: Buffer;
}

/**
 * Build a WebSocket text frame (FIN=1, opcode=text) suitable for writing
 * to a socket. Server-to-client frames are UNMASKED per RFC 6455 §5.1.
 *
 * @param payload - The UTF-8 text payload.
 * @returns A Buffer containing the complete WebSocket frame.
 */
export function buildWsTextFrame(payload: string): Buffer {
  const data = Buffer.from(payload, 'utf8');
  const length = data.length;

  // Header: FIN=1 (0x80) | opcode=text (0x01) = 0x81
  const headerParts: Buffer[] = [];

  if (length <= PAYLOAD_LENGTH_7) {
    headerParts.push(Buffer.from([0x81, length]));
  } else if (length <= 0xffff) {
    headerParts.push(Buffer.from([0x81, PAYLOAD_LENGTH_16]));
    headerParts.push(Buffer.alloc(2));
    headerParts[1]!.writeUInt16BE(length, 0);
  } else {
    headerParts.push(Buffer.from([0x81, PAYLOAD_LENGTH_64]));
    headerParts.push(Buffer.alloc(8));
    headerParts[1]!.writeBigUInt64BE(BigInt(length), 0);
  }

  return Buffer.concat([...headerParts, data]);
}

/**
 * Try to parse a WebSocket frame from a received data buffer.
 *
 * Client-to-server frames ARE masked (RFC 6455 §5.1). This function handles
 * unmasking transparently and returns decoded text frames.
 *
 * Returns null when more data is needed to complete the frame.
 */
export function tryParseWsFrame(
  buffer: Buffer,
): { payload: string; opcode: number; remainder: Buffer } | null {
  if (buffer.length < 2) return null;

  const firstByte = buffer[0]!;
  const secondByte = buffer[1]!;
  const opcode = firstByte & 0x0f;
  const mask = (secondByte & 0x80) !== 0;

  let payloadLength = secondByte & 0x7f;
  let offset = 2;

  if (payloadLength === PAYLOAD_LENGTH_16) {
    if (buffer.length < 4) return null;
    payloadLength = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (payloadLength === PAYLOAD_LENGTH_64) {
    if (buffer.length < 10) return null;
    const bigLen = buffer.readBigUInt64BE(offset);
    payloadLength = Number(bigLen);
    offset += 8;
  }

  let maskingKey: Buffer | undefined;
  if (mask) {
    if (buffer.length < offset + 4) return null;
    maskingKey = buffer.subarray(offset, offset + 4);
    offset += 4;
  }

  const frameEnd = offset + payloadLength;
  if (buffer.length < frameEnd) return null;

  let payloadData = buffer.subarray(offset, frameEnd);

  // Unmask if needed
  if (mask && maskingKey) {
    const unmasked: Buffer = Buffer.alloc(payloadData.length);
    for (let i = 0; i < payloadData.length; i++) {
      unmasked[i] = payloadData[i]! ^ maskingKey[i % 4]!;
    }
    payloadData = unmasked;
  }

  const remainder = buffer.subarray(frameEnd);

  // For text frames, decode as UTF-8
  if (opcode === OPCODE_TEXT) {
    return { payload: payloadData.toString('utf8'), opcode, remainder };
  }

  // For control frames (close, ping, pong), return empty string payload
  return { payload: '', opcode, remainder };
}

/**
 * Build a WebSocket close frame.
 */
function buildWsCloseFrame(code?: number): Buffer {
  const codeBytes = code !== undefined
    ? Buffer.alloc(2)
    : Buffer.alloc(0);
  if (code !== undefined && codeBytes.length >= 2) {
    codeBytes.writeUInt16BE(code, 0);
  }
  const header = Buffer.from([0x88, codeBytes.length]);
  return codeBytes.length > 0 ? Buffer.concat([header, codeBytes]) : header;
}

/**
 * Build a WebSocket pong frame (echoes the ping payload).
 */
function buildWsPongFrame(payload: Buffer): Buffer {
  const length = payload.length;
  if (length <= PAYLOAD_LENGTH_7) {
    return Buffer.concat([Buffer.from([0x8a, length]), payload]);
  }
  // Extended length — unlikely for pings but handle it
  const header = Buffer.from([0x8a, PAYLOAD_LENGTH_16]);
  const lenBytes = Buffer.alloc(2);
  lenBytes.writeUInt16BE(length, 0);
  return Buffer.concat([header, lenBytes, payload]);
}

// ─── FrameBuffer (incoming frame reassembly) ───────────────────────────────────

/**
 * Buffers incoming socket data and yields complete WebSocket frames.
 * Handles partial reads and reassembles fragmented frames.
 */
class FrameBuffer {
  private buffer: Buffer = Buffer.alloc(0);

  /**
   * Whether a close frame has been received.
   */
  closeRequested = false;

  /**
   * Append incoming data and extract any complete frames.
   * Returns an array of decoded text payloads.
   *
   * Control frames (close, ping, pong) are handled internally:
   *   - close → sets `closeRequested` and optionally reads close code.
   *   - ping → auto-reply with pong.
   */
  feed(
    data: Buffer,
    sendFrame: (frame: Buffer) => void,
  ): string[] {
    this.buffer = Buffer.concat([this.buffer, data]);
    const frames: string[] = [];

    while (true) {
      const result = tryParseWsFrame(this.buffer);
      if (!result) break; // Need more data

      this.buffer = result.remainder;

      switch (result.opcode) {
        case OPCODE_TEXT:
          frames.push(result.payload);
          break;
        case OPCODE_CLOSE:
          this.closeRequested = true;
          // Echo close frame back
          sendFrame(buildWsCloseFrame(1000));
          break;
        case OPCODE_PING:
          sendFrame(buildWsPongFrame(Buffer.from(result.payload, 'utf8')));
          break;
        case OPCODE_PONG:
          // Ignore unsolicited pongs
          break;
        default:
          // Unknown opcode — ignore
          break;
      }
    }

    return frames;
  }
}

// ─── InProcessTransport ────────────────────────────────────────────────────────

/**
 * In-process transport — direct function calls within the same process.
 *
 * Used as the default transport for local communication between the
 * bridge server and session runners when no remote client is involved.
 */
export class InProcessTransport implements BridgeTransport {
  sessionId?: string | undefined;
  private handler: ((msg: BridgeMessage) => void) | null = null;
  private closeHandler: ((reason?: string) => void) | null = null;
  private _closed = false;

  constructor(opts?: { sessionId?: string | undefined }) {
    this.sessionId = opts?.sessionId;
  }

  get closed(): boolean {
    return this._closed;
  }

  send(message: BridgeMessage): void {
    if (this._closed) return;
    // Deliver to paired transport if linked, otherwise to registered handler
    if (this.pairedHandler) {
      this.pairedHandler(message);
    } else {
      this.handler?.(message);
    }
  }

  onMessage(handler: (msg: BridgeMessage) => void): () => void {
    this.handler = handler;
    return () => {
      this.handler = null;
    };
  }

  onClose(handler: (reason?: string) => void): void {
    this.closeHandler = handler;
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    this.closeHandler?.();
    this.handler = null;
    this.pairedHandler = null;
  }

  /**
   * Internal handler set by `createLinkedTransports` for direct delivery.
   * Not exposed on the interface; used by the factory.
   */
  pairedHandler: ((msg: BridgeMessage) => void) | null = null;
}

/**
 * Create a pair of linked InProcessTransports that deliver messages
 * directly to each other's handler — zero-copy, no serialization.
 *
 * Useful for connecting a bridge server to a session runner within
 * the same process.
 */
export function createLinkedTransports(
  labelA?: string,
  labelB?: string,
): [InProcessTransport, InProcessTransport] {
  const a = new InProcessTransport({ sessionId: labelA });
  const b = new InProcessTransport({ sessionId: labelB });

  a.pairedHandler = (msg) => b['handler']?.(msg);
  b.pairedHandler = (msg) => a['handler']?.(msg);

  return [a, b];
}

// ─── WebSocketTransport ────────────────────────────────────────────────────────

/**
 * WebSocket transport — wraps a raw TCP socket after HTTP upgrade.
 *
 * Encodes/decodes RFC 6455 text frames around BridgeMessage JSON payloads.
 * Handles ping/pong, close frames, and partial-read reassembly automatically.
 *
 * This is the SERVER-SIDE transport (frames are unmasked on send, masked on
 * receive per RFC 6455 §5.1).
 */
export class WebSocketTransport implements BridgeTransport {
  sessionId?: string | undefined;
  private handler: ((msg: BridgeMessage) => void) | null = null;
  private closeCb: ((reason?: string) => void) | null = null;
  private _closed = false;
  private frameBuffer = new FrameBuffer();
  private socket: Socket;
  private cleanupFns: Array<() => void> = [];

  /**
   * @param socket - The raw TCP socket after the HTTP 101 upgrade.
   * @param opts - Optional configuration.
   */
  constructor(socket: Socket, opts?: { sessionId?: string | undefined }) {
    this.sessionId = opts?.sessionId;
    this.socket = socket;

    // Forward incoming data to the frame buffer
    const onData = (chunk: Buffer) => {
      const frames = this.frameBuffer.feed(chunk, (frame) => this.writeRaw(frame));
      for (const payload of frames) {
        this.deliver(payload);
      }
      // If close frame received, begin tear-down
      if (this.frameBuffer.closeRequested && !this._closed) {
        this.close();
      }
    };

    const onClose = () => {
      if (!this._closed) {
        this._closed = true;
        this.closeCb?.('socket closed');
      }
    };

    const onError = () => {
      if (!this._closed) {
        this._closed = true;
        this.closeCb?.('socket error');
      }
    };

    this.socket.on('data', onData);
    this.socket.on('close', onClose);
    this.socket.on('error', onError);
    this.cleanupFns = [
      () => this.socket.off('data', onData),
      () => this.socket.off('close', onClose),
      () => this.socket.off('error', onError),
    ];
  }

  get closed(): boolean {
    return this._closed;
  }

  send(message: BridgeMessage): void {
    if (this._closed) return;
    const payload = JSON.stringify(message);
    const frame = buildWsTextFrame(payload);
    this.writeRaw(frame);
  }

  onMessage(handler: (msg: BridgeMessage) => void): () => void {
    this.handler = handler;
    return () => {
      this.handler = null;
    };
  }

  onClose(handler: (reason?: string) => void): void {
    this.closeCb = handler;
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;

    // Send close frame
    try {
      this.writeRaw(buildWsCloseFrame(1000));
    } catch {
      // Socket may already be destroyed
    }

    // Clean up event listeners
    for (const fn of this.cleanupFns) {
      try {
        fn();
      } catch {
        // Ignore cleanup errors
      }
    }
    this.cleanupFns = [];

    // Destroy the socket
    try {
      this.socket.end();
      this.socket.destroy();
    } catch {
      // Already destroyed
    }

    this.closeCb?.();
    this.handler = null;
  }

  /**
   * Deliver a raw text payload as a parsed BridgeMessage to the handler.
   */
  private deliver(payload: string): void {
    try {
      const parsed = JSON.parse(payload) as unknown;
      this.handler?.(parsed as BridgeMessage);
    } catch {
      // Malformed JSON — ignore
    }
  }

  /**
   * Write raw bytes to the underlying socket.
   */
  private writeRaw(frame: Buffer): void {
    if (this.socket.destroyed) return;
    try {
      this.socket.write(frame);
    } catch {
      // Socket write error — ignore, onClose will fire
    }
  }
}

// ─── Transport factory ─────────────────────────────────────────────────────────

export type TransportType = 'inproc' | 'ws';

export interface TransportOptions {
  type: TransportType;
  sessionId?: string | undefined;
  /** For 'ws' type: the socket after HTTP upgrade. */
  socket?: Socket | undefined;
}

/**
 * Create a transport by type.
 *
 * @param options - Transport configuration.
 * @returns A BridgeTransport instance.
 * @throws {Error} When the transport type is unknown or required options
 *   (like `socket` for 'ws') are missing.
 */
export function createTransport(options: TransportOptions): BridgeTransport {
  switch (options.type) {
    case 'inproc':
      return new InProcessTransport({ sessionId: options.sessionId });
    case 'ws':
      if (!options.socket) {
        throw new Error('WebSocket transport requires a socket');
      }
      return new WebSocketTransport(options.socket, {
        sessionId: options.sessionId,
      });
    default:
      throw new Error(`Unknown transport type: ${options.type as string}`);
  }
}

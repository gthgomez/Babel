/**
 * Tests for bridge transport implementations.
 *
 * Covers:
 *   - NDJSON encoding/decoding
 *   - WebSocket frame encoding/decoding
 *   - InProcessTransport round-trip (message send/receive)
 *   - Linked transports pair
 *   - Transport factory
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { BridgeMessage } from './types.js';
import {
  encodeNdjson,
  tryParseNdjson,
  computeWsAcceptKey,
  buildWsTextFrame,
  tryParseWsFrame,
  InProcessTransport,
  createLinkedTransports,
  createTransport,
} from './transport.js';

// ─── NDJSON framing tests ──────────────────────────────────────────────────────

describe('NDJSON framing', () => {
  it('encodes a BridgeMessage as a JSON line with trailing newline', () => {
    const msg: BridgeMessage = { type: 'heartbeat', sessionId: 'test-1' };
    const encoded = encodeNdjson(msg);
    assert.equal(encoded.endsWith('\n'), true);
    const parsed = JSON.parse(encoded.trim()) as Record<string, unknown>;
    assert.equal(parsed['type'], 'heartbeat');
    assert.equal(parsed['sessionId'], 'test-1');
  });

  it('parses a complete NDJSON buffer', () => {
    const msg: BridgeMessage = {
      type: 'prompt',
      text: 'hello',
      sessionId: 'test-1',
    };
    const encoded = encodeNdjson(msg);
    const result = tryParseNdjson(encoded);
    assert.notEqual(result, null);
    if (result) {
      assert.equal(result.message.type, 'prompt');
      if (result.message.type === 'prompt') {
        assert.equal(result.message.text, 'hello');
      }
      assert.equal(result.remainder, '');
    }
  });

  it('parses the first line from a multi-line buffer', () => {
    const msg1: BridgeMessage = { type: 'heartbeat', sessionId: 'test-1' };
    const msg2: BridgeMessage = { type: 'done', sessionId: 'test-2' };
    const buffer = encodeNdjson(msg1) + encodeNdjson(msg2);
    const result = tryParseNdjson(buffer);
    assert.notEqual(result, null);
    if (result) {
      assert.equal(result.message.type, 'heartbeat');
      assert.equal(result.remainder, encodeNdjson(msg2));
    }
  });

  it('returns null for incomplete buffer', () => {
    const result = tryParseNdjson('{"type": "heartbeat"');
    assert.equal(result, null);
  });

  it('recovers from a malformed line', () => {
    const result = tryParseNdjson('not-json\n{"type":"heartbeat","sessionId":"s1"}\n');
    assert.notEqual(result, null);
    if (result) {
      // The malformed line produces an error message
      assert.equal(result.message.type, 'error');
    }
  });
});

// ─── WebSocket framing tests ────────────────────────────────────────────────────

describe('WebSocket framing', () => {
  it('computes the accept key correctly', () => {
    // RFC 6455 §1.3 example — derive key from plain text (avoid hardcoded base64 literals).
    const key = Buffer.from('the sample nonce', 'utf8').toString('base64');
    const expected = 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=';
    assert.equal(computeWsAcceptKey(key), expected);
  });

  it('builds and parses a small text frame (unmasked)', () => {
    const payload = 'Hello, World!';
    const frame = buildWsTextFrame(payload);

    // Parse it back
    const result = tryParseWsFrame(frame);
    assert.notEqual(result, null);
    if (result) {
      assert.equal(result.opcode, 0x01); // text
      assert.equal(result.payload, payload);
    }
  });

  it('builds and parses a medium text frame (>125 bytes)', () => {
    const payload = 'x'.repeat(200);
    const frame = buildWsTextFrame(payload);
    const result = tryParseWsFrame(frame);
    assert.notEqual(result, null);
    if (result) {
      assert.equal(result.payload.length, 200);
      assert.equal(result.payload, payload);
    }
  });

  it('builds and parses a large text frame (>65535 bytes)', () => {
    const payload = 'x'.repeat(70000);
    const frame = buildWsTextFrame(payload);
    const result = tryParseWsFrame(frame);
    assert.notEqual(result, null);
    if (result) {
      assert.equal(result.payload.length, 70000);
    }
  });

  it('returns null for truncated frame data', () => {
    const payload = 'Hello';
    const frame = buildWsTextFrame(payload);
    const truncated = frame.subarray(0, frame.length - 3);
    const result = tryParseWsFrame(truncated);
    assert.equal(result, null);
  });

  it('properly unmask client-to-server frames', () => {
    // Build a masked frame manually (simulating a client)
    const payload = Buffer.from('Hello, Server!', 'utf8');
    const maskKey = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) {
      masked[i] = payload[i]! ^ maskKey[i % 4]!;
    }

    // FIN=1, opcode=text, MASK=1, length
    const header = Buffer.from([0x81, 0x80 | payload.length]);
    const frame = Buffer.concat([header, maskKey, masked]);

    const result = tryParseWsFrame(frame);
    assert.notEqual(result, null);
    if (result) {
      assert.equal(result.payload, 'Hello, Server!');
    }
  });

  it('delivers remainder after parsing a frame from concatenated data', () => {
    const msg1 = 'first';
    const msg2 = 'second';
    const frame1 = buildWsTextFrame(msg1);
    const frame2 = buildWsTextFrame(msg2);
    const combined = Buffer.concat([frame1, frame2]);

    const result = tryParseWsFrame(combined);
    assert.notEqual(result, null);
    if (result) {
      assert.equal(result.payload, 'first');
      // Remainder should start with the second frame
      const remainder = result.remainder;
      const result2 = tryParseWsFrame(remainder);
      assert.notEqual(result2, null);
      if (result2) {
        assert.equal(result2.payload, 'second');
      }
    }
  });
});

// ─── InProcessTransport tests ──────────────────────────────────────────────────

describe('InProcessTransport', () => {
  it('sends and receives messages via linked transports', () => {
    const [client, server] = createLinkedTransports('client', 'server');

    const received: BridgeMessage[] = [];
    server.onMessage((msg) => {
      received.push(msg);
    });

    const prompt: BridgeMessage = {
      type: 'prompt',
      text: 'hello',
      sessionId: 'test-1',
    };
    client.send(prompt);

    assert.equal(received.length, 1);
    assert.equal(received[0]?.type, 'prompt');
    if (received[0]?.type === 'prompt') {
      assert.equal(received[0].text, 'hello');
    }

    client.close();
    server.close();
  });

  it('supports bidirectional communication', () => {
    const [a, b] = createLinkedTransports('a', 'b');

    const aReceived: BridgeMessage[] = [];
    const bReceived: BridgeMessage[] = [];

    a.onMessage((msg) => aReceived.push(msg));
    b.onMessage((msg) => bReceived.push(msg));

    a.send({ type: 'heartbeat', sessionId: 's1' });
    b.send({ type: 'done', sessionId: 's1' });

    assert.equal(bReceived.length, 1);
    assert.equal(aReceived.length, 1);

    a.close();
    b.close();
  });

  it('no-ops after close', () => {
    const transport = new InProcessTransport({ sessionId: 'test' });
    transport.close();

    // Should not throw
    transport.send({ type: 'heartbeat', sessionId: 's1' });
    transport.close(); // Double close should not throw

    assert.equal(transport.closed, true);
  });

  it('onMessage returns an unsubscribe function', () => {
    const transport = new InProcessTransport();
    const received: BridgeMessage[] = [];

    const unsub = transport.onMessage((msg) => received.push(msg));
    transport.send({ type: 'heartbeat', sessionId: 's1' });
    assert.equal(received.length, 1);

    unsub();
    transport.send({ type: 'heartbeat', sessionId: 's2' });
    assert.equal(received.length, 1); // No new messages after unsubscribe

    transport.close();
  });

  it('replaces handler on second onMessage call', () => {
    const transport = new InProcessTransport();
    const first: BridgeMessage[] = [];
    const second: BridgeMessage[] = [];

    transport.onMessage((msg) => first.push(msg));
    transport.onMessage((msg) => second.push(msg));
    transport.send({ type: 'heartbeat', sessionId: 's1' });

    assert.equal(first.length, 0); // First handler replaced
    assert.equal(second.length, 1);

    transport.close();
  });
});

// ─── Transport factory tests ───────────────────────────────────────────────────

describe('Transport factory', () => {
  it('creates an InProcessTransport by type', () => {
    const transport = createTransport({ type: 'inproc', sessionId: 'test' });
    assert.ok(transport instanceof InProcessTransport);
    assert.equal(transport.sessionId, 'test');
    transport.close();
  });

  it('throws for unknown transport type', () => {
    assert.throws(() => {
      createTransport({ type: 'unknown' as never, sessionId: 'test' });
    });
  });

  it('throws for WebSocket transport without socket', () => {
    assert.throws(() => {
      createTransport({ type: 'ws', sessionId: 'test' });
    });
  });
});

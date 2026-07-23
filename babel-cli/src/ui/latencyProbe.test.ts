/**
 * latencyProbe.test.ts — Tests for SSH latency detection and bucket classification.
 *
 * Tests manipulate env vars and internal state to verify SSH detection,
 * bucket classification, and DSR probe behavior. DSR probe tests use the
 * non-TTY fallback path since test runners don't provide a real TTY stdin.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { SshLatencyDetector } from './latencyProbe.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
  }
  try {
    for (const [key, val] of Object.entries(overrides)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
    SshLatencyDetector.resetInstance();
    fn();
  } finally {
    for (const [key, val] of Object.entries(saved)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
    SshLatencyDetector.resetInstance();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. SSH detection
// ═══════════════════════════════════════════════════════════════════════════════

test('detectSsh returns true when SSH_CLIENT is set', () => {
  withEnv({ SSH_CLIENT: '10.0.0.1 5000 22' }, () => {
    assert.equal(SshLatencyDetector.getInstance().isSsh, true);
  });
});

test('detectSsh returns true when SSH_TTY is set', () => {
  withEnv({ SSH_TTY: '/dev/pts/2' }, () => {
    assert.equal(SshLatencyDetector.getInstance().isSsh, true);
  });
});

test('detectSsh returns true when SSH_CONNECTION is set', () => {
  withEnv({ SSH_CONNECTION: '10.0.0.1 5000 10.0.0.2 22' }, () => {
    assert.equal(SshLatencyDetector.getInstance().isSsh, true);
  });
});

test('detectSsh returns false when no SSH env vars', () => {
  withEnv(
    {
      SSH_CLIENT: undefined,
      SSH_TTY: undefined,
      SSH_CONNECTION: undefined,
    },
    () => {
      assert.equal(SshLatencyDetector.getInstance().isSsh, false);
    },
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Bucket classification
// ═══════════════════════════════════════════════════════════════════════════════

test('getBucket: null RTT on non-SSH → local', () => {
  withEnv({ SSH_CLIENT: undefined }, () => {
    const detector = SshLatencyDetector.getInstance();
    assert.equal(detector.getBucket(), 'local');
  });
});

test('getBucket: null RTT on SSH → wan (conservative)', () => {
  withEnv({ SSH_CLIENT: '10.0.0.1 5000 22' }, () => {
    const detector = SshLatencyDetector.getInstance();
    assert.equal(detector.getBucket(), 'wan');
  });
});

test('getBucket: RTT < 5ms → local', () => {
  withEnv({ SSH_CLIENT: undefined }, () => {
    const detector = SshLatencyDetector.getInstance();
    (detector as any)._rtt = 2;
    assert.equal(detector.getBucket(), 'local');
  });
});

test('getBucket: RTT 5ms → lan', () => {
  withEnv({ SSH_CLIENT: undefined }, () => {
    const detector = SshLatencyDetector.getInstance();
    (detector as any)._rtt = 5;
    assert.equal(detector.getBucket(), 'lan');
  });
});

test('getBucket: RTT 25ms → lan', () => {
  withEnv({ SSH_CLIENT: undefined }, () => {
    const detector = SshLatencyDetector.getInstance();
    (detector as any)._rtt = 25;
    assert.equal(detector.getBucket(), 'lan');
  });
});

test('getBucket: RTT 49ms → lan', () => {
  withEnv({ SSH_CLIENT: undefined }, () => {
    const detector = SshLatencyDetector.getInstance();
    (detector as any)._rtt = 49;
    assert.equal(detector.getBucket(), 'lan');
  });
});

test('getBucket: RTT 50ms → wan', () => {
  withEnv({ SSH_CLIENT: undefined }, () => {
    const detector = SshLatencyDetector.getInstance();
    (detector as any)._rtt = 50;
    assert.equal(detector.getBucket(), 'wan');
  });
});

test('getBucket: RTT 200ms → wan', () => {
  withEnv({ SSH_CLIENT: '10.0.0.1 5000 22' }, () => {
    const detector = SshLatencyDetector.getInstance();
    (detector as any)._rtt = 200;
    assert.equal(detector.getBucket(), 'wan');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. DSR probe (non-TTY fallback)
// ═══════════════════════════════════════════════════════════════════════════════

test('measureRtt returns null on non-TTY', async () => {
  // Test runner stdin is not a TTY, so this should return null
  const detector = SshLatencyDetector.getInstance();
  const result = await detector.measureRtt();
  assert.equal(result, null, 'DSR probe should return null on non-TTY');
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Latency summary
// ═══════════════════════════════════════════════════════════════════════════════

test('getLatencySummary: local with measured RTT', () => {
  withEnv({ SSH_CLIENT: undefined }, () => {
    const detector = SshLatencyDetector.getInstance();
    (detector as any)._rtt = 3;
    assert.ok(detector.getLatencySummary().includes('Local'));
    assert.ok(detector.getLatencySummary().includes('3ms'));
  });
});

test('getLatencySummary: WAN over SSH', () => {
  withEnv({ SSH_CLIENT: '10.0.0.1 5000 22' }, () => {
    const detector = SshLatencyDetector.getInstance();
    (detector as any)._rtt = 100;
    const summary = detector.getLatencySummary();
    assert.ok(summary.includes('WAN'));
    assert.ok(summary.includes('SSH'));
    assert.ok(summary.includes('100ms'));
  });
});

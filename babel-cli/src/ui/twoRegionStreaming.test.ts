/**
 * twoRegionStreaming.test.ts — Tests for the TwoRegionStreaming class.
 *
 * Covers hardware-scroll mode, fallback mode, setup/teardown lifecycle,
 * resize handling, and integration with OutputBuffer scroll regions.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { TwoRegionStreaming } from './twoRegionStreaming.js';
import { OutputBuffer } from './outputBuffer.js';
import { resetTerminalProbe } from './terminalProbe.js';
import { withEnv } from './testUtils.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════════

function mockStdoutWrite(): { writes: string[]; restore: () => void } {
  const original = process.stdout.write;
  const writes: string[] = [];
  (process.stdout as { write: typeof process.stdout.write }).write = ((data: unknown) => {
    writes.push(String(data ?? ''));
    return true;
  }) as typeof process.stdout.write;
  return {
    writes,
    restore: () => {
      (process.stdout as { write: typeof process.stdout.write }).write = original;
    },
  };
}

const savedAnsiEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ['NO_COLOR', 'BABEL_A11Y'] as const) {
    savedAnsiEnv[key] = process.env[key];
    delete process.env[key];
  }
  OutputBuffer.resetInstance();
  resetTerminalProbe();
});

afterEach(() => {
  for (const key of ['NO_COLOR', 'BABEL_A11Y'] as const) {
    if (savedAnsiEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedAnsiEnv[key];
  }
  OutputBuffer.resetInstance();
  resetTerminalProbe();
});

// ═══════════════════════════════════════════════════════════════════════════════
// Lifecycle
// ═══════════════════════════════════════════════════════════════════════════════

describe('Lifecycle', () => {
  it('starts inactive', () => {
    const trs = new TwoRegionStreaming();
    assert.equal(trs.isActive, false);
  });

  it('setup activates the stream', () => {
    const trs = new TwoRegionStreaming();
    trs.setup(50);
    assert.equal(trs.isActive, true);
    trs.teardown();
  });

  it('teardown deactivates the stream', () => {
    const trs = new TwoRegionStreaming();
    trs.setup(50);
    trs.teardown();
    assert.equal(trs.isActive, false);
  });

  it('teardown is safe to call when not active', () => {
    const trs = new TwoRegionStreaming();
    trs.teardown(); // should not throw
    assert.equal(trs.isActive, false);
  });

  it('double teardown is safe', () => {
    const trs = new TwoRegionStreaming();
    trs.setup(50);
    trs.teardown();
    trs.teardown(); // should not throw
    assert.equal(trs.isActive, false);
  });

  it('write while inactive is a no-op', () => {
    const trs = new TwoRegionStreaming();
    const mock = mockStdoutWrite();
    try {
      trs.writeStreaming('hello');
      // Should not have written (inactive)
      assert.equal(mock.writes.length, 0);
    } finally {
      mock.restore();
    }
  });

  it('commit while inactive is a no-op', () => {
    const trs = new TwoRegionStreaming();
    trs.commitStreaming(); // should not throw
    assert.equal(trs.isActive, false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Fallback mode
// ═══════════════════════════════════════════════════════════════════════════════

describe('Fallback mode', () => {
  it('enters fallback mode when BABEL_SCROLL_REGIONS=0', () => {
    withEnv({ BABEL_SCROLL_REGIONS: '0' }, () => {
      const trs = new TwoRegionStreaming();
      trs.setup(50);
      assert.equal(trs.isHardwareMode, false);
      assert.equal(trs.isActive, true);
      trs.teardown();
    });
  });

  it('enters fallback mode when terminal is too small', () => {
    withEnv({ BABEL_SCROLL_REGIONS: '1' }, () => {
      const trs = new TwoRegionStreaming();
      // Terminal height below MIN_TERMINAL_HEIGHT (20)
      trs.setup(15);
      assert.equal(trs.isHardwareMode, false);
      trs.teardown();
    });
  });

  it('writes directly to stdout in fallback mode', () => {
    withEnv({ BABEL_SCROLL_REGIONS: '0' }, () => {
      const trs = new TwoRegionStreaming();
      const mock = mockStdoutWrite();
      try {
        trs.setup(50);
        trs.writeStreaming('fallback text');
        assert.ok(mock.writes.join('').includes('fallback text'));
      } finally {
        mock.restore();
        trs.teardown();
      }
    });
  });

  it('commit is a no-op in fallback mode', () => {
    withEnv({ BABEL_SCROLL_REGIONS: '0' }, () => {
      const trs = new TwoRegionStreaming();
      trs.setup(50);
      trs.writeStreaming('some content');
      trs.commitStreaming();
      // Should not throw and should deactivate
      assert.equal(trs.isActive, false);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Hardware mode
// ═══════════════════════════════════════════════════════════════════════════════

describe('Hardware mode', () => {
  it('enters hardware mode when scroll regions are supported', () => {
    withEnv({ BABEL_SCROLL_REGIONS: '1' }, () => {
      const trs = new TwoRegionStreaming();
      trs.setup(50, 12);
      assert.equal(trs.isHardwareMode, true);
      trs.teardown();
    });
  });

  it('streaming area rows defaults to 12', () => {
    withEnv({ BABEL_SCROLL_REGIONS: '1' }, () => {
      const trs = new TwoRegionStreaming();
      trs.setup(50);
      assert.equal(trs.streamingAreaRows, 12);
      trs.teardown();
    });
  });

  it('streaming area rows is capped at 1/3 of terminal height', () => {
    withEnv({ BABEL_SCROLL_REGIONS: '1' }, () => {
      const trs = new TwoRegionStreaming();
      // Request 30 streaming rows on a 60-row terminal — should be capped to 20
      trs.setup(60, 30);
      assert.ok(trs.streamingAreaRows <= 20, 'streaming rows should be capped at 1/3');
      trs.teardown();
    });
  });

  it('streaming area rows minimum is 4', () => {
    withEnv({ BABEL_SCROLL_REGIONS: '1' }, () => {
      const trs = new TwoRegionStreaming();
      // Request 1 streaming row — should be raised to 4
      trs.setup(50, 1);
      assert.ok(trs.streamingAreaRows >= 4, 'streaming rows minimum is 4');
      trs.teardown();
    });
  });

  it('setup sets scroll region for the scrollback area', () => {
    withEnv({ BABEL_SCROLL_REGIONS: '1' }, () => {
      const trs = new TwoRegionStreaming();
      const mock = mockStdoutWrite();
      try {
        trs.setup(50, 12);
        // Should emit DECSTBM scroll region for rows 1-38 (50-12=38)
        const output = mock.writes.join('');
        assert.ok(output.includes('\x1b[1;38r'), 'should set scroll region to scrollback area');
      } finally {
        mock.restore();
        trs.teardown();
      }
    });
  });

  it('writeStreaming content is rendered in streaming area', () => {
    withEnv({ BABEL_SCROLL_REGIONS: '1' }, () => {
      const trs = new TwoRegionStreaming();
      const mock = mockStdoutWrite();
      try {
        trs.setup(50, 12);
        // Clear previous writes from setup
        mock.writes.length = 0;
        trs.writeStreaming('streaming content');
        const output = mock.writes.join('');
        // Content should be written with cursor positioning into the streaming area
        assert.ok(output.includes('streaming content'), 'should write content');
      } finally {
        mock.restore();
        trs.teardown();
      }
    });
  });

  it('writeStreaming merges mid-line chunks onto one row (no vertical fragmentation)', () => {
    withEnv({ BABEL_SCROLL_REGIONS: '1' }, () => {
      const trs = new TwoRegionStreaming();
      const mock = mockStdoutWrite();
      try {
        trs.setup(50, 12);
        mock.writes.length = 0;
        trs.writeStreaming("Great question. Here's my");
        trs.writeStreaming(' startup process');
        trs.writeStreaming(' in this workspace');
        const output = mock.writes.join('');
        // Final paint must show the full sentence on a single logical line
        assert.ok(
          output.includes("Great question. Here's my startup process in this workspace"),
          'mid-line chunks must merge onto one streaming row',
        );
      } finally {
        mock.restore();
        trs.teardown();
      }
    });
  });

  it('writeStreaming treats embedded newlines as new rows', () => {
    withEnv({ BABEL_SCROLL_REGIONS: '1' }, () => {
      const trs = new TwoRegionStreaming();
      const mock = mockStdoutWrite();
      try {
        trs.setup(50, 12);
        mock.writes.length = 0;
        trs.writeStreaming('line one\nline two');
        const output = mock.writes.join('');
        assert.ok(output.includes('line one'));
        assert.ok(output.includes('line two'));
      } finally {
        mock.restore();
        trs.teardown();
      }
    });
  });

  it('commitStreaming clears streaming area before graduating content', () => {
    withEnv({ BABEL_SCROLL_REGIONS: '1' }, () => {
      const trs = new TwoRegionStreaming();
      const mock = mockStdoutWrite();
      try {
        trs.setup(50, 12);
        trs.writeStreaming('graduated answer line');
        mock.writes.length = 0;
        trs.commitStreaming();
        const output = mock.writes.join('');
        // Clear-to-EOL (writeLine empty) happens before the graduated write
        assert.ok(output.includes('\x1b[K'), 'should clear streaming rows before graduate');
        assert.ok(output.includes('graduated answer line'), 'should graduate content once');
        // Content should appear only once in the commit phase
        const copies = output.split('graduated answer line').length - 1;
        assert.equal(copies, 1, 'commit must not write graduated content twice');
      } finally {
        mock.restore();
      }
    });
  });

  it('replaceStreamingContent does not re-graduate the same prefix on each rewrite', () => {
    withEnv({ BABEL_SCROLL_REGIONS: '1' }, () => {
      const trs = new TwoRegionStreaming();
      const mock = mockStdoutWrite();
      try {
        // Small streaming window forces overflow into scrollback
        trs.setup(30, 4);
        const line = (n: number) => `line-${n}-xxxxxxxxxxxxxxxxxxxx`;

        // Growing full snapshots (simulates markdown rewrite of whole answer)
        const snap1 = [line(1), line(2), line(3), line(4), line(5)].join('\n');
        const snap2 = [line(1), line(2), line(3), line(4), line(5), line(6)].join('\n');
        const snap3 = [line(1), line(2), line(3), line(4), line(5), line(6), line(7)].join('\n');

        trs.replaceStreamingContent(snap1);
        const afterFirst = trs.graduatedLineCount;
        trs.replaceStreamingContent(snap2);
        const afterSecond = trs.graduatedLineCount;
        trs.replaceStreamingContent(snap3);
        const afterThird = trs.graduatedLineCount;

        // Watermark only advances for newly overflowed lines (never resets)
        assert.ok(afterFirst >= 1, 'first snap should overflow');
        assert.ok(afterSecond >= afterFirst, 'graduation is monotonic');
        assert.ok(afterThird >= afterSecond, 'graduation is monotonic');
        // 7 lines, 4-row window → target graduated = 3
        assert.equal(afterThird, 3, 'final graduated count should be len-window');
        // Growing by one line each time should advance watermark by at most 1
        assert.ok(afterSecond - afterFirst <= 1);
        assert.ok(afterThird - afterSecond <= 1);
      } finally {
        mock.restore();
        trs.teardown();
      }
    });
  });

  it('repeated full replaces of an unchanged long message do not advance graduation', () => {
    withEnv({ BABEL_SCROLL_REGIONS: '1' }, () => {
      const trs = new TwoRegionStreaming();
      const mock = mockStdoutWrite();
      try {
        trs.setup(30, 4);
        const lines = Array.from({ length: 10 }, (_, i) => `stable-line-${i}`);
        const snap = lines.join('\n');

        trs.replaceStreamingContent(snap);
        const graduated = trs.graduatedLineCount;
        assert.equal(graduated, 6, '10 lines with 4-row window → 6 graduated');

        // 8 more identical full replaces (table reformat / structural feeds)
        for (let i = 0; i < 8; i++) {
          trs.replaceStreamingContent(snap);
        }
        assert.equal(
          trs.graduatedLineCount,
          graduated,
          'unchanged full replace must not re-graduate',
        );
      } finally {
        mock.restore();
        trs.teardown();
      }
    });
  });

  it('commitStreaming resets scroll region', () => {
    withEnv({ BABEL_SCROLL_REGIONS: '1' }, () => {
      const trs = new TwoRegionStreaming();
      const mock = mockStdoutWrite();
      try {
        trs.setup(50, 12);
        // Clear previous writes
        mock.writes.length = 0;
        trs.commitStreaming();
        const output = mock.writes.join('');
        assert.ok(output.includes('\x1b[r'), 'should reset scroll region on commit');
      } finally {
        mock.restore();
        trs.teardown();
      }
    });
  });

  it('teardown resets scroll region', () => {
    withEnv({ BABEL_SCROLL_REGIONS: '1' }, () => {
      const trs = new TwoRegionStreaming();
      const mock = mockStdoutWrite();
      try {
        trs.setup(50, 12);
        // Clear previous writes
        mock.writes.length = 0;
        trs.teardown();
        const output = mock.writes.join('');
        assert.ok(output.includes('\x1b[r'), 'should reset scroll region on teardown');
      } finally {
        mock.restore();
      }
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Resize
// ═══════════════════════════════════════════════════════════════════════════════

describe('Resize handling', () => {
  it('onResize updates scroll region for new terminal height', () => {
    withEnv({ BABEL_SCROLL_REGIONS: '1' }, () => {
      const trs = new TwoRegionStreaming();
      const mock = mockStdoutWrite();
      try {
        trs.setup(50, 12);
        // Clear setup writes
        mock.writes.length = 0;
        // Resize to a taller terminal
        trs.onResize(60, 120);
        const output = mock.writes.join('');
        // New scroll region: rows 1-48 (60-12=48)
        assert.ok(output.includes('\x1b[1;48r'), 'should update scroll region for new height');
      } finally {
        mock.restore();
        trs.teardown();
      }
    });
  });

  it('onResize falls back when new height is too small', () => {
    withEnv({ BABEL_SCROLL_REGIONS: '1' }, () => {
      const trs = new TwoRegionStreaming();
      const mock = mockStdoutWrite();
      try {
        trs.setup(50, 12);
        mock.writes.length = 0;
        // Shrink below MIN_TERMINAL_HEIGHT
        trs.onResize(10, 80);
        const output = mock.writes.join('');
        assert.ok(output.includes('\x1b[r'), 'should reset scroll region on shrink');
        assert.equal(trs.isHardwareMode, false, 'should fall back');
      } finally {
        mock.restore();
        trs.teardown();
      }
    });
  });

  it('replaceStreamingContent re-renders streaming area at new width', () => {
    withEnv({ BABEL_SCROLL_REGIONS: '1' }, () => {
      const trs = new TwoRegionStreaming();
      const mock = mockStdoutWrite();
      try {
        trs.setup(50, 12, 80);
        trs.writeStreaming('line one\nline two');
        mock.writes.length = 0;
        trs.replaceStreamingContent('narrow-one\nnarrow-two\nnarrow-three');
        const output = mock.writes.join('');
        assert.ok(output.includes('narrow-three'), 'should paint reflowed content');
      } finally {
        mock.restore();
        trs.teardown();
      }
    });
  });

  it('onResize re-renders when width changes at same height', () => {
    withEnv({ BABEL_SCROLL_REGIONS: '1' }, () => {
      const trs = new TwoRegionStreaming();
      const mock = mockStdoutWrite();
      try {
        trs.setup(50, 12, 80);
        trs.writeStreaming('held content');
        mock.writes.length = 0;
        trs.onResize(50, 120);
        const output = mock.writes.join('');
        assert.ok(output.length > 0, 'width change should trigger streaming repaint');
      } finally {
        mock.restore();
        trs.teardown();
      }
    });
  });

  it('onResize is a no-op when inactive', () => {
    withEnv({ BABEL_SCROLL_REGIONS: '1' }, () => {
      const trs = new TwoRegionStreaming();
      const mock = mockStdoutWrite();
      try {
        trs.onResize(60, 120);
        assert.equal(mock.writes.length, 0);
      } finally {
        mock.restore();
      }
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Content overflow
// ═══════════════════════════════════════════════════════════════════════════════

describe('Content overflow', () => {
  it('excess content graduates to scrollback area', () => {
    withEnv({ BABEL_SCROLL_REGIONS: '1' }, () => {
      const trs = new TwoRegionStreaming();
      const mock = mockStdoutWrite();
      try {
        trs.setup(50, 4); // Small streaming area to force overflow
        mock.writes.length = 0;
        // Write more lines than the streaming area can hold
        for (let i = 0; i < 10; i++) {
          trs.writeStreaming(`line ${i}`);
        }
        // Should not throw and should have content
        assert.equal(trs.isActive, true);
      } finally {
        mock.restore();
        trs.teardown();
      }
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Force-override env vars
// ═══════════════════════════════════════════════════════════════════════════════

describe('BABEL_SCROLL_REGIONS override', () => {
  it('BABEL_SCROLL_REGIONS=1 forces hardware mode even on unsupported terminals', () => {
    withEnv(
      {
        BABEL_SCROLL_REGIONS: '1',
        TERM_PROGRAM: 'Apple_Terminal',
        TERM: 'xterm-256color',
      },
      () => {
        const trs = new TwoRegionStreaming();
        trs.setup(50, 12);
        assert.equal(trs.isHardwareMode, true);
        trs.teardown();
      },
    );
  });

  it('BABEL_SCROLL_REGIONS=0 forces fallback even on supported terminals', () => {
    withEnv(
      {
        BABEL_SCROLL_REGIONS: '0',
        TERM_PROGRAM: 'WezTerm',
        TERM: 'xterm-256color',
      },
      () => {
        const trs = new TwoRegionStreaming();
        trs.setup(50, 12);
        assert.equal(trs.isHardwareMode, false);
        trs.teardown();
      },
    );
  });
});

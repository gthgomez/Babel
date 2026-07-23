/**
 * theme.test.ts — Tests for color support detection (supportsTrueColor).
 *
 * Tests FORCE_COLOR, NO_COLOR, TTY gating, terminal identity detection
 * (delegated to terminalProbe.ts), COLORTERM, and TERM=xterm-direct fallbacks.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { supportsTrueColor } from './theme.js';
import { withEnv } from './testUtils.js';

/** A mock WriteStream that reports isTTY=true. */
function ttyStream(): NodeJS.WriteStream {
  return { isTTY: true } as NodeJS.WriteStream;
}

/** A mock WriteStream that reports isTTY=false. */
function nonTtyStream(): NodeJS.WriteStream {
  return { isTTY: false } as NodeJS.WriteStream;
}

// ═══════════════════════════════════════════════════════════════════════════════
// FORCE_COLOR overrides
// ═══════════════════════════════════════════════════════════════════════════════

test('supportsTrueColor returns true for FORCE_COLOR=2', () => {
  withEnv(
    { FORCE_COLOR: '2', NO_COLOR: undefined, TERM_PROGRAM: undefined, TERM: 'xterm' },
    () => {
      assert.equal(supportsTrueColor(ttyStream()), true);
    },
  );
});

test('supportsTrueColor returns true for FORCE_COLOR=3', () => {
  withEnv(
    { FORCE_COLOR: '3', NO_COLOR: undefined, TERM_PROGRAM: undefined, TERM: 'xterm' },
    () => {
      assert.equal(supportsTrueColor(ttyStream()), true);
    },
  );
});

test('supportsTrueColor returns false for FORCE_COLOR=1', () => {
  // FORCE_COLOR=1 bypasses TTY check but only grants 16 colors (level < 2)
  withEnv({ FORCE_COLOR: '1', NO_COLOR: undefined, TERM_PROGRAM: undefined, TERM: 'xterm' }, () => {
    assert.equal(supportsTrueColor(ttyStream()), false);
  });
});

test('supportsTrueColor returns false for FORCE_COLOR=0', () => {
  withEnv({ FORCE_COLOR: '0', NO_COLOR: undefined, TERM_PROGRAM: undefined }, () => {
    assert.equal(supportsTrueColor(ttyStream()), false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// NO_COLOR override
// ═══════════════════════════════════════════════════════════════════════════════

test('supportsTrueColor returns false when NO_COLOR is set', () => {
  withEnv({ NO_COLOR: '1', FORCE_COLOR: undefined, TERM_PROGRAM: undefined }, () => {
    assert.equal(supportsTrueColor(ttyStream()), false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TTY gating
// ═══════════════════════════════════════════════════════════════════════════════

test('supportsTrueColor returns false on non-TTY stream without FORCE_COLOR', () => {
  withEnv({ FORCE_COLOR: undefined, NO_COLOR: undefined, TERM_PROGRAM: 'kitty' }, () => {
    assert.equal(supportsTrueColor(nonTtyStream()), false);
  });
});

test('supportsTrueColor returns true on TTY stream with known terminal', () => {
  withEnv({ FORCE_COLOR: undefined, NO_COLOR: undefined, TERM_PROGRAM: 'kitty' }, () => {
    assert.equal(supportsTrueColor(ttyStream()), true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Terminal identity detection (delegated to terminalProbe.ts)
// ═══════════════════════════════════════════════════════════════════════════════

test('supportsTrueColor returns true for known true-color terminals (wezterm)', () => {
  withEnv(
    {
      FORCE_COLOR: undefined,
      NO_COLOR: undefined,
      TERM_PROGRAM: 'WezTerm',
      TERM: 'xterm-256color',
      COLORTERM: undefined,
    },
    () => {
      assert.equal(supportsTrueColor(ttyStream()), true);
    },
  );
});

test('supportsTrueColor returns true for known true-color terminals (ghostty)', () => {
  withEnv(
    {
      FORCE_COLOR: undefined,
      NO_COLOR: undefined,
      TERM_PROGRAM: 'ghostty',
      TERM: 'xterm-256color',
      COLORTERM: undefined,
    },
    () => {
      assert.equal(supportsTrueColor(ttyStream()), true);
    },
  );
});

test('supportsTrueColor returns true for known true-color terminals (winterm)', () => {
  withEnv(
    {
      FORCE_COLOR: undefined,
      NO_COLOR: undefined,
      TERM_PROGRAM: 'winterm',
      TERM: 'xterm-256color',
      COLORTERM: undefined,
    },
    () => {
      assert.equal(supportsTrueColor(ttyStream()), true);
    },
  );
});

test('supportsTrueColor returns false for unknown terminals without COLORTERM', () => {
  // Clear all Windows Terminal detection signals so isWindowsTerminal()
  // doesn't short-circuit. On non-Windows platforms these are already unset.
  withEnv(
    {
      FORCE_COLOR: undefined,
      NO_COLOR: undefined,
      TERM_PROGRAM: 'alacritty',
      TERM: 'screen-256color',
      COLORTERM: undefined,
      WT_SESSION: undefined,
      ConEmuANSI: undefined,
      ANSICON: undefined,
    },
    () => {
      assert.equal(supportsTrueColor(ttyStream()), false);
    },
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// COLORTERM fallback
// ═══════════════════════════════════════════════════════════════════════════════

test('supportsTrueColor returns true for COLORTERM=truecolor on TTY', () => {
  withEnv(
    {
      FORCE_COLOR: undefined,
      NO_COLOR: undefined,
      TERM_PROGRAM: undefined,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    },
    () => {
      assert.equal(supportsTrueColor(ttyStream()), true);
    },
  );
});

test('supportsTrueColor returns true for COLORTERM=24bit on TTY', () => {
  withEnv(
    {
      FORCE_COLOR: undefined,
      NO_COLOR: undefined,
      TERM_PROGRAM: undefined,
      TERM: 'xterm-256color',
      COLORTERM: '24bit',
    },
    () => {
      assert.equal(supportsTrueColor(ttyStream()), true);
    },
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// TERM=xterm-direct fallback
// ═══════════════════════════════════════════════════════════════════════════════

test('supportsTrueColor returns true for TERM=xterm-direct on TTY', () => {
  withEnv(
    {
      FORCE_COLOR: undefined,
      NO_COLOR: undefined,
      TERM_PROGRAM: undefined,
      TERM: 'xterm-direct',
      COLORTERM: undefined,
    },
    () => {
      assert.equal(supportsTrueColor(ttyStream()), true);
    },
  );
});

test('supportsTrueColor returns false for TERM=screen-256color without true-color signals', () => {
  // Use a TERM that doesn't contain "xterm" to avoid isWindowsTerminal()
  // short-circuiting on Windows platforms; screen-256color is a common
  // 256-color TERM with no true-color support. Also clear WT_SESSION,
  // ConEmuANSI, and ANSICON which would otherwise trigger isWindowsTerminal().
  withEnv(
    {
      FORCE_COLOR: undefined,
      NO_COLOR: undefined,
      TERM_PROGRAM: undefined,
      TERM: 'screen-256color',
      COLORTERM: undefined,
      WT_SESSION: undefined,
      ConEmuANSI: undefined,
      ANSICON: undefined,
    },
    () => {
      assert.equal(supportsTrueColor(ttyStream()), false);
    },
  );
});

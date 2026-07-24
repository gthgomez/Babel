/**
 * terminalProbe.test.ts — Tests for tmux detection and capability overrides.
 *
 * These tests manipulate environment variables to simulate different
 * terminal environments. Each test saves and restores relevant env vars
 * and calls resetTerminalProbe() to clear the cached capability matrix.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  probeTerminalCapabilities,
  resetTerminalProbe,
  formatCapabilityReport,
  detectTerminalIdentity,
  terminalCapsCompat,
} from './terminalProbe.js';
import { withEnv } from './testUtils.js';

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Tmux detection
// ═══════════════════════════════════════════════════════════════════════════════

test('detects tmux when TMUX env var is set', () => {
  withEnv(
    {
      TMUX: '/tmp/tmux-1000/default,1234,0',
      TERM: 'tmux-256color',
      TERM_PROGRAM: '',
    },
    () => {
      const caps = probeTerminalCapabilities();
      assert.equal(caps.isTmux, true);
    },
  );
});

test('detects tmux via TERM=screen', () => {
  withEnv(
    {
      TMUX: '/tmp/tmux-1000/default,1234,0',
      TERM: 'screen-256color',
      TERM_PROGRAM: '',
      BABEL_TMUX_VERSION: '3.2',
    },
    () => {
      const caps = probeTerminalCapabilities();
      assert.equal(caps.isTmux, true);
    },
  );
});

test('isTmux false when no TMUX env var', () => {
  withEnv(
    {
      TMUX: undefined,
      TERM: 'xterm-256color',
      TERM_PROGRAM: 'iterm2',
    },
    () => {
      const caps = probeTerminalCapabilities();
      assert.equal(caps.isTmux, false);
    },
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Tmux sync update overrides
// ═══════════════════════════════════════════════════════════════════════════════

test('tmux version < 3.3 disables syncUpdate', () => {
  withEnv(
    {
      TMUX: '/tmp/tmux-1000/default,1234,0',
      TERM: 'tmux-256color',
      TERM_PROGRAM: 'wezterm', // WezTerm normally supports syncUpdate
      BABEL_TMUX_VERSION: '3.2',
      BABEL_TMUX_PASSTHROUGH: undefined,
    },
    () => {
      const caps = probeTerminalCapabilities();
      assert.equal(caps.isTmux, true);
      assert.equal(caps.tmuxPassthrough, false);
      assert.equal(caps.syncUpdate, false, 'syncUpdate should be disabled when tmux < 3.3');
    },
  );
});

test('tmux version >= 3.3 with passthrough keeps syncUpdate', () => {
  withEnv(
    {
      TMUX: '/tmp/tmux-1000/default,1234,0',
      TERM: 'tmux-256color',
      TERM_PROGRAM: 'wezterm',
      BABEL_TMUX_VERSION: '3.3a',
      BABEL_TMUX_PASSTHROUGH: '1',
    },
    () => {
      const caps = probeTerminalCapabilities();
      assert.equal(caps.isTmux, true);
      assert.equal(caps.tmuxPassthrough, true);
      // syncUpdate should be true because WezTerm supports it AND passthrough is enabled
      assert.equal(caps.syncUpdate, true);
    },
  );
});

test('tmux passthrough explicitly disabled via env', () => {
  withEnv(
    {
      TMUX: '/tmp/tmux-1000/default,1234,0',
      TERM: 'tmux-256color',
      TERM_PROGRAM: 'wezterm',
      BABEL_TMUX_VERSION: '3.4',
      BABEL_TMUX_PASSTHROUGH: '0',
    },
    () => {
      const caps = probeTerminalCapabilities();
      assert.equal(caps.tmuxPassthrough, false);
      assert.equal(caps.syncUpdate, false);
    },
  );
});

test('unknown tmux version (no BABEL_TMUX_VERSION, no tmux binary) defaults safe', () => {
  withEnv(
    {
      TMUX: '/tmp/tmux-1000/default,1234,0',
      TERM: 'tmux-256color',
      TERM_PROGRAM: 'wezterm',
      BABEL_TMUX_VERSION: '', // empty string → null
    },
    () => {
      const caps = probeTerminalCapabilities();
      assert.equal(caps.tmuxVersion, null);
      assert.equal(caps.tmuxPassthrough, false);
      assert.equal(caps.syncUpdate, false);
    },
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Tmux env overrides
// ═══════════════════════════════════════════════════════════════════════════════

test('BABEL_TMUX_MOUSE and BABEL_TMUX_CLIPBOARD overrides', () => {
  withEnv(
    {
      TMUX: '/tmp/tmux-1000/default,1234,0',
      TERM: 'tmux-256color',
      BABEL_TMUX_VERSION: '3.3a',
      BABEL_TMUX_MOUSE: '1',
      BABEL_TMUX_CLIPBOARD: 'true',
    },
    () => {
      const caps = probeTerminalCapabilities();
      assert.equal(caps.tmuxMouse, true);
      assert.equal(caps.tmuxClipboard, true);
    },
  );
});

test('BABEL_TMUX_MOUSE off by default', () => {
  withEnv(
    {
      TMUX: '/tmp/tmux-1000/default,1234,0',
      TERM: 'tmux-256color',
      BABEL_TMUX_VERSION: '3.4',
      BABEL_TMUX_MOUSE: undefined,
      BABEL_TMUX_CLIPBOARD: undefined,
    },
    () => {
      const caps = probeTerminalCapabilities();
      assert.equal(caps.tmuxMouse, false);
      assert.equal(caps.tmuxClipboard, false);
    },
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. SSH detection
// ═══════════════════════════════════════════════════════════════════════════════

test('detects SSH when SSH_CLIENT is set', () => {
  withEnv(
    {
      SSH_CLIENT: '10.0.0.1 5000 22',
      SSH_TTY: undefined,
      SSH_CONNECTION: undefined,
    },
    () => {
      const caps = probeTerminalCapabilities();
      assert.equal(caps.isSsh, true);
    },
  );
});

test('detects SSH when SSH_TTY is set', () => {
  withEnv(
    {
      SSH_CLIENT: undefined,
      SSH_TTY: '/dev/pts/2',
      SSH_CONNECTION: undefined,
    },
    () => {
      const caps = probeTerminalCapabilities();
      assert.equal(caps.isSsh, true);
    },
  );
});

test('isSsh false when no SSH env vars', () => {
  withEnv(
    {
      SSH_CLIENT: undefined,
      SSH_TTY: undefined,
      SSH_CONNECTION: undefined,
    },
    () => {
      const caps = probeTerminalCapabilities();
      assert.equal(caps.isSsh, false);
    },
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. formatCapabilityReport
// ═══════════════════════════════════════════════════════════════════════════════

test('formatCapabilityReport includes tmux section when isTmux', () => {
  withEnv(
    {
      TMUX: '/tmp/tmux-1000/default,1234,0',
      TERM: 'tmux-256color',
      BABEL_TMUX_VERSION: '3.4',
      BABEL_TMUX_PASSTHROUGH: '1',
      BABEL_TMUX_MOUSE: '1',
      BABEL_TMUX_CLIPBOARD: '1',
    },
    () => {
      const report = formatCapabilityReport();
      assert.ok(report.includes('tmux'), 'report should contain tmux info');
      assert.ok(report.includes('3.4'), 'report should contain version');
      assert.ok(report.includes('passthrough'), 'report should include passthrough status');
    },
  );
});

test('formatCapabilityReport includes SSH when isSsh', () => {
  withEnv(
    {
      SSH_CLIENT: '10.0.0.1 5000 22',
      TMUX: undefined,
    },
    () => {
      const report = formatCapabilityReport();
      assert.ok(report.includes('SSH'), 'report should contain SSH info');
    },
  );
});

test('formatCapabilityReport works in default environment', () => {
  // Should not throw — just verify it produces output
  const report = formatCapabilityReport();
  assert.ok(report.length > 0);
  assert.ok(report.includes('Terminal:'));
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. detectTerminalIdentity
// ═══════════════════════════════════════════════════════════════════════════════

test('detectTerminalIdentity returns wezterm for TERM_PROGRAM=WezTerm', () => {
  withEnv({ TERM_PROGRAM: 'WezTerm', TERM: '', TERM_PROGRAM_VERSION: '' }, () => {
    assert.equal(detectTerminalIdentity(), 'wezterm');
  });
});

test('detectTerminalIdentity returns kitty for TERM_PROGRAM=kitty', () => {
  withEnv({ TERM_PROGRAM: 'kitty' }, () => {
    assert.equal(detectTerminalIdentity(), 'kitty');
  });
});

test('detectTerminalIdentity returns winterm for TERM_PROGRAM=winterm', () => {
  withEnv({ TERM_PROGRAM: 'winterm' }, () => {
    assert.equal(detectTerminalIdentity(), 'winterm');
  });
});

test('detectTerminalIdentity returns vscode for TERM_PROGRAM=vscode', () => {
  withEnv({ TERM_PROGRAM: 'vscode' }, () => {
    assert.equal(detectTerminalIdentity(), 'vscode');
  });
});

test('detectTerminalIdentity returns ghostty for TERM_PROGRAM=ghostty', () => {
  withEnv({ TERM_PROGRAM: 'ghostty' }, () => {
    assert.equal(detectTerminalIdentity(), 'ghostty');
  });
});

test('detectTerminalIdentity returns iterm2 for TERM_PROGRAM=iTerm2', () => {
  withEnv({ TERM_PROGRAM: 'iTerm2', TERM: 'xterm-256color' }, () => {
    assert.equal(detectTerminalIdentity(), 'iterm2');
  });
});

test('detectTerminalIdentity returns unknown for unrecognized TERM_PROGRAM', () => {
  withEnv({ TERM_PROGRAM: 'alacritty', TERM: 'xterm-256color' }, () => {
    assert.equal(detectTerminalIdentity(), 'unknown');
  });
});

test('detectTerminalIdentity returns unknown when TERM_PROGRAM is unset', () => {
  withEnv({ TERM_PROGRAM: undefined, TERM: 'xterm-256color' }, () => {
    assert.equal(detectTerminalIdentity(), 'unknown');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. Graphics detection (migrated from terminalCapabilities.test.ts)
// ═══════════════════════════════════════════════════════════════════════════════

test('TerminalCapabilities has all expected graphics fields', () => {
  resetTerminalProbe();
  const caps = probeTerminalCapabilities();
  assert.equal(typeof caps.dec2026Sync, 'boolean');
  assert.equal(typeof caps.kittyGraphics, 'boolean');
  assert.equal(typeof caps.sixel, 'boolean');
  assert.equal(typeof caps.iterm2Graphics, 'boolean');
  assert.equal(typeof caps.anyGraphics, 'boolean');
  assert.equal(typeof caps.trueColor, 'boolean');
});

test('anyGraphics is true if any image protocol is supported', () => {
  resetTerminalProbe();
  const caps = probeTerminalCapabilities();
  if (caps.kittyGraphics || caps.sixel || caps.iterm2Graphics) {
    assert.equal(caps.anyGraphics, true);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. terminalCapsCompat backward compatibility
// ═══════════════════════════════════════════════════════════════════════════════

test('terminalCapsCompat returns same object reference as probeTerminalCapabilities', () => {
  resetTerminalProbe();
  const caps1 = probeTerminalCapabilities();
  // terminalCapsCompat is a simple wrapper; after probe, it returns the
  // same cached object.
  const caps2 = terminalCapsCompat();
  assert.strictEqual(caps1, caps2, 'should return same cached object');
});

test('terminalCapsCompat works without prior probe', () => {
  resetTerminalProbe();
  const caps = terminalCapsCompat();
  assert.equal(typeof caps.dec2026Sync, 'boolean');
  assert.equal(typeof caps.trueColor, 'boolean');
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. Windows Terminal DEC 2026 override
// ═══════════════════════════════════════════════════════════════════════════════

test('Windows Terminal defaults dec2026Sync to false', { skip: process.platform !== 'win32' }, () => {
  resetTerminalProbe();
  withEnv(
    {
      TERM_PROGRAM: 'winterm',
      TERM: 'xterm-256color',
      WT_SESSION: 'abc123',
      TMUX: undefined,
      BABEL_WINTERM_SYNC: undefined,
    },
    () => {
      const caps = probeTerminalCapabilities();
      assert.equal(caps.isWindowsTerminal, true);
      // syncUpdate says true for known winterm entry, but dec2026Sync
      // should be false due to the winterm guard
      assert.equal(caps.syncUpdate, true);
      assert.equal(caps.dec2026Sync, false,
        'dec2026Sync should default to false on Windows Terminal');
    },
  );
});

test('BABEL_WINTERM_SYNC=1 enables dec2026Sync on Windows Terminal', { skip: process.platform !== 'win32' }, () => {
  resetTerminalProbe();
  withEnv(
    {
      TERM_PROGRAM: 'winterm',
      TERM: 'xterm-256color',
      WT_SESSION: 'abc123',
      TMUX: undefined,
      BABEL_WINTERM_SYNC: '1',
    },
    () => {
      const caps = probeTerminalCapabilities();
      assert.equal(caps.isWindowsTerminal, true);
      assert.equal(caps.dec2026Sync, true,
        'dec2026Sync should be true when BABEL_WINTERM_SYNC=1');
    },
  );
});

test('BABEL_WINTERM_SYNC=0 overrides stays false on Windows Terminal', { skip: process.platform !== 'win32' }, () => {
  resetTerminalProbe();
  withEnv(
    {
      TERM_PROGRAM: 'winterm',
      TERM: 'xterm-256color',
      WT_SESSION: 'abc123',
      TMUX: undefined,
      BABEL_WINTERM_SYNC: '0',
    },
    () => {
      const caps = probeTerminalCapabilities();
      assert.equal(caps.dec2026Sync, false);
    },
  );
});

test('non-Windows-Terminal gets dec2026Sync from terminal capabilities', () => {
  resetTerminalProbe();
  withEnv(
    {
      TERM_PROGRAM: 'kitty',
      TERM: 'kitty',
      WT_SESSION: undefined,
      TMUX: undefined,
      KITTY_WINDOW_ID: '1',
      ConEmuANSI: undefined,
      ANSICON: undefined,
    },
    () => {
      const caps = probeTerminalCapabilities();
      assert.equal(caps.isWindowsTerminal, false);
      // Kitty supports sync update — dec2026Sync should match syncUpdate
      assert.equal(caps.syncUpdate, true);
      assert.equal(caps.dec2026Sync, true);
    },
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// 10. formatCapabilityReport includes DEC 2026 info
// ═══════════════════════════════════════════════════════════════════════════════

test('formatCapabilityReport includes DEC 2026 gated line', () => {
  resetTerminalProbe();
  const report = formatCapabilityReport();
  assert.ok(report.includes('DEC 2026 gated:'),
    'report should include DEC 2026 gated line');
});

test('formatCapabilityReport shows winterm hint when disabled', { skip: process.platform !== 'win32' }, () => {
  resetTerminalProbe();
  withEnv(
    {
      TERM_PROGRAM: 'winterm',
      TERM: 'xterm-256color',
      WT_SESSION: 'abc123',
      TMUX: undefined,
      BABEL_WINTERM_SYNC: undefined,
    },
    () => {
      const report = formatCapabilityReport();
      assert.ok(report.includes('BABEL_WINTERM_SYNC'),
        'report should mention BABEL_WINTERM_SYNC override on Windows Terminal');
    },
  );
});

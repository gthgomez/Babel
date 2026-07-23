/**
 * Tests for clipboard-native — native platform clipboard fallback.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { execSync as realExecSync } from 'node:child_process';
import {
  _setExecSync,
  _setPlatform,
  _setEnv,
  _platform,
  _env as _nativeEnv,
  isNativeClipboardSupported,
  copyToClipboardNativeSync,
  copyToClipboardNative,
  readFromClipboardNative,
} from './clipboard-native.js';

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Setup: mock execSync, set platform and env to defaults. */
function setup(opts: {
  platform?: NodeJS.Platform;
  execImpl?: (...args: any[]) => any;
  env?: Record<string, string | undefined>;
}) {
  const mockExec = opts.execImpl ? mock.fn(opts.execImpl) : mock.fn(() => Buffer.from(''));
  _setExecSync(mockExec);
  _setPlatform(opts.platform ?? 'win32');
  _setEnv(opts.env ?? { ...process.env });
  return mockExec;
}

/** Teardown: restore real execSync, platform, env. */
function teardown() {
  _setExecSync(realExecSync);
  _setPlatform(process.platform);
  _setEnv(process.env);
}

// ─── isNativeClipboardSupported ──────────────────────────────────

test('isNativeClipboardSupported: Windows with PowerShell returns true', () => {
  const mockExec = setup({ platform: 'win32', execImpl: () => Buffer.from('') });
  assert.equal(isNativeClipboardSupported(), true);
  assert.ok(mockExec.mock.calls.length > 0);
  assert.ok((mockExec.mock.calls[0]!.arguments[0] as string).includes('powershell'));
  teardown();
});

test('isNativeClipboardSupported: Windows without PowerShell returns false', () => {
  setup({
    platform: 'win32',
    execImpl: () => {
      throw new Error('not found');
    },
  });
  assert.equal(isNativeClipboardSupported(), false);
  teardown();
});

test('isNativeClipboardSupported: macOS with pbcopy returns true', () => {
  const mockExec = setup({ platform: 'darwin', execImpl: () => Buffer.from('') });
  assert.equal(isNativeClipboardSupported(), true);
  assert.ok((mockExec.mock.calls[0]!.arguments[0] as string).includes('pbcopy'));
  teardown();
});

test('isNativeClipboardSupported: macOS without pbcopy returns false', () => {
  setup({
    platform: 'darwin',
    execImpl: () => {
      throw new Error('not found');
    },
  });
  assert.equal(isNativeClipboardSupported(), false);
  teardown();
});

test('isNativeClipboardSupported: Wayland Linux with wl-copy returns true', () => {
  const mockExec = setup({
    platform: 'linux',
    env: { WAYLAND_DISPLAY: 'wayland-0' },
    execImpl: () => Buffer.from(''),
  });
  assert.equal(isNativeClipboardSupported(), true);
  assert.ok((mockExec.mock.calls[0]!.arguments[0] as string).includes('wl-copy'));
  teardown();
});

test('isNativeClipboardSupported: Wayland Linux without wl-copy returns false', () => {
  setup({
    platform: 'linux',
    env: { WAYLAND_DISPLAY: 'wayland-0' },
    execImpl: () => {
      throw new Error('not found');
    },
  });
  assert.equal(isNativeClipboardSupported(), false);
  teardown();
});

test('isNativeClipboardSupported: X11 Linux with xclip returns true', () => {
  const mockExec = setup({
    platform: 'linux',
    execImpl: (cmd: string) => {
      if (cmd.includes('xclip')) return Buffer.from('');
      throw new Error('not found');
    },
  });
  assert.equal(isNativeClipboardSupported(), true);
  assert.ok(mockExec.mock.calls.some((c) => (c.arguments[0] as string).includes('xclip')));
  teardown();
});

test('isNativeClipboardSupported: X11 Linux with xsel returns true', () => {
  const mockExec = setup({
    platform: 'linux',
    execImpl: (cmd: string) => {
      if (cmd.includes('xsel')) return Buffer.from('');
      throw new Error('not found');
    },
  });
  assert.equal(isNativeClipboardSupported(), true);
  assert.ok(mockExec.mock.calls.some((c) => (c.arguments[0] as string).includes('xsel')));
  teardown();
});

test('isNativeClipboardSupported: Linux with no tools returns false', () => {
  setup({
    platform: 'linux',
    execImpl: () => {
      throw new Error('not found');
    },
  });
  assert.equal(isNativeClipboardSupported(), false);
  teardown();
});

test('isNativeClipboardSupported: unsupported platform returns false', () => {
  setup({ platform: 'android', execImpl: () => Buffer.from('') });
  assert.equal(isNativeClipboardSupported(), false);
  teardown();
});

// ─── copyToClipboardNativeSync ──────────────────────────────────

test('copyToClipboardNativeSync: Windows success path', () => {
  const mockExec = setup({ platform: 'win32', execImpl: () => Buffer.from('') });
  const result = copyToClipboardNativeSync('hello world');
  assert.equal(result, true);
  assert.ok(mockExec.mock.calls.length > 0);
  const cmd = mockExec.mock.calls[0]!.arguments[0] as string;
  assert.ok(cmd.includes('Set-Clipboard'));
  assert.ok(cmd.includes('FromBase64String'));
  teardown();
});

test('copyToClipboardNativeSync: Windows failure returns false', () => {
  setup({
    platform: 'win32',
    execImpl: () => {
      throw new Error('exec error');
    },
  });
  assert.equal(copyToClipboardNativeSync('hello'), false);
  teardown();
});

test('copyToClipboardNativeSync: macOS success path', () => {
  const mockExec = setup({ platform: 'darwin', execImpl: () => Buffer.from('') });
  const result = copyToClipboardNativeSync('hello');
  assert.equal(result, true);
  const cmd = mockExec.mock.calls[0]!.arguments[0] as string;
  assert.equal(cmd, 'pbcopy');
  assert.equal(mockExec.mock.calls[0]!.arguments[1]!.input, 'hello');
  teardown();
});

test('copyToClipboardNativeSync: macOS failure returns false', () => {
  setup({
    platform: 'darwin',
    execImpl: () => {
      throw new Error('pbcopy error');
    },
  });
  assert.equal(copyToClipboardNativeSync('hello'), false);
  teardown();
});

test('copyToClipboardNativeSync: Linux wl-copy path', () => {
  let callCount = 0;
  const mockExec = setup({
    platform: 'linux',
    env: { WAYLAND_DISPLAY: 'wayland-0' },
    execImpl: () => {
      callCount++;
      if (callCount === 1) return Buffer.from(''); // command -v wl-copy succeeds
      return Buffer.from(''); // wl-copy succeeds
    },
  });
  const result = copyToClipboardNativeSync('hello');
  assert.equal(result, true);
  const cmd = mockExec.mock.calls[1]!.arguments[0] as string;
  assert.equal(cmd, 'wl-copy');
  teardown();
});

test('copyToClipboardNativeSync: Linux xclip path', () => {
  const mockExec = setup({
    platform: 'linux',
    execImpl: (cmd: string) => {
      if (cmd.includes('command -v')) {
        if (cmd.includes('xclip')) return Buffer.from('');
        throw new Error('not found');
      }
      return Buffer.from('');
    },
  });
  const result = copyToClipboardNativeSync('hello');
  assert.equal(result, true);
  const copyCall = mockExec.mock.calls.find((c) =>
    (c.arguments[0] as string).includes('xclip -selection clipboard'),
  );
  assert.ok(copyCall, 'Expected an xclip invocation');
  teardown();
});

test('copyToClipboardNativeSync: Linux no tools returns false', () => {
  setup({
    platform: 'linux',
    execImpl: () => {
      throw new Error('not found');
    },
  });
  assert.equal(copyToClipboardNativeSync('hello'), false);
  teardown();
});

test('copyToClipboardNativeSync: empty text returns false', () => {
  setup({ platform: 'win32' });
  assert.equal(copyToClipboardNativeSync(''), false);
  teardown();
});

test('copyToClipboardNativeSync: unsupported platform returns false', () => {
  setup({ platform: 'android' });
  assert.equal(copyToClipboardNativeSync('hello'), false);
  teardown();
});

// ─── copyToClipboardNative (async) ──────────────────────────────

test('copyToClipboardNative: async wrapper returns sync result', async () => {
  const mockExec = setup({ platform: 'darwin', execImpl: () => Buffer.from('') });
  const result = await copyToClipboardNative('hello');
  assert.equal(result, true);
  assert.equal(mockExec.mock.calls[0]!.arguments[0], 'pbcopy');
  teardown();
});

test('copyToClipboardNative: async wrapper propagates failure', async () => {
  setup({
    platform: 'darwin',
    execImpl: () => {
      throw new Error('fail');
    },
  });
  const result = await copyToClipboardNative('hello');
  assert.equal(result, false);
  teardown();
});

// ─── readFromClipboardNative ────────────────────────────────────

test('readFromClipboardNative: Windows returns clipboard text', async () => {
  setup({
    platform: 'win32',
    execImpl: () => Buffer.from('clipboard content'),
  });
  const result = await readFromClipboardNative();
  assert.equal(result, 'clipboard content');
  teardown();
});

test('readFromClipboardNative: Windows trims whitespace', async () => {
  setup({
    platform: 'win32',
    execImpl: () => Buffer.from('  hello world\n'),
  });
  const result = await readFromClipboardNative();
  assert.equal(result, 'hello world');
  teardown();
});

test('readFromClipboardNative: Windows exec failure returns null', async () => {
  setup({
    platform: 'win32',
    execImpl: () => {
      throw new Error('error');
    },
  });
  const result = await readFromClipboardNative();
  assert.equal(result, null);
  teardown();
});

test('readFromClipboardNative: macOS returns clipboard text', async () => {
  setup({
    platform: 'darwin',
    execImpl: () => Buffer.from('mac clipboard'),
  });
  const result = await readFromClipboardNative();
  assert.equal(result, 'mac clipboard');
  teardown();
});

test('readFromClipboardNative: Linux wl-paste returns text', async () => {
  let callCount = 0;
  setup({
    platform: 'linux',
    env: { WAYLAND_DISPLAY: 'wayland-0' },
    execImpl: () => {
      callCount++;
      if (callCount === 1) return Buffer.from(''); // command -v wl-copy succeeds
      return Buffer.from('wayland clipboard'); // wl-paste succeeds
    },
  });
  const result = await readFromClipboardNative();
  assert.equal(result, 'wayland clipboard');
  teardown();
});

test('readFromClipboardNative: Linux no tools returns null', async () => {
  setup({
    platform: 'linux',
    execImpl: () => {
      throw new Error('not found');
    },
  });
  const result = await readFromClipboardNative();
  assert.equal(result, null);
  teardown();
});

test('readFromClipboardNative: empty result returns null', async () => {
  setup({
    platform: 'darwin',
    execImpl: () => Buffer.from('   \n  '),
  });
  const result = await readFromClipboardNative();
  assert.equal(result, null);
  teardown();
});

test('readFromClipboardNative: unsupported platform returns null', async () => {
  setup({ platform: 'android' });
  const result = await readFromClipboardNative();
  assert.equal(result, null);
  teardown();
});

// ─── clipboard.ts — SSH/tmux detection ──────────────────────────────

import {
  isSsh as clipIsSsh,
  isZellij as clipIsZellij,
  isTmux as clipIsTmux,
  isScreen as clipIsScreen,
  getClipboardStrategy,
  _copyToClipboardWith,
  _setEnv as _setClipEnv,
  _setStdout,
  _setStdin,
} from './clipboard.js';

/** Setup for clipboard.ts env-override tests. */
function clipSetup(env: Record<string, string | undefined>) {
  _setClipEnv({ ...env });
  // Mock stdout/stdin to avoid real terminal I/O
  _setStdout({ isTTY: true, write: () => true, on: () => {} } as any);
  _setStdin({ on: () => {}, off: () => {} } as any);
}

/** Teardown clipboard.ts env overrides. */
function clipTeardown() {
  _setClipEnv(process.env);
  _setStdout(process.stdout);
  _setStdin(process.stdin);
}

// ─── isSsh ──────────────────────────────────────────────────────────

test('isSsh: returns true when SSH_TTY is set', () => {
  clipSetup({ SSH_TTY: '/dev/pts/0' });
  assert.equal(clipIsSsh(), true);
  clipTeardown();
});

test('isSsh: returns true when SSH_CLIENT is set', () => {
  clipSetup({ SSH_CLIENT: '10.0.0.1 22 1234' });
  assert.equal(clipIsSsh(), true);
  clipTeardown();
});

test('isSsh: returns true when SSH_CONNECTION is set', () => {
  clipSetup({ SSH_CONNECTION: '10.0.0.1 22 10.0.0.2 22' });
  assert.equal(clipIsSsh(), true);
  clipTeardown();
});

test('isSsh: returns false when no SSH env vars are set', () => {
  clipSetup({});
  assert.equal(clipIsSsh(), false);
  clipTeardown();
});

// ─── isZellij ───────────────────────────────────────────────────────

test('isZellij: returns true when ZELLIJ is set', () => {
  clipSetup({ ZELLIJ: '/tmp/zellij-123.sock' });
  assert.equal(clipIsZellij(), true);
  clipTeardown();
});

test('isZellij: returns true when ZELLIJ is non-empty string', () => {
  clipSetup({ ZELLIJ: '1' });
  assert.equal(clipIsZellij(), true);
  clipTeardown();
});

test('isZellij: returns false when ZELLIJ is unset', () => {
  clipSetup({});
  assert.equal(clipIsZellij(), false);
  clipTeardown();
});

test('isZellij: returns false when ZELLIJ is empty string', () => {
  clipSetup({ ZELLIJ: '' });
  assert.equal(clipIsZellij(), false);
  clipTeardown();
});

// ─── isTmux (re-test with injection) ────────────────────────────────

test('isTmux: returns true when TMUX is set', () => {
  clipSetup({ TMUX: '/tmp/tmux-1000/default,12345,0' });
  assert.equal(clipIsTmux(), true);
  clipTeardown();
});

test('isTmux: returns false when no tmux env vars', () => {
  clipSetup({});
  assert.equal(clipIsTmux(), false);
  clipTeardown();
});

test('isTmux: detects tmux via TERM starting with tmux', () => {
  clipSetup({ TERM: 'tmux-256color' });
  assert.equal(clipIsTmux(), true);
  clipTeardown();
});

test('isTmux: detects tmux via TERM_PROGRAM', () => {
  clipSetup({ TERM_PROGRAM: 'tmux' });
  assert.equal(clipIsTmux(), true);
  clipTeardown();
});

// ─── isScreen ───────────────────────────────────────────────────────

test('isScreen: returns true when STY is set', () => {
  clipSetup({ STY: '12345.pts-0.host' });
  assert.equal(clipIsScreen(), true);
  clipTeardown();
});

test('isScreen: detects screen via TERM starting with screen', () => {
  clipSetup({ TERM: 'screen-256color' });
  assert.equal(clipIsScreen(), true);
  clipTeardown();
});

// ─── getClipboardStrategy ───────────────────────────────────────────

test('getClipboardStrategy: SSH + tmux returns tmux-buffer', () => {
  clipSetup({ SSH_TTY: '/dev/pts/0', TMUX: '/tmp/tmux-1000/default,12345,0' });
  assert.equal(getClipboardStrategy(), 'tmux-buffer');
  clipTeardown();
});

test('getClipboardStrategy: SSH only returns osc52', () => {
  clipSetup({ SSH_TTY: '/dev/pts/0' });
  assert.equal(getClipboardStrategy(), 'osc52');
  clipTeardown();
});

test('getClipboardStrategy: local tmux returns tmux-buffer', () => {
  clipSetup({ TMUX: '/tmp/tmux-1000/default,12345,0' });
  assert.equal(getClipboardStrategy(), 'tmux-buffer');
  clipTeardown();
});

test('getClipboardStrategy: Zellij returns osc52-direct', () => {
  clipSetup({ ZELLIJ: '/tmp/zellij-123.sock' });
  assert.equal(getClipboardStrategy(), 'osc52-direct');
  clipTeardown();
});

test('getClipboardStrategy: local with native supported returns native', () => {
  // No SSH/TMUX/Zellij; native tools are available (mocked in clipboard-native)
  // Use a platform where native is available (win32 with powershell mocked)
  const savedPlatform = _platform;
  const savedEnv = { ..._nativeEnv };
  _setPlatform('win32');

  // Mock execSync so `where powershell` succeeds for native clipboard check
  const mockExec = mock.fn((): string | Buffer => Buffer.from(''));
  _setExecSync(mockExec as any);

  // Environment with no special session vars
  _setClipEnv({});

  assert.equal(getClipboardStrategy(), 'native');
  assert.ok(mockExec.mock.calls.length > 0);

  // Restore
  _setPlatform(savedPlatform);
  _setEnv(savedEnv);
  clipTeardown();
  _setExecSync(realExecSync);
});

test('getClipboardStrategy: nothing available returns none', () => {
  // No SSH/TMUX/Zellij; native tools unavailable; OSC 52 disabled via CI
  const savedPlatform = _platform;
  const savedEnv = { ..._nativeEnv };

  _setPlatform('android');
  // _setEnv from clipboard-native for isNativeClipboardSupported check
  _setEnv({});

  // CI=true disables OSC 52 path
  _setClipEnv({ CI: 'true' });

  assert.equal(getClipboardStrategy(), 'none');

  _setPlatform(savedPlatform);
  _setEnv(savedEnv);
  clipTeardown();
});

// ─── _copyToClipboardWith — strategy chain fallthrough ──────────────

/**
 * Helper: create a set of mock strategy functions that count calls.
 */
function countingStrategies() {
  const calls = { tmuxBuffer: 0, osc52Passthrough: 0, osc52Direct: 0, native: 0 };
  return {
    calls,
    strategies: {
      tmuxBuffer: (_text: string) => { calls.tmuxBuffer++; return false; },
      osc52Passthrough: (_text: string, _clip: 'c' | 'p') => { calls.osc52Passthrough++; return false; },
      osc52Direct: (_text: string, _clip: 'c' | 'p') => { calls.osc52Direct++; return false; },
      native: (_text: string) => { calls.native++; return false; },
    } as const,
  };
}

test('_copyToClipboardWith: SSH + tmux tries tmuxBuffer first, then osc52Passthrough, then osc52Direct', () => {
  clipSetup({ SSH_TTY: '/dev/pts/0', TMUX: '/tmp/tmux-1000/default,12345,0' });
  const { calls, strategies } = countingStrategies();

  const result = _copyToClipboardWith('hello', 'c', strategies);

  assert.equal(result, false);
  assert.equal(calls.tmuxBuffer, 1, 'should try tmux buffer first');
  assert.equal(calls.osc52Passthrough, 1, 'should fall through to OSC 52 passthrough');
  assert.equal(calls.osc52Direct, 1, 'should fall through to OSC 52 direct');
  assert.equal(calls.native, 0, 'should NOT try native clipboard over SSH');
  clipTeardown();
});

test('_copyToClipboardWith: SSH + tmux stops at tmuxBuffer when it succeeds', () => {
  clipSetup({ SSH_TTY: '/dev/pts/0', TMUX: '/tmp/tmux-1000/default,12345,0' });
  const { calls, strategies } = countingStrategies();

  // Make tmuxBuffer succeed
  const result = _copyToClipboardWith('hello', 'c', {
    ...strategies,
    tmuxBuffer: (_text) => { calls.tmuxBuffer++; return true; },
  });

  assert.equal(result, true);
  assert.equal(calls.tmuxBuffer, 1);
  assert.equal(calls.osc52Passthrough, 0, 'should not try OSC 52 if tmux buffer succeeded');
  assert.equal(calls.osc52Direct, 0);
  assert.equal(calls.native, 0);
  clipTeardown();
});

test('_copyToClipboardWith: SSH only tries osc52Direct only', () => {
  clipSetup({ SSH_TTY: '/dev/pts/0' });
  const { calls, strategies } = countingStrategies();

  const result = _copyToClipboardWith('hello', 'c', strategies);

  assert.equal(result, false);
  assert.equal(calls.tmuxBuffer, 0, 'should not try tmux buffer (no tmux)');
  assert.equal(calls.osc52Passthrough, 0, 'should not try OSC 52 passthrough (no tmux)');
  assert.equal(calls.osc52Direct, 1, 'should try OSC 52 direct');
  assert.equal(calls.native, 0, 'should NOT try native clipboard over SSH');
  clipTeardown();
});

test('_copyToClipboardWith: local tmux tries tmuxBuffer then osc52Passthrough then native then osc52Direct', () => {
  clipSetup({ TMUX: '/tmp/tmux-1000/default,12345,0' });
  const { calls, strategies } = countingStrategies();

  const result = _copyToClipboardWith('hello', 'c', strategies);

  assert.equal(result, false);
  assert.equal(calls.tmuxBuffer, 1, 'should try tmux buffer first');
  assert.equal(calls.osc52Passthrough, 1, 'should try OSC 52 passthrough second');
  assert.equal(calls.native, 1, 'should try native clipboard third');
  assert.equal(calls.osc52Direct, 1, 'should try OSC 52 direct last');
  clipTeardown();
});

test('_copyToClipboardWith: local tmux stops at tmuxBuffer when it succeeds', () => {
  clipSetup({ TMUX: '/tmp/tmux-1000/default,12345,0' });
  const { calls, strategies } = countingStrategies();

  const result = _copyToClipboardWith('hello', 'c', {
    ...strategies,
    tmuxBuffer: (_text) => { calls.tmuxBuffer++; return true; },
  });

  assert.equal(result, true);
  assert.equal(calls.tmuxBuffer, 1);
  assert.equal(calls.osc52Passthrough, 0, 'should not fall through if tmux buffer succeeded');
  assert.equal(calls.native, 0);
  assert.equal(calls.osc52Direct, 0);
  clipTeardown();
});

test('_copyToClipboardWith: local tmux falls through to native after tmuxBuffer and osc52Passthrough fail', () => {
  clipSetup({ TMUX: '/tmp/tmux-1000/default,12345,0' });
  const { calls, strategies } = countingStrategies();

  const result = _copyToClipboardWith('hello', 'c', {
    ...strategies,
    native: (_text) => { calls.native++; return true; },
  });

  assert.equal(result, true);
  assert.equal(calls.tmuxBuffer, 1);
  assert.equal(calls.osc52Passthrough, 1);
  assert.equal(calls.native, 1, 'native should succeed after first two fail');
  assert.equal(calls.osc52Direct, 0, 'should not reach OSC 52 direct');
  clipTeardown();
});

test('_copyToClipboardWith: Zellij tries osc52Direct first then native', () => {
  clipSetup({ ZELLIJ: '/tmp/zellij-123.sock' });
  const { calls, strategies } = countingStrategies();

  const result = _copyToClipboardWith('hello', 'c', strategies);

  assert.equal(result, false);
  assert.equal(calls.tmuxBuffer, 0, 'should not try tmux buffer');
  assert.equal(calls.osc52Passthrough, 0, 'should not try OSC 52 passthrough');
  assert.equal(calls.osc52Direct, 1, 'should try OSC 52 direct first');
  assert.equal(calls.native, 1, 'should fall through to native');
  clipTeardown();
});

test('_copyToClipboardWith: Zellij stops at osc52Direct when it succeeds', () => {
  clipSetup({ ZELLIJ: '/tmp/zellij-123.sock' });
  const { calls, strategies } = countingStrategies();

  const result = _copyToClipboardWith('hello', 'c', {
    ...strategies,
    osc52Direct: (_text, _clip) => { calls.osc52Direct++; return true; },
  });

  assert.equal(result, true);
  assert.equal(calls.osc52Direct, 1);
  assert.equal(calls.native, 0, 'should not fall through to native');
  clipTeardown();
});

test('_copyToClipboardWith: local (no mux) tries native first then osc52Direct', () => {
  clipSetup({});
  const { calls, strategies } = countingStrategies();

  const result = _copyToClipboardWith('hello', 'c', strategies);

  assert.equal(result, false);
  assert.equal(calls.tmuxBuffer, 0);
  assert.equal(calls.osc52Passthrough, 0);
  assert.equal(calls.native, 1, 'should try native first');
  assert.equal(calls.osc52Direct, 1, 'should fall through to OSC 52 direct');
  clipTeardown();
});

test('_copyToClipboardWith: local stops at native when it succeeds', () => {
  clipSetup({});
  const { calls, strategies } = countingStrategies();

  const result = _copyToClipboardWith('hello', 'c', {
    ...strategies,
    native: (_text) => { calls.native++; return true; },
  });

  assert.equal(result, true);
  assert.equal(calls.native, 1);
  assert.equal(calls.osc52Direct, 0, 'should not fall through');
  clipTeardown();
});

test('_copyToClipboardWith: empty text returns false immediately', () => {
  clipSetup({});
  const { calls, strategies } = countingStrategies();

  const result = _copyToClipboardWith('', 'c', strategies);

  assert.equal(result, false);
  assert.equal(calls.tmuxBuffer, 0, 'should not try any strategy for empty text');
  assert.equal(calls.osc52Passthrough, 0);
  assert.equal(calls.osc52Direct, 0);
  assert.equal(calls.native, 0);
  clipTeardown();
});

// ─── Integration: copyToClipboard delegates to _copyToClipboardWith ──
// No integration test needed: `copyToClipboard` is a one-line wrapper that
// delegates to `_copyToClipboardWith` with real strategy implementations.
// The strategy chains are comprehensively tested via `_copyToClipboardWith`
// above. Real clipboard/terminal I/O is tested at the e2e level.

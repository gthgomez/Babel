import test from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { execSync as realExecSync } from 'node:child_process';
import {
  _setExecSync,
  _setEnv,
  _setStdout,
  _setStdin,
  _stdin,
  _stdout,
  _env,
  readFromClipboard,
  isClipboardSupported,
  isGnuScreen,
  isScreen,
  isScreenDetached,
  isTmux,
  isZellij,
  tmuxRefreshClient,
  writeClipboardWithTmuxRefresh,
  zellijWriteClipboard,
  zellijReadClipboard,
  writeClipboardEnhanced,
  detectClipboardEnvironment,
} from './clipboard.js';

test('tmux save-buffer fallback tests', async (t) => {
  // Save original state
  const originalEnv = { ...process.env };
  const originalExec = realExecSync;
  const originalStdout = process.stdout;
  const originalStdin = _stdin;

  t.afterEach(() => {
    _setExecSync(originalExec);
    _setEnv(originalEnv);
    _setStdout(originalStdout);
    _setStdin(originalStdin);
    // Restore real process.env
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  });

  await t.test('readFromClipboard: fallback in tmux when OSC 52 is not supported', async () => {
    const mockExec = mock.fn((cmd: string) => {
      if (cmd === 'tmux save-buffer -') {
        return Buffer.from('hello-tmux-paste');
      }
      throw new Error('command failed');
    });

    _setExecSync(mockExec as any);
    _setEnv({
      TMUX: '/tmp/tmux-1000/default,1234,0',
      SSH_CONNECTION: '127.0.0.1 54321 127.0.0.1 22',
    });
    // Force _osc52Supported to be false by mocking isTTY to false
    _setStdout({ isTTY: false, write: () => {} } as any);

    const result = await readFromClipboard();
    assert.equal(result, 'hello-tmux-paste');
    assert.equal(mockExec.mock.calls.length, 1);
    const callArgs = mockExec.mock.calls[0]?.arguments;
    assert.ok(callArgs);
    assert.equal(callArgs[0], 'tmux save-buffer -');
  });

  await t.test('readFromClipboard: fallback in tmux when OSC 52 times out', async () => {
    const mockExec = mock.fn((cmd: string) => {
      if (cmd === 'tmux save-buffer -') {
        return Buffer.from('hello-tmux-paste');
      }
      throw new Error('command failed');
    });

    const mockStdin = {
      on: mock.fn(() => {}),
      off: mock.fn(() => {}),
      pause: mock.fn(() => {}),
    };

    _setExecSync(mockExec as any);
    _setStdin(mockStdin as any);
    _setEnv({
      TMUX: '/tmp/tmux-1000/default,1234,0',
      SSH_CONNECTION: '127.0.0.1 54321 127.0.0.1 22',
    });
    
    // Force supportsColor to return true by setting FORCE_COLOR and removing NO_COLOR/CI
    process.env['FORCE_COLOR'] = '1';
    delete process.env['NO_COLOR'];
    delete process.env['CI'];

    // Force _osc52Supported to be true
    _setStdout({ isTTY: true, write: () => {} } as any);

    // Run the clipboard read, which will trigger the 500ms timeout
    const start = Date.now();
    const result = await readFromClipboard();
    const elapsed = Date.now() - start;

    assert.equal(result, 'hello-tmux-paste');
    assert.ok(elapsed >= 450, `Expected elapsed time to be at least 500ms, got ${elapsed}ms`);
    assert.equal(mockExec.mock.calls.length, 1);
    const callArgs = mockExec.mock.calls[0]?.arguments;
    assert.ok(callArgs);
    assert.equal(callArgs[0], 'tmux save-buffer -');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// E4: Edge-case detection helpers
// ═══════════════════════════════════════════════════════════════════════════════

test('isGnuScreen — alias for isScreen', async (t) => {
  const originalEnv = { ..._env };

  t.afterEach(() => {
    _setEnv(originalEnv);
  });

  await t.test('returns true when STY is set', () => {
    _setEnv({ STY: '12345.pts-0.host' });
    assert.equal(isGnuScreen(), true);
  });

  await t.test('returns true when TERM starts with screen', () => {
    _setEnv({ TERM: 'screen-256color' });
    assert.equal(isGnuScreen(), true);
  });

  await t.test('returns false when neither STY nor TERM indicate screen', () => {
    _setEnv({ STY: undefined, TERM: 'xterm-256color' });
    assert.equal(isGnuScreen(), false);
  });

  await t.test('matches isScreen() exactly', () => {
    _setEnv({ STY: '12345.pts-0.host' });
    assert.equal(isGnuScreen(), isScreen());
  });
});

test('isScreenDetached — Screen session without controlling terminal', async (t) => {
  const originalEnv = { ..._env };
  const originalStdout = _stdout;

  t.afterEach(() => {
    _setEnv(originalEnv);
    _setStdout(originalStdout);
  });

  await t.test('returns true when STY is set and stdout is not TTY', () => {
    _setEnv({ STY: '12345.pts-0.host' });
    _setStdout({ isTTY: false, write() {} } as any);
    assert.equal(isScreenDetached(), true);
  });

  await t.test('returns false when STY is set and stdout is TTY', () => {
    _setEnv({ STY: '12345.pts-0.host' });
    _setStdout({ isTTY: true, write() {} } as any);
    assert.equal(isScreenDetached(), false);
  });

  await t.test('returns false when not in Screen', () => {
    _setEnv({ STY: undefined, TERM: 'xterm-256color' });
    assert.equal(isScreenDetached(), false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// E4: tmuxRefreshClient
// ═══════════════════════════════════════════════════════════════════════════════

test('tmuxRefreshClient', async (t) => {
  const originalEnv = { ..._env };
  const origExec = realExecSync;
  const origStdout = _stdout;

  t.afterEach(() => {
    _setEnv(originalEnv);
    _setStdout(origStdout);
    _setExecSync(origExec);
  });

  await t.test('returns true when in tmux and command succeeds', () => {
    _setEnv({ TMUX: '/tmp/tmux-1234/default' });
    _setExecSync(() => Buffer.from('') as any);
    assert.equal(tmuxRefreshClient(), true);
  });

  await t.test('returns false when not in tmux', () => {
    _setEnv({ TMUX: undefined, TERM: 'xterm-256color' });
    assert.equal(tmuxRefreshClient(), false);
  });

  await t.test('returns false when command throws', () => {
    _setEnv({ TMUX: '/tmp/tmux-1234/default' });
    _setExecSync(() => { throw new Error('not found'); });
    assert.equal(tmuxRefreshClient(), false);
  });

  await t.test('calls tmux refresh-client -w exactly', () => {
    _setEnv({ TMUX: '/tmp/tmux-1234/default' });
    let called = '';
    _setExecSync(((cmd: string) => { called = cmd; return Buffer.from(''); }) as any);
    tmuxRefreshClient();
    assert.equal(called, 'tmux refresh-client -w');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// E4: writeClipboardWithTmuxRefresh
// ═══════════════════════════════════════════════════════════════════════════════

test('writeClipboardWithTmuxRefresh', async (t) => {
  const originalEnv = { ..._env };
  const origExec = realExecSync;

  t.afterEach(() => {
    _setEnv(originalEnv);
    _setExecSync(origExec);
  });

  await t.test('calls load-buffer + refresh-client on success', () => {
    _setEnv({ TMUX: '/tmp/tmux-1234/default' });
    const calls: string[] = [];
    _setExecSync(((cmd: string) => { calls.push(cmd); return Buffer.from(''); }) as any);
    const result = writeClipboardWithTmuxRefresh('hello');
    assert.equal(result, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[0], 'tmux load-buffer -w -');
    assert.equal(calls[1], 'tmux refresh-client -w');
  });

  await t.test('returns false when not in tmux', () => {
    _setEnv({ TMUX: undefined });
    assert.equal(writeClipboardWithTmuxRefresh('hello'), false);
  });

  await t.test('returns false for empty text', () => {
    _setEnv({ TMUX: '/tmp/tmux-1234/default' });
    assert.equal(writeClipboardWithTmuxRefresh(''), false);
  });

  await t.test('returns false when commands throw', () => {
    _setEnv({ TMUX: '/tmp/tmux-1234/default' });
    _setExecSync(() => { throw new Error('fail'); });
    assert.equal(writeClipboardWithTmuxRefresh('hello'), false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// E4: Zellij clipboard integration
// ═══════════════════════════════════════════════════════════════════════════════

test('zellijWriteClipboard', async (t) => {
  const originalEnv = { ..._env };
  const origExec = realExecSync;

  t.afterEach(() => {
    _setEnv(originalEnv);
    _setExecSync(origExec);
  });

  await t.test('returns true when in Zellij and command succeeds', () => {
    _setEnv({ ZELLIJ: '/tmp/zellij-ipc.sock' });
    _setExecSync(() => Buffer.from('') as any);
    assert.equal(zellijWriteClipboard('hello'), true);
  });

  await t.test('calls zellij action write-clipboard', () => {
    _setEnv({ ZELLIJ: '/tmp/zellij-ipc.sock' });
    let called = '';
    _setExecSync(((cmd: string) => { called = cmd; return Buffer.from(''); }) as any);
    zellijWriteClipboard('test');
    assert.equal(called, 'zellij action write-clipboard');
  });

  await t.test('returns false when not in Zellij', () => {
    _setEnv({ ZELLIJ: undefined });
    assert.equal(zellijWriteClipboard('hello'), false);
  });

  await t.test('returns false for empty text', () => {
    _setEnv({ ZELLIJ: '/tmp/zellij-ipc.sock' });
    assert.equal(zellijWriteClipboard(''), false);
  });

  await t.test('returns false when command throws', () => {
    _setEnv({ ZELLIJ: '/tmp/zellij-ipc.sock' });
    _setExecSync(() => { throw new Error('not found'); });
    assert.equal(zellijWriteClipboard('data'), false);
  });
});

test('zellijReadClipboard always returns null', () => {
  assert.equal(zellijReadClipboard(), null);
});

// ═══════════════════════════════════════════════════════════════════════════════
// E4: writeClipboardEnhanced — extended priority chain
// ═══════════════════════════════════════════════════════════════════════════════

test('writeClipboardEnhanced', async (t) => {
  const originalEnv = { ..._env };
  const origExec = realExecSync;
  const origStdout = _stdout;

  t.afterEach(() => {
    _setEnv(originalEnv);
    _setStdout(origStdout);
    _setExecSync(origExec);
  });

  await t.test('returns false for empty text', () => {
    assert.equal(writeClipboardEnhanced(''), false);
  });

  await t.test('tries Zellij first when in Zellij', () => {
    _setEnv({ ZELLIJ: '/tmp/zellij-ipc.sock' });
    _setStdout({ isTTY: false, write() {} } as any);
    let zellijCalled = false;
    _setExecSync(((cmd: string) => {
      if (cmd === 'zellij action write-clipboard') { zellijCalled = true; return Buffer.from(''); }
      throw new Error('unexpected');
    }) as any);
    assert.equal(writeClipboardEnhanced('test'), true);
    assert.equal(zellijCalled, true);
  });

  await t.test('tries tmux path when in tmux', () => {
    _setEnv({ TMUX: '/tmp/tmux-1234/default', ZELLIJ: undefined });
    let loadCalled = false;
    let refreshCalled = false;
    _setExecSync(((cmd: string) => {
      if (cmd === 'tmux load-buffer -w -') { loadCalled = true; return Buffer.from(''); }
      if (cmd === 'tmux refresh-client -w') { refreshCalled = true; return Buffer.from(''); }
      throw new Error('unexpected: ' + cmd);
    }) as any);
    assert.equal(writeClipboardEnhanced('data'), true);
    assert.equal(loadCalled, true);
    assert.equal(refreshCalled, true);
  });

  await t.test('does not throw in any environment', () => {
    _setEnv({ TMUX: undefined, ZELLIJ: undefined, STY: undefined });
    _setStdout({ isTTY: true, write() {} } as any);
    assert.doesNotThrow(() => writeClipboardEnhanced('text'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// E4: detectClipboardEnvironment
// ═══════════════════════════════════════════════════════════════════════════════

test('detectClipboardEnvironment', async (t) => {
  const originalEnv = { ..._env };
  const origStdout = _stdout;

  t.afterEach(() => {
    _setEnv(originalEnv);
    _setStdout(origStdout);
  });

  await t.test('detects tmux with limitations', () => {
    _setEnv({ TMUX: '/tmp/tmux-1234/default' });
    _setStdout({ isTTY: true, write() {} } as any);
    const env = detectClipboardEnvironment();
    assert.equal(env.terminal, 'tmux');
    assert.ok(env.limitations.length > 0);
    assert.ok(env.limitations[0]!.includes('set-clipboard'));
  });

  await t.test('detects Zellij with no limitations', () => {
    _setEnv({ ZELLIJ: '/tmp/zellij-ipc.sock' });
    _setStdout({ isTTY: true, write() {} } as any);
    const env = detectClipboardEnvironment();
    assert.equal(env.terminal, 'zellij');
    assert.equal(env.limitations.length, 0);
  });

  await t.test('detects Screen attached', () => {
    _setEnv({ STY: '12345.pts-0.host' });
    _setStdout({ isTTY: true, write() {} } as any);
    const env = detectClipboardEnvironment();
    assert.equal(env.terminal, 'screen');
    assert.ok(env.limitations.length > 0);
  });

  await t.test('detects Screen detached with clipboard disabled', () => {
    _setEnv({ STY: '12345.pts-0.host' });
    _setStdout({ isTTY: false, write() {} } as any);
    const env = detectClipboardEnvironment();
    assert.equal(env.terminal, 'screen');
    assert.equal(env.clipboardSupported, false);
    assert.ok(env.limitations.some((l) => l.includes('detached')));
  });

  await t.test('returns non-multiplexer result with no TTY', () => {
    _setEnv({});
    _setStdout({ isTTY: false, write() {} } as any);
    const env = detectClipboardEnvironment();
    // NOTE: On systems with native clipboard tools (PowerShell, pbcopy, etc.),
    // detectClipboardEnvironment will return 'native' with no limitations instead
    // of 'unknown'. We verify that no multiplexer (tmux/zellij/screen) was detected.
    assert.ok(env.terminal !== 'tmux');
    assert.ok(env.terminal !== 'zellij');
    assert.ok(env.terminal !== 'screen');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// E4: Cross-detection independence
// ═══════════════════════════════════════════════════════════════════════════════

test('detection helpers are independent', async (t) => {
  const originalEnv = { ..._env };

  t.afterEach(() => {
    _setEnv(originalEnv);
  });

  await t.test('tmux and zellij detection do not interfere', () => {
    _setEnv({ TMUX: '/tmp/tmux-1234/default', ZELLIJ: undefined });
    assert.equal(isTmux(), true);
    assert.equal(isZellij(), false);

    _setEnv({ TMUX: undefined, ZELLIJ: '/tmp/sock' });
    assert.equal(isZellij(), true);
    assert.equal(isTmux(), false);
  });

  await t.test('screen detection coexists with tmux detection', () => {
    _setEnv({ STY: '12345', TMUX: '/tmp/tmux-1234/default' });
    assert.equal(isScreen(), true);
    assert.equal(isGnuScreen(), true);
    assert.equal(isTmux(), true);
  });
});

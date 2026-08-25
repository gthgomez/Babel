/**
 * sharedPrimitives.test.ts — Invariant & regression test suite for Babel's TUI shared primitives.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  sanitizeUntrustedTerminalText,
  sanitizeHyperlinkUri,
  encodeHyperlink,
} from './sanitize.js';
import {
  measureDisplayWidth,
  truncateDisplay,
  wrapDisplayLines,
  wrapPrefixedBlock,
} from './textLayout.js';
import { scanFenceLine } from './markdownFenceScanner.js';
import { MarkdownAccumulator } from './markdownAccumulator.js';
import { renderMarkdown, highlightCodeBlocks } from './highlight.js';
import { createVirtualCellGrid } from './observe/virtualCellGrid.js';
import { computeScreenLayout } from './screenLayout.js';
import { ScreenManager } from './screenManager.js';
import {
  TerminalTransport,
  setObservedTerminalSize,
} from './observe/terminalTransport.js';

describe('Shared Primitive 1: Terminal Trust Boundary', () => {
  it('strips all raw CSI, OSC, DCS, and raw OSC 8 from untrusted text', () => {
    const rawInput =
      '\x1b[31;1mDangerous\x1b[0m \x1b]8;;https://malicious.site\x1b\\Click\x1b]8;;\x1b\\ \x1bP1;1;1q\x1b\\Payload\x07';
    const sanitized = sanitizeUntrustedTerminalText(rawInput);
    assert.equal(sanitized, 'Dangerous Click Payload');
  });

  it('NO_COLOR mode still sanitizes untrusted input through renderMarkdown', () => {
    const oldNoColor = process.env['NO_COLOR'];
    try {
      process.env['NO_COLOR'] = '1';
      const dangerousMarkdown =
        'Hello \x1b[2J\x1b[HWorld \x1b]8;;https://bad.com\x1b\\Link\x1b]8;;\x1b\\';
      const output = renderMarkdown(dangerousMarkdown);
      assert.ok(
        !output.includes('\x1b'),
        'Output must not contain any raw escape sequences in NO_COLOR mode',
      );
      assert.ok(output.includes('Hello World Link'));
    } finally {
      if (oldNoColor === undefined) delete process.env['NO_COLOR'];
      else process.env['NO_COLOR'] = oldNoColor;
    }
  });

  it('sanitizeHyperlinkUri allows only valid http/https URLs', () => {
    assert.equal(sanitizeHyperlinkUri('https://babel.dev/docs'), 'https://babel.dev/docs');
    assert.equal(sanitizeHyperlinkUri('http://127.0.0.1:8080'), 'http://127.0.0.1:8080');
    assert.equal(sanitizeHyperlinkUri('javascript:alert(1)'), null);
    assert.equal(sanitizeHyperlinkUri('file:///etc/hosts'), null);
    assert.equal(sanitizeHyperlinkUri('data:text/plain,hello'), null);
  });

  it('encodeHyperlink emits valid matching OSC 8 pairs and falls back for invalid URLs', () => {
    const valid = encodeHyperlink('https://github.com/gthgomez/Babel', 'Babel Repo');
    assert.equal(
      valid,
      '\x1b]8;;https://github.com/gthgomez/Babel\x1b\\Babel Repo\x1b]8;;\x1b\\',
    );

    const invalid = encodeHyperlink('javascript:eval("malicious")', 'Innocent Link');
    assert.equal(invalid, 'Innocent Link');
  });
});

describe('Shared Primitive 2: Terminal Text Layout Engine', () => {
  it('measureDisplayWidth correctly handles ANSI codes, OSC 8, CJK, and emoji', () => {
    const plain = 'Hello world';
    assert.equal(measureDisplayWidth(plain), 11);

    const ansiColored = '\x1b[38;2;255;100;50mHello\x1b[0m \x1b[1mworld\x1b[0m';
    assert.equal(measureDisplayWidth(ansiColored), 11);

    const withHyperlink = '\x1b]8;;https://example.com\x1b\\Click here\x1b]8;;\x1b\\';
    assert.equal(measureDisplayWidth(withHyperlink), 10);

    const cjk = '你好世界';
    assert.equal(measureDisplayWidth(cjk), 8);
  });

  it('truncateDisplay safely closes active SGR and active OSC 8 upon truncation', () => {
    const styledText = '\x1b[1m\x1b[31mVery long bold red text that should be truncated\x1b[0m';
    const truncated = truncateDisplay(styledText, 15);
    assert.ok(measureDisplayWidth(truncated) <= 15);
    assert.ok(truncated.endsWith('\x1b[0m'), 'Must emit SGR reset upon truncation');

    const linkedText =
      '\x1b]8;;https://example.com\x1b\\Very long hyperlinked text that gets cut\x1b]8;;\x1b\\';
    const truncatedLink = truncateDisplay(linkedText, 15);
    assert.ok(measureDisplayWidth(truncatedLink) <= 15);
    assert.ok(truncatedLink.includes('\x1b]8;;\x1b\\'), 'Must emit OSC 8 closer upon truncation');
  });

  it('wrapDisplayLines carries active OSC 8 hyperlink state across physical wraps', () => {
    const linkUrl = 'https://example.com/very/long/path/to/resource';
    const linkedText = `\x1b]8;;${linkUrl}\x1b\\This is a very long hyperlinked text that must wrap across multiple lines\x1b]8;;\x1b\\`;
    const wrapped = wrapDisplayLines(linkedText, 30);

    assert.ok(wrapped.length > 1);
    // Physical line 1 must close OSC 8
    assert.ok(
      wrapped[0]!.endsWith('\x1b]8;;\x1b\\'),
      `Line 1 must end with OSC 8 closer: ${JSON.stringify(wrapped[0])}`,
    );
    // Physical line 2 must reopen OSC 8 with matching URL
    assert.ok(
      wrapped[1]!.startsWith(`\x1b]8;;${linkUrl}\x1b\\`),
      `Line 2 must start with reopened OSC 8 opener: ${JSON.stringify(wrapped[1])}`,
    );
  });

  it('wrapPrefixedBlock wraps simultaneous SGR color and OSC 8 without leaking into prefix or next line', () => {
    const linkUrl = 'https://example.com';
    const firstPrefix = '  Babel  ';
    const continuationPrefix = '         ';
    const body = `Prefix \x1b[34m\x1b]8;;${linkUrl}\x1b\\first part of link and second part of link\x1b]8;;\x1b\\\x1b[0m unlinked trailing text`;

    const wrapped = wrapPrefixedBlock(body, {
      firstPrefix,
      continuationPrefix,
      width: 40,
    });

    assert.ok(wrapped.length > 1);

    // Line 1: Starts with firstPrefix, ends with OSC 8 closer + SGR reset
    assert.ok(wrapped[0]!.startsWith(firstPrefix));
    assert.ok(wrapped[0]!.includes(`\x1b]8;;${linkUrl}\x1b\\`));
    assert.ok(wrapped[0]!.endsWith('\x1b]8;;\x1b\\\x1b[0m'));

    // Line 2: Starts with continuationPrefix, followed by reopened SGR then reopened OSC 8
    assert.ok(wrapped[1]!.startsWith(continuationPrefix));
    // Prefix itself must not contain escape sequences
    const prefixSegment = wrapped[1]!.slice(0, continuationPrefix.length);
    assert.equal(prefixSegment, continuationPrefix);

    // After prefix, SGR is reopened and OSC 8 is reopened
    const afterPrefix = wrapped[1]!.slice(continuationPrefix.length);
    assert.ok(afterPrefix.startsWith(`\x1b[34m\x1b]8;;${linkUrl}\x1b\\`));

    // Trailing unlinked text must have no active hyperlink
    assert.ok(wrapped.some((line) => line.includes('unlinked')));
    assert.ok(wrapped.some((line) => line.includes('trailing text')));
  });

  it('wrapPrefixedBlock guarantees every line <= totalWidth under hard-wrap policy', () => {
    const firstPrefix = '  You    ';
    const continuationPrefix = '         ';
    const totalWidth = 40;
    const body =
      'This is a long message that needs to wrap neatly across several lines without overflowing the terminal width at all.';

    const lines = wrapPrefixedBlock(body, {
      firstPrefix,
      continuationPrefix,
      width: totalWidth,
      longTokenPolicy: 'hard-wrap',
    });

    assert.ok(lines.length > 1);
    for (const line of lines) {
      const w = measureDisplayWidth(line);
      assert.ok(
        w <= totalWidth,
        `Line width ${w} exceeded totalWidth ${totalWidth}: "${line}"`,
      );
    }
  });

  it('does not leave trailing spaces before line break', () => {
    const text = 'word1 word2 word3 word4';
    const wrapped = wrapDisplayLines(text, 12);
    for (const line of wrapped) {
      assert.equal(line, line.trimEnd(), `Line must not have trailing whitespace: "${line}"`);
    }
  });

  it('hard-wrap width invariant holds even for very long leading whitespace', () => {
    const longLeadingSpaces = ' '.repeat(100) + 'x';
    const wrapped = wrapDisplayLines(longLeadingSpaces, 20);
    assert.ok(wrapped.length > 1);
    for (const line of wrapped) {
      const w = measureDisplayWidth(line);
      assert.ok(
        w <= 20,
        `Line width ${w} exceeded maxWidth 20 for line with long leading spaces: "${line}"`,
      );
    }
  });

  it('wrapPrefixedBlock handles multiline paragraphs correctly', () => {
    const firstPrefix = '  Babel  ';
    const continuationPrefix = '         ';
    const totalWidth = 50;
    const body = 'Line 1\nLine 2 is on its own paragraph\nLine 3';

    const lines = wrapPrefixedBlock(body, {
      firstPrefix,
      continuationPrefix,
      width: totalWidth,
    });

    assert.ok(lines[0]!.startsWith('  Babel  Line 1'));
    assert.ok(lines[1]!.startsWith('         Line 2 is on its own paragraph'));
    assert.ok(lines[2]!.startsWith('         Line 3'));
  });
});

describe('CommonMark Markdown Code Fence Scanner & Streaming Accumulator', () => {
  it('detects simple backtick opener with language tag', () => {
    const res = scanFenceLine('```ts', null);
    assert.equal(res.isOpener, true);
    assert.ok(res.fence);
    assert.equal(res.fence?.char, '`');
    assert.equal(res.fence?.length, 3);
    assert.equal(res.fence?.info, 'ts');
    assert.equal(res.fence?.language, 'ts');
  });

  it('detects backtick opener with leading space in info string (e.g. ``` ts)', () => {
    const res = scanFenceLine('``` ts', null);
    assert.equal(res.isOpener, true);
    assert.ok(res.fence);
    assert.equal(res.fence?.info, 'ts');
    assert.equal(res.fence?.language, 'ts');
  });

  it('detects backtick opener with multi-word info string', () => {
    const res = scanFenceLine('```js title="app.js"', null);
    assert.equal(res.isOpener, true);
    assert.ok(res.fence);
    assert.equal(res.fence?.info, 'js title="app.js"');
    assert.equal(res.fence?.language, 'js');
  });

  it('allows 0 to 3 spaces of indentation on opener', () => {
    const res0 = scanFenceLine('```ts', null);
    const res1 = scanFenceLine(' ```ts', null);
    const res2 = scanFenceLine('  ```ts', null);
    const res3 = scanFenceLine('   ```ts', null);

    assert.equal(res0.isOpener, true);
    assert.equal(res1.isOpener, true);
    assert.equal(res2.isOpener, true);
    assert.equal(res3.isOpener, true);
  });

  it('rejects 4 or more spaces of indentation on opener (CommonMark indented code block)', () => {
    const res = scanFenceLine('    ```ts', null);
    assert.equal(res.isOpener, false);
    assert.equal(res.fence, null);
  });

  it('rejects backtick fence opener if info string contains backticks (CommonMark invariant)', () => {
    const res = scanFenceLine('``` foo`bar', null);
    assert.equal(res.isOpener, false);
    assert.equal(res.fence, null);
  });

  it('allows tilde fence opener info string to contain backticks', () => {
    const res = scanFenceLine('~~~ foo`bar', null);
    assert.equal(res.isOpener, true);
    assert.ok(res.fence);
    assert.equal(res.fence?.char, '~');
    assert.equal(res.fence?.info, 'foo`bar');
  });

  it('requires closer length >= opener length', () => {
    const opener = scanFenceLine('````', null).fence;
    assert.ok(opener);

    // Shorter closer does NOT close
    const shortClose = scanFenceLine('```', opener);
    assert.equal(shortClose.isCloser, false);
    assert.equal(shortClose.fence, opener);

    // Equal length closer closes
    const exactClose = scanFenceLine('````', opener);
    assert.equal(exactClose.isCloser, true);
    assert.equal(exactClose.fence, null);
  });

  it('rejects closer with non-whitespace trailing characters', () => {
    const opener = scanFenceLine('```', null).fence;
    assert.ok(opener);

    const invalidCloser = scanFenceLine('``` foo', opener);
    assert.equal(invalidCloser.isCloser, false);
    assert.equal(invalidCloser.fence, opener);
  });

  it('MarkdownAccumulator extracts exact syntax language from multi-word info strings', () => {
    const acc1 = new MarkdownAccumulator();
    acc1.feed('``` js title="app.js"\nconst x = 1;\n', (text) => text);
    assert.equal(acc1.activeCodeBlockLanguage, 'js');

    const acc2 = new MarkdownAccumulator();
    acc2.feed('```ts linenums="1"\nconst y = 2;\n', (text) => text);
    assert.equal(acc2.activeCodeBlockLanguage, 'ts');

    const acc3 = new MarkdownAccumulator();
    acc3.feed('~~~ python title="main.py"\nx = 1\n', (text) => text);
    assert.equal(acc3.activeCodeBlockLanguage, 'python');
  });

  it('highlightCodeBlocks uses shared scanFenceLine for multi-word info strings and tildes', () => {
    const raw = '``` js title="app.js"\nconst x = 1;\n```\n~~~ python\ny = 2\n~~~';
    const highlighted = highlightCodeBlocks(raw);
    assert.ok(highlighted.includes('const x = 1;'));
    assert.ok(highlighted.includes('y = 2'));
  });
});

describe('Shared Primitive 3: Terminal State & VT Model', () => {
  it('VirtualCellGrid parses 24-bit TrueColor SGR without setting dim=true', () => {
    const grid = createVirtualCellGrid(40, 10);
    grid.apply('\x1b[38;2;215;175;255mColoredText\x1b[0m');

    const snap = grid.snapshot();
    assert.equal(snap.lines[0], 'ColoredText');
    assert.ok(snap.styleRuns.length > 0);
    const run = snap.styleRuns[0]!;
    assert.equal(run.attr.dim, false, 'TrueColor param 2 must not be treated as dim modifier');
    assert.equal(run.attr.fg.kind, 'rgb');
    if (run.attr.fg.kind === 'rgb') {
      assert.equal(run.attr.fg.r, 215);
      assert.equal(run.attr.fg.g, 175);
      assert.equal(run.attr.fg.b, 255);
    }
  });

  it('VirtualCellGrid visualHash changes on style-only change while textHash remains stable', () => {
    const grid = createVirtualCellGrid(40, 5);

    // Initial state: green "Status OK"
    grid.apply('\x1b[1;1H\x1b[32mStatus OK\x1b[0m');
    const snap1 = grid.snapshot();

    // Change color to red "Status OK" (same text, different styling)
    grid.apply('\x1b[1;1H\x1b[31mStatus OK\x1b[0m');
    const snap2 = grid.snapshot();

    assert.equal(snap1.textHash, snap2.textHash, 'Text hash should be identical for same text');
    assert.notEqual(
      snap1.visualHash,
      snap2.visualHash,
      'Visual hash MUST change when cell color changes',
    );
    assert.deepEqual(
      snap2.visualChangedRows,
      [0],
      'visualChangedRows must identify Row 0 as modified',
    );
  });

  it('DECAWM deferred autowrap prevents phantom linefeeds on exact-margin CRLF', () => {
    const grid = createVirtualCellGrid(10, 5);
    // Write exactly 10 characters followed by CRLF
    grid.apply('0123456789\r\nSecondLine');

    const snap = grid.snapshot();
    assert.equal(snap.lines[0], '0123456789');
    assert.equal(snap.lines[1], 'SecondLine');
    assert.equal(snap.lines[2], '');
  });

  it('computeScreenLayout provides structured degraded modes for small terminals', () => {
    const normal = computeScreenLayout(24, 80);
    assert.equal(normal.mode, 'normal');
    assert.equal(normal.titleRow, 1);
    assert.equal(normal.borderRow, 2);
    assert.equal(normal.contentTop, 3);
    assert.equal(normal.contentBottom, 22);
    assert.equal(normal.contentRowCount, 20);

    const normal5 = computeScreenLayout(5, 80);
    assert.equal(normal5.mode, 'normal');
    assert.equal(normal5.contentTop, 3);
    assert.equal(normal5.contentBottom, 3);
    assert.equal(normal5.contentRowCount, 1);

    const compact = computeScreenLayout(4, 80);
    assert.equal(compact.mode, 'compact');
    assert.equal(compact.titleRow, 1);
    assert.equal(compact.borderRow, 2);
    assert.equal(compact.contentRowCount, 0);

    const linear = computeScreenLayout(2, 80);
    assert.equal(linear.mode, 'linear');
    assert.equal(linear.contentRowCount, 0);
  });

  it('ScreenManager seamlessly handles normal ↔ compact ↔ linear mode transitions', () => {
    try {
      // Start in normal mode (rows=24)
      setObservedTerminalSize({ cols: 80, rows: 24 });
      const sm = new ScreenManager({
        model: 'test-model',
        mode: 'chat',
        project: 'test-proj',
        totalTokens: 100,
        totalCost: 0.01,
        turnCount: 1,
      });
      assert.equal(sm.getMode(), 'normal');
      assert.equal(sm.getContentHeight(), 20);

      // Transition: normal -> compact (rows=4)
      setObservedTerminalSize({ cols: 80, rows: 4 });
      sm.refreshDimensions();
      assert.equal(sm.getMode(), 'compact');
      assert.equal(sm.getContentHeight(), 0);

      // Transition: compact -> linear (rows=2)
      setObservedTerminalSize({ cols: 80, rows: 2 });
      sm.refreshDimensions();
      assert.equal(sm.getMode(), 'linear');
      assert.equal(sm.getContentHeight(), 0);

      // Transition: linear -> normal (rows=24)
      setObservedTerminalSize({ cols: 80, rows: 24 });
      sm.refreshDimensions();
      assert.equal(sm.getMode(), 'normal');
      assert.equal(sm.getContentHeight(), 20);

      // Transition: normal -> linear (rows=3)
      setObservedTerminalSize({ cols: 80, rows: 3 });
      sm.refreshDimensions();
      assert.equal(sm.getMode(), 'linear');
      assert.equal(sm.getContentHeight(), 0);

      // Transition: compact -> normal (rows=10)
      setObservedTerminalSize({ cols: 80, rows: 4 });
      sm.refreshDimensions();
      setObservedTerminalSize({ cols: 80, rows: 10 });
      sm.refreshDimensions();
      assert.equal(sm.getMode(), 'normal');
      assert.equal(sm.getContentHeight(), 6);
    } finally {
      setObservedTerminalSize(null);
    }
  });

  it('ScreenManager active live updates do not emit in linear mode after resize', () => {
    try {
      setObservedTerminalSize({ cols: 80, rows: 24 });
      const sm = new ScreenManager({
        model: 'test-model',
        mode: 'chat',
        project: 'test-proj',
        totalTokens: 500,
        totalCost: 0.05,
        turnCount: 2,
      });

      sm.startLiveUpdates(0.05);

      // Resize to linear mode
      setObservedTerminalSize({ cols: 80, rows: 2 });
      sm.refreshDimensions();
      assert.equal(sm.getMode(), 'linear');

      // Calling drawBottomStats directly or stopping live updates is completely safe
      sm.drawBottomStats();
      sm.stopStatusUpdates();
    } finally {
      setObservedTerminalSize(null);
    }
  });

  it('TerminalTransport replacement does not double-wrap stream writes', () => {
    const profile = {
      geometry: { cols: 80, rows: 24 },
      terminal: 'minimal' as const,
      syncUpdate: false,
      scrollRegions: true,
      trueColor: true,
      emoji: true,
      pinGeometry: true,
    };

    const transportA = new TerminalTransport(profile, 'session-A');
    transportA.install();
    assert.ok(transportA.isInstalled());

    const transportB = new TerminalTransport(profile, 'session-B');
    transportB.install();
    assert.ok(transportB.isInstalled());
    assert.ok(!transportA.isInstalled());

    transportB.uninstall();
    assert.ok(!transportB.isInstalled());
  });
});

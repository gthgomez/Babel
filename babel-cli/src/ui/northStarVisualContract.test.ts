/**
 * Deterministic North Star regression coverage for the shared TUI contract.
 *
 * This suite intentionally exercises existing primitives and state helpers;
 * it does not create screenshot-only product state or assert a new renderer.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  babelDawn,
  babelDawnDaltonized,
  babelDusk,
  babelDuskDaltonized,
  babelHc,
  babelPrismNight,
  BUILTIN_THEMES,
  resolveBuiltinTheme,
} from './tokens.js';
import {
  error,
  focusedBorder,
  muted,
  stripAnsi,
  success,
  warning,
} from './theme.js';
import { Box, Text } from './primitives.js';
import { computeScreenLayout } from './screenLayout.js';
import { measureDisplayWidth, wrapPrefixedBlock } from './textLayout.js';
import { scanTerminalTokens } from './terminalSequenceScanner.js';
import { VtTestBackend } from './vtTestBackend.js';

const VIEWPORTS = [
  { cols: 80, rows: 24 },
  { cols: 100, rows: 30 },
  { cols: 120, rows: 40 },
  { cols: 160, rows: 45 },
] as const;

const semanticTrueColorRoles = [
  'canvas',
  'surface',
  'raised',
  'selected',
  'border',
  'borderFocused',
  'accent',
  'accentHigh',
  'textPrimary',
  'textMuted',
  'success',
  'warning',
  'error',
] as const;

const semanticFallbackRoles = [
  'canvas',
  'surface',
  'raised',
  'selected',
  'border',
  'borderFocused',
  'accent',
  'accentHigh',
  'textPrimary',
  'textMuted',
  'success',
  'warning',
  'error',
] as const;

function assertClosedTerminalStyles(line: string): void {
  const tokens = [...scanTerminalTokens(line)];
  let hyperlinkOpen = false;
  let foregroundOpen = false;
  let attributeOpen = false;

  for (const token of tokens) {
    if (token.type === 'osc8_open') hyperlinkOpen = true;
    if (token.type === 'osc8_close') hyperlinkOpen = false;
    if (token.type !== 'sgr') continue;

    const params = token.params ?? [];
    if (params.includes(0)) {
      foregroundOpen = false;
      attributeOpen = false;
    } else if (params.includes(39)) {
      foregroundOpen = false;
    } else if (
      params.some((param) => param >= 30 || (param >= 90 && param <= 107))
    ) {
      foregroundOpen = true;
    }
    if (params.includes(22)) attributeOpen = false;
    if (params.includes(1) || params.includes(2)) attributeOpen = true;
  }

  assert.equal(
    hyperlinkOpen,
    false,
    `OSC 8 state leaked from line: ${JSON.stringify(line)}`,
  );
  assert.equal(
    foregroundOpen,
    false,
    `foreground state leaked from line: ${JSON.stringify(line)}`,
  );
  assert.equal(
    attributeOpen,
    false,
    `text attribute leaked from line: ${JSON.stringify(line)}`,
  );
}

test('North Star dusk palette exposes centralized semantic roles', () => {
  assert.equal(babelDusk.trueColor.canvas, babelDusk.trueColor.background);
  assert.equal(babelDusk.trueColor.surface, babelDusk.trueColor.panel);
  assert.equal(babelDusk.trueColor.raised, babelDusk.trueColor.panelRaised);
  assert.equal(babelDusk.trueColor.selected, '#0A1C45');
  assert.equal(babelDusk.trueColor.borderFocused, '#2E6CFF');
  assert.equal(babelDusk.trueColor.accentHigh, '#5F8FFF');
  assert.equal(babelDusk.trueColor.success, '#43C57B');
  assert.equal(babelDusk.ansiFallback.borderFocused, 33);
  assert.equal(babelDusk.ansiFallback.accentHigh, 75);
  // Backgrounds use reverse video in degraded terminals; the neutral track
  // fallback remains a foreground token and is intentionally conservative.
  assert.equal(babelDusk.ansiFallback.meterTrack, 8);

  for (const role of semanticTrueColorRoles) {
    assert.match(babelDusk.trueColor[role] ?? '', /^#[0-9A-F]{6}$/i, role);
  }
  for (const role of semanticFallbackRoles) {
    assert.equal(typeof babelDusk.ansiFallback[role], 'number', role);
  }
});

test('all built-in alternate themes remain selectable and semantically complete', () => {
  const themes = [
    babelDusk,
    babelDawn,
    babelDuskDaltonized,
    babelDawnDaltonized,
    babelHc,
    babelPrismNight,
  ];

  for (const theme of themes) {
    assert.equal(resolveBuiltinTheme(theme.name), theme);
    assert.equal(BUILTIN_THEMES[theme.name], theme);
    assert.equal(theme.trueColor.canvas, theme.trueColor.background);
    assert.equal(theme.trueColor.surface, theme.trueColor.panel);
    assert.equal(theme.trueColor.raised, theme.trueColor.panelRaised);
    assert.ok(theme.trueColor.selected);
    assert.ok(theme.trueColor.borderFocused);
    assert.ok(theme.ansiFallback.selected !== undefined);
    assert.ok(theme.ansiFallback.borderFocused !== undefined);
  }
});

test('existing bordered surface stays frame-stable at required viewport sizes', () => {
  const content = new Text({
    content: 'Long existing content remains clipped within the frame: 你好 😀',
    style: 'primary',
  });

  for (const { cols, rows } of VIEWPORTS) {
    const frame = new Box({
      children: [content],
      border: 'single',
      borderColor: 'border',
      background: 'surface',
      focused: true,
      title: 'CHAT',
      width: cols,
      height: rows,
      // Keep the exact outer-frame contract exercised here. The existing
      // padding path has separate legacy sizing behavior.
      padding: 0,
    }).render();
    const lines = frame.split('\n');

    assert.equal(lines.length, rows, `${cols}x${rows} row drift`);
    for (const line of lines) {
      assert.equal(
        measureDisplayWidth(line),
        cols,
        `${cols}x${rows} column drift`,
      );
      assertClosedTerminalStyles(line);
    }

    const terminal = new VtTestBackend(rows, cols);
    // Feed each row with CUP so the fixture does not interpret a full-width
    // write followed by LF as an additional autowrap. The final cell is
    // already covered by the display-width assertion above; omitting it here
    // also avoids the fixture scrolling after a bottom-right write.
    frame.split('\n').forEach((line, index) => {
      terminal.write(`\x1b[${index + 1};1H${line.slice(0, -1)}`);
    });
    const screenshot = terminal.screenshotStripped();
    assert.equal(screenshot.rows, rows);
    assert.equal(screenshot.cols, cols);
    assert.equal(
      screenshot.lines.length,
      rows,
      `${cols}x${rows} screen row drift`,
    );
    assert.equal(screenshot.lines[0]!.charAt(0), '┌');
    assert.equal(screenshot.lines.at(-1)!.charAt(0), '└');
  }
});

test('long ANSI and Unicode content wraps within every required viewport width', () => {
  const body =
    'Investigate the long-running task, preserve focus, and report the result: 你好 😀 🔥 café ' +
    'without overflowing the terminal frame.';
  const styledBody = success(body);

  for (const { cols } of VIEWPORTS) {
    const lines = wrapPrefixedBlock(styledBody, {
      firstPrefix: '  > ',
      continuationPrefix: '    ',
      width: cols,
      longTokenPolicy: 'hard-wrap',
    });

    const bodyWidth = measureDisplayWidth(styledBody);
    if (bodyWidth > cols - 5) {
      assert.ok(lines.length > 1, `${cols} columns should wrap the long body`);
    }
    for (const line of lines) {
      assert.ok(
        measureDisplayWidth(line) <= cols,
        `${cols}-column line overflowed`,
      );
      assert.equal(
        line,
        line.trimEnd(),
        'wrapped lines must not drift with trailing spaces',
      );
      assertClosedTerminalStyles(line);
    }
    assert.match(stripAnsi(lines.join('\n')), /你好 😀 🔥 café/);
  }
});

test('focus and execution states remain distinguishable without relying on color', () => {
  const focused = stripAnsi(focusedBorder('focused composer'));
  const running = stripAnsi(warning('◐ running'));
  const passed = stripAnsi(success('✔ success'));
  const failed = stripAnsi(error('✖ error'));
  const metadata = stripAnsi(muted('secondary metadata'));

  assert.notEqual(focused, metadata);
  assert.notEqual(running, passed);
  assert.notEqual(passed, failed);
  assert.match(running, /running/);
  assert.match(passed, /success/);
  assert.match(failed, /error/);
});

test('screen geometry remains aligned and degrades only for constrained heights', () => {
  for (const { cols, rows } of VIEWPORTS) {
    const layout = computeScreenLayout(rows, cols);
    assert.equal(layout.mode, 'normal');
    assert.equal(layout.rows, rows);
    assert.equal(layout.cols, cols);
    assert.equal(layout.contentTop, 3);
    assert.equal(layout.contentBottom, rows - 2);
    assert.equal(layout.statsRow + 1, layout.inputRow);
    assert.equal(layout.contentRowCount, rows - 4);
  }

  assert.equal(computeScreenLayout(4, 80).mode, 'compact');
  assert.equal(computeScreenLayout(3, 80).mode, 'linear');
});

test('degraded 256-color fallback uses semantic roles and preserves reset boundaries', () => {
  const script = `
    import { accent, bgSelected, focusedBorder, stripAnsi, success } from './src/ui/theme.js';
    const rendered = [accent('accent'), focusedBorder('focus'), success('success'), bgSelected('row')].join('|');
    process.stdout.write(JSON.stringify({ rendered, plain: stripAnsi(rendered) }));
  `;
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', script],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, FORCE_COLOR: '1', NO_COLOR: '' },
      timeout: 15_000,
    },
  );

  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  const parsed = JSON.parse(result.stdout.trim()) as {
    rendered: string;
    plain: string;
  };
  assert.equal(parsed.plain, 'accent|focus|success|row');
  assert.match(parsed.rendered, /\u001B\[38;5;33maccent\u001B\[39m/);
  assert.match(parsed.rendered, /\u001B\[38;5;78m/);
  assert.match(parsed.rendered, /\u001B\[7mrow\u001B\[27m/);
  assert.doesNotMatch(parsed.rendered, /#[0-9A-F]{6}/i);
});

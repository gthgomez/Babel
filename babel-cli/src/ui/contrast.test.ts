/**
 * contrast.test.ts — WCAG contrast ratio tests for all built-in Babel themes.
 *
 * Verifies:
 *   1. Core math: relative luminance, contrast ratio, threshold checks
 *   2. babel-hc theme passes WCAG AA (4.5:1) on ALL pairs — THE GATE
 *   3. Other themes meet at least large-text AA (3:1) on primary text pairs
 *   4. Contrast ratio is order-independent
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  relativeLuminance,
  contrastRatio,
  isWcagAa,
  isWcagAaLarge,
  isWcagAaa,
  checkThemeContrast,
  formatContrastReport,
} from './contrast.js';
import {
  babelDusk,
  babelDawn,
  babelDuskDaltonized,
  babelDawnDaltonized,
  babelHc,
} from './tokens.js';

// ═══════════════════════════════════════════════════════════════════════════
// 1. Core math
// ═══════════════════════════════════════════════════════════════════════════

test('relativeLuminance: pure white = 1.0', () => {
  const l = relativeLuminance('#FFFFFF');
  assert.ok(Math.abs(l - 1.0) < 0.001, `expected ~1.0, got ${l}`);
});

test('relativeLuminance: pure black = 0.0', () => {
  const l = relativeLuminance('#000000');
  assert.ok(Math.abs(l - 0.0) < 0.001, `expected ~0.0, got ${l}`);
});

test('relativeLuminance: known mid-gray #888888', () => {
  const l = relativeLuminance('#888888');
  assert.ok(l > 0.2 && l < 0.35, `expected ~0.22-0.30, got ${l}`);
});

test('contrastRatio: white on black = 21:1', () => {
  const ratio = contrastRatio('#FFFFFF', '#000000');
  assert.ok(Math.abs(ratio - 21) < 0.1, `expected ~21, got ${ratio}`);
});

test('contrastRatio: same color = 1:1', () => {
  assert.equal(contrastRatio('#FF0000', '#FF0000'), 1);
  assert.equal(contrastRatio('#0B0A16', '#0B0A16'), 1);
});

test('contrastRatio: order invariant', () => {
  const a = contrastRatio('#000000', '#FFFFFF');
  const b = contrastRatio('#FFFFFF', '#000000');
  assert.equal(a, b);
});

test('contrastRatio: known pair — #888 on #fff', () => {
  // #888888 vs white should be around 3.5:1
  const ratio = contrastRatio('#888888', '#FFFFFF');
  assert.ok(ratio > 3.0 && ratio < 4.0, `expected ~3.5:1, got ${ratio.toFixed(2)}:1`);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Threshold helpers
// ═══════════════════════════════════════════════════════════════════════════

test('isWcagAa: 4.5 passes, 4.49 fails', () => {
  assert.equal(isWcagAa(4.5), true);
  assert.equal(isWcagAa(4.49), false);
});

test('isWcagAaLarge: 3.0 passes, 2.99 fails', () => {
  assert.equal(isWcagAaLarge(3.0), true);
  assert.equal(isWcagAaLarge(2.99), false);
});

test('isWcagAaa: 7.0 passes, 6.99 fails', () => {
  assert.equal(isWcagAaa(7.0), true);
  assert.equal(isWcagAaa(6.99), false);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Theme contrast checks
// ═══════════════════════════════════════════════════════════════════════════

test('babel-hc: ALL pairs pass WCAG AA (4.5:1)', () => {
  const results = checkThemeContrast(babelHc);
  const failures = results.filter((r) => !r.passesAa);
  assert.equal(
    failures.length,
    0,
    `babel-hc should pass AA on all pairs. Failures:\n${failures
      .map((f) => `  ${f.name}: ${f.ratio.toFixed(2)}:1`)
      .join('\n')}`,
  );
});

test('babel-hc: AAA coverage (informational — AA is the gate)', () => {
  const results = checkThemeContrast(babelHc);
  const aaaFailures = results.filter((r) => !r.passesAaa);
  // babel-hc is designed for AA, not strict AAA. Document any near-misses.
  if (aaaFailures.length > 0) {
    console.log(`\n  [info] babel-hc has ${aaaFailures.length} pairs below AAA 7:1:`);
    for (const f of aaaFailures) {
      console.log(`    ${f.name}: ${f.ratio.toFixed(2)}:1 [fg=${f.fgHex} bg=${f.bgHex}]`);
    }
  }
  // AA is the gate; AAA is aspirational
  assert.ok(aaaFailures.length <= 2, 'babel-hc should have at most 2 AAA failures');
});

test('ALL themes: textPrimary on background passes WCAG AA Large (3:1)', () => {
  const themes = [babelDusk, babelDawn, babelDuskDaltonized, babelDawnDaltonized, babelHc];
  for (const theme of themes) {
    const results = checkThemeContrast(theme);
    const textPairs = results.filter((r) => r.fgToken === 'textPrimary');
    for (const pair of textPairs) {
      assert.ok(
        pair.passesAaLarge,
        `${theme.name}: ${pair.name} = ${pair.ratio.toFixed(2)}:1 (needs ≥ 3:1)`,
      );
    }
  }
});

test('ALL themes: textPrimary on panel passes WCAG AA Large (3:1)', () => {
  const themes = [babelDusk, babelDawn, babelDuskDaltonized, babelDawnDaltonized, babelHc];
  for (const theme of themes) {
    const results = checkThemeContrast(theme);
    const panelTextPairs = results.filter(
      (r) => r.fgToken === 'textPrimary' && r.bgToken === 'panel',
    );
    for (const pair of panelTextPairs) {
      assert.ok(
        pair.passesAaLarge,
        `${theme.name}: ${pair.name} = ${pair.ratio.toFixed(2)}:1 (needs ≥ 3:1)`,
      );
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Smoke: formatContrastReport does not throw
// ═══════════════════════════════════════════════════════════════════════════

test('formatContrastReport: produces output for each theme', () => {
  for (const theme of [babelDusk, babelHc]) {
    const report = formatContrastReport(theme);
    assert.ok(report.includes(theme.name));
    assert.ok(report.includes('AA passes'));
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Document AA gaps in non-HC themes (informational, not gating)
// ═══════════════════════════════════════════════════════════════════════════

test('babel-dusk: document AA failures (informational)', () => {
  const results = checkThemeContrast(babelDusk);
  const failures = results.filter((r) => !r.passesAa);
  // This is informational — we expect some pairs to fail AA on non-HC themes.
  // Log them so they appear in test output for awareness.
  if (failures.length > 0) {
    console.log(`\n  [info] babel-dusk has ${failures.length} pairs below AA 4.5:1:`);
    for (const f of failures) {
      console.log(`    ${f.name}: ${f.ratio.toFixed(2)}:1 [fg=${f.fgHex} bg=${f.bgHex}]`);
    }
  }
  // No assertion — this test exists to surface gaps
});

test('babel-dawn: document AA failures (informational)', () => {
  const results = checkThemeContrast(babelDawn);
  const failures = results.filter((r) => !r.passesAa);
  if (failures.length > 0) {
    console.log(`\n  [info] babel-dawn has ${failures.length} pairs below AA 4.5:1:`);
    for (const f of failures) {
      console.log(`    ${f.name}: ${f.ratio.toFixed(2)}:1 [fg=${f.fgHex} bg=${f.bgHex}]`);
    }
  }
});

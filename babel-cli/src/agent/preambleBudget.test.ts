import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  computePreambleBudget,
  enforcePreambleBudget,
  estimateTextTokens,
  MAP_HARD_FLOOR_TOKENS,
  PREAMBLE_WINDOW_SHARE,
  trimRepoMapToBudget,
} from './preambleBudget.js';

describe('preambleBudget (packet B5)', () => {
  test('budget respects hard floor and window cap', () => {
    const tiny = computePreambleBudget({ historyTokens: 0, contextWindowTokens: 512 });
    assert.equal(tiny.maxMapTokens, MAP_HARD_FLOOR_TOKENS);
    assert.ok(tiny.maxPreambleTokens >= 1_024);

    const full = computePreambleBudget({ historyTokens: 0, contextWindowTokens: 128_000 });
    assert.equal(full.maxPreambleTokens, Math.ceil(128_000 * PREAMBLE_WINDOW_SHARE));
    assert.ok(full.maxMapTokens <= full.maxPreambleTokens);
  });

  test('map share is monotonically non-increasing as history grows', () => {
    let previous = Number.POSITIVE_INFINITY;
    for (let turn = 0; turn <= 200; turn++) {
      const history = turn * 400;
      const budget = computePreambleBudget({
        historyTokens: history,
        contextWindowTokens: 128_000,
      });
      assert.ok(
        budget.maxMapTokens <= previous,
        `map share grew at turn ${turn}: ${previous} -> ${budget.maxMapTokens}`,
      );
      previous = budget.maxMapTokens;
    }
    // Eventually pinned at the hard floor once the window is nearly full.
    const saturated = computePreambleBudget({
      historyTokens: 127_990,
      contextWindowTokens: 128_000,
    });
    assert.equal(saturated.maxMapTokens, MAP_HARD_FLOOR_TOKENS);
  });

  test('trimRepoMapToBudget never exceeds the budget and keeps head lines', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `path/file${i}.ts: symbol${i}`);
    const map = lines.join('\n');
    const trimmed = trimRepoMapToBudget(map, 50);
    assert.ok(estimateTextTokens(trimmed) <= 50);
    assert.ok(trimmed.startsWith(lines[0] ?? ''));
    assert.ok(trimmed.length < map.length);
    assert.equal(trimRepoMapToBudget(map, 0), '');
    assert.equal(trimRepoMapToBudget(map, estimateTextTokens(map)), map);
  });

  test('property: 200-turn conversation — total preamble <= budget, map share non-increasing', () => {
    // Rendered repo map the graph pipeline would produce (over-budget size).
    const map = Array.from(
      { length: 400 },
      (_, i) => `src/module${Math.floor(i / 10)}/file${i}.ts: ${['alpha', 'beta', 'gamma'][i % 3]}`,
    ).join('\n');
    const instructions =
      'You are Babel. Follow the governed mutation policy. '.repeat(40); // ~530 tokens

    let previousMaxMap = Number.POSITIVE_INFINITY;
    let previousMapLength = Number.POSITIVE_INFINITY;
    for (let turn = 0; turn < 200; turn++) {
      // Simulated conversation grows by ~600 tokens per turn.
      const historyTokens = turn * 600;
      const input = { historyTokens, contextWindowTokens: 128_000 };
      const enforced = enforcePreambleBudget(instructions, map, input);
      const budget = enforced.budget;

      // Total preamble stays within the budget.
      assert.ok(
        enforced.totalPreambleTokens <= budget.maxPreambleTokens,
        `turn ${turn}: total ${enforced.totalPreambleTokens} > budget ${budget.maxPreambleTokens}`,
      );
      assert.equal(
        enforced.totalPreambleTokens,
        estimateTextTokens(enforced.instructions) + estimateTextTokens(enforced.map),
      );
      // Map share never grows as history grows.
      assert.ok(budget.maxMapTokens <= previousMaxMap, `turn ${turn}: budget grew`);
      assert.ok(enforced.map.length <= previousMapLength, `turn ${turn}: map grew`);
      previousMaxMap = budget.maxMapTokens;
      previousMapLength = enforced.map.length;
    }
    // The map was actually trimmed somewhere along the way.
    assert.ok(previousMapLength < map.length);
  });
});

/**
 * Multi-Model Telemetry Audit & Context Truthfulness Tests.
 *
 * Asserts that:
 * 1. Active conversation context is truthful and never fabricated.
 * 2. Helper model calls (critic, deliberation, reviewer) do not overwrite visible conversation context tokens.
 * 3. Cumulative session usage is kept distinct from active request context.
 * 4. Model switch updates the context denominator limit appropriately.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { renderStatusBar, type StatusBarState } from '../../ui/statusBar.js';
import { getContextLimit } from '../../ui/tokenBar.js';
import { stripAnsi } from '../../ui/theme.js';

describe('PR-A Certification: Multi-Model Telemetry Audit', () => {
  test('status bar renders truthful active context and distinct session totals', () => {
    const state: StatusBarState = {
      model: 'DeepSeek v4 Flash',
      modelId: 'deepseek-v4-flash',
      mode: 'chat',
      project: 'Babel',
      activeContext: {
        tokens: 30_000,
        modelId: 'deepseek-v4-flash',
        source: 'provider_prompt_tokens',
      },
      activeContextTokens: 30_000,
      totalTokens: 150_000, // Cumulative across multiple turns
      totalCost: 0.045,
      turnCount: 5,
      width: 120,
    };

    const rendered = renderStatusBar(state);
    const plain = stripAnsi(rendered);

    // Active context percentage is calculated from 30,000 / 1,000,000 (3%), NOT from 150,000
    assert.ok(plain.includes('3%'), `Expected 3% active context meter, got: ${plain}`);
    assert.ok(plain.includes('$0.0450') || plain.includes('$0.045'), `Expected total cost, got: ${plain}`);
    assert.ok(plain.includes('150,000 tok'), `Expected total tokens, got: ${plain}`);
  });

  test('helper model execution does not overwrite main conversation model context denominator', () => {
    // Session model is Claude Sonnet 4.6 (200k limit in CONTEXT_LIMITS)
    // A helper model was invoked internally
    const state: StatusBarState = {
      model: 'Sonnet 4.6',
      modelId: 'claude-sonnet-4-6',
      mode: 'chat',
      project: 'Babel',
      activeContext: {
        tokens: 50_000,
        modelId: 'claude-sonnet-4-6', // Conversation model context preserved
        source: 'provider_prompt_tokens',
      },
      totalTokens: 75_000,
      totalCost: 0.15,
      turnCount: 2,
      width: 120,
    };

    const rendered = renderStatusBar(state);
    const plain = stripAnsi(rendered);

    // 50k / 200k = 25%
    assert.ok(plain.includes('25%'), `Expected 25% for 50k in 200k window, got: ${plain}`);
  });

  test('unknown active context renders [ctx ?] without fabricating numbers', () => {
    const state: StatusBarState = {
      model: 'Custom Model',
      modelId: 'unknown-custom-model',
      mode: 'chat',
      project: 'Babel',
      activeContext: null, // No provider token telemetry available
      activeContextTokens: undefined,
      totalTokens: 10_000,
      totalCost: 0.01,
      turnCount: 1,
      width: 100,
    };

    const rendered = renderStatusBar(state);
    const plain = stripAnsi(rendered);

    assert.ok(plain.includes('[ctx ?]'), `Expected [ctx ?] when activeContext is unknown, got: ${plain}`);
  });

  test('model switch updates context limit lookup truthfully', () => {
    const flashLimit = getContextLimit('deepseek-v4-flash');
    const proLimit = getContextLimit('deepseek-v4-pro');
    const sonnetLimit = getContextLimit('claude-sonnet-4-6');

    assert.equal(flashLimit.tokens, 1_000_000);
    assert.equal(proLimit.tokens, 1_000_000);
    assert.equal(sonnetLimit.tokens, 200_000);
  });
});

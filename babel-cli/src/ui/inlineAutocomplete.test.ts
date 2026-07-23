/**
 * inlineAutocomplete.test.ts — Tests for the ghost-text inline completion engine.
 *
 * Covers constructor defaults, history-based suggestions (single/multiple/absent),
 * accept/dismiss lifecycle, state queries, cache management, and AI provider
 * integration.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InlineAutocomplete } from './inlineAutocomplete.js';
import type { InlineCompletion } from './inlineAutocomplete.js';

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Constructor defaults
// ═══════════════════════════════════════════════════════════════════════════════

describe('InlineAutocomplete constructor', () => {
  it('initializes with default values when no config provided', () => {
    const ac = new InlineAutocomplete();
    assert.equal(ac.hasSuggestion(), false);
    assert.equal(ac.getGhostText(), null);
    assert.equal(ac.accept(), null);
  });

  it('accepts custom config values', () => {
    let called = false;
    const ac = new InlineAutocomplete({
      maxCacheSize: 10,
      debounceMs: 300,
      aiProvider: async () => {
        called = true;
        return null;
      },
    });
    assert.equal(ac.hasSuggestion(), false);
    // Config is applied; we verify the AI provider is registered by calling suggest
    ac.suggest('x', 'x', 1);
    assert.equal(called, false, 'AI provider not called immediately (debounced)');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. suggest() — basic behavior
// ═══════════════════════════════════════════════════════════════════════════════

describe('suggest()', () => {
  it('returns null with empty history and no AI provider', () => {
    const ac = new InlineAutocomplete();
    const result = ac.suggest('hello', 'hello world', 5);
    assert.equal(result, null);
    assert.equal(ac.hasSuggestion(), false);
  });

  it('returns null for empty prefix', () => {
    const ac = new InlineAutocomplete();
    ac.addHistoryEntry('deploy.sh --prod');
    const result = ac.suggest('', '', 0);
    assert.equal(result, null);
    assert.equal(ac.hasSuggestion(), false);
  });

  it('returns history-based completion when prefix matches', () => {
    const ac = new InlineAutocomplete();
    ac.addHistoryEntry('deploy.sh --prod');
    ac.addHistoryEntry('deploy.sh --staging');
    ac.addHistoryEntry('npm test');

    const result = ac.suggest('deploy', 'deploy', 6);
    assert.notEqual(result, null);
    assert.ok(result!.text.startsWith('deploy'));
    assert.equal(result!.prefix, 'deploy');
    assert.equal(result!.source, 'history');
    assert.equal(ac.hasSuggestion(), true);
  });

  it('returns most frequent match for ambiguous prefix', () => {
    const ac = new InlineAutocomplete();
    // "deploy.sh --prod" appears 3 times, "deploy.sh --staging" appears 2 times
    ac.addHistoryEntry('deploy.sh --staging');
    ac.addHistoryEntry('deploy.sh --prod');
    ac.addHistoryEntry('deploy.sh --prod');
    ac.addHistoryEntry('deploy.sh --staging');
    ac.addHistoryEntry('deploy.sh --prod');

    const result = ac.suggest('deploy', 'deploy', 6);
    assert.notEqual(result, null);
    assert.equal(result!.text, 'deploy.sh --prod');
    assert.equal(result!.source, 'history');
  });

  it('returns null for no matches', () => {
    const ac = new InlineAutocomplete();
    ac.addHistoryEntry('deploy.sh --prod');
    ac.addHistoryEntry('npm test');

    const result = ac.suggest('git', 'git', 3);
    assert.equal(result, null);
    assert.equal(ac.hasSuggestion(), false);
  });

  it('does not match prefix against the same-line prefix itself', () => {
    // When the only matching entry is the prefix string itself (same length),
    // there is nothing to suggest, so return null.
    const ac = new InlineAutocomplete();
    ac.addHistoryEntry('hello');
    // 'hello' starts with 'hello' but is not longer — no suggestion
    const result = ac.suggest('hello', 'hello', 5);
    assert.equal(result, null);
  });

  it('ignores empty history entries', () => {
    const ac = new InlineAutocomplete();
    ac.addHistoryEntry('');
    ac.addHistoryEntry('  ');
    const result = ac.suggest('test', 'test', 4);
    assert.equal(result, null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. accept()
// ═══════════════════════════════════════════════════════════════════════════════

describe('accept()', () => {
  it('returns the suffix to insert and clears state', () => {
    const ac = new InlineAutocomplete();
    ac.addHistoryEntry('deploy.sh --prod');
    ac.suggest('deploy', 'deploy', 6);

    const suffix = ac.accept();
    assert.equal(suffix, '.sh --prod');
    assert.equal(ac.hasSuggestion(), false);
    assert.equal(ac.getGhostText(), null);
  });

  it('returns null when no suggestion is active', () => {
    const ac = new InlineAutocomplete();
    assert.equal(ac.accept(), null);
  });

  it('returns null after suggestion was already consumed', () => {
    const ac = new InlineAutocomplete();
    ac.addHistoryEntry('deploy.sh --prod');
    ac.suggest('deploy', 'deploy', 6);
    ac.accept(); // first call consumes
    assert.equal(ac.accept(), null); // second call returns null
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. dismiss()
// ═══════════════════════════════════════════════════════════════════════════════

describe('dismiss()', () => {
  it('clears the current suggestion', () => {
    const ac = new InlineAutocomplete();
    ac.addHistoryEntry('deploy.sh --prod');
    ac.suggest('deploy', 'deploy', 6);
    assert.equal(ac.hasSuggestion(), true);

    ac.dismiss();
    assert.equal(ac.hasSuggestion(), false);
    assert.equal(ac.getGhostText(), null);
  });

  it('is safe to call when no suggestion is active', () => {
    const ac = new InlineAutocomplete();
    assert.doesNotThrow(() => ac.dismiss());
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. hasSuggestion() / getGhostText() state tracking
// ═══════════════════════════════════════════════════════════════════════════════

describe('hasSuggestion() and getGhostText()', () => {
  it('tracks suggestion lifecycle across suggest/accept/dismiss', () => {
    const ac = new InlineAutocomplete();
    ac.addHistoryEntry('deploy.sh --prod');

    // Before any suggestion
    assert.equal(ac.hasSuggestion(), false);
    assert.equal(ac.getGhostText(), null);

    // After suggest
    ac.suggest('deploy', 'deploy', 6);
    assert.equal(ac.hasSuggestion(), true);
    assert.equal(ac.getGhostText(), '.sh --prod');

    // After dismiss
    ac.dismiss();
    assert.equal(ac.hasSuggestion(), false);
    assert.equal(ac.getGhostText(), null);

    // Re-suggest
    ac.suggest('deploy', 'deploy', 6);
    assert.equal(ac.hasSuggestion(), true);

    // After accept
    ac.accept();
    assert.equal(ac.hasSuggestion(), false);
    assert.equal(ac.getGhostText(), null);
  });

  it('getGhostText() returns full text when it does not start with prefix (fallback)', () => {
    // Edge case: if the completion text doesn't actually start with the prefix
    // (shouldn't happen in normal operation), return the full text.
    const ac = new InlineAutocomplete();
    // Simulate an AI result that diverges from prefix
    const acAny = ac as unknown as { currentSuggestion: InlineCompletion | null };
    acAny.currentSuggestion = {
      text: 'completely-different',
      prefix: 'deploy',
      source: 'ai',
    };
    const ghost = ac.getGhostText();
    assert.equal(ghost, 'completely-different');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. addHistoryEntry()
// ═══════════════════════════════════════════════════════════════════════════════

describe('addHistoryEntry()', () => {
  it('adds entries to the suggestion pool', () => {
    const ac = new InlineAutocomplete();
    ac.addHistoryEntry('npm test');
    ac.addHistoryEntry('git push');

    const result = ac.suggest('npm', 'npm', 3);
    assert.notEqual(result, null);
    assert.equal(result!.text, 'npm test');
  });

  it('accumulates duplicate entries for frequency counting', () => {
    const ac = new InlineAutocomplete();
    ac.addHistoryEntry('npm test');
    ac.addHistoryEntry('git push');
    ac.addHistoryEntry('npm test'); // duplicate — accumulates for higher frequency
    ac.addHistoryEntry('deploy.sh --prod');

    // "npm test" appears twice, so it beats "npm run" (zero) and wins
    const result = ac.suggest('npm', 'npm', 3);
    assert.notEqual(result, null);
    assert.equal(result!.text, 'npm test');
  });

  it('does not add whitespace-only entries', () => {
    const ac = new InlineAutocomplete();
    ac.addHistoryEntry('');
    ac.addHistoryEntry('  ');
    ac.addHistoryEntry('valid entry');

    // Only the valid entry should be in history
    const result = ac.suggest('valid', 'valid', 5);
    assert.notEqual(result, null);
    assert.equal(result!.text, 'valid entry');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. clearCache()
// ═══════════════════════════════════════════════════════════════════════════════

describe('clearCache()', () => {
  it('resets the suggestion cache', () => {
    const ac = new InlineAutocomplete();
    // Add a history entry and get a suggestion (which may be cached)
    ac.addHistoryEntry('deploy.sh --prod');
    ac.suggest('deploy', 'deploy', 6);
    assert.equal(ac.hasSuggestion(), true);

    ac.clearCache();
    // Cache is cleared; current suggestion is unaffected
    // (currentSuggestion is separate from cache)
    assert.equal(ac.hasSuggestion(), true);
  });

  it('does not affect history entries', () => {
    const ac = new InlineAutocomplete();
    ac.addHistoryEntry('deploy.sh --prod');
    ac.clearCache();

    // History should still be available for suggestions
    const result = ac.suggest('deploy', 'deploy', 6);
    assert.notEqual(result, null);
    assert.equal(result!.text, 'deploy.sh --prod');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. Multiple suggestions — ambiguity handling
// ═══════════════════════════════════════════════════════════════════════════════

describe('Multiple suggestions for same prefix', () => {
  it('selects most frequent match', () => {
    const ac = new InlineAutocomplete();
    ac.addHistoryEntry('npm run build');
    ac.addHistoryEntry('npm run test');
    ac.addHistoryEntry('npm run build'); // appears twice
    ac.addHistoryEntry('npm run lint');

    const result = ac.suggest('npm', 'npm', 3);
    assert.notEqual(result, null);
    assert.equal(result!.text, 'npm run build');
    assert.equal(result!.source, 'history');
  });

  it('uses most recent as tiebreaker when frequencies are equal', () => {
    const ac = new InlineAutocomplete();
    ac.addHistoryEntry('npm run build');
    ac.addHistoryEntry('npm run test');
    ac.addHistoryEntry('npm run build');
    ac.addHistoryEntry('npm run test');
    ac.addHistoryEntry('npm run lint');
    ac.addHistoryEntry('npm run test'); // test appears 3x, build 2x — test wins
    ac.addHistoryEntry('npm run build'); // now build also 3x, but test is more recent

    const result = ac.suggest('npm', 'npm', 3);
    assert.notEqual(result, null);
    assert.equal(result!.text, 'npm run build'); // build was added last (most recent)
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. AI provider integration
// ═══════════════════════════════════════════════════════════════════════════════

describe('AI provider integration', () => {
  it('calls the registered provider after debounce', async () => {
    const calls: Array<{ prefix: string; context: string }> = [];
    const ac = new InlineAutocomplete({
      debounceMs: 5,
      aiProvider: async (prefix, context) => {
        calls.push({ prefix, context });
        return prefix + '-ai-result';
      },
    });

    ac.suggest('hello', 'hello world', 5);

    // Wait for debounce + AI completion
    await new Promise<void>((r) => setTimeout(r, 50));

    // Provider should have been called
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.prefix, 'hello');
    assert.equal(calls[0]!.context, 'hello world');
  });

  it('caches AI result and promotes it on next suggest()', async () => {
    const ac = new InlineAutocomplete({
      debounceMs: 5,
      aiProvider: async (prefix) => prefix + '-ai-result',
    });

    // First suggest — gets history null, triggers AI debounce
    assert.equal(ac.suggest('hello', 'hello world', 5), null);

    // Wait for AI to complete
    await new Promise<void>((r) => setTimeout(r, 50));

    // Second suggest with same prefix should find cached AI result
    const result = ac.suggest('hello', 'hello world', 5);
    assert.notEqual(result, null);
    assert.equal(result!.text, 'hello-ai-result');
    assert.equal(result!.source, 'ai');
    assert.equal(result!.prefix, 'hello');
  });

  it('AI result overrides history suggestion for same prefix', async () => {
    const ac = new InlineAutocomplete({
      debounceMs: 5,
      aiProvider: async (prefix) => prefix + '-ai-better',
    });

    ac.addHistoryEntry('hello world');

    // First suggest gets history match
    let result = ac.suggest('hello', 'hello world', 5);
    assert.notEqual(result, null);
    assert.equal(result!.text, 'hello world');
    assert.equal(result!.source, 'history');

    // Wait for AI to complete
    await new Promise<void>((r) => setTimeout(r, 50));

    // Second suggest should get the (now cached) AI result, overriding history
    result = ac.suggest('hello', 'hello world', 5);
    assert.notEqual(result, null);
    assert.equal(result!.text, 'hello-ai-better');
    assert.equal(result!.source, 'ai');
  });

  it('does not call AI provider when none is configured', async () => {
    const ac = new InlineAutocomplete();
    ac.addHistoryEntry('hello world');

    const result = ac.suggest('hello', 'hello world', 5);
    assert.notEqual(result, null);
    assert.equal(result!.source, 'history');

    // No AI provider, so no additional calls — clean
    assert.equal(ac.hasSuggestion(), true);
  });

  it('survives AI provider throwing an error', async () => {
    const ac = new InlineAutocomplete({
      debounceMs: 5,
      aiProvider: async () => {
        throw new Error('AI unavailable');
      },
    });

    ac.addHistoryEntry('fallback text');

    // suggest should still return the history match without crashing
    const result = ac.suggest('fallback', 'fallback text', 8);
    assert.notEqual(result, null);
    assert.equal(result!.text, 'fallback text');
    assert.equal(result!.source, 'history');

    // Wait for AI to fail
    await new Promise<void>((r) => setTimeout(r, 50));

    // State should remain consistent
    assert.equal(ac.hasSuggestion(), true);
  });

  it('debounce cancels previous pending AI request on rapid typing', async () => {
    let callCount = 0;
    const ac = new InlineAutocomplete({
      debounceMs: 20,
      aiProvider: async () => {
        callCount++;
        return 'result';
      },
    });

    // Rapid typing — only the last prefix should trigger an AI call
    ac.suggest('a', 'a', 1);
    ac.suggest('ab', 'ab', 2);
    ac.suggest('abc', 'abc', 3);

    // Wait for debounce to settle
    await new Promise<void>((r) => setTimeout(r, 60));

    // Should have called the provider once (for "abc")
    assert.equal(callCount, 1);
  });
});

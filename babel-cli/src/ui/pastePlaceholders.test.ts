import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PastePlaceholderStore,
  LARGE_PASTE_CHAR_THRESHOLD,
  expandPastePlaceholders,
  formatPastePlaceholder,
  nextLargePastePlaceholder,
  normalizePasteText,
} from './pastePlaceholders.js';

describe('pastePlaceholders', () => {
  it('normalizes CRLF pastes', () => {
    assert.equal(normalizePasteText('a\r\nb\r'), 'a\nb\n');
  });

  it('nextLargePastePlaceholder dedupes suffixes', () => {
    const base = formatPastePlaceholder(1200);
    assert.equal(nextLargePastePlaceholder(1200, []), base);
    assert.equal(nextLargePastePlaceholder(1200, [base]), `${base} #2`);
    assert.equal(
      nextLargePastePlaceholder(1200, [base, `${base} #2`]),
      `${base} #3`,
    );
  });

  it('integratePaste collapses large pastes only', () => {
    const store = new PastePlaceholderStore();
    const small = store.integratePaste('short', '');
    assert.equal(small.collapsed, false);
    assert.equal(small.insertText, 'short');

    const largeText = 'x'.repeat(LARGE_PASTE_CHAR_THRESHOLD + 1);
    const large = store.integratePaste(largeText, '');
    assert.equal(large.collapsed, true);
    assert.ok(large.insertText.startsWith('[Pasted Content'));
    assert.equal(store.getPending().length, 1);
    assert.equal(store.getPending()[0]!.content, largeText);
  });

  it('expand replaces placeholders with stored content', () => {
    const placeholder = formatPastePlaceholder(50);
    const content = 'line1\nline2';
    const expanded = expandPastePlaceholders(`before ${placeholder} after`, [
      { placeholder, content },
    ]);
    assert.equal(expanded, `before ${content} after`);
  });

  it('syncWithBuffer prunes deleted placeholders', () => {
    const store = new PastePlaceholderStore();
    const ph = formatPastePlaceholder(2000);
    store.restoreFromPairs([[ph, 'body']]);
    store.syncWithBuffer('no placeholder here');
    assert.equal(store.getPending().length, 0);
  });

  it('toPairs round-trips through restoreFromPairs', () => {
    const store = new PastePlaceholderStore();
    const ph = formatPastePlaceholder(1500);
    store.restoreFromPairs([[ph, 'payload']]);
    const store2 = new PastePlaceholderStore();
    store2.restoreFromPairs(store.toPairs());
    assert.deepEqual(store2.getPending(), store.getPending());
  });
});
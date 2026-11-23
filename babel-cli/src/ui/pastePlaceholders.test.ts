import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PastePlaceholderStore,
  LARGE_PASTE_CHAR_THRESHOLD,
  expandPastePlaceholders,
  formatPastePlaceholder,
  nextLargePastePlaceholder,
  normalizePasteText,
  PASTE_PLACEHOLDER_PATTERN,
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
    const pasteToken = formatPastePlaceholder(50);
    const content = 'line1\nline2';
    const expanded = expandPastePlaceholders(`before ${pasteToken} after`, [
      { pasteToken, content },
    ]);
    assert.equal(expanded, `before ${content} after`);
  });

  it('expands duplicate-length paste tokens without consuming a longer owned token', () => {
    const store = new PastePlaceholderStore();
    const firstContent = 'A'.repeat(1232);
    const secondContent = 'B'.repeat(1232);
    const first = store.integratePaste(firstContent, '');
    const second = store.integratePaste(secondContent, first.insertText);

    assert.equal(
      expandPastePlaceholders(first.insertText + second.insertText, store.getPending()),
      firstContent + secondContent,
    );
  });

  it('expands only the editor-owned occurrence when a literal label collides', () => {
    const store = new PastePlaceholderStore();
    const content = 'A'.repeat(1001);
    const paste = store.integratePaste(content, '');
    store.trackOwnedPlaceholder(paste.insertText, 0);

    assert.equal(store.expand(`${paste.insertText}${paste.insertText}`), `${content}${paste.insertText}`);
  });

  it('does not rescan expanded content and recognizes the suffix outside the label bracket', () => {
    const store = new PastePlaceholderStore();
    const secondToken = formatPastePlaceholder(1200);
    const firstContent = `${secondToken}${'a'.repeat(1201 - secondToken.length)}`;
    const secondContent = 'b'.repeat(1200);
    const first = store.integratePaste(firstContent, '');
    const second = store.integratePaste(secondContent, first.insertText);
    const raw = first.insertText + second.insertText;

    assert.equal(
      expandPastePlaceholders(raw, store.getPending()),
      firstContent + secondContent,
    );

    const labels = [...`${secondToken} #2 [Pasted Content 999 chars]`.matchAll(PASTE_PLACEHOLDER_PATTERN)]
      .map((match) => match[0]);
    assert.deepEqual(labels, [`${secondToken} #2`, '[Pasted Content 999 chars]']);
    assert.equal(expandPastePlaceholders('[Pasted Content 999 chars]', []), '[Pasted Content 999 chars]');
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

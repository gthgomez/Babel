import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ComposerHistory } from './composerHistory.js';

describe('ComposerHistory', () => {
  it('loads persistent entries and records session submissions separately', () => {
    const history = new ComposerHistory();
    history.setPersistentEntries(['alpha', 'beta']);
    assert.equal(history.totalEntries(), 2);
    assert.deepEqual(history.getPersistentTexts(), ['alpha', 'beta']);
    assert.equal(history.getSessionTexts().length, 0);

    history.recordSessionSubmission('gamma');
    assert.equal(history.totalEntries(), 3);
    assert.deepEqual(history.getSessionTexts(), ['gamma']);
    assert.deepEqual(history.getPersistentTexts(), ['alpha', 'beta']);
  });

  it('navigateOlder walks newest to oldest across layers', () => {
    const history = new ComposerHistory();
    history.setPersistentEntries(['old']);
    history.recordSessionSubmission('new');

    assert.deepEqual(history.navigateOlder()?.text, 'new');
    assert.deepEqual(history.navigateOlder()?.text, 'old');
    assert.equal(history.navigateOlder(), null);
  });

  it('navigateNewer returns past_newest past the newest entry', () => {
    const history = new ComposerHistory();
    history.setPersistentEntries(['only']);
    history.navigateOlder();
    assert.equal(history.navigateNewer(), 'past_newest');
    assert.equal(history.isBrowsing(), false);
  });

  it('skips persistent duplicates already present in session', () => {
    const history = new ComposerHistory();
    history.setPersistentEntries(['dup', 'older']);
    history.recordSessionSubmission('dup');

    assert.deepEqual(history.navigateOlder()?.text, 'dup');
    assert.deepEqual(history.navigateOlder()?.text, 'older');
    assert.equal(history.navigateOlder(), null);
  });

  it('shouldHandleNavigation requires boundary cursor for recalled text', () => {
    const history = new ComposerHistory();
    history.setPersistentEntries(['hello']);
    history.navigateOlder();

    assert.equal(history.shouldHandleNavigation('', 0), true);
    assert.equal(history.shouldHandleNavigation('hello', 0), true);
    assert.equal(history.shouldHandleNavigation('hello', 5), true);
    assert.equal(history.shouldHandleNavigation('hello', 2), false);
    assert.equal(history.shouldHandleNavigation('other', 0), false);
  });

  it('dedupes adjacent session submissions', () => {
    const history = new ComposerHistory();
    history.recordSessionSubmission('same');
    assert.equal(history.recordSessionSubmission('same'), false);
    assert.equal(history.getSessionTexts().length, 1);
  });

  it('getAllTexts dedupes persistent and session overlap', () => {
    const history = new ComposerHistory();
    history.setPersistentEntries(['a', 'b']);
    history.recordSessionSubmission('b');
    history.recordSessionSubmission('c');
    assert.deepEqual(history.getAllTexts(), ['a', 'b', 'c']);
  });

  it('resetNavigation clears browsing state', () => {
    const history = new ComposerHistory();
    history.setPersistentEntries(['x']);
    history.navigateOlder();
    assert.equal(history.isBrowsing(), true);
    history.resetNavigation();
    assert.equal(history.isBrowsing(), false);
    assert.equal(history.getLastRecalledText(), null);
  });
});
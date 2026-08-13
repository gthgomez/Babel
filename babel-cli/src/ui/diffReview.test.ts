import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  getLastReviewDiff,
  openDiffReview,
  rememberReviewDiff,
  resetReviewDiffForTests,
} from './diffReview.js';

describe('diff review roundtrip', () => {
  it('restores composer text exactly after opening and closing the diff', async () => {
    resetReviewDiffForTests();
    let draft = 'follow-up: also rename the helper';
    const shown: string[] = [];
    const result = await openDiffReview({
      getDiff: () => 'diff --git a/src/foo.ts b/src/foo.ts\n+ok',
      getComposerDraft: () => draft,
      setComposerDraft: (text) => {
        draft = text;
      },
      showPager: async (content) => {
        shown.push(content);
        draft = 'pager must not keep this';
      },
    });
    assert.equal(result.restoredDraft, 'follow-up: also rename the helper');
    assert.equal(draft, 'follow-up: also rename the helper');
    assert.match(shown[0] ?? '', /src\/foo\.ts/);
  });

  it('remembers last review files for /diff', () => {
    rememberReviewDiff({ files: ['a.ts', 'b.ts'], draft: 'x', cwd: '/repo' });
    const last = getLastReviewDiff();
    assert.deepEqual(last.files, ['a.ts', 'b.ts']);
    assert.equal(last.cwd, '/repo');
  });
});

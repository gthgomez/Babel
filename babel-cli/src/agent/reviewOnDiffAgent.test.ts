/**
 * W2.3 tests — review-on-diff agent (diff only, no repo explore).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  extractPathsFromUnifiedDiff,
  formatReviewOnDiffMarkdown,
  reviewDiffHeuristically,
  runReviewOnDiffAgent,
} from './reviewOnDiffAgent.js';

const samplePatch = `diff --git a/src/parser.ts b/src/parser.ts
--- a/src/parser.ts
+++ b/src/parser.ts
@@ -1,3 +1,4 @@
 export function parse(s: string) {
+  console.log('debug');
   return s.length;
 }
`;

describe('extractPathsFromUnifiedDiff', () => {
  it('extracts +++ b/ paths', () => {
    const paths = extractPathsFromUnifiedDiff(samplePatch);
    assert.deepEqual(paths, ['src/parser.ts']);
  });
});

describe('reviewDiffHeuristically', () => {
  it('flags write_scope violations', () => {
    const comments = reviewDiffHeuristically({
      task: 'fix parser',
      patch: samplePatch,
      changedFiles: ['src/parser.ts', 'README.md'],
      writeScope: ['src'],
    });
    assert.ok(comments.some((c) => c.category === 'scope' && c.path === 'README.md'));
  });

  it('flags possible secrets', () => {
    const comments = reviewDiffHeuristically({
      task: 'add config',
      patch: '+++ b/cfg.ts\n+const api_key = "sk-abcdefghijklmnopqrstuvwxyz1234"\n',
      changedFiles: ['cfg.ts'],
    });
    assert.ok(comments.some((c) => c.category === 'risk' && c.severity === 'error'));
  });

  it('flags missing tests when task asks for tests', () => {
    const comments = reviewDiffHeuristically({
      task: 'Fix bug and add unit test',
      patch: samplePatch,
      changedFiles: ['src/parser.ts'],
    });
    assert.ok(comments.some((c) => c.category === 'test'));
  });
});

describe('runReviewOnDiffAgent', () => {
  it('returns read-only result with write_count 0', () => {
    const result = runReviewOnDiffAgent({
      task: 'Fix parser off-by-one',
      patch: samplePatch,
      writeScope: ['src'],
      agentId: 'rev-1',
      now: new Date('2026-07-15T16:00:00.000Z'),
    });
    assert.equal(result.success, true);
    assert.equal(result.write_count, 0);
    assert.equal(result.readOnly, true);
    assert.ok(result.changedFiles.includes('src/parser.ts'));
    assert.ok(result.comments.length >= 1);
    assert.ok(['approve', 'comment', 'request_changes'].includes(result.verdict));
  });

  it('request_changes when empty catch or not-implemented', () => {
    const result = runReviewOnDiffAgent({
      task: 'implement feature',
      patch: `+++ b/src/a.ts\n@@ -1,1 +1,3 @@\n+export function f() {\n+  throw new Error('not implemented');\n+}\n`,
    });
    assert.equal(result.verdict, 'request_changes');
  });

  it('rejects empty task', () => {
    const result = runReviewOnDiffAgent({ task: '', patch: samplePatch });
    assert.equal(result.success, false);
  });

  it('formatReviewOnDiffMarkdown includes verdict', () => {
    const result = runReviewOnDiffAgent({
      task: 't',
      patch: samplePatch,
    });
    const md = formatReviewOnDiffMarkdown(result);
    assert.ok(md.includes('Review-on-diff'));
    assert.ok(md.includes(result.verdict));
  });
});

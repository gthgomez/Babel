import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MentionPopup, type MentionResult } from './mentionPopup.js';

// ─── Factory helpers ────────────────────────────────────────────────────────

function makeResult(overrides: Partial<MentionResult> & { label: string }): MentionResult {
  return {
    type: 'file',
    description: '',
    insertText: overrides.label,
    score: 0,
    ...overrides,
  };
}

// ─── MentionPopup Tests ─────────────────────────────────────────────────────

describe('MentionPopup', () => {
  // ── Initial state ───────────────────────────────────────────────────────

  it('starts empty with no selection', () => {
    const popup = new MentionPopup();
    assert.equal(popup.hasResults(), false);
    assert.equal(popup.getSelected(), null);
    assert.equal(popup.getSelectionIndex(), 0);
    assert.deepEqual(popup.getVisibleResults(), []);
  });

  it('respects custom maxVisible', () => {
    const popup = new MentionPopup({ maxVisible: 3 });
    // Populate with 5 results
    popup.setResults([
      makeResult({ label: 'a', score: 5 }),
      makeResult({ label: 'b', score: 4 }),
      makeResult({ label: 'c', score: 3 }),
      makeResult({ label: 'd', score: 2 }),
      makeResult({ label: 'e', score: 1 }),
    ]);

    assert.equal(popup.hasResults(), true);
    const visible = popup.getVisibleResults();
    assert.equal(visible.length, 3);
    assert.equal(visible[0]!.label, 'a');
  });

  // ── setResults sorts by score ──────────────────────────────────────────

  it('sorts results by score descending on setResults', () => {
    const popup = new MentionPopup();
    popup.setResults([
      makeResult({ label: 'low', score: 1 }),
      makeResult({ label: 'high', score: 10 }),
      makeResult({ label: 'mid', score: 5 }),
    ]);

    // Fetch all by navigating
    assert.equal(popup.getSelected()!.label, 'high');
    popup.moveSelection(1);
    assert.equal(popup.getSelected()!.label, 'mid');
    popup.moveSelection(1);
    assert.equal(popup.getSelected()!.label, 'low');
  });

  it('setResults orders by descending score even when input is already sorted', () => {
    const popup = new MentionPopup();
    popup.setResults([
      makeResult({ label: 'z', score: 3 }),
      makeResult({ label: 'a', score: 10 }),
      makeResult({ label: 'm', score: 7 }),
    ]);

    assert.equal(popup.getSelected()!.label, 'a');
    assert.equal(popup.getSelected()!.score, 10);

    popup.moveSelection(1);
    assert.equal(popup.getSelected()!.label, 'm');
    assert.equal(popup.getSelected()!.score, 7);

    popup.moveSelection(1);
    assert.equal(popup.getSelected()!.label, 'z');
    assert.equal(popup.getSelected()!.score, 3);
  });

  // ── moveSelection wraps at boundaries ──────────────────────────────────

  it('moveSelection wraps from first to last when going up', () => {
    const popup = new MentionPopup();
    popup.setResults([
      makeResult({ label: 'first', score: 3 }),
      makeResult({ label: 'second', score: 2 }),
      makeResult({ label: 'third', score: 1 }),
    ]);

    // Move up from first (index 0) — should wrap to last (index 2)
    popup.moveSelection(-1);
    assert.equal(popup.getSelected()!.label, 'third');
  });

  it('moveSelection wraps from last to first when going down', () => {
    const popup = new MentionPopup();
    popup.setResults([
      makeResult({ label: 'first', score: 3 }),
      makeResult({ label: 'second', score: 2 }),
      makeResult({ label: 'third', score: 1 }),
    ]);

    // Navigate to last
    popup.moveSelection(1); // first → second
    popup.moveSelection(1); // second → third
    // Should wrap to first
    popup.moveSelection(1); // third → first
    assert.equal(popup.getSelected()!.label, 'first');
  });

  it('moveSelection does nothing when there are no results', () => {
    const popup = new MentionPopup();
    popup.moveSelection(1);
    assert.equal(popup.getSelected(), null);
    assert.equal(popup.hasResults(), false);
  });

  // ── getSelected returns correct item ───────────────────────────────────

  it('getSelected returns the item at the current selection', () => {
    const popup = new MentionPopup();
    popup.setResults([
      makeResult({ label: 'src/main.ts', score: 10 }),
      makeResult({ label: 'src/utils.ts', score: 8 }),
    ]);

    const selected = popup.getSelected();
    assert.notEqual(selected, null);
    assert.equal(selected!.label, 'src/main.ts');
    assert.equal(selected!.score, 10);
    assert.equal(selected!.type, 'file');
  });

  it('getSelected tracks the selection after navigation', () => {
    const popup = new MentionPopup();
    popup.setResults([
      makeResult({ label: 'first', score: 3 }),
      makeResult({ label: 'second', score: 2 }),
      makeResult({ label: 'third', score: 1 }),
    ]);

    popup.moveSelection(1);
    assert.equal(popup.getSelected()!.label, 'second');

    popup.moveSelection(-1);
    assert.equal(popup.getSelected()!.label, 'first');
  });

  // ── reset clears everything ────────────────────────────────────────────

  it('reset clears results and selection', () => {
    const popup = new MentionPopup();
    popup.setResults([makeResult({ label: 'a', score: 1 }), makeResult({ label: 'b', score: 2 })]);
    assert.equal(popup.hasResults(), true);

    popup.reset();
    assert.equal(popup.hasResults(), false);
    assert.equal(popup.getSelected(), null);
    assert.equal(popup.getSelectionIndex(), 0);
    assert.deepEqual(popup.getVisibleResults(), []);
  });

  // ── Empty results ──────────────────────────────────────────────────────

  it('handles setResults with empty array gracefully', () => {
    const popup = new MentionPopup();
    popup.setResults([]);
    assert.equal(popup.hasResults(), false);
    assert.equal(popup.getSelected(), null);
    assert.equal(popup.getSelectionIndex(), 0);
    assert.deepEqual(popup.getVisibleResults(), []);
  });

  it('getSelected returns null when no results', () => {
    const popup = new MentionPopup();
    assert.equal(popup.getSelected(), null);

    // After calling methods that should not crash
    popup.moveSelection(1);
    assert.equal(popup.getSelected(), null);

    popup.moveSelection(-1);
    assert.equal(popup.getSelected(), null);
  });

  // ── Visible results window ─────────────────────────────────────────────

  it('getVisibleResults returns at most maxVisible items', () => {
    const popup = new MentionPopup({ maxVisible: 4 });
    const items = Array.from({ length: 10 }, (_, i) =>
      makeResult({ label: `item-${i}`, score: 10 - i }),
    );
    popup.setResults(items);

    // First window should show items 0-3 (first 4)
    const firstWindow = popup.getVisibleResults();
    assert.equal(firstWindow.length, 4);
    assert.equal(firstWindow[0]!.label, 'item-0');
    assert.equal(firstWindow[3]!.label, 'item-3');
  });

  it('getVisibleResults scrolls when selection moves past visible window', () => {
    const popup = new MentionPopup({ maxVisible: 3 });
    const items = Array.from({ length: 6 }, (_, i) =>
      makeResult({ label: `item-${i}`, score: 6 - i }),
    );
    popup.setResults(items);

    // Navigate to item-3 (index 3) — window should start at 1
    popup.moveSelection(1); // item-1
    popup.moveSelection(1); // item-2
    popup.moveSelection(1); // item-3

    const window = popup.getVisibleResults();
    assert.equal(window.length, 3);
    assert.equal(window[0]!.label, 'item-1');
    assert.equal(window[1]!.label, 'item-2');
    assert.equal(window[2]!.label, 'item-3');
  });

  it('getVisibleResults clamps to results when fewer than maxVisible', () => {
    const popup = new MentionPopup({ maxVisible: 10 });
    popup.setResults([makeResult({ label: 'a', score: 3 }), makeResult({ label: 'b', score: 2 })]);

    const visible = popup.getVisibleResults();
    assert.equal(visible.length, 2);
    assert.equal(visible[0]!.label, 'a');
    assert.equal(visible[1]!.label, 'b');
  });
});

// ─── searchFilesGlob Tests ───────────────────────────────────────────────────

import { before, after } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { searchFilesGlob } from './mentionPopup.js';

describe('searchFilesGlob', () => {
  let tempDir: string;

  before(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'babel-mention-glob-'));
    // Create a structured test directory
    mkdirSync(join(tempDir, 'src', 'ui'), { recursive: true });
    mkdirSync(join(tempDir, 'src', 'utils'), { recursive: true });
    mkdirSync(join(tempDir, 'node_modules', 'some-pkg'), { recursive: true });
    mkdirSync(join(tempDir, '.git'), { recursive: true });
    mkdirSync(join(tempDir, 'dist'), { recursive: true });

    // Source files
    writeFileSync(join(tempDir, 'src', 'ui', 'mentionPopup.ts'), '');
    writeFileSync(join(tempDir, 'src', 'ui', 'promptInput.ts'), '');
    writeFileSync(join(tempDir, 'src', 'utils', 'fuzzy.ts'), '');
    writeFileSync(join(tempDir, 'src', 'utils', 'helpers.ts'), '');
    writeFileSync(join(tempDir, 'index.ts'), '');
    writeFileSync(join(tempDir, 'package.json'), '{}');

    // Files in skipped directories (should never appear in results)
    writeFileSync(join(tempDir, 'node_modules', 'some-pkg', 'index.ts'), '');
    writeFileSync(join(tempDir, '.git', 'config'), '');
    writeFileSync(join(tempDir, 'dist', 'bundle.js'), '');
  });

  after(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('finds files matching the query', () => {
    const results = searchFilesGlob('mention', tempDir);
    assert.ok(results.length >= 1);
    assert.ok(results.some((r) => r.label.includes('mentionPopup')));
    assert.ok(results.every((r) => r.type === 'file'));
  });

  it('excludes node_modules results', () => {
    const results = searchFilesGlob('index', tempDir);
    assert.equal(
      results.some((r) => r.label.includes('node_modules')),
      false,
    );
  });

  it('excludes .git directory results', () => {
    const results = searchFilesGlob('config', tempDir);
    assert.equal(
      results.some((r) => r.label.startsWith('.git')),
      false,
    );
  });

  it('excludes dist directory results', () => {
    const results = searchFilesGlob('bundle', tempDir);
    assert.equal(
      results.some((r) => r.label.includes('dist')),
      false,
    );
  });

  it('sorts results by score descending', () => {
    const results = searchFilesGlob('fuzzy', tempDir);
    for (let i = 1; i < results.length; i++) {
      assert.ok(
        results[i]!.score <= results[i - 1]!.score,
        `Expected ${results[i]!.label} (score=${results[i]!.score}) <= ${results[i - 1]!.label} (score=${results[i - 1]!.score})`,
      );
    }
  });

  it('caps results at maxResults option', () => {
    // Create enough files to exceed any reasonable cap
    for (let i = 0; i < 15; i++) {
      writeFileSync(join(tempDir, `src`, `file-${i}.ts`), '');
    }
    const results = searchFilesGlob('file', tempDir, { maxResults: 5 });
    assert.ok(results.length <= 5);
    // Cleanup extra files
    for (let i = 0; i < 15; i++) {
      try {
        rmSync(join(tempDir, `src`, `file-${i}.ts`));
      } catch {
        /* ignore */
      }
    }
  });

  it('returns empty array for non-matching query', () => {
    const results = searchFilesGlob('zzzznonexistent', tempDir);
    assert.deepEqual(results, []);
  });

  it('returns empty array for missing root directory', () => {
    const results = searchFilesGlob('test', '/nonexistent-path-that-does-not-exist');
    assert.deepEqual(results, []);
  });

  it('returns empty array for file path instead of directory', () => {
    const filePath = join(tempDir, 'package.json');
    const results = searchFilesGlob('test', filePath);
    assert.deepEqual(results, []);
  });

  it('respects default maxResults of 20', () => {
    // Create 25 files all matching the query 'a'
    for (let i = 0; i < 25; i++) {
      writeFileSync(join(tempDir, `a-file-${i}.ts`), '');
    }
    const results = searchFilesGlob('a', tempDir);
    assert.ok(results.length <= 20, `Expected ≤20 results, got ${results.length}`);
    // Cleanup
    for (let i = 0; i < 25; i++) {
      try {
        rmSync(join(tempDir, `a-file-${i}.ts`));
      } catch {
        /* ignore */
      }
    }
  });

  it('uses matchPaths — path-segment query finds file across segments', () => {
    // Query contains a path separator; with matchPaths, the matcher treats
    // "/" as a word boundary, matching on individual path segments.
    mkdirSync(join(tempDir, 'src', 'hooks'), { recursive: true });
    writeFileSync(join(tempDir, 'src', 'hooks', 'useData.ts'), '');
    writeFileSync(join(tempDir, 'src', 'hooks', 'useAuth.ts'), '');

    const results = searchFilesGlob('hooks/use', tempDir);
    assert.ok(results.length >= 1, 'Expected at least one result for path-segment query');
    assert.ok(
      results.some((r) => r.label === 'src/hooks/useData.ts' || r.label === 'src/hooks/useAuth.ts'),
    );

    // Cleanup
    try {
      rmSync(join(tempDir, 'src', 'hooks', 'useData.ts'));
      rmSync(join(tempDir, 'src', 'hooks', 'useAuth.ts'));
    } catch {
      /* ignore */
    }
  });
});

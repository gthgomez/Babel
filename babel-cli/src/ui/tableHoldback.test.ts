/**
 * Tests for TableHoldbackScanner, FenceTracker, and helper functions.
 *
 * Ported from Codex:
 *   - table_holdback.rs tests  (table_holdback.rs)
 *   - table_detect.rs tests    (table_detect.rs)
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseTableSegments,
  isTableHeaderLine,
  isTableDelimiterLine,
  stripBlockquotePrefix,
  parseFenceMarker,
  FenceTracker,
  FenceKind,
  TableHoldbackScanner,
  HoldbackState,
  cellDisplayWidth,
  expandColumnMaxWidths,
} from './tableHoldback.js';

// =========================================================================
// parseTableSegments
// =========================================================================

describe('parseTableSegments', () => {
  it('splits basic pipe-delimited line', () => {
    assert.deepStrictEqual(parseTableSegments('| A | B | C |'), ['A', 'B', 'C']);
  });

  it('handles line without outer pipes', () => {
    assert.deepStrictEqual(parseTableSegments('A | B | C'), ['A', 'B', 'C']);
  });

  it('handles line with leading pipe only', () => {
    assert.deepStrictEqual(parseTableSegments('| A | B | C'), ['A', 'B', 'C']);
  });

  it('handles line with trailing pipe only', () => {
    assert.deepStrictEqual(parseTableSegments('A | B | C |'), ['A', 'B', 'C']);
  });

  it('allows single segment with outer pipes', () => {
    assert.deepStrictEqual(parseTableSegments('| only |'), ['only']);
  });

  it('returns null for single segment without pipes', () => {
    assert.strictEqual(parseTableSegments('just text'), null);
  });

  it('returns null for empty string', () => {
    assert.strictEqual(parseTableSegments(''), null);
  });

  it('returns null for whitespace-only string', () => {
    assert.strictEqual(parseTableSegments('   '), null);
  });

  it('preserves escaped pipes', () => {
    assert.deepStrictEqual(parseTableSegments(String.raw`| A \| B | C |`), [String.raw`A \| B`, 'C']);
  });
});

// =========================================================================
// isTableHeaderLine
// =========================================================================

describe('isTableHeaderLine', () => {
  it('detects a header line with non-empty cells', () => {
    assert.strictEqual(isTableHeaderLine('| A | B |'), true);
  });

  it('detects a header line without outer pipes', () => {
    assert.strictEqual(isTableHeaderLine('Name | Value'), true);
  });

  it('rejects a line with all empty segments', () => {
    assert.strictEqual(isTableHeaderLine('| | |'), false);
  });
});

// =========================================================================
// isTableDelimiterLine
// =========================================================================

describe('isTableDelimiterLine', () => {
  it('accepts basic delimiter', () => {
    assert.strictEqual(isTableDelimiterLine('| --- | --- |'), true);
  });

  it('accepts aligned delimiters', () => {
    assert.strictEqual(isTableDelimiterLine('|:---:|---:|'), true);
  });

  it('accepts delimiter without outer pipes', () => {
    assert.strictEqual(isTableDelimiterLine('--- | --- | ---'), true);
  });

  it('rejects a header line as delimiter', () => {
    assert.strictEqual(isTableDelimiterLine('| A | B |'), false);
  });

  it('rejects short dashes', () => {
    assert.strictEqual(isTableDelimiterLine('| -- | -- |'), false);
  });

  it('accepts various colon positions', () => {
    assert.strictEqual(isTableDelimiterLine('|:---|---:|'), true);
  });
});

// =========================================================================
// stripBlockquotePrefix
// =========================================================================

describe('stripBlockquotePrefix', () => {
  it('strips single blockquote prefix', () => {
    assert.strictEqual(stripBlockquotePrefix('> hello'), 'hello');
  });

  it('strips nested blockquote prefixes', () => {
    assert.strictEqual(stripBlockquotePrefix('> > nested'), 'nested');
  });

  it('returns string unchanged when no prefix', () => {
    assert.strictEqual(stripBlockquotePrefix('no prefix'), 'no prefix');
  });

  it('strips blockquote prefix with inner pipe table', () => {
    assert.strictEqual(stripBlockquotePrefix('> | A | B |'), '| A | B |');
  });

  it('handles multiple levels of nesting', () => {
    assert.strictEqual(stripBlockquotePrefix('> > > deep'), 'deep');
  });
});

// =========================================================================
// parseFenceMarker
// =========================================================================

describe('parseFenceMarker', () => {
  it('detects backtick fence', () => {
    assert.deepStrictEqual(parseFenceMarker('```rust'), { marker: '`', length: 3 });
  });

  it('detects longer backtick fence', () => {
    assert.deepStrictEqual(parseFenceMarker('````'), { marker: '`', length: 4 });
  });

  it('detects tilde fence', () => {
    assert.deepStrictEqual(parseFenceMarker('~~~python'), { marker: '~', length: 3 });
  });

  it('rejects too-short fences', () => {
    assert.strictEqual(parseFenceMarker('``'), null);
    assert.strictEqual(parseFenceMarker('~~'), null);
  });

  it('rejects non-fence text', () => {
    assert.strictEqual(parseFenceMarker('hello'), null);
    assert.strictEqual(parseFenceMarker(''), null);
  });
});

// =========================================================================
// FenceTracker
// =========================================================================

describe('FenceTracker', () => {
  it('starts outside', () => {
    const ft = new FenceTracker();
    assert.strictEqual(ft.kind(), 'outside');
  });

  it('opens and closes a backtick fence', () => {
    const ft = new FenceTracker();

    ft.advance('```rust');
    assert.strictEqual(ft.kind(), 'other');

    ft.advance('let x = 1;');
    assert.strictEqual(ft.kind(), 'other');

    ft.advance('```');
    assert.strictEqual(ft.kind(), 'outside');
  });

  it('opens and closes a tilde fence', () => {
    const ft = new FenceTracker();

    ft.advance('~~~python');
    assert.strictEqual(ft.kind(), 'other');

    ft.advance('~~~');
    assert.strictEqual(ft.kind(), 'outside');
  });

  it('recognises markdown fences', () => {
    const ft = new FenceTracker();

    ft.advance('```md');
    assert.strictEqual(ft.kind(), 'markdown');

    ft.advance('| A | B |');
    assert.strictEqual(ft.kind(), 'markdown');

    ft.advance('```');
    assert.strictEqual(ft.kind(), 'outside');
  });

  it('is case-insensitive for markdown info', () => {
    const ft = new FenceTracker();

    ft.advance('```Markdown');
    assert.strictEqual(ft.kind(), 'markdown');

    ft.advance('```');
    assert.strictEqual(ft.kind(), 'outside');
  });

  it('shorter close marker does not close', () => {
    const ft = new FenceTracker();

    ft.advance('````sh');
    assert.strictEqual(ft.kind(), 'other');

    ft.advance('```');
    assert.strictEqual(ft.kind(), 'other'); // shorter — no close

    ft.advance('````');
    assert.strictEqual(ft.kind(), 'outside');
  });

  it('mismatched char does not close', () => {
    const ft = new FenceTracker();

    ft.advance('```sh');
    assert.strictEqual(ft.kind(), 'other');

    ft.advance('~~~');
    assert.strictEqual(ft.kind(), 'other'); // tilde doesn't close backtick

    ft.advance('```');
    assert.strictEqual(ft.kind(), 'outside');
  });

  it('fence with >3 leading spaces is not a fence', () => {
    const ft = new FenceTracker();

    ft.advance('    ```sh');
    assert.strictEqual(ft.kind(), 'outside');
  });

  it('strips blockquote prefix before scanning fence', () => {
    const ft = new FenceTracker();

    ft.advance('> ```sh');
    assert.strictEqual(ft.kind(), 'other');

    ft.advance('> ```');
    assert.strictEqual(ft.kind(), 'outside');
  });

  it('fence close with trailing content does not close', () => {
    const ft = new FenceTracker();

    ft.advance('```sh');
    assert.strictEqual(ft.kind(), 'other');

    ft.advance('``` extra');
    assert.strictEqual(ft.kind(), 'other');

    ft.advance('```');
    assert.strictEqual(ft.kind(), 'outside');
  });

  it('reset returns to outside', () => {
    const ft = new FenceTracker();

    ft.advance('```rust');
    assert.strictEqual(ft.kind(), 'other');

    ft.reset();
    assert.strictEqual(ft.kind(), 'outside');
  });
});

// =========================================================================
// TableHoldbackScanner — state transitions
// =========================================================================

describe('TableHoldbackScanner', () => {
  let scanner: TableHoldbackScanner;

  beforeEach(() => {
    scanner = new TableHoldbackScanner();
  });

  it('starts in none state', () => {
    assert.strictEqual(scanner.state(), 'none');
  });

  it('transitions none -> pending-header on header line', () => {
    scanner.pushLine('| Name | Value |\n');
    assert.strictEqual(scanner.state(), 'pending-header');
  });

  it('transitions pending-header -> confirmed on header+delimiter pair', () => {
    scanner.pushLine('| Name | Value |\n');
    assert.strictEqual(scanner.state(), 'pending-header');

    scanner.pushLine('|------|-------|\n');
    assert.strictEqual(scanner.state(), 'confirmed');
  });

  it('single line with header and delimiter in one chunk', () => {
    scanner.pushLine('| Name | Value |\n');
    scanner.pushLine('|------|-------|\n');
    assert.strictEqual(scanner.state(), 'confirmed');
  });

  it('non-table content does not trigger pending-header', () => {
    scanner.pushLine('This is plain text.\n');
    assert.strictEqual(scanner.state(), 'none');

    scanner.pushLine('More text.\n');
    assert.strictEqual(scanner.state(), 'none');
  });

  it('pending-header resets to none when next line is not a delimiter', () => {
    scanner.pushLine('| Name | Value |\n');
    assert.strictEqual(scanner.state(), 'pending-header');

    scanner.pushLine('Just a normal line.\n');
    assert.strictEqual(scanner.state(), 'none');
  });

  it('confirmed stays confirmed after more lines', () => {
    scanner.pushLine('| Name | Value |\n');
    scanner.pushLine('|------|-------|\n');
    assert.strictEqual(scanner.state(), 'confirmed');

    scanner.pushLine('| A | 1 |\n');
    assert.strictEqual(scanner.state(), 'confirmed');

    scanner.pushLine('| B | 2 |\n');
    assert.strictEqual(scanner.state(), 'confirmed');
  });

  it('reset clears all state', () => {
    scanner.pushLine('| Name | Value |\n');
    scanner.pushLine('|------|-------|\n');
    assert.strictEqual(scanner.state(), 'confirmed');

    scanner.reset();
    assert.strictEqual(scanner.state(), 'none');
  });

  it('blank line does not trigger pending-header', () => {
    scanner.pushLine('\n');
    assert.strictEqual(scanner.state(), 'none');
  });

  it('multiple scanners are independent', () => {
    const s1 = new TableHoldbackScanner();
    const s2 = new TableHoldbackScanner();

    s1.pushLine('| A | B |\n');
    s2.pushLine('Plain text.\n');

    assert.strictEqual(s1.state(), 'pending-header');
    assert.strictEqual(s2.state(), 'none');
  });
});

// =========================================================================
// Table inside fenced code blocks
// =========================================================================

describe('TableHoldbackScanner — fenced code blocks', () => {
  it('table inside non-markdown fence is NOT detected', () => {
    const scanner = new TableHoldbackScanner();

    scanner.pushLine('```rust\n');
    // Inside rust fence
    scanner.pushLine('| Name | Value |\n');
    assert.strictEqual(scanner.state(), 'none'); // inside rust — not detected

    scanner.pushLine('|------|-------|\n');
    assert.strictEqual(scanner.state(), 'none'); // inside rust — not detected
  });

  it('table inside markdown fence IS detected', () => {
    const scanner = new TableHoldbackScanner();

    scanner.pushLine('```md\n');
    // Inside markdown fence
    scanner.pushLine('| Name | Value |\n');
    assert.strictEqual(scanner.state(), 'pending-header');

    scanner.pushLine('|------|-------|\n');
    assert.strictEqual(scanner.state(), 'confirmed');
  });

  it('table outside fence is detected', () => {
    const scanner = new TableHoldbackScanner();

    scanner.pushLine('| Name | Value |\n');
    scanner.pushLine('|------|-------|\n');
    assert.strictEqual(scanner.state(), 'confirmed');
  });

  it('table detection resumes after fence closes', () => {
    const scanner = new TableHoldbackScanner();

    scanner.pushLine('```rust\n');
    scanner.pushLine('| A | B |\n');
    assert.strictEqual(scanner.state(), 'none');

    scanner.pushLine('```\n');
    assert.strictEqual(scanner.state(), 'none');

    // Now outside — table should be detected
    scanner.pushLine('| Name | Value |\n');
    assert.strictEqual(scanner.state(), 'pending-header');

    scanner.pushLine('|------|-------|\n');
    assert.strictEqual(scanner.state(), 'confirmed');
  });
});

// =========================================================================
// Blockquoted tables
// =========================================================================

describe('TableHoldbackScanner — blockquoted tables', () => {
  it('detects a blockquoted table', () => {
    const scanner = new TableHoldbackScanner();

    scanner.pushLine('> | Name | Value |\n');
    assert.strictEqual(scanner.state(), 'pending-header');

    scanner.pushLine('> |------|-------|\n');
    assert.strictEqual(scanner.state(), 'confirmed');
  });

  it('detects a deeply blockquoted table', () => {
    const scanner = new TableHoldbackScanner();

    scanner.pushLine('> > | A | B |\n');
    assert.strictEqual(scanner.state(), 'pending-header');

    scanner.pushLine('> > |---|---|\n');
    assert.strictEqual(scanner.state(), 'confirmed');
  });
});

// =========================================================================
// pushChunk (multi-line chunks)
// =========================================================================

describe('TableHoldbackScanner — pushChunk', () => {
  it('processes multi-line chunks', () => {
    const scanner = new TableHoldbackScanner();

    scanner.pushChunk('Before text.\n\n| Name | Value |\n');
    assert.strictEqual(scanner.state(), 'pending-header');

    scanner.pushChunk('|------|-------|\n');
    assert.strictEqual(scanner.state(), 'confirmed');
  });

  it('ignores partial trailing lines', () => {
    const scanner = new TableHoldbackScanner();

    // Only "| Name " is partial (no newline), so it's not fed
    scanner.pushChunk('| Name ');
    assert.strictEqual(scanner.state(), 'none');
  });

  it('header at end of chunk (no trailing newline) not yet processed', () => {
    const scanner = new TableHoldbackScanner();

    // The header is the partial last line — not fed
    scanner.pushChunk('Some text.\n| Name | Value |');
    assert.strictEqual(scanner.state(), 'none'); // header not processed
  });

  it('header+delimiter across two chunks confirms', () => {
    const scanner = new TableHoldbackScanner();

    scanner.pushChunk('| Name | Value |\n');
    assert.strictEqual(scanner.state(), 'pending-header');

    scanner.pushChunk('|------|-------|\n');
    assert.strictEqual(scanner.state(), 'confirmed');
  });

  it('empty chunk does not change state', () => {
    const scanner = new TableHoldbackScanner();

    scanner.pushChunk('');
    assert.strictEqual(scanner.state(), 'none');

    scanner.pushLine('| A | B |\n');
    assert.strictEqual(scanner.state(), 'pending-header');
  });
});

// =========================================================================
// Non-table content passes through unchanged
// =========================================================================

describe('TableHoldbackScanner — non-table content', () => {
  it('plain text leaves state as none', () => {
    const scanner = new TableHoldbackScanner();

    scanner.pushLine('Hello world\n');
    assert.strictEqual(scanner.state(), 'none');

    scanner.pushLine('This is a test\n');
    assert.strictEqual(scanner.state(), 'none');
  });

  it('text without pipe is ignored', () => {
    const scanner = new TableHoldbackScanner();

    scanner.pushLine('Just some regular text\n');
    assert.strictEqual(scanner.state(), 'none');
  });

  it('list with pipes is not a table', () => {
    const scanner = new TableHoldbackScanner();

    scanner.pushLine('- item 1\n');
    scanner.pushLine('- item 2\n');
    assert.strictEqual(scanner.state(), 'none');
  });
});

// =========================================================================
// Multi-table sequences
// =========================================================================

describe('TableHoldbackScanner — multi-table sequences', () => {
  it('detects first table, reset, then second table', () => {
    const scanner = new TableHoldbackScanner();

    // First table
    scanner.pushLine('| A | B |\n');
    scanner.pushLine('|---|---|\n');
    assert.strictEqual(scanner.state(), 'confirmed');

    // Reset between tables
    scanner.reset();
    assert.strictEqual(scanner.state(), 'none');

    // Second table
    scanner.pushLine('| C | D |\n');
    assert.strictEqual(scanner.state(), 'pending-header');

    scanner.pushLine('|------|------|\n');
    assert.strictEqual(scanner.state(), 'confirmed');
  });

  it('two tables separated by blank line (G3 end + re-detect)', () => {
    const scanner = new TableHoldbackScanner();

    // First table — confirmed
    scanner.pushLine('| A | B |\n');
    scanner.pushLine('|---|---|\n');
    scanner.pushLine('| 1 | 2 |\n');
    assert.strictEqual(scanner.state(), 'confirmed');

    // Blank line ends the table (G3) so a following table can re-detect
    scanner.pushLine('\n');
    assert.strictEqual(scanner.didTableEnd(), true);
    assert.strictEqual(scanner.state(), 'none');
    assert.strictEqual(scanner.shouldHold(), false);
    scanner.acknowledgeTableEnd();

    // Second table starts cleanly
    scanner.pushLine('| C | D |\n');
    assert.strictEqual(scanner.state(), 'pending-header');

    scanner.pushLine('|---|---|\n');
    assert.strictEqual(scanner.state(), 'confirmed');
  });
});

// =========================================================================
// Real-world streaming patterns
// =========================================================================

describe('TableHoldbackScanner — streaming patterns', () => {
  it('streaming table chunk by chunk', () => {
    const scanner = new TableHoldbackScanner();

    // Simulate LLM streaming a table character by character
    scanner.pushChunk('| Name | Value |\n');
    assert.strictEqual(scanner.state(), 'pending-header');

    scanner.pushChunk('|');
    assert.strictEqual(scanner.state(), 'pending-header'); // partial line, no change

    scanner.pushChunk('-----');
    assert.strictEqual(scanner.state(), 'pending-header'); // still partial

    scanner.pushChunk('|-------|\n');
    assert.strictEqual(scanner.state(), 'confirmed'); // now complete line

    scanner.pushChunk('| A');
    assert.strictEqual(scanner.state(), 'confirmed'); // stays confirmed

    scanner.pushChunk(' | 1 |\n');
    assert.strictEqual(scanner.state(), 'confirmed'); // stays confirmed
  });

  it('pre-table text does not trigger detection', () => {
    const scanner = new TableHoldbackScanner();

    scanner.pushLine('Here are some results:\n');
    assert.strictEqual(scanner.state(), 'none');

    scanner.pushLine('\n');
    assert.strictEqual(scanner.state(), 'none');

    scanner.pushLine('| Name | Value |\n');
    assert.strictEqual(scanner.state(), 'pending-header');
  });

  it('table detection with single-cell header', () => {
    const scanner = new TableHoldbackScanner();

    scanner.pushLine('| Only |\n');
    assert.strictEqual(scanner.state(), 'pending-header');

    scanner.pushLine('|------|\n');
    assert.strictEqual(scanner.state(), 'confirmed');
  });
});

// =========================================================================
// Edge cases
// =========================================================================

// =========================================================================
// G3 — column width tracking
// =========================================================================

describe('cellDisplayWidth / expandColumnMaxWidths', () => {
  it('counts ASCII as width 1', () => {
    assert.equal(cellDisplayWidth('abc'), 3);
  });

  it('counts CJK as width 2', () => {
    assert.equal(cellDisplayWidth('中文'), 4);
  });

  it('expandColumnMaxWidths grows and reports expansion', () => {
    const max: number[] = [];
    assert.equal(expandColumnMaxWidths(max, ['a', 'bb']), true);
    assert.deepEqual(max, [1, 2]);
    assert.equal(expandColumnMaxWidths(max, ['a', 'bb']), false);
    assert.equal(expandColumnMaxWidths(max, ['aaaa', 'b']), true);
    assert.deepEqual(max, [4, 2]);
  });
});

describe('TableHoldbackScanner — G3 column widths', () => {
  it('tracks column max widths as body rows stream in', () => {
    const scanner = new TableHoldbackScanner();
    scanner.pushLine('| Name | Val |\n');
    scanner.pushLine('| --- | --- |\n');
    assert.equal(scanner.state(), 'confirmed');
    // Header seeded: Name=4, Val=3 — seed does not set dirty (no reshuffle yet)
    assert.deepEqual([...scanner.getColumnMaxWidths()], [4, 3]);
    assert.equal(scanner.widthsExpandedSinceCheck(), false);

    scanner.pushLine('| a | 1 |\n');
    // no expansion beyond header
    assert.equal(scanner.widthsExpandedSinceCheck(), false);
    assert.equal(scanner.getBodyRowCount(), 1);

    scanner.pushLine('| longer-name | 99 |\n');
    assert.equal(scanner.widthsExpandedSinceCheck(), true);
    assert.deepEqual([...scanner.getColumnMaxWidths()], [11, 3]);
    assert.equal(scanner.shouldHold(), true);
  });

  it('marks table ended on blank line after body', () => {
    const scanner = new TableHoldbackScanner();
    scanner.pushLine('| A | B |\n');
    scanner.pushLine('|---|---|\n');
    scanner.pushLine('| 1 | 2 |\n');
    scanner.pushLine('\n');
    assert.equal(scanner.didTableEnd(), true);
    assert.equal(scanner.shouldHold(), false);
    // widths retained until acknowledge
    assert.ok(scanner.getColumnMaxWidths().length >= 2);
    scanner.acknowledgeTableEnd();
    assert.equal(scanner.didTableEnd(), false);
    assert.equal(scanner.getColumnMaxWidths().length, 0);
  });

  it('marks table ended on non-table line after body', () => {
    const scanner = new TableHoldbackScanner();
    scanner.pushLine('| A | B |\n');
    scanner.pushLine('|---|---|\n');
    scanner.pushLine('| 1 | 2 |\n');
    scanner.pushLine('Following paragraph.\n');
    assert.equal(scanner.didTableEnd(), true);
    assert.equal(scanner.state(), 'none');
  });
});

describe('TableHoldbackScanner — edge cases', () => {
  it('header line with no delimiter after does not confirm', () => {
    const scanner = new TableHoldbackScanner();

    scanner.pushLine('| A | B |\n');
    assert.strictEqual(scanner.state(), 'pending-header');

    // Non-table line resets pending
    scanner.pushLine('Not a delimiter\n');
    assert.strictEqual(scanner.state(), 'none');
  });

  it('delimiter without prior header enters pending-header (conservative)', () => {
    const scanner = new TableHoldbackScanner();

    // A delimiter line has non-empty segments ("------"), so the scanner
    // conservatively treats it as a potential header in the absence of a
    // prior line. If followed by a second delimiter it would confirm.
    scanner.pushLine('|------|-------|\n');
    assert.strictEqual(scanner.state(), 'pending-header');

    // Followed by non-delimiter text → resets to none
    scanner.pushLine('Not a table\n');
    assert.strictEqual(scanner.state(), 'none');
  });

  it('whitespace-only lines do not affect pending state', () => {
    const scanner = new TableHoldbackScanner();

    scanner.pushLine('| A | B |\n');
    assert.strictEqual(scanner.state(), 'pending-header');

    scanner.pushLine('  \n');
    // Blank line — pending is NOT cleared (blank lines don't count as non-header)
    // Actually: blank line has trimmed.length === 0, so pendingHeader is unchanged.
    // Wait, let me check: the code says `if (!this.confirmed && stripped.trim().length > 0)`
    // So blank lines (trimmed.length === 0) keep the current pendingHeader value.
    assert.strictEqual(scanner.state(), 'pending-header');
  });

  it('number pipe is ambiguous but table detected', () => {
    const scanner = new TableHoldbackScanner();

    // "| 5 |" looks like a single-cell header
    scanner.pushLine('| 5 |\n');
    assert.strictEqual(scanner.state(), 'pending-header');

    scanner.pushLine('|---|\n');
    assert.strictEqual(scanner.state(), 'confirmed');
  });

  it('header line with trailing spaces is detected', () => {
    const scanner = new TableHoldbackScanner();

    scanner.pushLine('| Name | Value |   \n');
    assert.strictEqual(scanner.state(), 'pending-header');

    scanner.pushLine('|------|-------|\n');
    assert.strictEqual(scanner.state(), 'confirmed');
  });
});

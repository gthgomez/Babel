/**
 * screenLayout.ts — Deterministic screen coordinate layout calculator.
 *
 * Computes terminal screen zones across varying terminal dimensions,
 * including structured degraded modes for compact or tiny terminal heights.
 */

export type ScreenMode = 'normal' | 'compact' | 'linear';

export interface ScreenLayout {
  mode: ScreenMode;
  rows: number;
  cols: number;
  titleRow: number;
  borderRow: number;
  contentTop: number;
  contentBottom: number;
  contentRowCount: number;
  statsRow: number;
  inputRow: number;
}

/**
 * Compute screen coordinate zones for given rows and cols.
 *
 * Layout rules:
 *   - rows >= 5: Normal mode
 *       Row 1: Title
 *       Row 2: Border
 *       Rows 3..(rows-2): Scrollable content area
 *       Row rows-1: Status/stats line
 *       Row rows: Input prompt
 *   - rows === 4: Compact mode (no scroll region, fixed chrome)
 *       Row 1: Title
 *       Row 2: Border
 *       Row 3: Stats
 *       Row 4: Input
 *   - rows <= 3: Linear fallback mode (single-line or direct stdout)
 */
export function computeScreenLayout(rows: number, cols: number): ScreenLayout {
  const safeRows = Math.max(1, rows);
  const safeCols = Math.max(1, cols);

  if (safeRows >= 5) {
    const titleRow = 1;
    const borderRow = 2;
    const contentTop = 3;
    const contentBottom = safeRows - 2;
    const statsRow = safeRows - 1;
    const inputRow = safeRows;
    const contentRowCount = Math.max(0, contentBottom - contentTop + 1);

    return {
      mode: 'normal',
      rows: safeRows,
      cols: safeCols,
      titleRow,
      borderRow,
      contentTop,
      contentBottom,
      contentRowCount,
      statsRow,
      inputRow,
    };
  }

  if (safeRows === 4) {
    return {
      mode: 'compact',
      rows: 4,
      cols: safeCols,
      titleRow: 1,
      borderRow: 2,
      contentTop: 0,
      contentBottom: 0,
      contentRowCount: 0,
      statsRow: 3,
      inputRow: 4,
    };
  }

  // Linear fallback for rows <= 3
  return {
    mode: 'linear',
    rows: safeRows,
    cols: safeCols,
    titleRow: 1,
    borderRow: 0,
    contentTop: 0,
    contentBottom: 0,
    contentRowCount: 0,
    statsRow: Math.min(2, safeRows),
    inputRow: safeRows,
  };
}

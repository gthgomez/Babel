/**
 * Local prompt presentation contracts used when the editor is embedded in a
 * host-owned frame.
 *
 * Coordinates are local to the rectangle supplied to PromptInput.getView().
 * The view contains presentation data only; it does not carry terminal
 * control sequences for cursor movement, screen clearing or raw-mode changes.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LocalCursor {
  row: number;
  col: number;
  visible: boolean;
}

export interface PromptPopup {
  rect: Rect;
  rows: readonly string[];
}

export interface PromptView {
  /** Styled, terminal-safe rows relative to the supplied prompt rectangle. */
  rows: readonly string[];
  /** Cursor coordinates relative to the returned rows and rectangle. */
  cursor: LocalCursor;
  /** Optional typeahead popup, also expressed in local coordinates. */
  popup?: PromptPopup;
}

export interface PromptInputPresentationTarget {
  /** Return the host's current prompt rectangle without performing I/O. */
  getRect: () => Rect;
  /** Request a root-frame repaint; the target does not paint the terminal. */
  invalidate: (reason: string) => void;
}

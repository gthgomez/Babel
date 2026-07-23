/**
 * Unseen Divider Pill — visual indicator for new content while scrolled up.
 *
 * When the user is scrolled above the bottom of the content area and new
 * output arrives, a pill like "↓ 3 new messages" appears at the bottom of
 * the visible area. Clicking or pressing Enter on the pill jumps to the
 * bottom and dismisses it.
 *
 * Architecture:
 *   - The pill is rendered as a styled ANSI string via renderUnseenDividerPill()
 *   - Scroll position and unseen-count tracking live in ScrollbackBuffer
 *   - The pill integrates into ScreenManager (full-screen layout) and
 *     ConversationalRenderer (stdout streaming)
 *
 * @module unseenDivider
 */

import { dim, accent, bold, muted } from './theme.js';

/**
 * Render the unseen divider pill as a styled ANSI string.
 *
 * Returns an empty string when count <= 0, so callers can conditionally
 * render with a simple `if (pill)` check.
 *
 * The pill uses reverse video (ANSI 7m) on 256-color/no-color terminals
 * to remain visible. On true-color terminals the accent color is applied
 * for a polished look.
 *
 * @param count - Number of unseen lines/messages
 * @returns Styled pill string, or empty string if count <= 0
 */
export function renderUnseenDividerPill(count: number): string {
  if (count <= 0) return '';
  const label = count === 1 ? ` ↓ 1 new message ` : ` ↓ ${count} new messages `;

  // Use accent + bold for visibility; the pill stands out against
  // the regular content flow.
  return `  ${dim('─')} ${accent(bold(label))} ${dim('─')}  `;
}

/**
 * Render a compact "scroll away" hint for lists that exceed the visible
 * height. Returns ↑ when items are above the viewport, ↓ when items are
 * below, or both when content extends in both directions.
 *
 * @param hasAbove - Whether there are items above the viewport
 * @param hasBelow - Whether there are items below the viewport
 * @returns Styled hint string, or empty string if neither
 */
export function renderScrollAwayHint(hasAbove: boolean, hasBelow: boolean): string {
  const parts: string[] = [];
  if (hasAbove) parts.push('↑');
  if (hasBelow) parts.push('↓');
  if (parts.length === 0) return '';
  return muted(` ${parts.join(' ')} `);
}

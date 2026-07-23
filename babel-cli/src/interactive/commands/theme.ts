// ─── Theme Command Handler ──────────────────────────────────────────────────────

import type { ReplContext } from '../context.js';
import { ThemePickerDialog } from '../../ui/themePicker.js';

/**
 * Handle the `/theme` command.
 *
 * Opens the theme picker dialog, letting the user browse and select a built-in
 * theme. The dialog previews each theme live on cursor movement. On confirm the
 * selection is persisted to the session; on cancel the original theme is
 * restored. The idle header is always redrawn after the dialog closes so the
 * theme change is reflected immediately.
 */
export async function handleTheme(ctx: ReplContext, _args: string[]): Promise<void> {
  const selected = await ThemePickerDialog.show();
  if (selected) {
    // Theme is already applied by the dialog's live preview
    ctx.saveSessionState();
    console.log(`Theme set to ${selected}`);
  }
  // Always redraw the header after dialog closes (applies even when cancelled)
  ctx.printIdleHeader();
}

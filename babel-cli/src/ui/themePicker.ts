/**
 * Theme Picker Dialog
 *
 * A modal dialog that lets the user browse and select from built-in themes.
 * Renders a live color swatch preview that updates on cursor movement:
 * each Up/Down keypress instantly previews the highlighted theme's colors
 * via setActiveTheme(), so swatches reflect the real theme tokens in real time.
 *
 * Extends Dialog<string> and uses the DialogManager infrastructure from
 * dialog.ts for screen save/restore, keyboard dispatch, and rendering.
 *
 * @module themePicker
 */

import { Dialog, DialogManager } from './dialog.js';
import { getActiveTheme, setActiveTheme, BUILTIN_THEMES } from './tokens.js';
import {
  primary,
  accent,
  accentBright,
  success,
  error,
  warning,
  muted,
  ghost,
  bold,
  dim,
  visibleLength,
} from './theme.js';
import type { KeyEvent } from './keyInput.js';

// ── Constants ────────────────────────────────────────────────────────────────────

/** The swatch label used for each color block. */
const SWATCH_LABEL = '██';

/** Ordered list of semantic color roles shown in the preview panel. */
const SWATCH_ROLES: Array<{ label: string; fn: (text: string) => string }> = [
  { label: 'primary', fn: primary },
  { label: 'accent', fn: accent },
  { label: 'success', fn: success },
  { label: 'error', fn: error },
  { label: 'warning', fn: warning },
  { label: 'muted', fn: muted },
];

/** Width of a single swatch block in visible columns. */
const SWATCH_VIS_WIDTH = 2; // '██' = 2 columns

/** Gap between swatch blocks in visible columns. */
const SWATCH_GAP = 1;

/** Total visible width consumed by the full swatch panel (6 blocks + 5 gaps). */
const SWATCH_PANEL_WIDTH =
  SWATCH_ROLES.length * SWATCH_VIS_WIDTH + (SWATCH_ROLES.length - 1) * SWATCH_GAP;

// ── Theme Picker Dialog ──────────────────────────────────────────────────────────

export class ThemePickerDialog extends Dialog<string> {
  private readonly themes: string[];
  private selectedIndex: number;
  private readonly originalTheme: string;

  constructor() {
    const themes = Object.keys(BUILTIN_THEMES);
    const currentTheme = getActiveTheme().name;
    const selectedIndex = themes.indexOf(currentTheme);

    super({
      title: 'Theme Picker',
      message: 'Choose a theme for the session.',
      minWidth: 50,
    });

    this.originalTheme = currentTheme;
    this.themes = themes;
    this.selectedIndex = selectedIndex >= 0 ? selectedIndex : 0;
  }

  /**
   * Open the theme picker dialog.
   * Returns the selected theme name on confirm, or `null` on cancel.
   */
  static async show(): Promise<string | null> {
    const dialog = new ThemePickerDialog();
    try {
      return await DialogManager.getInstance().open(dialog);
    } catch {
      // User cancelled — original theme was restored in handleKey
      return null;
    }
  }

  // ── Key handling ───────────────────────────────────────────────────────────────

  override handleKey(event: KeyEvent): boolean {
    if (event.name === 'enter') {
      // Confirm selection — persist the currently previewed theme
      const selected = this.themes[this.selectedIndex];
      if (selected) {
        setActiveTheme(selected);
      }
      this.resolve(selected ?? '');
      return true;
    }

    if (event.name === 'escape') {
      // Cancel — restore original theme
      setActiveTheme(this.originalTheme);
      this.reject(new Error('cancel'));
      return true;
    }

    if (event.name === 'up') {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      setActiveTheme(this.themes[this.selectedIndex]!);
      this.markDirty();
      this.renderToScreen();
      return true;
    }

    if (event.name === 'down') {
      this.selectedIndex = Math.min(this.themes.length - 1, this.selectedIndex + 1);
      setActiveTheme(this.themes[this.selectedIndex]!);
      this.markDirty();
      this.renderToScreen();
      return true;
    }

    return false;
  }

  // ── Rendering ──────────────────────────────────────────────────────────────────

  protected override buildContent(): string {
    const swatchBlock = SWATCH_ROLES.map((c) => c.fn(SWATCH_LABEL)).join(' ');
    const swatchVisLen = visibleLength(swatchBlock);

    const innerW = this.dialogWidth - 4;

    const optionLines: string[] = [];
    for (let i = 0; i < this.themes.length; i++) {
      const name = this.themes[i]!;
      const isSelected = i === this.selectedIndex;
      const indicator = isSelected ? accentBright('›') : dim(' ');
      const displayName = isSelected ? bold(name) : dim(name);

      const namePart = `${indicator} ${displayName}`;
      const nameVisLen = visibleLength(namePart);

      // Fill remaining space so swatches are right-aligned with a margin
      const padding = Math.max(1, innerW - nameVisLen - swatchVisLen - 2);
      const line = `${namePart}${' '.repeat(padding)} ${swatchBlock}`;
      optionLines.push(line);
    }

    // Footer hint
    const hint = 'Enter=select  arrows=navigate  Esc=cancel';

    const content = [...optionLines, '', ghost(hint)].join('\n');

    return this.createFrame(content);
  }
}

/**
 * Dialog/Overlay system for Babel's TUI.
 *
 * Provides reusable modal overlays that render over the current terminal
 * content and capture keyboard input. Replaces the raw `y/n?` prompts
 * previously used for permission approvals, confirmations, and selections.
 *
 * Architecture:
 *   - DialogManager: singleton stack managing open dialogs, focus, and cleanup
 *   - Dialog base class (extends Component): dirty tracking, focus, lifecycle
 *   - Concrete dialogs: ConfirmDialog, SelectDialog, MultiSelectDialog, PermissionDialog
 *   - Integration with InputCoordinator for stdin ownership
 *
 * Usage:
 *   const result = await ConfirmDialog.show({
 *     title: 'Approve write?',
 *     message: 'Write 42 lines to src/foo.ts',
 *     confirmLabel: 'Approve',
 *     rejectLabel: 'Deny',
 *   });
 *   if (result) { ... }
 *
 * @module dialog
 */

import { Component } from './component.js';
import { DiffView } from './diffView.js';
import { Box, type BoxOptions } from './primitives.js';
import {
  dim,
  muted,
  ghost,
  accent,
  accentBright,
  bold,
  primary,
  success,
  warning,
  error,
  info,
  buttonFocused,
  buttonNormal,
  bgPanel,
  bgAccent,
  bgPrimary,
  bgSuccess,
  bgWarning,
  bgError,
  headerBg,
} from './theme.js';
import { getEffectiveTerminalWidth, visibleLength, truncate, wrapText } from './theme.js';
import { installKeyHandler, type KeyEvent } from './keyInput.js';
import { FrameScheduler } from './frameScheduler.js';
import { OutputBuffer } from './outputBuffer.js';
import { PaneManager } from './paneManager.js';

// ── Types ───────────────────────────────────────────────────────────────────────

export interface DialogConfig {
  /** Dialog title (shown in top border) */
  title: string;
  /** Body message or content */
  message: string;
  /** Minimum dialog width in characters (default: 40) */
  minWidth?: number;
  /** Maximum dialog width as fraction of terminal width (default: 0.8) */
  maxWidthRatio?: number;
  /** Maximum dialog height as fraction of terminal height (default: 0.6) */
  maxHeightRatio?: number;
}

export interface ConfirmDialogConfig extends DialogConfig {
  /** Label for the confirm/accept button (default: "Yes") */
  confirmLabel?: string;
  /** Label for the reject/cancel button (default: "No") */
  rejectLabel?: string;
  /** Whether confirm is the dangerous action (colors it red) */
  danger?: boolean;
  /** Timeout in ms after which the default action is taken (0 = no timeout) */
  timeoutMs?: number;
  /** Default action on timeout (default: false = reject) */
  timeoutResult?: boolean;
}

export interface SelectDialogConfig extends DialogConfig {
  /** Options to choose from */
  options: string[];
  /** Currently selected index (default: 0) */
  selectedIndex?: number;
  /** Whether to allow cancel (Escape) */
  allowCancel?: boolean;
}

export interface MultiSelectDialogConfig extends DialogConfig {
  /** Options to choose from */
  options: string[];
  /** Descriptions for each option (optional) */
  descriptions?: string[];
  /** Initially selected indices */
  selected?: number[];
  /** Minimum required selections (default: 0) */
  minSelections?: number;
  /** Maximum allowed selections (default: unlimited) */
  maxSelections?: number;
}

export interface PermissionDialogConfig extends DialogConfig {
  /** The action being approved (e.g., "write_file", "apply_patch") */
  actionType: 'write_file' | 'apply_patch' | 'shell_exec' | 'delete_file' | 'mcp_call' | 'generic';
  /** File or resource path */
  path?: string;
  /** Preview content (first few lines of file/diff) */
  preview?: string;
  /** Additional metadata lines */
  metadata?: string[];
  /** Whether to show a diff-style preview */
  showDiff?: boolean;
}

export interface InputDialogConfig extends DialogConfig {
  /** Default/initial value for the input field */
  defaultValue?: string;
  /** Placeholder text shown when input is empty */
  placeholder?: string;
  /** Optional validation function. Return error string, or null if valid. */
  validate?: (value: string) => string | null;
}

export interface CostThresholdDialogConfig extends DialogConfig {
  /** Estimated dollar cost of the operation */
  estimatedCost: number;
  /** Number of tokens involved */
  tokenCount: number;
  /** Model name (e.g., "claude-sonnet-4-20250514") */
  model: string;
  /** The cost threshold that triggered this warning */
  threshold: number;
}

export interface ProgressDialogConfig extends DialogConfig {
  /** Current progress value (default: 0) */
  value?: number;
  /** Maximum progress value (default: 100) */
  max?: number;
  /** Whether the dialog can be cancelled via Escape (default: false) */
  cancelable?: boolean;
}

export interface AlertDialogConfig extends DialogConfig {
  /** Severity level for color-coding (default: 'info') */
  severity?: 'info' | 'warning' | 'error';
}

export interface ThemePickerDialogConfig extends DialogConfig {
  /** List of available theme names */
  themes: string[];
  /** Currently active theme name */
  currentTheme: string;
}

// ── Dialog Manager ──────────────────────────────────────────────────────────────

type DialogResult<T> = T;

export class DialogManager {
  private static instance: DialogManager | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private stack: Dialog<any>[] = [];
  private cleanupKeyHandler: (() => void) | null = null;
  private active = false;

  /**
   * When true, dialogs are rendered as PaneManager floating modal panes
   * instead of using direct OutputBuffer writes.
   * Default is true for PaneManager integration.
   */
  private _usePaneManager = true;

  /**
   * Set whether dialogs should use PaneManager for rendering.
   * When enabled, Dialog.show() creates a floating modal pane via
   * PaneManager.createModal() instead of writing directly to OutputBuffer.
   */
  setUsePaneManager(enabled: boolean): void {
    this._usePaneManager = enabled;
  }

  /** Whether PaneManager integration is active. */
  get usePaneManager(): boolean {
    return this._usePaneManager;
  }

  static getInstance(): DialogManager {
    if (!DialogManager.instance) {
      DialogManager.instance = new DialogManager();
    }
    return DialogManager.instance;
  }

  async open<T>(dialog: Dialog<T>): Promise<DialogResult<T>> {
    // Use PaneManager integration when enabled
    if (this._usePaneManager) {
      return this.openWithPaneManager(dialog);
    }

    // Save screen state before first dialog
    if (this.stack.length === 0) {
      this.activate();
    }

    this.stack.push(dialog);
    dialog.mountRecursive();

    try {
      const result = await dialog.run();
      return result;
    } finally {
      // Remove from stack
      const idx = this.stack.indexOf(dialog);
      if (idx >= 0) this.stack.splice(idx, 1);
      dialog.unmountRecursive();

      // Deactivate when stack is empty
      if (this.stack.length === 0) {
        this.deactivate();
      } else {
        // Re-render the now-top dialog
        this.renderTop();
      }
    }
  }

  /**
   * Open a dialog using the PaneManager for rendering.
   * Creates a floating modal pane, renders the dialog's Component content
   * inside it, and cleans up when the dialog resolves.
   */
  private async openWithPaneManager<T>(dialog: Dialog<T>): Promise<T> {
    const pm = PaneManager.instance;

    // Create a pane that renders the dialog content.
    // Use a closure to capture the dialog's render output.
    const pane = pm.createModal(
      (region) => {
        dialog.dirty = true;
        return dialog.renderSafe();
      },
      {
        title: dialog.config.title,
        closable: false,
        width: dialog.dialogWidth,
        minWidth: dialog.config.minWidth ?? 40,
        minHeight: 8,
      },
    );

    // Route keyboard input from the pane to the dialog
    pane.handleKey = (event: import('./keyInput.js').KeyEvent): boolean => {
      return dialog.handleKey(event);
    };

    pm.render();

    const onResize = (width: number, height: number) => {
      pm.onTerminalResize(height, width);
      pm.render();
    };
    const unregisterResize = OutputBuffer.getInstance().onResize(onResize);

    try {
      const result = await dialog.run();
      return result;
    } finally {
      unregisterResize();
      pm.closePane(pane.id);
      pm.render();
    }
  }

  private activate(): void {
    if (this.active) return;
    this.active = true;

    // Install key handler
    this.cleanupKeyHandler = installKeyHandler(process.stdin, (event) => {
      this.handleKey(event);
    });
  }

  private deactivate(): void {
    if (!this.active) return;
    this.active = false;

    if (this.cleanupKeyHandler) {
      this.cleanupKeyHandler();
      this.cleanupKeyHandler = null;
    }

    // Show cursor
    OutputBuffer.getInstance().showCursor();
  }

  private handleKey(event: KeyEvent): void {
    const top = this.stack[this.stack.length - 1];
    if (top) top.handleKey(event);
  }

  renderTop(): void {
    const top = this.stack[this.stack.length - 1];
    if (!top) return;
    top.dirty = true;
    top.renderToScreen();
  }
}

// ── Base Dialog (extends Component) ─────────────────────────────────────────────

export abstract class Dialog<T> extends Component {
  /** Dialog configuration (immutable after construction). */
  readonly config: DialogConfig;
  protected resolved = false;
  protected resolvePromise!: (value: T) => void;
  protected rejectPromise!: (reason: Error) => void;
  protected promise: Promise<T>;
  protected termWidth: number;
  /** The computed dialog width in characters. */
  readonly dialogWidth: number;

  constructor(config: DialogConfig) {
    super();
    this.config = config;
    this.termWidth = getEffectiveTerminalWidth(config.minWidth ?? 40, 200);
    const maxWidthRatio = config.maxWidthRatio ?? 0.8;
    this.dialogWidth = Math.max(
      config.minWidth ?? 40,
      Math.min(this.termWidth - 4, Math.floor(this.termWidth * maxWidthRatio)),
    );

    this.promise = new Promise<T>((resolve, reject) => {
      this.resolvePromise = resolve;
      this.rejectPromise = reject;
    });
  }

  async run(): Promise<T> {
    this.renderToScreen();
    return this.promise;
  }

  resolve(value: T): void {
    if (this.resolved) return;
    this.resolved = true;
    this.resolvePromise(value);
  }

  reject(reason: Error): void {
    if (this.resolved) return;
    this.resolved = true;
    this.rejectPromise(reason);
  }

  // ── Component overrides ──────────────────────────────────────────────────

  /**
   * Return the dialog as a string. Defaults to building content inside a
   * bordered Box with the dialog title.
   */
  override render(): string {
    return this.buildContent();
  }

  abstract override handleKey(event: KeyEvent): boolean;

  // ── Subclass API ─────────────────────────────────────────────────────────

  /** Build the dialog content string. Subclasses override this. */
  protected buildContent(): string {
    const messageLines = this.wrapMessage();
    const children: string[] = [...messageLines];
    return children.join('\n');
  }

  /** Wrap message text to dialog width (accounting for border + padding). */
  protected wrapMessage(): string[] {
    const innerW = this.dialogWidth - 4; // 2 border + 2 padding
    const lines: string[] = [];
    for (const line of this.config.message.split('\n')) {
      const wrapped = wrapText(line, innerW);
      if (Array.isArray(wrapped)) {
        lines.push(...wrapped);
      } else {
        lines.push(wrapped);
      }
    }
    return lines;
  }

  /**
   * Build a Box configured for this dialog's width and title.
   * Convenience for subclasses.
   */
  protected createFrame(content: string): string {
    const box = new Box({
      border: 'single',
      borderColor: 'border',
      padding: { top: 0, right: 1, bottom: 0, left: 1 },
      width: this.dialogWidth,
      title: this.config.title,
      children: [content],
    });
    return box.render();
  }

  // ── Screen positioning ───────────────────────────────────────────────────

  /**
   * Calculate where the dialog should appear.
   * Returns 1-based row/col positions.
   */
  protected getDialogPosition(): { startRow: number; endRow: number; leftCol: number } {
    const rows = process.stdout.rows || 24;
    const maxHeightRatio = this.config.maxHeightRatio ?? 0.6;
    const maxDialogRows = Math.floor(rows * maxHeightRatio);

    // Estimate dialog height from rendered content
    const content = this.buildContent();
    const contentLines = content.split('\n');
    // Actual dialog height = content + 2 border lines
    const dialogHeight = Math.min(contentLines.length + 2, maxDialogRows);

    const startRow = Math.max(1, Math.floor((rows - dialogHeight) / 2));
    const endRow = Math.min(rows, startRow + dialogHeight - 1);
    const leftCol = Math.max(1, Math.floor((this.termWidth - this.dialogWidth) / 2));
    return { startRow, endRow, leftCol };
  }

  /**
   * Render the dialog to the terminal at its calculated position.
   * Uses OutputBuffer with DEC 2026 for tear-free rendering.
   */
  renderToScreen(): void {
    if (!this.dirty) return;
    this.dirty = false;

    const { startRow, endRow, leftCol } = this.getDialogPosition();
    const content = this.render();
    const lines = content.split('\n');

    const buf = OutputBuffer.getInstance();
    const useSync = OutputBuffer.supportsSyncUpdate();
    if (useSync) buf.beginFrame();
    try {
      // Clear dialog area
      buf.clearRegion(startRow, endRow, leftCol, leftCol + this.dialogWidth - 1);

      // Write each line at the correct absolute position
      for (let i = 0; i < lines.length && startRow + i <= endRow; i++) {
        buf.writeLine(startRow + i, leftCol, lines[i]!);
      }

      buf.hideCursor();
    } finally {
      if (useSync) buf.endFrame();
    }
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  override onUnmount(): void {
    // Clean up any subclass resources
  }

  // ── Internal helpers ─────────────────────────────────────────────────────

  /** Expose mount for DialogManager (bypasses parent requirement). */
  override mountRecursive(): void {
    this.mounted = true;
    this.onMount();
    for (const child of this.children) {
      child.mountRecursive();
    }
  }

  /** Expose unmount for DialogManager. */
  override unmountRecursive(): void {
    this.blur();
    this.mounted = false;
    this.onUnmount();
    for (const child of this.children) {
      child.unmountRecursive();
    }
  }
}

// ── Confirm Dialog ──────────────────────────────────────────────────────────────

export class ConfirmDialog extends Dialog<boolean> {
  private confirmLabel: string;
  private rejectLabel: string;
  private danger: boolean;
  private currentFocus: 'confirm' | 'reject';
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: ConfirmDialogConfig) {
    super(config);
    this.confirmLabel = config.confirmLabel ?? 'Yes';
    this.rejectLabel = config.rejectLabel ?? 'No';
    this.danger = config.danger ?? false;
    this.currentFocus = config.danger ? 'reject' : 'confirm'; // safe default

    // Timeout
    if (config.timeoutMs && config.timeoutMs > 0) {
      this.timeoutTimer = setTimeout(() => {
        this.resolve(config.timeoutResult ?? false);
      }, config.timeoutMs);
    }
  }

  static async show(config: ConfirmDialogConfig): Promise<boolean> {
    const dialog = new ConfirmDialog(config);
    return DialogManager.getInstance().open(dialog);
  }

  override handleKey(event: KeyEvent): boolean {
    if (event.name === 'enter') {
      if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
      this.resolve(this.currentFocus === 'confirm');
      return true;
    }

    if (event.name === 'escape') {
      if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
      this.resolve(false); // Escape = reject
      return true;
    }

    // Arrow keys / Tab to switch focus
    if (event.name === 'left' || event.name === 'right' || event.name === 'tab') {
      this.currentFocus = this.currentFocus === 'confirm' ? 'reject' : 'confirm';
      this.markDirty();
      this.renderToScreen();
      return true;
    }

    // Quick key shortcuts
    const lower = event.name.toLowerCase();
    if (lower === 'y') {
      if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
      this.resolve(true);
      return true;
    } else if (lower === 'n') {
      if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
      this.resolve(false);
      return true;
    }

    return false;
  }

  protected override buildContent(): string {
    const messageLines = this.wrapMessage();

    // Build buttons
    const confirmStyled =
      this.currentFocus === 'confirm'
        ? buttonFocused(this.confirmLabel, this.danger)
        : this.danger
          ? error(` ${this.confirmLabel} `)
          : ` ${this.confirmLabel} `;

    const rejectStyled =
      this.currentFocus === 'reject'
        ? buttonFocused(this.rejectLabel, false)
        : muted(` ${this.rejectLabel} `);

    const buttonsLine = `  ${confirmStyled}  ${rejectStyled}  ${ghost('(Enter=select  arrows=switch  Esc=cancel)')}`;

    const content = [...messageLines, '', buttonsLine].join('\n');

    return this.createFrame(content);
  }

  override onUnmount(): void {
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
  }
}

// ── Select Dialog ───────────────────────────────────────────────────────────────

export class SelectDialog extends Dialog<string | null> {
  private options: string[];
  private selectedIndex: number;
  private allowCancel: boolean;

  constructor(config: SelectDialogConfig) {
    super(config);
    this.options = config.options;
    this.selectedIndex = config.selectedIndex ?? 0;
    this.allowCancel = config.allowCancel !== false;
  }

  static async show(config: SelectDialogConfig): Promise<string | null> {
    const dialog = new SelectDialog(config);
    return DialogManager.getInstance().open(dialog);
  }

  override handleKey(event: KeyEvent): boolean {
    if (event.name === 'enter') {
      this.resolve(this.options[this.selectedIndex] ?? null);
      return true;
    }

    if (event.name === 'escape' && this.allowCancel) {
      this.resolve(null);
      return true;
    }

    if (event.name === 'up') {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.markDirty();
      this.renderToScreen();
      return true;
    }

    if (event.name === 'down') {
      this.selectedIndex = Math.min(this.options.length - 1, this.selectedIndex + 1);
      this.markDirty();
      this.renderToScreen();
      return true;
    }

    return false;
  }

  protected override buildContent(): string {
    const messageLines = this.wrapMessage();
    const maxVisible = this.options.length;
    const innerW = this.dialogWidth - 4;

    const optionLines: string[] = [];
    for (let i = 0; i < maxVisible; i++) {
      const option = this.options[i] ?? '';
      const isSelected = i === this.selectedIndex;
      const indicator = isSelected ? accentBright('›') : ' ';
      const display = isSelected ? buttonFocused(option.padEnd(innerW - 4), false) : ` ${option}`;
      optionLines.push(`${indicator} ${display}`);
    }

    // Footer hint
    const hint = this.allowCancel
      ? 'Enter=select  arrows=navigate  Esc=cancel'
      : 'Enter=select  arrows=navigate';

    const content = [...messageLines, '', ...optionLines, '', ghost(hint)].join('\n');

    return this.createFrame(content);
  }
}

// ── Multi-Select Dialog ─────────────────────────────────────────────────────────

export class MultiSelectDialog extends Dialog<string[] | null> {
  private options: string[];
  private descriptions: string[];
  private selected: Set<number>;
  private cursor: number;
  private minSelections: number;
  private maxSelections: number;

  constructor(config: MultiSelectDialogConfig) {
    super(config);
    this.options = config.options;
    this.descriptions = config.descriptions ?? [];
    this.selected = new Set(config.selected ?? []);
    this.cursor = 0;
    this.minSelections = config.minSelections ?? 0;
    this.maxSelections = config.maxSelections ?? Number.MAX_SAFE_INTEGER;
  }

  static async show(config: MultiSelectDialogConfig): Promise<string[] | null> {
    const dialog = new MultiSelectDialog(config);
    return DialogManager.getInstance().open(dialog);
  }

  override handleKey(event: KeyEvent): boolean {
    if (event.name === 'enter') {
      if (this.selected.size >= this.minSelections) {
        const result = [...this.selected].sort().map((i) => this.options[i]!);
        this.resolve(result);
      }
      return true;
    }

    if (event.name === 'escape') {
      this.resolve(null);
      return true;
    }

    if (event.name === 'space' || event.name === ' ') {
      this.toggleSelection(this.cursor);
      this.markDirty();
      this.renderToScreen();
      return true;
    }

    if (event.name === 'up') {
      this.cursor = Math.max(0, this.cursor - 1);
      this.markDirty();
      this.renderToScreen();
      return true;
    }

    if (event.name === 'down') {
      this.cursor = Math.min(this.options.length - 1, this.cursor + 1);
      this.markDirty();
      this.renderToScreen();
      return true;
    }

    return false;
  }

  private toggleSelection(index: number): void {
    if (this.selected.has(index)) {
      if (this.selected.size > this.minSelections) {
        this.selected.delete(index);
      }
    } else {
      if (this.selected.size < this.maxSelections) {
        this.selected.add(index);
      }
    }
  }

  protected override buildContent(): string {
    const maxVisible = this.options.length;

    const optionLines: string[] = [];
    for (let i = 0; i < maxVisible; i++) {
      const option = this.options[i] ?? '';
      const checked = this.selected.has(i) ? '\x1b[32m✓\x1b[0m' : '○';
      const isCursor = i === this.cursor;
      const desc = this.descriptions[i] ? ghost(` — ${this.descriptions[i]}`) : '';
      const display = isCursor
        ? bgPanel(primary(` ${checked} ${option}${desc} `))
        : ` ${checked} ${option}${desc}`;
      optionLines.push(display);
    }

    // Footer
    const countStr = `${this.selected.size}/${this.options.length} selected`;
    const hint = `Space=toggle  Enter=confirm(${countStr})  Esc=cancel`;

    const content = [...optionLines, '', ghost(hint)].join('\n');

    return this.createFrame(content);
  }
}

// ── Permission Dialog ───────────────────────────────────────────────────────────

export class PermissionDialog extends Dialog<boolean> {
  private actionType: PermissionDialogConfig['actionType'];
  private path: string | undefined;
  private preview: string | undefined;
  private metadata: string[] | undefined;
  private showDiff: boolean;
  private currentFocus: 'approve' | 'reject';

  constructor(config: PermissionDialogConfig) {
    super({ ...config, minWidth: config.minWidth ?? 50 });
    this.actionType = config.actionType;
    this.path = config.path;
    this.preview = config.preview;
    this.metadata = config.metadata;
    this.showDiff = config.showDiff ?? false;
    this.currentFocus = 'approve';
  }

  static async show(config: PermissionDialogConfig): Promise<boolean> {
    const dialog = new PermissionDialog(config);
    return DialogManager.getInstance().open(dialog);
  }

  override handleKey(event: KeyEvent): boolean {
    if (event.name === 'enter') {
      this.resolve(this.currentFocus === 'approve');
      return true;
    }

    if (event.name === 'escape') {
      this.resolve(false);
      return true;
    }

    if (event.name === 'left' || event.name === 'right' || event.name === 'tab') {
      this.currentFocus = this.currentFocus === 'approve' ? 'reject' : 'approve';
      this.markDirty();
      this.renderToScreen();
      return true;
    }

    // Quick keys
    if (event.name.toLowerCase() === 'y') {
      this.resolve(true);
      return true;
    }
    if (event.name.toLowerCase() === 'n') {
      this.resolve(false);
      return true;
    }

    return false;
  }

  protected override buildContent(): string {
    const actionLabel = this.getActionLabel();
    const innerW = this.dialogWidth - 4;
    const contentLines: string[] = [];

    // Path
    if (this.path) {
      contentLines.push(info(`  Path: ${this.path}`));
      contentLines.push('');
    }

    // Metadata
    if (this.metadata) {
      for (const m of this.metadata) {
        contentLines.push(dim(`  ${m}`));
      }
      if (this.metadata.length > 0) contentLines.push('');
    }

    // Preview (diff-aware when showDiff is set)
    if (this.preview) {
      if (this.showDiff && this.preview.includes('@@')) {
        contentLines.push(muted('  ── Diff preview ──'));
        const diffRendered = DiffView.render({
          diff: this.preview,
          width: Math.max(this.dialogWidth - 6, 40),
          maxLines: 12,
        });
        for (const line of diffRendered.split('\n')) {
          contentLines.push(`  ${line}`);
        }
      } else {
        const previewLines = this.preview.split('\n');
        const maxPreviewLines = Math.min(previewLines.length, 10);
        if (maxPreviewLines > 0) {
          contentLines.push(muted('  ── Preview ──'));
          for (let i = 0; i < maxPreviewLines; i++) {
            contentLines.push(ghost(`  ${previewLines[i]}`));
          }
          if (previewLines.length > maxPreviewLines) {
            contentLines.push(ghost(`  ... ${previewLines.length - maxPreviewLines} more lines`));
          }
        }
      }
      contentLines.push('');
    }

    // Buttons
    const approveLabel = this.actionType === 'delete_file' ? 'Delete' : 'Approve';
    const approveStyled =
      this.currentFocus === 'approve'
        ? this.actionType === 'delete_file'
          ? buttonFocused(approveLabel, true)
          : buttonFocused(approveLabel, false)
        : ` ${approveLabel} `;

    const rejectStyled =
      this.currentFocus === 'reject' ? buttonFocused('Deny', false) : muted(' Deny ');

    const buttonsLine = `  ${approveStyled}  ${rejectStyled}  ${ghost('(Enter=select  arrows=switch)')}`;
    contentLines.push(buttonsLine);

    // Build frame with action label prepended to title
    const titledContent = contentLines.join('\n');
    const box = new Box({
      border: 'single',
      borderColor: 'border',
      padding: { top: 0, right: 1, bottom: 0, left: 1 },
      width: this.dialogWidth,
      title: `${actionLabel} ${this.config.title}`,
      children: [titledContent],
    });
    return box.render();
  }

  private getActionLabel(): string {
    switch (this.actionType) {
      case 'write_file':
        return warning('[WRITE]');
      case 'apply_patch':
        return info('[PATCH]');
      case 'shell_exec':
        return error('[EXEC]');
      case 'delete_file':
        return error('[DELETE]');
      case 'mcp_call':
        return accent('[MCP]');
      default:
        return muted('[ACTION]');
    }
  }
}

// ── Input Dialog ────────────────────────────────────────────────────────────────

/**
 * InputDialog — single-line text input with optional default, placeholder,
 * and validation. Returns the entered string on submit, or null on cancel.
 *
 * Keys: printable chars to type, Backspace to delete, Enter to submit,
 * Escape to cancel.
 */
export class InputDialog extends Dialog<string | null> {
  private inputBuffer: string;
  private placeholder: string;
  private validate: ((value: string) => string | null) | null;
  private validationError: string | null;

  constructor(config: InputDialogConfig) {
    super(config);
    this.inputBuffer = config.defaultValue ?? '';
    this.placeholder = config.placeholder ?? '';
    this.validate = config.validate ?? null;
    this.validationError = null;
  }

  static async show(config: InputDialogConfig): Promise<string | null> {
    const dialog = new InputDialog(config);
    return DialogManager.getInstance().open(dialog);
  }

  override handleKey(event: KeyEvent): boolean {
    if (event.name === 'enter') {
      this.validationError = null;
      if (this.validate) {
        const err = this.validate(this.inputBuffer);
        if (err !== null) {
          this.validationError = err;
          this.markDirty();
          this.renderToScreen();
          return true;
        }
      }
      this.resolve(this.inputBuffer);
      return true;
    }

    if (event.name === 'escape') {
      this.resolve(null);
      return true;
    }

    if (event.name === 'backspace') {
      this.inputBuffer = this.inputBuffer.slice(0, -1);
      this.validationError = null;
      this.markDirty();
      this.renderToScreen();
      return true;
    }

    if (event.name === 'space') {
      this.inputBuffer += ' ';
      this.validationError = null;
      this.markDirty();
      this.renderToScreen();
      return true;
    }

    // Paste event
    if (event.name === 'paste') {
      this.inputBuffer += event.sequence;
      this.validationError = null;
      this.markDirty();
      this.renderToScreen();
      return true;
    }

    // Printable character (single char, no modifier)
    if (event.name.length === 1 && !event.ctrl && !event.meta) {
      this.inputBuffer += event.sequence;
      this.validationError = null;
      this.markDirty();
      this.renderToScreen();
      return true;
    }

    return false;
  }

  protected override buildContent(): string {
    const messageLines = this.wrapMessage();
    const innerW = this.dialogWidth - 8; // border + padding + margin

    let inputDisplay: string;
    if (this.inputBuffer.length > 0) {
      inputDisplay = truncate(this.inputBuffer, innerW - 1);
    } else if (this.placeholder) {
      inputDisplay = dim(truncate(this.placeholder, innerW - 1));
    } else {
      inputDisplay = '';
    }
    const cursor = accent('|');
    const inputLine = `  > ${inputDisplay}${cursor}`;

    const lines: string[] = [...messageLines, '', inputLine];

    if (this.validationError) {
      lines.push('', `  ${error(this.validationError)}`);
    }

    lines.push('', ghost('  Enter=submit  Esc=cancel'));

    return this.createFrame(lines.join('\n'));
  }
}

// ── Cost Threshold Dialog ───────────────────────────────────────────────────────

/**
 * CostThresholdDialog — warns the user that an operation exceeds a cost
 * threshold. Shows estimated cost, token count, model, and threshold.
 * Returns true to proceed, false to cancel.
 */
export class CostThresholdDialog extends Dialog<boolean> {
  private estimatedCost: number;
  private tokenCount: number;
  private model: string;
  private threshold: number;
  private currentFocus: 'proceed' | 'cancel';

  constructor(config: CostThresholdDialogConfig) {
    super({ ...config, minWidth: config.minWidth ?? 50 });
    this.estimatedCost = config.estimatedCost;
    this.tokenCount = config.tokenCount;
    this.model = config.model;
    this.threshold = config.threshold;
    this.currentFocus = 'cancel';
  }

  static async show(config: CostThresholdDialogConfig): Promise<boolean> {
    const dialog = new CostThresholdDialog(config);
    return DialogManager.getInstance().open(dialog);
  }

  override handleKey(event: KeyEvent): boolean {
    if (event.name === 'enter') {
      this.resolve(this.currentFocus === 'proceed');
      return true;
    }

    if (event.name === 'escape') {
      this.resolve(false);
      return true;
    }

    if (event.name === 'left' || event.name === 'right' || event.name === 'tab') {
      this.currentFocus = this.currentFocus === 'proceed' ? 'cancel' : 'proceed';
      this.markDirty();
      this.renderToScreen();
      return true;
    }

    const lower = event.name.toLowerCase();
    if (lower === 'y') {
      this.resolve(true);
      return true;
    } else if (lower === 'n') {
      this.resolve(false);
      return true;
    }

    return false;
  }

  protected override buildContent(): string {
    const messageLines = this.wrapMessage();
    const innerW = this.dialogWidth - 4;

    const costStr = `$${this.estimatedCost.toFixed(2)}`;
    const thresholdStr = `$${this.threshold.toFixed(2)}`;
    const tokenStr = this.tokenCount.toLocaleString();

    const infoLines: string[] = [
      '',
      `  ${bold('Estimated Cost:')} ${warning(costStr)}${this.estimatedCost >= this.threshold ? ` ${error('(exceeds threshold)')}` : ''}`,
      `  ${bold('Token Count:')}    ${info(tokenStr)}`,
      `  ${bold('Model:')}         ${accent(this.model)}`,
      `  ${bold('Threshold:')}     ${muted(thresholdStr)}`,
      '',
    ];

    // Buttons
    const proceedStyled =
      this.currentFocus === 'proceed'
        ? buttonFocused('Proceed', true)
        : error(' Proceed ');

    const cancelStyled =
      this.currentFocus === 'cancel'
        ? buttonFocused('Cancel', false)
        : muted(' Cancel ');

    const buttonsLine = `  ${proceedStyled}  ${cancelStyled}  ${ghost('(Enter=select  arrows=switch  Esc=cancel)')}`;

    const content = [...messageLines, ...infoLines, buttonsLine].join('\n');
    return this.createFrame(content);
  }
}

// ── Progress Dialog ─────────────────────────────────────────────────────────────

/**
 * ProgressDialog — shows a determinate or indeterminate progress bar.
 * Supports external updates via updateValue(). Auto-closes when value
 * reaches max. Optionally cancelable via Escape.
 *
 * Usage:
 *   const dialog = new ProgressDialog({ title, message, max: 100 });
 *   const promise = DialogManager.getInstance().open(dialog);
 *   // ... update progress:
 *   dialog.updateValue(50);
 *   const result = await promise; // true = completed, false = canceled
 */
export class ProgressDialog extends Dialog<boolean> {
  private currentValue: number;
  private maxValue: number;
  private cancelable: boolean;

  constructor(config: ProgressDialogConfig) {
    super(config);
    this.currentValue = config.value ?? 0;
    this.maxValue = config.max ?? 100;
    this.cancelable = config.cancelable ?? false;
  }

  static async show(config: ProgressDialogConfig): Promise<boolean> {
    const dialog = new ProgressDialog(config);
    return DialogManager.getInstance().open(dialog);
  }

  /** Update the current progress value. Auto-closes when value >= max. */
  updateValue(value: number): void {
    if (this.resolved) return;
    this.currentValue = Math.min(value, this.maxValue);
    if (this.currentValue >= this.maxValue) {
      this.resolve(true);
    } else {
      this.markDirty();
      this.renderToScreen();
    }
  }

  override handleKey(event: KeyEvent): boolean {
    if (event.name === 'escape' && this.cancelable && !this.resolved) {
      this.resolve(false);
      return true;
    }
    return false;
  }

  protected override buildContent(): string {
    const messageLines = this.wrapMessage();
    const bar = this.renderBar();
    const percentage = this.maxValue > 0
      ? Math.round((this.currentValue / this.maxValue) * 100)
      : 0;
    const pctStr = percentage === 100 ? success('100%') : primary(`${percentage}%`.padStart(4));
    const barLine = `  ${bar}  ${pctStr}`;

    const lines = [...messageLines, '', barLine];
    return this.createFrame(lines.join('\n'));
  }

  private renderBar(): string {
    const barWidth = Math.min(30, Math.max(10, this.dialogWidth - 16));
    const filled = this.maxValue > 0
      ? Math.round((this.currentValue / this.maxValue) * barWidth)
      : 0;
    const clampedFilled = Math.min(filled, barWidth);
    const clampedEmpty = barWidth - clampedFilled;
    const filledStr = '█'.repeat(clampedFilled);
    const emptyStr = '░'.repeat(clampedEmpty);
    return accent(filledStr) + ghost(emptyStr);
  }
}

// ── Alert Dialog ────────────────────────────────────────────────────────────────

/**
 * AlertDialog — simple informational dialog with a single "OK" button and
 * color-coded severity border. Dismisses on Enter or Escape.
 */
export class AlertDialog extends Dialog<void> {
  private severity: AlertDialogConfig['severity'];

  constructor(config: AlertDialogConfig) {
    super(config);
    this.severity = config.severity ?? 'info';
  }

  static async show(config: AlertDialogConfig): Promise<void> {
    const dialog = new AlertDialog(config);
    return DialogManager.getInstance().open(dialog);
  }

  override handleKey(event: KeyEvent): boolean {
    if (event.name === 'enter' || event.name === 'escape') {
      this.resolve(undefined);
      return true;
    }
    return false;
  }

  protected override buildContent(): string {
    const messageLines = this.wrapMessage();

    const severityLabel = this.getSeverityLabel();

    // OK button
    const okStyled = buttonFocused('OK', false);
    const buttonsLine = `  ${okStyled}  ${ghost('(Enter/Esc to dismiss)')}`;

    const content = [...messageLines, '', buttonsLine].join('\n');

    // Use box with severity-tinted border
    const borderColor = this.getBorderColor();
    const box = new Box({
      border: 'single',
      borderColor,
      padding: { top: 0, right: 1, bottom: 0, left: 1 },
      width: this.dialogWidth,
      title: `${severityLabel} ${this.config.title}`,
      children: [content],
    });
    return box.render();
  }

  private getSeverityLabel(): string {
    switch (this.severity) {
      case 'error':
        return error('ERROR');
      case 'warning':
        return warning('WARNING');
      default:
        return info('INFO');
    }
  }

  private getBorderColor(): 'border' | 'error' | 'warning' | 'info' {
    switch (this.severity) {
      case 'error':
        return 'error';
      case 'warning':
        return 'warning';
      default:
        return 'info';
    }
  }
}

// ── Theme Picker Dialog ─────────────────────────────────────────────────────────

/**
 * ThemePickerDialog — lets the user preview and select from a list of themes.
 * Shows theme names with a color preview swatch. Up/down to navigate,
 * Enter to select, Escape to cancel.
 *
 * Returns the selected theme name string, or null on cancel.
 */
export class ThemePickerDialog extends Dialog<string | null> {
  private themes: string[];
  private currentTheme: string;
  private selectedIndex: number;

  /** Cycling swatch background functions for visual variety */
  private static readonly SWATCH_BG_FNS = [
    bgAccent,
    bgPrimary,
    bgSuccess,
    bgWarning,
    bgError,
    bgPanel,
  ];

  constructor(config: ThemePickerDialogConfig) {
    super(config);
    this.themes = config.themes;
    this.currentTheme = config.currentTheme;
    // Find current theme index; default to 0
    const idx = this.themes.indexOf(this.currentTheme);
    this.selectedIndex = idx >= 0 ? idx : 0;
  }

  static async show(config: ThemePickerDialogConfig): Promise<string | null> {
    const dialog = new ThemePickerDialog(config);
    return DialogManager.getInstance().open(dialog);
  }

  override handleKey(event: KeyEvent): boolean {
    if (event.name === 'enter') {
      const selected = this.themes[this.selectedIndex] ?? null;
      this.resolve(selected);
      return true;
    }

    if (event.name === 'escape') {
      this.resolve(null);
      return true;
    }

    if (event.name === 'up') {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.markDirty();
      this.renderToScreen();
      return true;
    }

    if (event.name === 'down') {
      this.selectedIndex = Math.min(this.themes.length - 1, this.selectedIndex + 1);
      this.markDirty();
      this.renderToScreen();
      return true;
    }

    return false;
  }

  protected override buildContent(): string {
    const messageLines = this.wrapMessage();

    const optionLines: string[] = [];
    for (let i = 0; i < this.themes.length; i++) {
      const theme = this.themes[i] ?? '';
      const isCurrent = theme === this.currentTheme;
      const isSelected = i === this.selectedIndex;

      // Color swatch (two spaces with background color)
      const swatchBg = ThemePickerDialog.SWATCH_BG_FNS[i % ThemePickerDialog.SWATCH_BG_FNS.length]!;
      const swatch = swatchBg('  ');

      const indicator = isSelected ? accentBright('›') : ' ';
      const checkmark = isCurrent ? success(' ✓') : '';

      let line: string;
      if (isSelected) {
        line = `  ${indicator} ${swatch} ${buttonFocused(theme, false)}${checkmark}`;
      } else {
        line = `  ${indicator} ${swatch}  ${theme}${checkmark}`;
      }
      optionLines.push(line);
    }

    const hint = ghost('arrows=navigate  Enter=select  Esc=cancel');
    const content = [...messageLines, '', ...optionLines, '', hint].join('\n');
    return this.createFrame(content);
  }
}

// ── Convenience exports ─────────────────────────────────────────────────────────

/**
 * Quick confirmation dialog.
 * Returns true if the user confirmed, false otherwise.
 */
export async function confirm(config: ConfirmDialogConfig): Promise<boolean> {
  return ConfirmDialog.show(config);
}

/**
 * Quick single-select dialog.
 * Returns the selected option string, or null if canceled.
 */
export async function select(config: SelectDialogConfig): Promise<string | null> {
  return SelectDialog.show(config);
}

/**
 * Quick multi-select dialog.
 * Returns array of selected option strings, or null if canceled.
 */
export async function multiSelect(config: MultiSelectDialogConfig): Promise<string[] | null> {
  return MultiSelectDialog.show(config);
}

/**
 * Quick permission approval dialog.
 * Returns true if approved, false if denied.
 */
export async function requestPermission(config: PermissionDialogConfig): Promise<boolean> {
  return PermissionDialog.show(config);
}

/**
 * Quick text input dialog.
 * Returns the entered string, or null if canceled.
 */
export async function input(config: InputDialogConfig): Promise<string | null> {
  return InputDialog.show(config);
}

/**
 * Quick cost threshold warning dialog.
 * Returns true if the user proceeds, false if canceled.
 */
export async function confirmCost(config: CostThresholdDialogConfig): Promise<boolean> {
  return CostThresholdDialog.show(config);
}

/**
 * Quick progress dialog. Use ProgressDialog directly for updateValue() access.
 */
export async function showProgress(config: ProgressDialogConfig): Promise<boolean> {
  return ProgressDialog.show(config);
}

/**
 * Quick alert dialog.
 */
export async function alert(config: AlertDialogConfig): Promise<void> {
  return AlertDialog.show(config);
}

/**
 * Quick theme picker dialog.
 * Returns the selected theme name, or null if canceled.
 */
export async function pickTheme(config: ThemePickerDialogConfig): Promise<string | null> {
  return ThemePickerDialog.show(config);
}

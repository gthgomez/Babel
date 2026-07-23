/**
 * Interactive keybinding remapping wizard for Babel's TUI.
 *
 * Models Codex's /keymap command with a 3-step flow:
 *   1. Pick an action from a grouped, scrollable list
 *   2. Choose operation: add, replace, or remove
 *   3. Capture the key combination (for add/replace)
 *
 * Writes atomically to ~/.babel_keybindings.json and calls
 * KeybindingManager.reload() to pick up changes.
 *
 * @module keybindingRemap
 */

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Dialog, DialogManager, SelectDialog, type DialogConfig } from './dialog.js';
import {
  DEFAULT_BINDINGS,
  serializeKeyEvent,
  type KeybindingConfig,
  type KeybindingManager,
  type BindingMap,
} from './keybindings.js';
import { type KeyEvent } from './keyInput.js';
import {
  accentBright,
  dim,
  ghost,
  buttonFocused,
  muted,
  primary,
  warning,
  error as errorColor,
  success,
  bold,
} from './theme.js';

// ─── Types ───────────────────────────────────────────────────────────────────────

export interface ActionItem {
  context: string;
  action: string;
  currentKeys: string[];
}

export interface ValidationResult {
  valid: boolean;
  level: 'info' | 'warn' | 'error';
  message: string;
}

type Operation = 'add' | 'replace' | 'remove';

// ─── Config path ─────────────────────────────────────────────────────────────────

/** Get the keybinding config file path (~/.babel_keybindings.json). */
export function getKeybindingConfigPath(): string {
  return join(homedir(), '.babel_keybindings.json');
}

// ─── Validation ───────────────────────────────────────────────────────────────────

/**
 * Validate a key descriptor against context-specific rules and existing bindings.
 *
 * Rules:
 *   1. Bare Escape is reserved for cancel in chat/governed contexts
 *   2. Bare Ctrl+C is reserved for double-tap exit in governed context
 *   3. Warn if the key is already bound to a different action in the same context
 *   4. Warn if the key matches a global binding
 */
export function validateBinding(
  keyDescriptor: string,
  context: string,
  _action: string,
  _keybindingManager: KeybindingManager,
  allActions: ActionItem[],
): ValidationResult {
  // Rule 1: Bare Escape in chat/governed
  if ((context === 'governed' || context === 'chat') && keyDescriptor === 'Escape') {
    return {
      valid: false,
      level: 'error',
      message: `Cannot bind bare Escape in "${context}" context — it is reserved for cancel.`,
    };
  }

  // Rule 2: Bare Ctrl+C in governed
  if (context === 'governed' && keyDescriptor === 'Ctrl+C') {
    return {
      valid: false,
      level: 'error',
      message: 'Cannot bind bare Ctrl+C in "governed" context — it is reserved for double-tap exit.',
    };
  }

  const warnings: string[] = [];

  // Rule 3: Same key used by a different action in this context
  const sameCtxActions = allActions.filter(
    (a) => a.context === context && a.action !== _action,
  );
  for (const other of sameCtxActions) {
    if (other.currentKeys.includes(keyDescriptor)) {
      warnings.push(
        `"${keyDescriptor}" is also bound to "${other.action}" in this context.`,
      );
    }
  }

  // Rule 4: Key matches a global binding
  const globalActions = allActions.filter((a) => a.context === 'global');
  for (const glob of globalActions) {
    if (glob.currentKeys.includes(keyDescriptor)) {
      warnings.push(
        `"${keyDescriptor}" is also a global binding for "${glob.action}".`,
      );
    }
  }

  if (warnings.length > 0) {
    return { valid: true, level: 'warn', message: warnings.join('  ') };
  }

  return { valid: true, level: 'info', message: '' };
}

// ─── Config merge ─────────────────────────────────────────────────────────────────

/**
 * Apply a change to the keybinding config and write atomically to disk.
 *
 * @returns The updated config (written to disk).
 */
export function applyConfigChange(
  keybindingManager: KeybindingManager,
  selected: ActionItem,
  operation: Operation,
  keyDescriptor: string,
  /** Override path for testing (default: ~/.babel_keybindings.json) */
  configPath?: string,
): KeybindingConfig {
  const path = configPath ?? getKeybindingConfigPath();

  // Read existing config
  let config: KeybindingConfig = {};
  try {
    config = JSON.parse(readFileSync(path, 'utf-8')) as KeybindingConfig;
    if (typeof config !== 'object' || config === null || Array.isArray(config)) {
      config = {};
    }
  } catch {
    config = {};
  }

  // Ensure context map exists
  if (!config[selected.context]) {
    (config as Record<string, BindingMap | undefined>)[selected.context] = {};
  }
  const ctx = config[selected.context]!;

  if (operation === 'add') {
    if (!ctx[selected.action]) {
      ctx[selected.action] = [];
    }
    if (!ctx[selected.action]!.includes(keyDescriptor)) {
      ctx[selected.action]!.push(keyDescriptor);
    }
  } else if (operation === 'replace') {
    ctx[selected.action] = [keyDescriptor];
  } else if (operation === 'remove') {
    if (ctx[selected.action]) {
      ctx[selected.action] = ctx[selected.action]!.filter((k) => k !== keyDescriptor);
      if (ctx[selected.action]!.length === 0) {
        delete ctx[selected.action];
      }
    }
  }

  // Remove empty contexts
  if (Object.keys(ctx).length === 0) {
    delete (config as Record<string, BindingMap | undefined>)[selected.context];
  }

  // Atomic write: write to temp, rename over original
  const tmpPath = path + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  renameSync(tmpPath, path);

  // Reload the manager to pick up changes
  keybindingManager.reload();

  return config;
}

// ─── Gather all available actions ─────────────────────────────────────────────────

/**
 * Collect all bindable actions from the defaults, resolving current keys
 * through the KeybindingManager (so user overrides show up).
 */
export function getAllActions(keybindingManager: KeybindingManager): ActionItem[] {
  const items: ActionItem[] = [];
  const defaults = DEFAULT_BINDINGS as Record<string, BindingMap>;

  for (const [context, bindings] of Object.entries(defaults)) {
    for (const action of Object.keys(bindings)) {
      const currentKeys = keybindingManager.getBindings(context, action);
      items.push({ context, action, currentKeys: [...currentKeys] });
    }
  }

  // Sort: first by context, then by action name
  items.sort((a, b) => {
    if (a.context !== b.context) return a.context.localeCompare(b.context);
    return a.action.localeCompare(b.action);
  });

  return items;
}

// ─── Action Picker Dialog ─────────────────────────────────────────────────────────

/**
 * A scrollable dialog showing all bindable actions grouped by context.
 * Each row shows the action name and current key bindings.
 * Up/Down to navigate, Enter to select, Escape to cancel.
 */
class ActionPickerDialog extends Dialog<ActionItem | null> {
  private items: ActionItem[];
  private selectedIndex: number = 0;
  private scrollOffset: number = 0;

  constructor(config: DialogConfig, items: ActionItem[]) {
    super(config);
    this.items = items;
  }

  static async show(config: DialogConfig, items: ActionItem[]): Promise<ActionItem | null> {
    const dialog = new ActionPickerDialog(config, items);
    return DialogManager.getInstance().open(dialog);
  }

  override handleKey(event: KeyEvent): boolean {
    if (event.name === 'enter') {
      this.resolve(this.items[this.selectedIndex] ?? null);
      return true;
    }
    if (event.name === 'escape') {
      this.resolve(null);
      return true;
    }
    if (event.name === 'up') {
      if (this.selectedIndex > 0) {
        this.selectedIndex--;
        this.adjustScroll();
        this.markDirty();
        this.renderToScreen();
      }
      return true;
    }
    if (event.name === 'down') {
      if (this.selectedIndex < this.items.length - 1) {
        this.selectedIndex++;
        this.adjustScroll();
        this.markDirty();
        this.renderToScreen();
      }
      return true;
    }
    return false;
  }

  // ── Scroll logic ──────────────────────────────────────────────────────────────

  /**
   * Compute the display line number (0-based) for a given item index,
   * accounting for group header lines inserted between context groups.
   */
  private getItemDisplayLine(itemIndex: number): number {
    let line = 0;
    let currentContext = '';
    for (let i = 0; i < this.items.length; i++) {
      const item = this.items[i]!;
      if (item.context !== currentContext) {
        currentContext = item.context;
        line++; // header line
      }
      if (i === itemIndex) return line;
      line++;
    }
    return 0;
  }

  /**
   * Compute the total number of display lines (headers + items).
   */
  private getTotalDisplayLines(): number {
    let count = 0;
    let currentContext = '';
    for (const item of this.items) {
      if (item.context !== currentContext) {
        currentContext = item.context;
        count++; // header line
      }
      count++;
    }
    return count;
  }

  /**
   * Return the number of content lines that fit inside the dialog area
   * (accounting for borders, title, and footer hint).
   */
  private getMaxContentLines(): number {
    const rows = process.stdout.rows || 24;
    const maxHeightRatio = this.config.maxHeightRatio ?? 0.6;
    const maxDialogRows = Math.floor(rows * maxHeightRatio);
    // Subtract: 2 border lines + 1 title padding + 1 footer hint line + some margin
    return maxDialogRows - 6;
  }

  private adjustScroll(): void {
    const maxLines = this.getMaxContentLines();
    const selectedDisplayLine = this.getItemDisplayLine(this.selectedIndex);

    if (selectedDisplayLine < this.scrollOffset) {
      this.scrollOffset = selectedDisplayLine;
    } else if (selectedDisplayLine >= this.scrollOffset + maxLines) {
      this.scrollOffset = selectedDisplayLine - maxLines + 1;
    }

    // Clamp
    const totalLines = this.getTotalDisplayLines();
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, totalLines - maxLines));
  }

  // ── Display ───────────────────────────────────────────────────────────────────

  protected override buildContent(): string {
    // Build all display lines
    const allLines: string[] = [];
    const itemDisplayLines: number[] = [];
    let currentContext = '';

    for (let i = 0; i < this.items.length; i++) {
      const item = this.items[i]!;

      // Group header
      if (item.context !== currentContext) {
        currentContext = item.context;
        allLines.push(dim(`  ${currentContext}`));
      }

      // Item line
      const isSelected = i === this.selectedIndex;
      const indicator = isSelected ? accentBright('›') : ' ';
      const actionName = item.action.padEnd(22);
      const keysStr = item.currentKeys.length > 0
        ? ghost(item.currentKeys.join(', '))
        : dim('(no bindings)');

      let text: string;
      if (isSelected) {
        text = `  ${indicator} ${buttonFocused(actionName, false)} ${keysStr}`;
      } else {
        text = `  ${indicator}  ${actionName} ${keysStr}`;
      }
      allLines.push(`  ${text}`);
      itemDisplayLines.push(allLines.length - 1);
    }

    // Apply scrolling
    const maxLines = this.getMaxContentLines();
    const startLine = Math.min(this.scrollOffset, Math.max(0, allLines.length - maxLines));
    const visibleLines = allLines.slice(startLine, startLine + maxLines);

    // Footer hint
    const hint = ghost('  arrows=navigate  Enter=select  Esc=cancel');
    const scrollHint =
      this.items.length > maxLines
        ? ghost('  (scrollable)')
        : '';

    const content = [...visibleLines, '', `${hint}${scrollHint}`].join('\n');

    return this.createFrame(content);
  }
}

// ─── Key Capture Dialog ───────────────────────────────────────────────────────────

/**
 * A two-phase dialog:
 *   Phase 1 — capture: displays "Press key combo…", captures first keypress
 *   Phase 2 — confirm: shows the captured key, asks Save / Retry / Cancel
 *
 * Returns the serialized key descriptor string, or null on cancel.
 */
class KeyCaptureDialog extends Dialog<string | null> {
  private phase: 'capturing' | 'confirming' = 'capturing';
  private capturedDescriptor: string = '';
  private validationMessage: string = '';
  private validationLevel: 'info' | 'warn' | 'error' = 'info';
  private actionLabel: string;

  constructor(
    config: DialogConfig,
    private actionContext: string,
    private actionName: string,
    private operation: 'add' | 'replace',
    private capturedEvent: KeyEvent | null,
    private allActions: ActionItem[],
    private keybindingManager: KeybindingManager,
  ) {
    super(config);
    this.actionLabel = `${actionContext} › ${actionName}`;
  }

  static async show(
    config: DialogConfig,
    actionContext: string,
    actionName: string,
    operation: 'add' | 'replace',
    capturedEvent: KeyEvent | null,
    allActions: ActionItem[],
    keybindingManager: KeybindingManager,
  ): Promise<string | null> {
    const dialog = new KeyCaptureDialog(
      config,
      actionContext,
      actionName,
      operation,
      capturedEvent,
      allActions,
      keybindingManager,
    );
    return DialogManager.getInstance().open(dialog);
  }

  override handleKey(event: KeyEvent): boolean {
    if (this.phase === 'capturing') {
      // Escape during capture -> cancel
      if (event.name === 'escape' && !event.ctrl && !event.meta) {
        this.resolve(null);
        return true;
      }

      // Capture the key event
      this.capturedEvent = event;
      this.capturedDescriptor = serializeKeyEvent(event);
      this.capturedEvent = event;

      // Validate
      const validation = validateBinding(
        this.capturedDescriptor,
        this.actionContext,
        this.actionName,
        this.keybindingManager,
        this.allActions,
      );
      this.validationMessage = validation.message;
      this.validationLevel = validation.level;

      this.phase = 'confirming';
      this.markDirty();
      this.renderToScreen();
      return true;
    }

    // ── Confirming phase ────────────────────────────────────────────────────
    if (this.phase === 'confirming') {
      if (event.name === 'enter') {
        // Save — even with warnings, user can proceed
        this.resolve(this.capturedDescriptor);
        return true;
      }

      if (event.name === 'escape' && !event.ctrl && !event.meta) {
        // Retry — go back to capturing
        this.phase = 'capturing';
        this.capturedDescriptor = '';
        this.validationMessage = '';
        this.markDirty();
        this.renderToScreen();
        return true;
      }

      if (event.name === 'c' && event.ctrl) {
        // Cancel the whole wizard interaction
        this.resolve(null);
        return true;
      }

      // Consume all other keys during confirmation
      return true;
    }

    return false;
  }

  protected override buildContent(): string {
    if (this.phase === 'capturing') {
      const label = this.operation === 'replace'
        ? `Replace bindings for ${this.actionLabel}`
        : `Add binding to ${this.actionLabel}`;

      return this.createFrame(
        [
          `  ${primary(label)}`,
          '',
          `  ${bold('Press the key combination…')}`,
          '',
          `  ${ghost('(Esc to cancel)')}`,
        ].join('\n'),
      );
    }

    // Confirming phase
    const keyDisplay = accentBright(`  ${this.capturedDescriptor}  `);

    let validationLine = '';
    if (this.validationLevel === 'error') {
      validationLine = `  ${errorColor(this.validationMessage)}`;
    } else if (this.validationLevel === 'warn') {
      validationLine = `  ${warning(this.validationMessage)}`;
    } else if (this.validationMessage) {
      validationLine = `  ${muted(this.validationMessage)}`;
    }

    const statusLine = this.validationLevel === 'error'
      ? errorColor('Cannot bind this key.')
      : success('Key captured!');

    return this.createFrame(
      [
        `  ${primary(this.actionLabel)}`,
        '',
        `  ${statusLine}`,
        '',
        `  ${keyDisplay}`,
        validationLine ? '' : undefined,
        validationLine ? validationLine : undefined,
        '',
        this.validationLevel === 'error'
          ? `  ${ghost('[Esc=Retry]  [Ctrl+C=Cancel]')}`
          : `  ${ghost('[Enter=Save]  [Esc=Retry]  [Ctrl+C=Cancel]')}`,
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }
}

// ─── Binding picker dialog (for 'remove' operation) ───────────────────────────────

/**
 * A simple dialog that shows the existing bindings for a given action
 * and lets the user pick which one to remove.
 */
class BindingPickerDialog extends Dialog<string | null> {
  private bindings: string[];
  private selectedIndex: number = 0;

  constructor(config: DialogConfig, bindings: string[]) {
    super(config);
    this.bindings = bindings;
  }

  static async show(config: DialogConfig, bindings: string[]): Promise<string | null> {
    const dialog = new BindingPickerDialog(config, bindings);
    return DialogManager.getInstance().open(dialog);
  }

  override handleKey(event: KeyEvent): boolean {
    if (event.name === 'enter') {
      const selected = this.bindings[this.selectedIndex] ?? null;
      this.resolve(selected);
      return true;
    }
    if (event.name === 'escape') {
      this.resolve(null);
      return true;
    }
    if (event.name === 'up') {
      if (this.selectedIndex > 0) {
        this.selectedIndex--;
        this.markDirty();
        this.renderToScreen();
      }
      return true;
    }
    if (event.name === 'down') {
      if (this.selectedIndex < this.bindings.length - 1) {
        this.selectedIndex++;
        this.markDirty();
        this.renderToScreen();
      }
      return true;
    }
    return false;
  }

  protected override buildContent(): string {
    const innerW = this.dialogWidth - 4;
    const lines: string[] = [];

    lines.push(`  ${muted('Select a binding to remove:')}`);
    lines.push('');

    for (let i = 0; i < this.bindings.length; i++) {
      const binding = this.bindings[i] ?? '';
      const isSelected = i === this.selectedIndex;
      const indicator = isSelected ? accentBright('›') : ' ';
      const display = isSelected
        ? `  ${indicator} ${buttonFocused(binding.padEnd(innerW - 6), false)}`
        : `  ${indicator}  ${binding}`;
      lines.push(display);
    }

    lines.push('');
    lines.push(ghost('  Enter=select  arrows=navigate  Esc=cancel'));

    return this.createFrame(lines.join('\n'));
  }
}

// ─── Operation picker (uses SelectDialog) ─────────────────────────────────────────

/**
 * Build the options array for the operation selection dialog.
 */
function buildOperationOptions(
  action: ActionItem,
): string[] {
  const opts: string[] = [];

  if (action.currentKeys.length > 0) {
    opts.push('+ Add binding');
  } else {
    opts.push('+ Add binding');
  }
  opts.push('= Replace all');
  if (action.currentKeys.length > 0) {
    opts.push('- Remove binding');
  }
  opts.push('Cancel');

  return opts;
}

function parseOperationChoice(
  selected: string | null,
): Operation | 'cancel' | null {
  if (!selected) return null;
  if (selected.startsWith('+')) return 'add';
  if (selected.startsWith('=')) return 'replace';
  if (selected.startsWith('-')) return 'remove';
  if (selected === 'Cancel') return 'cancel';
  return null;
}

// ─── Wizard ───────────────────────────────────────────────────────────────────────

export class KeybindingRemapWizard {
  constructor(private keybindingManager: KeybindingManager) {}

  /**
   * Run the full 3-step keybinding remapping wizard.
   *
   * Returns the new config if changes were made, null if the user canceled
   * at any point.
   */
  async run(): Promise<KeybindingConfig | null> {
    const allActions = getAllActions(this.keybindingManager);

    if (allActions.length === 0) {
      // No actions to remap — shouldn't happen with defaults, but guard
      return null;
    }

    // ── Step 1: Pick an action ──────────────────────────────────────────────
    const selectedAction = await this.stepPickAction(allActions);
    if (!selectedAction) return null;

    // ── Steps 2 & 3: Operation loop (allows retry) ──────────────────────────
    while (true) {
      const operation = await this.stepPickOperation(selectedAction);
      if (!operation || operation === 'cancel') return null;

      if (operation === 'remove') {
        // Pick which binding to remove
        const targetKey = await this.stepPickBinding(selectedAction);
        if (!targetKey) continue; // Escape -> back to operation picker

        // Apply (no capture needed for remove)
        return applyConfigChange(
          this.keybindingManager,
          selectedAction,
          'remove',
          targetKey,
        );
      }

      // For 'add' or 'replace': capture a key
      const capturedKey = await this.stepCaptureKey(
        selectedAction,
        operation,
        allActions,
      );
      if (!capturedKey) continue; // Escape -> back to operation picker

      // Apply the change
      return applyConfigChange(
        this.keybindingManager,
        selectedAction,
        operation,
        capturedKey,
      );
    }
  }

  // ── Step 1: Action Picker ──────────────────────────────────────────────────

  private async stepPickAction(
    allActions: ActionItem[],
  ): Promise<ActionItem | null> {
    const actionConfig: DialogConfig = {
      title: 'Choose action to remap',
      message: '',
      minWidth: 50,
      maxWidthRatio: 0.75,
      maxHeightRatio: 0.7,
    };

    return ActionPickerDialog.show(actionConfig, allActions);
  }

  // ── Step 2: Operation Picker ───────────────────────────────────────────────

  private async stepPickOperation(
    selected: ActionItem,
  ): Promise<Operation | 'cancel' | null> {
    const keys = selected.currentKeys;

    const opts: string[] = [];
    opts.push('+ Add binding');
    opts.push('= Replace all');
    if (keys.length > 0) {
      opts.push('- Remove binding');
    }
    opts.push('Cancel');

    const selectedOpt = await SelectDialog.show({
      title: `Choose operation for ${selected.context} › ${selected.action}`,
      message: keys.length > 0
        ? `Current bindings: ${keys.join(', ')}`
        : 'No current bindings',
      options: opts,
      allowCancel: true,
      minWidth: 48,
      maxWidthRatio: 0.7,
      maxHeightRatio: 0.5,
    });

    if (!selectedOpt) return null; // Escape -> cancel

    if (selectedOpt === 'Cancel') return 'cancel';

    if (selectedOpt.startsWith('+')) return 'add';
    if (selectedOpt.startsWith('=')) return 'replace';
    if (selectedOpt.startsWith('-')) return 'remove';

    return null;
  }

  // ── Step (Remove sub): Pick binding to remove ──────────────────────────────

  private async stepPickBinding(
    selected: ActionItem,
  ): Promise<string | null> {
    if (selected.currentKeys.length === 0) return null;

    return BindingPickerDialog.show(
      {
        title: `Remove binding for ${selected.context} › ${selected.action}`,
        message: '',
        minWidth: 46,
        maxWidthRatio: 0.65,
        maxHeightRatio: 0.5,
      },
      selected.currentKeys,
    );
  }

  // ── Step 3: Key Capture ────────────────────────────────────────────────────

  private async stepCaptureKey(
    selected: ActionItem,
    operation: 'add' | 'replace',
    allActions: ActionItem[],
  ): Promise<string | null> {
    return KeyCaptureDialog.show(
      {
        title:
          operation === 'replace'
            ? 'Replace all bindings'
            : 'Add binding',
        message: '',
        minWidth: 50,
        maxWidthRatio: 0.7,
        maxHeightRatio: 0.5,
      },
      selected.context,
      selected.action,
      operation,
      null,
      allActions,
      this.keybindingManager,
    );
  }
}

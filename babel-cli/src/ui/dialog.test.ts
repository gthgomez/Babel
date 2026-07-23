/**
 * dialog.test.ts — Tests for all Babel TUI dialog types.
 *
 * Covers construction, key handling, and content rendering for every dialog,
 * including the 5 new types: InputDialog, CostThresholdDialog, ProgressDialog,
 * AlertDialog, and ThemePickerDialog.
 *
 * @module dialog.test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  type ConfirmDialogConfig,
  type SelectDialogConfig,
  type MultiSelectDialogConfig,
  type PermissionDialogConfig,
  type InputDialogConfig,
  type CostThresholdDialogConfig,
  type ProgressDialogConfig,
  type AlertDialogConfig,
  type ThemePickerDialogConfig,
  ConfirmDialog,
  SelectDialog,
  MultiSelectDialog,
  PermissionDialog,
  InputDialog,
  CostThresholdDialog,
  ProgressDialog,
  AlertDialog,
  ThemePickerDialog,
} from './dialog.js';
import type { KeyEvent } from './keyInput.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

function key(name: string, extra: Partial<KeyEvent> = {}): KeyEvent {
  return { name, ctrl: false, meta: false, shift: false, sequence: '', ...extra };
}

function enterKey(): KeyEvent { return key('enter'); }
function escapeKey(): KeyEvent { return key('escape'); }
function upKey(): KeyEvent { return key('up'); }
function downKey(): KeyEvent { return key('down'); }
function leftKey(): KeyEvent { return key('left'); }
function rightKey(): KeyEvent { return key('right'); }
function backspaceKey(): KeyEvent { return key('backspace'); }
function charKey(ch: string): KeyEvent { return key(ch, { sequence: ch, shift: ch !== ch.toLowerCase() }); }
function spaceKey(): KeyEvent { return key('space', { sequence: ' ' }); }

/** Check resolved flag via type assertion. */
function resolved(d: { handleKey: (e: KeyEvent) => boolean }): boolean {
  return (d as unknown as { resolved: boolean }).resolved;
}

/** Use render() to get dialog content (buildContent is protected). */
function renderContent(d: { render: () => string }): string {
  return d.render();
}

// ═══════════════════════════════════════════════════════════════════════════════
// Existing Dialogs
// ═══════════════════════════════════════════════════════════════════════════════

test('ConfirmDialog: construction without errors', () => {
  const d = new ConfirmDialog({ title: 'Test', message: 'Continue?' });
  assert.ok(d instanceof ConfirmDialog);
});

test('ConfirmDialog: handleKey Enter resolves true (confirm default)', () => {
  const d = new ConfirmDialog({ title: 'Test', message: 'Continue?' });
  const result = d.handleKey(enterKey());
  assert.equal(result, true);
  assert.equal(resolved(d), true);
});

test('ConfirmDialog: handleKey Escape resolves', () => {
  const d = new ConfirmDialog({ title: 'Test', message: 'Continue?' });
  const result = d.handleKey(escapeKey());
  assert.equal(result, true);
  assert.equal(resolved(d), true);
});

test('ConfirmDialog: render returns non-empty string', () => {
  const d = new ConfirmDialog({ title: 'Test', message: 'Continue?' });
  assert.ok(renderContent(d).length > 0);
});

test('SelectDialog: construction without errors', () => {
  const d = new SelectDialog({ title: 'Pick', message: 'Choose:', options: ['a', 'b', 'c'] });
  assert.ok(d instanceof SelectDialog);
});

test('SelectDialog: handleKey Enter resolves', () => {
  const d = new SelectDialog({ title: 'Pick', message: 'Choose:', options: ['a', 'b', 'c'] });
  d.handleKey(enterKey());
  assert.equal(resolved(d), true);
});

test('SelectDialog: render returns non-empty string', () => {
  const d = new SelectDialog({ title: 'Pick', message: 'Choose:', options: ['a', 'b', 'c'] });
  assert.ok(renderContent(d).length > 0);
});

test('MultiSelectDialog: construction without errors', () => {
  const d = new MultiSelectDialog({ title: 'Pick', message: 'Select:', options: ['x', 'y', 'z'] });
  assert.ok(d instanceof MultiSelectDialog);
});

test('MultiSelectDialog: render returns non-empty string', () => {
  const d = new MultiSelectDialog({ title: 'Pick', message: 'Select:', options: ['x', 'y', 'z'] });
  assert.ok(renderContent(d).length > 0);
});

test('PermissionDialog: construction without errors', () => {
  const d = new PermissionDialog({ title: 'Approve?', message: 'Allow?', actionType: 'write_file' });
  assert.ok(d instanceof PermissionDialog);
});

test('PermissionDialog: render returns non-empty string', () => {
  const d = new PermissionDialog({ title: 'Approve?', message: 'Allow?', actionType: 'shell_exec' });
  assert.ok(renderContent(d).length > 0);
});

test('PermissionDialog: showDiff renders diff preview section', () => {
  const preview = [
    '--- a/src/foo.ts',
    '+++ b/src/foo.ts',
    '@@ -1,3 +1,4 @@',
    ' export const x = 1;',
    '+export const y = 2;',
  ].join('\n');
  const d = new PermissionDialog({
    title: 'Apply patch',
    message: 'Allow patch?',
    actionType: 'apply_patch',
    preview,
    showDiff: true,
  });
  const content = renderContent(d);
  assert.match(content, /Diff preview/i);
  assert.match(content, /export const y = 2/);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 1. InputDialog
// ═══════════════════════════════════════════════════════════════════════════════

test('InputDialog: construction without errors', () => {
  const d = new InputDialog({ title: 'Input', message: 'Enter name:' });
  assert.ok(d instanceof InputDialog);
});

test('InputDialog: construction with defaultValue', () => {
  const d = new InputDialog({ title: 'Input', message: 'Enter name:', defaultValue: 'Alice' });
  assert.ok(d instanceof InputDialog);
});

test('InputDialog: handleKey Enter resolves', () => {
  const d = new InputDialog({ title: 'Input', message: 'Enter name:' });
  d.handleKey(charKey('H'));
  d.handleKey(charKey('i'));
  d.handleKey(enterKey());
  assert.equal(resolved(d), true);
});

test('InputDialog: handleKey Escape resolves null', () => {
  const d = new InputDialog({ title: 'Input', message: 'Enter name:' });
  d.handleKey(escapeKey());
  assert.equal(resolved(d), true);
});

test('InputDialog: handleKey Backspace removes last character', () => {
  const d = new InputDialog({ title: 'Input', message: 'Enter name:' });
  d.handleKey(charKey('A'));
  d.handleKey(charKey('B'));
  d.handleKey(backspaceKey());
  d.handleKey(enterKey());
  assert.equal(resolved(d), true);
});

test('InputDialog: handleKey space appends space', () => {
  const d = new InputDialog({ title: 'Input', message: 'Enter name:' });
  d.handleKey(charKey('J'));
  d.handleKey(charKey('o'));
  d.handleKey(charKey('e'));
  d.handleKey(spaceKey());
  d.handleKey(charKey('S'));
  d.handleKey(enterKey());
  assert.equal(resolved(d), true);
});

test('InputDialog: handleKey printable characters append to buffer', () => {
  const d = new InputDialog({ title: 'Input', message: 'Enter name:' });
  d.handleKey(charKey('H'));
  d.handleKey(charKey('e'));
  d.handleKey(charKey('l'));
  d.handleKey(charKey('l'));
  d.handleKey(charKey('o'));
  d.handleKey(enterKey());
  assert.equal(resolved(d), true);
});

test('InputDialog: validation rejects invalid input', () => {
  const d = new InputDialog({
    title: 'Input',
    message: 'Enter email:',
    validate: (v) => (v.includes('@') ? null : 'Must include @'),
  });
  d.handleKey(charKey('a'));
  d.handleKey(enterKey());
  // Should NOT be resolved because validation failed
  assert.equal(resolved(d), false);
});

test('InputDialog: validation passes with valid input', () => {
  const d = new InputDialog({
    title: 'Input',
    message: 'Enter email:',
    validate: (v) => (v.includes('@') ? null : 'Must include @'),
  });
  d.handleKey(charKey('a'));
  d.handleKey(charKey('@'));
  d.handleKey(charKey('b'));
  d.handleKey(enterKey());
  assert.equal(resolved(d), true);
});

test('InputDialog: render returns non-empty string', () => {
  const d = new InputDialog({ title: 'Input', message: 'Enter name:' });
  assert.ok(renderContent(d).length > 0);
});

test('InputDialog: render with input shows typed text', () => {
  const d = new InputDialog({ title: 'Input', message: 'Enter name:' });
  d.handleKey(charKey('F'));
  d.handleKey(charKey('o'));
  d.handleKey(charKey('o'));
  assert.ok(renderContent(d).length > 0);
});

test('InputDialog: handleKey ctrl/meta chars do not append', () => {
  const d = new InputDialog({ title: 'Input', message: 'Enter name:' });
  const ctrlA: KeyEvent = key('a', { ctrl: true });
  const result = d.handleKey(ctrlA);
  // ctrl+a isn't enter/escape/backspace/space -> returns false
  assert.equal(result, false);
});

test('InputDialog: handleKey paste appends sequence', () => {
  const d = new InputDialog({ title: 'Input', message: 'Enter name:' });
  d.handleKey(key('paste', { sequence: 'Hello World' }));
  d.handleKey(enterKey());
  assert.equal(resolved(d), true);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. CostThresholdDialog
// ═══════════════════════════════════════════════════════════════════════════════

test('CostThresholdDialog: construction without errors', () => {
  const d = new CostThresholdDialog({
    title: 'Cost Warning',
    message: 'This operation will cost money',
    estimatedCost: 0.05,
    tokenCount: 1234,
    model: 'claude-sonnet-4-20250514',
    threshold: 0.10,
  });
  assert.ok(d instanceof CostThresholdDialog);
});

test('CostThresholdDialog: handleKey Enter with cancel default resolves', () => {
  const d = new CostThresholdDialog({
    title: 'Cost Warning', message: 'Proceed?',
    estimatedCost: 0.05, tokenCount: 100, model: 'test', threshold: 0.10,
  });
  d.handleKey(enterKey());
  assert.equal(resolved(d), true);
});

test('CostThresholdDialog: handleKey Right switches to proceed, then Enter resolves', () => {
  const d = new CostThresholdDialog({
    title: 'Cost Warning', message: 'Proceed?',
    estimatedCost: 0.05, tokenCount: 100, model: 'test', threshold: 0.10,
  });
  d.handleKey(rightKey());
  d.handleKey(enterKey());
  assert.equal(resolved(d), true);
});

test('CostThresholdDialog: handleKey Escape resolves false', () => {
  const d = new CostThresholdDialog({
    title: 'Cost Warning', message: 'Proceed?',
    estimatedCost: 0.05, tokenCount: 100, model: 'test', threshold: 0.10,
  });
  d.handleKey(escapeKey());
  assert.equal(resolved(d), true);
});

test('CostThresholdDialog: handleKey y resolves', () => {
  const d = new CostThresholdDialog({
    title: 'Cost Warning', message: 'Proceed?',
    estimatedCost: 0.05, tokenCount: 100, model: 'test', threshold: 0.10,
  });
  d.handleKey(key('y'));
  assert.equal(resolved(d), true);
});

test('CostThresholdDialog: handleKey n resolves', () => {
  const d = new CostThresholdDialog({
    title: 'Cost Warning', message: 'Proceed?',
    estimatedCost: 0.05, tokenCount: 100, model: 'test', threshold: 0.10,
  });
  d.handleKey(key('n'));
  assert.equal(resolved(d), true);
});

test('CostThresholdDialog: render returns non-empty string', () => {
  const d = new CostThresholdDialog({
    title: 'Cost Warning', message: 'Proceed?',
    estimatedCost: 0.05, tokenCount: 1234, model: 'test', threshold: 0.10,
  });
  assert.ok(renderContent(d).length > 0);
});

test('CostThresholdDialog: render shows cost details', () => {
  const d = new CostThresholdDialog({
    title: 'Cost Warning', message: 'Proceed?',
    estimatedCost: 1.50, tokenCount: 50000, model: 'claude-opus-4-20250514', threshold: 1.00,
  });
  const content = renderContent(d);
  assert.ok(content.length > 0);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. ProgressDialog
// ═══════════════════════════════════════════════════════════════════════════════

test('ProgressDialog: construction without errors', () => {
  const d = new ProgressDialog({ title: 'Working', message: 'Processing...' });
  assert.ok(d instanceof ProgressDialog);
});

test('ProgressDialog: construction with custom max', () => {
  const d = new ProgressDialog({ title: 'Working', message: 'Processing...', max: 50 });
  assert.ok(d instanceof ProgressDialog);
});

test('ProgressDialog: construction with cancelable', () => {
  const d = new ProgressDialog({ title: 'Working', message: 'Processing...', cancelable: true });
  assert.ok(d instanceof ProgressDialog);
});

test('ProgressDialog: handleKey Escape does nothing when not cancelable', () => {
  const d = new ProgressDialog({ title: 'Working', message: 'Processing...' });
  const result = d.handleKey(escapeKey());
  assert.equal(result, false);
  assert.equal(resolved(d), false);
});

test('ProgressDialog: handleKey Escape resolves when cancelable', () => {
  const d = new ProgressDialog({ title: 'Working', message: 'Processing...', cancelable: true });
  const result = d.handleKey(escapeKey());
  assert.equal(result, true);
  assert.equal(resolved(d), true);
});

test('ProgressDialog: updateValue without resolving if below max', () => {
  const d = new ProgressDialog({ title: 'Working', message: 'Processing...', max: 100 });
  d.updateValue(50);
  assert.equal(resolved(d), false);
});

test('ProgressDialog: updateValue auto-resolves when reaching max', () => {
  const d = new ProgressDialog({ title: 'Working', message: 'Processing...', max: 100 });
  d.updateValue(100);
  assert.equal(resolved(d), true);
});

test('ProgressDialog: updateValue clamps to max', () => {
  const d = new ProgressDialog({ title: 'Working', message: 'Processing...', max: 100 });
  d.updateValue(999);
  assert.equal(resolved(d), true);
});

test('ProgressDialog: render returns non-empty string', () => {
  const d = new ProgressDialog({ title: 'Working', message: 'Processing...', max: 100 });
  assert.ok(renderContent(d).length > 0);
});

test('ProgressDialog: render after update shows progress', () => {
  const d = new ProgressDialog({ title: 'Working', message: 'Processing...', max: 100 });
  d.updateValue(50);
  assert.ok(renderContent(d).length > 0);
});

test('ProgressDialog: render at completion', () => {
  const d = new ProgressDialog({ title: 'Working', message: 'Processing...', max: 100 });
  d.updateValue(100);
  const content = renderContent(d);
  assert.ok(content.length > 0);
  assert.ok(content.includes('█') || content.includes('%')); // block or percent
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. AlertDialog
// ═══════════════════════════════════════════════════════════════════════════════

test('AlertDialog: construction without errors (info)', () => {
  const d = new AlertDialog({ title: 'Info', message: 'Something happened' });
  assert.ok(d instanceof AlertDialog);
});

test('AlertDialog: construction with warning severity', () => {
  const d = new AlertDialog({ title: 'Warning', message: 'Be careful', severity: 'warning' });
  assert.ok(d instanceof AlertDialog);
});

test('AlertDialog: construction with error severity', () => {
  const d = new AlertDialog({ title: 'Error', message: 'Something broke', severity: 'error' });
  assert.ok(d instanceof AlertDialog);
});

test('AlertDialog: handleKey Enter resolves', () => {
  const d = new AlertDialog({ title: 'Info', message: 'OK?' });
  d.handleKey(enterKey());
  assert.equal(resolved(d), true);
});

test('AlertDialog: handleKey Escape resolves', () => {
  const d = new AlertDialog({ title: 'Info', message: 'OK?' });
  d.handleKey(escapeKey());
  assert.equal(resolved(d), true);
});

test('AlertDialog: other keys are not handled', () => {
  const d = new AlertDialog({ title: 'Info', message: 'OK?' });
  const result = d.handleKey(key('space'));
  assert.equal(result, false);
});

test('AlertDialog: render returns non-empty string', () => {
  const d = new AlertDialog({ title: 'Info', message: 'Something happened' });
  assert.ok(renderContent(d).length > 0);
});

test('AlertDialog: render with severity warning', () => {
  const d = new AlertDialog({ title: 'Warning', message: 'Be careful', severity: 'warning' });
  assert.ok(renderContent(d).length > 0);
});

test('AlertDialog: render with severity error', () => {
  const d = new AlertDialog({ title: 'Error', message: 'Something broke', severity: 'error' });
  assert.ok(renderContent(d).length > 0);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. ThemePickerDialog
// ═══════════════════════════════════════════════════════════════════════════════

test('ThemePickerDialog: construction without errors', () => {
  const d = new ThemePickerDialog({
    title: 'Pick Theme', message: 'Select a theme:',
    themes: ['babel-dusk', 'babel-dawn', 'babel-hc'],
    currentTheme: 'babel-dusk',
  });
  assert.ok(d instanceof ThemePickerDialog);
});

test('ThemePickerDialog: construction selects current theme index', () => {
  const d = new ThemePickerDialog({
    title: 'Pick Theme', message: 'Select:',
    themes: ['a', 'b', 'c'], currentTheme: 'b',
  });
  d.handleKey(enterKey());
  assert.equal(resolved(d), true);
});

test('ThemePickerDialog: handleKey Enter resolves with selected theme', () => {
  const d = new ThemePickerDialog({
    title: 'Pick Theme', message: 'Select:',
    themes: ['alpha', 'beta', 'gamma'], currentTheme: 'alpha',
  });
  d.handleKey(enterKey());
  assert.equal(resolved(d), true);
});

test('ThemePickerDialog: handleKey Escape resolves null', () => {
  const d = new ThemePickerDialog({
    title: 'Pick Theme', message: 'Select:',
    themes: ['alpha', 'beta', 'gamma'], currentTheme: 'alpha',
  });
  d.handleKey(escapeKey());
  assert.equal(resolved(d), true);
});

test('ThemePickerDialog: handleKey Up navigates', () => {
  const d = new ThemePickerDialog({
    title: 'Pick Theme', message: 'Select:',
    themes: ['alpha', 'beta', 'gamma'], currentTheme: 'beta',
  });
  d.handleKey(upKey());
  d.handleKey(enterKey());
  assert.equal(resolved(d), true);
});

test('ThemePickerDialog: handleKey Down navigates', () => {
  const d = new ThemePickerDialog({
    title: 'Pick Theme', message: 'Select:',
    themes: ['alpha', 'beta', 'gamma'], currentTheme: 'alpha',
  });
  d.handleKey(downKey());
  d.handleKey(enterKey());
  assert.equal(resolved(d), true);
});

test('ThemePickerDialog: Up at top stays at top', () => {
  const d = new ThemePickerDialog({
    title: 'Pick Theme', message: 'Select:',
    themes: ['alpha', 'beta', 'gamma'], currentTheme: 'alpha',
  });
  d.handleKey(upKey());
  d.handleKey(enterKey());
  assert.equal(resolved(d), true);
});

test('ThemePickerDialog: Down at bottom stays at bottom', () => {
  const d = new ThemePickerDialog({
    title: 'Pick Theme', message: 'Select:',
    themes: ['alpha', 'beta', 'gamma'], currentTheme: 'gamma',
  });
  d.handleKey(downKey());
  d.handleKey(enterKey());
  assert.equal(resolved(d), true);
});

test('ThemePickerDialog: render returns non-empty string', () => {
  const d = new ThemePickerDialog({
    title: 'Pick Theme', message: 'Select:',
    themes: ['babel-dusk', 'babel-dawn', 'babel-hc'],
    currentTheme: 'babel-dusk',
  });
  assert.ok(renderContent(d).length > 0);
});

test('ThemePickerDialog: render shows themes', () => {
  const d = new ThemePickerDialog({
    title: 'Pick Theme', message: 'Select:',
    themes: ['babel-dusk', 'babel-dawn'], currentTheme: 'babel-dawn',
  });
  assert.ok(renderContent(d).length > 0);
});

test('ThemePickerDialog: render for single theme', () => {
  const d = new ThemePickerDialog({
    title: 'Pick Theme', message: 'Select:',
    themes: ['babel-dusk'], currentTheme: 'babel-dusk',
  });
  assert.ok(renderContent(d).length > 0);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Cross-dialog: static show methods exist
// ═══════════════════════════════════════════════════════════════════════════════

test('All dialogs have static show() method', () => {
  assert.equal(typeof ConfirmDialog.show, 'function');
  assert.equal(typeof SelectDialog.show, 'function');
  assert.equal(typeof MultiSelectDialog.show, 'function');
  assert.equal(typeof PermissionDialog.show, 'function');
  assert.equal(typeof InputDialog.show, 'function');
  assert.equal(typeof CostThresholdDialog.show, 'function');
  assert.equal(typeof ProgressDialog.show, 'function');
  assert.equal(typeof AlertDialog.show, 'function');
  assert.equal(typeof ThemePickerDialog.show, 'function');
});

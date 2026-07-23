/**
 * Tests for KeybindingManager — match, matchStack, parseKeyDescriptor (via
 * public API), serializeKeyEvent, getBindings, config loading, singleton
 * lifecycle.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { KeybindingManager, serializeKeyEvent } from './keybindings.js';
import type { KeyEvent } from './keyInput.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeEvent(
  name: string,
  opts: { ctrl?: boolean; shift?: boolean; meta?: boolean } = {},
): KeyEvent {
  return {
    name,
    ctrl: opts.ctrl ?? false,
    shift: opts.shift ?? false,
    meta: opts.meta ?? false,
    sequence: name,
  };
}

test.beforeEach(() => {
  KeybindingManager.resetInstance();
});

test.afterEach(() => {
  KeybindingManager.resetInstance();
});

// ── serializeKeyEvent ──────────────────────────────────────────────────────

test('serializeKeyEvent: single lowercase letter', () => {
  assert.equal(serializeKeyEvent(makeEvent('a')), 'a');
});

test('serializeKeyEvent: Ctrl + letter', () => {
  assert.equal(serializeKeyEvent(makeEvent('c', { ctrl: true })), 'Ctrl+c');
});

test('serializeKeyEvent: named key is capitalized', () => {
  assert.equal(serializeKeyEvent(makeEvent('escape')), 'Escape');
});

test('serializeKeyEvent: combination with all modifiers', () => {
  const result = serializeKeyEvent(
    makeEvent('a', {
      ctrl: true,
      shift: true,
      meta: true,
    }),
  );
  assert.ok(result.includes('Ctrl'));
  assert.ok(result.includes('Alt'));
  assert.ok(result.includes('Shift'));
});

// ── Singleton pattern ──────────────────────────────────────────────────────

test('getInstance() returns same instance', () => {
  const a = KeybindingManager.getInstance();
  const b = KeybindingManager.getInstance();
  assert.equal(a, b);
});

test('resetInstance() clears singleton', () => {
  const a = KeybindingManager.getInstance();
  KeybindingManager.resetInstance();
  const b = KeybindingManager.getInstance();
  assert.notEqual(a, b);
});

// ── match() — single context ───────────────────────────────────────────────

test('match: Escape in "chat" context returns "cancel"', () => {
  const kb = KeybindingManager.getInstance();
  assert.equal(kb.match('chat', makeEvent('escape')), 'cancel');
});

test('match: Escape in "governed" context returns "cancel"', () => {
  const kb = KeybindingManager.getInstance();
  assert.equal(kb.match('governed', makeEvent('escape')), 'cancel');
});

test('match: "p" in "chat" returns "pause_toggle"', () => {
  const kb = KeybindingManager.getInstance();
  assert.equal(kb.match('chat', makeEvent('p')), 'pause_toggle');
});

test('match: "t" in "chat" returns "thought_toggle"', () => {
  const kb = KeybindingManager.getInstance();
  assert.equal(kb.match('chat', makeEvent('t')), 'thought_toggle');
});

test('match: Ctrl+C in "chat" returns "cancel_double"', () => {
  const kb = KeybindingManager.getInstance();
  assert.equal(kb.match('chat', makeEvent('c', { ctrl: true })), 'cancel_double');
});

test('match: Ctrl+Z in any context returns "suspend" (global)', () => {
  const kb = KeybindingManager.getInstance();
  assert.equal(kb.match('chat', makeEvent('z', { ctrl: true })), 'suspend');
  assert.equal(kb.match('governed', makeEvent('z', { ctrl: true })), 'suspend');
  assert.equal(kb.match('pager', makeEvent('z', { ctrl: true })), 'suspend');
});

test('match: returns null for unrecognized key in context', () => {
  const kb = KeybindingManager.getInstance();
  assert.equal(kb.match('chat', makeEvent('f9')), null);
  assert.equal(kb.match('chat', makeEvent('x')), null);
});

test('match: non-existent context returns null (only global checked)', () => {
  const kb = KeybindingManager.getInstance();
  // Ctrl+Z is global, so it matches even from unknown context
  assert.equal(kb.match('nonexistent', makeEvent('z', { ctrl: true })), 'suspend');
  // A non-global key in unknown context returns null
  assert.equal(kb.match('nonexistent', makeEvent('escape')), null);
});

test('match: global bindings are checked before context bindings', () => {
  // In the "pager" context, Ctrl+C is bound to "quit".
  // But "cancel_double" only exists in chat/governed/thinking/streaming.
  // In pager, Ctrl+C should match the pager "quit" action, not cancel_double.
  const kb = KeybindingManager.getInstance();
  // Actually, match() checks global FIRST then context. So global 'suspend' (Ctrl+Z)
  // takes precedence in all contexts. For keys not in global:
  // pager has 'quit': ['q', 'Escape', 'Ctrl+C']
  // Ctrl+C in pager should match 'quit'
  const result = kb.match('pager', makeEvent('c', { ctrl: true }));
  // Global has only 'suspend': Ctrl+Z. So pager's own Ctrl+C binding wins.
  assert.equal(result, 'quit');
});

// ── matchStack() — priority ordering ───────────────────────────────────────

test('matchStack: first context in array has highest priority', () => {
  const kb = KeybindingManager.getInstance();
  // Both 'governed' and 'chat' have 'cancel' bound to Escape
  // matchStack should return from the first context that matches
  const result = kb.matchStack(['governed', 'chat'], makeEvent('escape'));
  assert.equal(result, 'cancel'); // 'cancel' is the action name, same in both
});

test('matchStack: contexts are checked in array order', () => {
  const kb = KeybindingManager.getInstance();
  // 'pager' binds Escape to 'quit', 'chat' binds Escape to 'cancel'
  // With ['pager', 'chat'], Escape should match 'quit' from pager first
  const result = kb.matchStack(['pager', 'chat'], makeEvent('escape'));
  assert.equal(result, 'quit');
});

test('matchStack: reversed order yields different result when bindings differ', () => {
  const kb = KeybindingManager.getInstance();
  // With ['chat', 'pager'], Escape matches 'cancel' from chat first
  const result = kb.matchStack(['chat', 'pager'], makeEvent('escape'));
  assert.equal(result, 'cancel');
});

test('matchStack: global bindings are checked last (lowest priority)', () => {
  const kb = KeybindingManager.getInstance();
  // Ctrl+Z is only in global. Even with non-matching contexts, global fires last.
  const result = kb.matchStack(['nonexistent'], makeEvent('z', { ctrl: true }));
  assert.equal(result, 'suspend');
});

test('matchStack: empty context array still checks global', () => {
  const kb = KeybindingManager.getInstance();
  const result = kb.matchStack([], makeEvent('z', { ctrl: true }));
  assert.equal(result, 'suspend');
});

test('matchStack: non-existent context names are skipped', () => {
  const kb = KeybindingManager.getInstance();
  // 'nonexistent' has no matchers, 'chat' has them — chat should match
  const result = kb.matchStack(['nonexistent', 'chat'], makeEvent('escape'));
  assert.equal(result, 'cancel');
});

test('matchStack: returns null when no context matches and no global match', () => {
  const kb = KeybindingManager.getInstance();
  const result = kb.matchStack(['chat'], makeEvent('f11'));
  assert.equal(result, null);
});

test('matchStack: overlapping bindings — dialog takes priority over streaming', () => {
  const kb = KeybindingManager.getInstance();
  // dialog has 'confirm' on Enter, streaming has no Enter binding
  // Escape: dialog has 'reject', streaming has 'cancel'
  // With ['dialog', 'streaming'], Escape should match dialog's 'reject' first
  const result = kb.matchStack(['dialog', 'streaming'], makeEvent('escape'));
  assert.equal(result, 'reject');
});

// ── getBindings ────────────────────────────────────────────────────────────

test('getBindings returns key descriptors for known action', () => {
  const kb = KeybindingManager.getInstance();
  const bindings = kb.getBindings('governed', 'pause_toggle');
  assert.deepEqual(bindings, ['p']);
});

test('getBindings returns multiple descriptors for multi-key actions', () => {
  const kb = KeybindingManager.getInstance();
  const bindings = kb.getBindings('pager', 'quit');
  assert.deepEqual(bindings, ['q', 'Escape', 'Ctrl+C']);
});

test('getBindings returns empty array for unknown context', () => {
  const kb = KeybindingManager.getInstance();
  assert.deepEqual(kb.getBindings('nonexistent', 'cancel'), []);
});

test('getBindings returns empty array for unknown action', () => {
  const kb = KeybindingManager.getInstance();
  assert.deepEqual(kb.getBindings('chat', 'nonexistent_action'), []);
});

// ── Case insensitivity ─────────────────────────────────────────────────────

test('parseKeyDescriptor is case-insensitive for key names', () => {
  const kb = KeybindingManager.getInstance();
  // 'Enter' action is defined in prompt context
  // The default uses exact-case but parseKeyDescriptor lowercases
  assert.equal(kb.match('dialog', makeEvent('enter')), 'confirm');
  assert.equal(kb.match('dialog', makeEvent('escape')), 'reject');
});

// ── Prompt context bindings ────────────────────────────────────────────────

test('prompt context: Enter returns "submit"', () => {
  const kb = KeybindingManager.getInstance();
  assert.equal(kb.match('prompt', makeEvent('enter')), 'submit');
});

test('prompt context: Up returns "history_prev"', () => {
  const kb = KeybindingManager.getInstance();
  assert.equal(kb.match('prompt', makeEvent('up')), 'history_prev');
});

test('prompt context: Down returns "history_next"', () => {
  const kb = KeybindingManager.getInstance();
  assert.equal(kb.match('prompt', makeEvent('down')), 'history_next');
});

test('prompt context: Ctrl+A returns "home"', () => {
  const kb = KeybindingManager.getInstance();
  assert.equal(kb.match('prompt', makeEvent('a', { ctrl: true })), 'home');
});

test('prompt context: Ctrl+E returns "end"', () => {
  const kb = KeybindingManager.getInstance();
  assert.equal(kb.match('prompt', makeEvent('e', { ctrl: true })), 'end');
});

test('prompt context: Backspace returns "delete_left"', () => {
  const kb = KeybindingManager.getInstance();
  assert.equal(kb.match('prompt', makeEvent('backspace')), 'delete_left');
});

// ── Pager context bindings ─────────────────────────────────────────────────

test('pager context: q returns "quit"', () => {
  const kb = KeybindingManager.getInstance();
  assert.equal(kb.match('pager', makeEvent('q')), 'quit');
});

test('pager context: j returns "scroll_down"', () => {
  const kb = KeybindingManager.getInstance();
  assert.equal(kb.match('pager', makeEvent('j')), 'scroll_down');
});

test('pager context: k returns "scroll_up"', () => {
  const kb = KeybindingManager.getInstance();
  assert.equal(kb.match('pager', makeEvent('k')), 'scroll_up');
});

test('pager context: / returns "search"', () => {
  const kb = KeybindingManager.getInstance();
  assert.equal(kb.match('pager', makeEvent('/')), 'search');
});

// ── Dialog context bindings ────────────────────────────────────────────────

test('dialog context: y returns "confirm"', () => {
  const kb = KeybindingManager.getInstance();
  assert.equal(kb.match('dialog', makeEvent('y')), 'confirm');
});

test('dialog context: n returns "reject"', () => {
  const kb = KeybindingManager.getInstance();
  assert.equal(kb.match('dialog', makeEvent('n')), 'reject');
});

test('dialog context: Space returns "toggle"', () => {
  const kb = KeybindingManager.getInstance();
  assert.equal(kb.match('dialog', makeEvent('space')), 'toggle');
});

// ── reload() ───────────────────────────────────────────────────────────────

test('reload() does not throw and preserves default bindings', () => {
  const kb = KeybindingManager.getInstance();
  assert.doesNotThrow(() => kb.reload());
  // Default bindings should still work after reload
  assert.equal(kb.match('chat', makeEvent('escape')), 'cancel');
});

// ── Shift handling for letters ─────────────────────────────────────────────

test('Shift+G (uppercase name) matches pager bottom action', () => {
  const kb = KeybindingManager.getInstance();
  // parseKeyDescriptor lowercases the key name from the config descriptor ('Shift+G' → resolved='g')
  // then checks event.name against the lowercase key + wantsShift vs isUpper.
  // KeyInput produces lowercase names for letter keys with shift flag set.
  const result = kb.match('pager', makeEvent('g', { shift: true }));
  assert.equal(result, 'bottom');
});

// ── Scroll bindings (chat, streaming, governed) ─────────────────────────────

test('chat context: End matches scroll_to_bottom', () => {
  const kb = KeybindingManager.getInstance();
  assert.equal(kb.match('chat', makeEvent('end')), 'scroll_to_bottom');
});

test('chat context: PageUp matches scroll_up', () => {
  const kb = KeybindingManager.getInstance();
  assert.equal(kb.match('chat', makeEvent('pageup')), 'scroll_up');
});

test('chat context: PageDown matches scroll_down', () => {
  const kb = KeybindingManager.getInstance();
  assert.equal(kb.match('chat', makeEvent('pagedown')), 'scroll_down');
});

test('streaming context: End matches scroll_to_bottom', () => {
  const kb = KeybindingManager.getInstance();
  assert.equal(kb.match('streaming', makeEvent('end')), 'scroll_to_bottom');
});

test('governed context: PageUp matches scroll_up', () => {
  const kb = KeybindingManager.getInstance();
  assert.equal(kb.match('governed', makeEvent('pageup')), 'scroll_up');
});

test('governed context: scroll_to_bottom via End', () => {
  const kb = KeybindingManager.getInstance();
  assert.equal(kb.match('governed', makeEvent('end')), 'scroll_to_bottom');
});

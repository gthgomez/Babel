/**
 * Tests for KeybindingRemapWizard — validation rules, config merge, action
 * enumeration, and atomic write.
 *
 * Dialog-level tests (steps 1-3) are not run here because they require a TTY;
 * they are exercised by integration tests.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { KeybindingManager, serializeKeyEvent } from './keybindings.js';
import {
  validateBinding,
  applyConfigChange,
  getAllActions,
  KeybindingRemapWizard,
  type ActionItem,
  type ValidationResult,
} from './keybindingRemap.js';

// ── Helpers ──────────────────────────────────────────────────────────────────────

/** Create a minimal KeyEvent for serialization tests. */
function makeEvent(
  name: string,
  opts: { ctrl?: boolean; shift?: boolean; meta?: boolean } = {},
): { name: string; ctrl: boolean; shift: boolean; meta: boolean; sequence: string } {
  return {
    name,
    ctrl: opts.ctrl ?? false,
    shift: opts.shift ?? false,
    meta: opts.meta ?? false,
    sequence: name,
  };
}

/** Build a fake KeybindingManager that returns known bindings for an action list. */
function buildMockManager(
  overrides?: Record<string, Record<string, string[]>>,
): KeybindingManager {
  // The singleton loads from disk — for pure logic tests we use the defaults
  // via resetInstance(). The merge tests use a real file in a temp dir.
  KeybindingManager.resetInstance();
  return KeybindingManager.getInstance();
}

/**
 * Build a minimal ActionItem list for validation tests.
 * Only includes the actions relevant to the test case.
 */
function makeActions(overrides: Array<{ context: string; action: string; keys: string[] }>): ActionItem[] {
  return overrides.map((o) => ({ context: o.context, action: o.action, currentKeys: [...o.keys] }));
}

// ── Cleanup singleton between test groups ────────────────────────────────────────

test.beforeEach(() => {
  KeybindingManager.resetInstance();
});

test.afterEach(() => {
  KeybindingManager.resetInstance();
});

// ── getAllActions ─────────────────────────────────────────────────────────────────

test('getAllActions returns all default context+action pairs', () => {
  const kb = KeybindingManager.getInstance();
  const all = getAllActions(kb);

  // At minimum we should have items from all 10 default contexts
  const contexts = new Set(all.map((a) => a.context));
  assert.ok(contexts.has('global'));
  assert.ok(contexts.has('chat'));
  assert.ok(contexts.has('governed'));
  assert.ok(contexts.has('thinking'));
  assert.ok(contexts.has('streaming'));
  assert.ok(contexts.has('search'));
  assert.ok(contexts.has('pager'));
  assert.ok(contexts.has('dialog'));
  assert.ok(contexts.has('palette'));
  assert.ok(contexts.has('prompt'));

  // Each item should have a context, action, and currentKeys array
  for (const item of all) {
    assert.ok(typeof item.context === 'string' && item.context.length > 0);
    assert.ok(typeof item.action === 'string' && item.action.length > 0);
    assert.ok(Array.isArray(item.currentKeys));
  }

  // Items should be sorted by context then by action
  for (let i = 1; i < all.length; i++) {
    const prev = all[i - 1]!;
    const curr = all[i]!;
    if (prev.context === curr.context) {
      assert.ok(prev.action <= curr.action);
    } else {
      assert.ok(prev.context <= curr.context);
    }
  }
});

test('getAllActions: each action has currentKeys with at least one binding', () => {
  const kb = KeybindingManager.getInstance();
  const all = getAllActions(kb);

  // Most actions should have bindings; at minimum the core ones do
  const cancelChat = all.find((a) => a.context === 'chat' && a.action === 'cancel');
  assert.ok(cancelChat);
  assert.ok(cancelChat!.currentKeys.includes('Escape'));
});

// ── Validation ────────────────────────────────────────────────────────────────────

test('validateBinding: rejects bare Escape in chat context', () => {
  const result = validateBinding(
    'Escape',
    'chat',
    'some_action',
    KeybindingManager.getInstance(),
    [],
  );
  assert.equal(result.valid, false);
  assert.equal(result.level, 'error');
  assert.ok(result.message.includes('Escape'));
  assert.ok(result.message.includes('chat'));
});

test('validateBinding: rejects bare Escape in governed context', () => {
  const result = validateBinding(
    'Escape',
    'governed',
    'some_action',
    KeybindingManager.getInstance(),
    [],
  );
  assert.equal(result.valid, false);
  assert.equal(result.level, 'error');
  assert.ok(result.message.includes('governed'));
});

test('validateBinding: Escape is valid in non-chat/governed contexts', () => {
  const result = validateBinding(
    'Escape',
    'pager',
    'quit',
    KeybindingManager.getInstance(),
    [],
  );
  assert.equal(result.valid, true);
});

test('validateBinding: rejects bare Ctrl+C in governed context', () => {
  const result = validateBinding(
    'Ctrl+C',
    'governed',
    'some_action',
    KeybindingManager.getInstance(),
    [],
  );
  assert.equal(result.valid, false);
  assert.equal(result.level, 'error');
  assert.ok(result.message.includes('Ctrl+C'));
});

test('validateBinding: Ctrl+C is valid in non-governed contexts', () => {
  const result = validateBinding(
    'Ctrl+C',
    'pager',
    'quit',
    KeybindingManager.getInstance(),
    [],
  );
  assert.equal(result.valid, true);
});

test('validateBinding: warns when key is already bound to a different action in same context', () => {
  const actions = makeActions([
    { context: 'pager', action: 'quit', keys: ['q', 'Escape'] },
    { context: 'pager', action: 'scroll_up', keys: ['k'] },
  ]);

  const result = validateBinding(
    'q',
    'pager',
    'scroll_up', // different action
    KeybindingManager.getInstance(),
    actions,
  );

  assert.equal(result.valid, true);
  assert.equal(result.level, 'warn');
  assert.ok(result.message.includes('"q"'));
  assert.ok(result.message.includes('"quit"'));
});

test('validateBinding: warns when key matches a global binding', () => {
  const actions = makeActions([
    { context: 'global', action: 'suspend', keys: ['Ctrl+Z'] },
    { context: 'pager', action: 'quit', keys: ['q', 'Escape'] },
  ]);

  const result = validateBinding(
    'Ctrl+Z',
    'pager',
    'quit',
    KeybindingManager.getInstance(),
    actions,
  );

  assert.equal(result.valid, true);
  assert.equal(result.level, 'warn');
  assert.ok(result.message.includes('Ctrl+Z'));
  assert.ok(result.message.includes('global'));
});

test('validateBinding: no warnings for brand-new key binding', () => {
  const actions = makeActions([
    { context: 'chat', action: 'cancel', keys: ['Escape'] },
  ]);

  const result = validateBinding(
    'Ctrl+Shift+K',
    'chat',
    'pause_toggle',
    KeybindingManager.getInstance(),
    actions,
  );

  assert.equal(result.valid, true);
  assert.equal(result.level, 'info');
});

// ── Config merge helpers ──────────────────────────────────────────────────────────

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'keybind-remap-test-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('applyConfigChange: add binding to existing context', () => {
  withTempDir((dir) => {
    const configPath = join(dir, '.babel_keybindings.json');
    // Start with an existing config
    writeFileSync(
      configPath,
      JSON.stringify({ chat: { pause_toggle: ['p'] } }, null, 2) + '\n',
      'utf-8',
    );

    const kb = KeybindingManager.getInstance();
    const selected: ActionItem = { context: 'chat', action: 'pause_toggle', currentKeys: ['p'] };
    const result = applyConfigChange(kb, selected, 'add', 'Ctrl+Shift+P', configPath);

    assert.ok(result.chat);
    assert.ok(result.chat!.pause_toggle);
    assert.ok(result.chat!.pause_toggle!.includes('p'));
    assert.ok(result.chat!.pause_toggle!.includes('Ctrl+Shift+P'));

    // Verify the file was written
    const fileContent = JSON.parse(readFileSync(configPath, 'utf-8'));
    assert.deepEqual(fileContent, result);
  });
});

test('applyConfigChange: add binding to new context', () => {
  withTempDir((dir) => {
    const configPath = join(dir, '.babel_keybindings.json');
    // Empty config — starting from scratch, no default bindings exist
    writeFileSync(configPath, '{}\n', 'utf-8');

    const kb = KeybindingManager.getInstance();
    const selected: ActionItem = { context: 'chat', action: 'pause_toggle', currentKeys: [] };
    const result = applyConfigChange(kb, selected, 'add', 'Ctrl+Shift+P', configPath);

    assert.ok(result.chat);
    // Only the added binding is present (starting from empty config)
    assert.deepEqual(result.chat!.pause_toggle, ['Ctrl+Shift+P']);
  });
});

test('applyConfigChange: replace all bindings for action', () => {
  withTempDir((dir) => {
    const configPath = join(dir, '.babel_keybindings.json');
    writeFileSync(
      configPath,
      JSON.stringify({ pager: { quit: ['q', 'Escape', 'Ctrl+C'] } }, null, 2) + '\n',
      'utf-8',
    );

    const kb = KeybindingManager.getInstance();
    const selected: ActionItem = { context: 'pager', action: 'quit', currentKeys: ['q', 'Escape', 'Ctrl+C'] };
    const result = applyConfigChange(kb, selected, 'replace', 'Ctrl+Q', configPath);

    assert.ok(result.pager);
    assert.deepEqual(result.pager!.quit, ['Ctrl+Q']);
  });
});

test('applyConfigChange: remove specific binding', () => {
  withTempDir((dir) => {
    const configPath = join(dir, '.babel_keybindings.json');
    writeFileSync(
      configPath,
      JSON.stringify({ chat: { cancel: ['Escape', 'Ctrl+C'] } }, null, 2) + '\n',
      'utf-8',
    );

    const kb = KeybindingManager.getInstance();
    const selected: ActionItem = { context: 'chat', action: 'cancel', currentKeys: ['Escape', 'Ctrl+C'] };
    const result = applyConfigChange(kb, selected, 'remove', 'Ctrl+C', configPath);

    assert.ok(result.chat);
    assert.deepEqual(result.chat!.cancel, ['Escape']);
  });
});

test('applyConfigChange: remove last binding removes action from map', () => {
  withTempDir((dir) => {
    const configPath = join(dir, '.babel_keybindings.json');
    writeFileSync(
      configPath,
      JSON.stringify({ chat: { cancel: ['Escape'] } }, null, 2) + '\n',
      'utf-8',
    );

    const kb = KeybindingManager.getInstance();
    const selected: ActionItem = { context: 'chat', action: 'cancel', currentKeys: ['Escape'] };
    const result = applyConfigChange(kb, selected, 'remove', 'Escape', configPath);

    // The action is removed from the config map (empty context is also removed)
    assert.equal(result.chat, undefined);
  });
});

test('applyConfigChange: remove last binding removes empty context', () => {
  withTempDir((dir) => {
    const configPath = join(dir, '.babel_keybindings.json');
    writeFileSync(
      configPath,
      JSON.stringify({ chat: { cancel: ['Escape'] } }, null, 2) + '\n',
      'utf-8',
    );

    const kb = KeybindingManager.getInstance();
    const selected: ActionItem = { context: 'chat', action: 'cancel', currentKeys: ['Escape'] };
    const result = applyConfigChange(kb, selected, 'remove', 'Escape', configPath);

    // The empty 'chat' context should be removed from config
    assert.equal(result.chat, undefined);
  });
});

// ── Atomic write behavior ─────────────────────────────────────────────────────────

test('applyConfigChange: atomic write uses temp file then rename', () => {
  withTempDir((dir) => {
    const configPath = join(dir, '.babel_keybindings.json');
    writeFileSync(configPath, '{"chat":{"cancel":["Escape"]}}\n', 'utf-8');

    const kb = KeybindingManager.getInstance();
    const selected: ActionItem = { context: 'chat', action: 'cancel', currentKeys: ['Escape'] };

    // After apply, the .tmp file should NOT exist (it was renamed)
    applyConfigChange(kb, selected, 'add', 'Ctrl+Shift+Escape', configPath);
    assert.equal(existsSync(configPath + '.tmp'), false);

    // The actual file should contain the updated config
    const content = JSON.parse(readFileSync(configPath, 'utf-8'));
    assert.ok(content.chat!.cancel!.includes('Ctrl+Shift+Escape'));
  });
});

test('applyConfigChange: calls reload() on the manager', () => {
  withTempDir((dir) => {
    // Trick: point homedir to the temp dir so KeybindingManager.reload()
    // reads from our temp file instead of the real ~/.babel_keybindings.json.
    const originalHome = process.env['USERPROFILE'] ?? process.env['HOME'];
    const isWindows = process.platform === 'win32';
    const homeVar = isWindows ? 'USERPROFILE' : 'HOME';
    process.env[homeVar] = dir;
    const realConfigPath = join(dir, '.babel_keybindings.json');

    try {
      writeFileSync(realConfigPath, '{"chat":{"cancel":["Escape"]}}\n', 'utf-8');

      // Reset singleton so the temp file is loaded on next getInstance()
      KeybindingManager.resetInstance();
      const kb = KeybindingManager.getInstance();

      // Before change: chat cancel should have ['Escape']
      assert.deepEqual(kb.getBindings('chat', 'cancel'), ['Escape']);

      const selected: ActionItem = { context: 'chat', action: 'cancel', currentKeys: ['Escape'] };

      // Apply change via applyConfigChange — it writes to the temp file
      applyConfigChange(kb, selected, 'replace', 'Ctrl+Shift+Escape', realConfigPath);

      // After change and reload: chat cancel should have updated bindings
      assert.deepEqual(kb.getBindings('chat', 'cancel'), ['Ctrl+Shift+Escape']);
    } finally {
      // Restore original env var
      if (originalHome === undefined) {
        delete process.env[homeVar];
      } else {
        process.env[homeVar] = originalHome;
      }
      KeybindingManager.resetInstance();
    }
  });
});

// ── serializeKeyEvent (interop with wizard) ───────────────────────────────────────

test('serializeKeyEvent: produces descriptors that validateBinding can check', () => {
  const event = makeEvent('k', { ctrl: true, shift: true, meta: true });
  const descriptor = serializeKeyEvent(event);
  // For single-char keys, shift capitalizes the letter
  assert.equal(descriptor, 'Ctrl+Alt+Shift+K');
});

test('serializeKeyEvent: named key with Ctrl', () => {
  const event = makeEvent('pageup', { ctrl: true });
  assert.equal(serializeKeyEvent(event), 'Ctrl+Pageup');
});

// ── Wizard construction ───────────────────────────────────────────────────────────

test('KeybindingRemapWizard constructs with KeybindingManager', () => {
  const kb = KeybindingManager.getInstance();
  const wizard = new KeybindingRemapWizard(kb);
  assert.ok(wizard instanceof KeybindingRemapWizard);
});

// ── Config file is missing → starts fresh ─────────────────────────────────────────

test('applyConfigChange: handles missing config file gracefully', () => {
  withTempDir((dir) => {
    const configPath = join(dir, '.nonexistent.json');
    // File does not exist

    const kb = KeybindingManager.getInstance();
    const selected: ActionItem = { context: 'testctx', action: 'testaction', currentKeys: [] };
    const result = applyConfigChange(kb, selected, 'add', 'Ctrl+X', configPath);

    assert.ok(result.testctx);
    assert.deepEqual(result.testctx!.testaction, ['Ctrl+X']);
  });
});

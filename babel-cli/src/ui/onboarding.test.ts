/**
 * Tests for the first-run onboarding module.
 *
 * Covers:
 *   - isFirstRun() returns correct boolean based on filesystem state
 *   - showOnboarding() writes expected content to stdout
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { isFirstRun, showOnboarding } from './onboarding.js';
import { stripAnsi } from './theme.js';
import { updateUserSettings } from '../config/userSettings.js';

function withProfile(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'babel-onboarding-'));
  const previous = process.env['BABEL_STATE_DIR'];
  process.env['BABEL_STATE_DIR'] = root;
  try { run(root); } finally {
    if (previous === undefined) delete process.env['BABEL_STATE_DIR'];
    else process.env['BABEL_STATE_DIR'] = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

// ─── isFirstRun ──────────────────────────────────────────────────────────────

test('isFirstRun returns true for a fresh private profile', () => withProfile(() => {
  assert.equal(isFirstRun(), true);
}));

test('command history does not suppress incomplete provider setup', () => withProfile(root => {
  writeFileSync(join(root, '.babel_history'), '["test command"]', 'utf-8');
  assert.equal(isFirstRun(), true);
}));

test('completed user setup is independent of command history', () => withProfile(() => {
  updateUserSettings({ setup: { completed: true } });
  assert.equal(isFirstRun(), false);
}));

// ─── showOnboarding ──────────────────────────────────────────────────────────

test('showOnboarding writes Babel logo to stdout', () => {
  // Capture stdout
  const chunks: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
    return true;
  };

  try {
    showOnboarding();

    const output = chunks.join('');
    const plain = stripAnsi(output);

    // Verify logo block characters appear (Unicode art for "BABEL")
    assert.ok(plain.includes('██'), 'Output should contain logo block characters');

    // Verify welcome message
    assert.ok(plain.includes('Welcome'), 'Output should contain welcome message');

    // Verify key tips
    assert.ok(plain.includes('Type a task'), 'Should show first tip');
    assert.ok(plain.includes('/help'), 'Should show help command tip');
    assert.ok(plain.includes('Ctrl+P'), 'Should show command palette tip');
    assert.ok(plain.includes('/theme'), 'Should show theme command tip');
    assert.ok(plain.includes('/mode'), 'Should show mode command tip');
    assert.ok(plain.includes('@'), 'Should show file search tip');
  } finally {
    process.stdout.write = origWrite;
  }
});

test('showOnboarding output includes rule separator', () => {
  const chunks: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
    return true;
  };

  try {
    showOnboarding();
    const output = chunks.join('');
    // Should contain a horizontal rule (dashes)
    assert.ok(output.includes('─'), 'Output should include a separator rule');
  } finally {
    process.stdout.write = origWrite;
  }
});

test('narrow onboarding uses a compact brand and explicit model command', () => {
  const previousColumns = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  const previousWrite = process.stdout.write;
  const chunks: string[] = [];
  Object.defineProperty(process.stdout, 'columns', { value: 40, configurable: true });
  process.stdout.write = ((chunk: string) => { chunks.push(String(chunk)); return true; }) as typeof process.stdout.write;
  try {
    showOnboarding();
    const output = stripAnsi(chunks.join(''));
    assert.match(output, /BABEL/);
    assert.doesNotMatch(output, /██/);
    assert.match(output, /\/model use <id>/);
  } finally {
    process.stdout.write = previousWrite;
    if (previousColumns) Object.defineProperty(process.stdout, 'columns', previousColumns);
    else Reflect.deleteProperty(process.stdout, 'columns');
  }
});

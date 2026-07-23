/**
 * Tests for the first-run onboarding module.
 *
 * Covers:
 *   - isFirstRun() returns correct boolean based on filesystem state
 *   - showOnboarding() writes expected content to stdout
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { isFirstRun, showOnboarding } from './onboarding.js';
import { stripAnsi } from './theme.js';

// Same path used by onboarding.ts and ../services/history.ts
const HISTORY_FILE = join(process.cwd(), '.babel_history');

// ─── isFirstRun ──────────────────────────────────────────────────────────────

test('isFirstRun returns true when no history file exists', () => {
  // Remove the file if it exists
  const existed = existsSync(HISTORY_FILE);
  if (existed) {
    unlinkSync(HISTORY_FILE);
  }

  try {
    const result = isFirstRun();
    assert.equal(result, true);
  } finally {
    // Restore if we removed it
    if (existed) {
      writeFileSync(HISTORY_FILE, '[]', 'utf-8');
    }
  }
});

test('isFirstRun returns false when history file exists', () => {
  // Ensure the file exists
  writeFileSync(HISTORY_FILE, '["test command"]', 'utf-8');

  try {
    const result = isFirstRun();
    assert.equal(result, false);
  } finally {
    unlinkSync(HISTORY_FILE);
  }
});

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

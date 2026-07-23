// ─── Snapshot Utility ────────────────────────────────────────────────────────
// Lightweight inline snapshot helper for node:test. Stores expected output as
// JSON .snap files alongside test files. No external dependencies.
//
// Usage:
//   import { matchSnapshot, matchStrippedSnapshot } from './snapshot.js';
//   test('my test', () => {
//     const output = renderSomething(input);
//     matchStrippedSnapshot(output, 'my test', import.meta.url);
//   });
//
// Update mode:  UPDATE_SNAPSHOTS=1 npx tsx --test src/ui/my.test.ts
// Creates/updates .snap files. Review changes and commit them.
//
// ANSI determinism: snapshot rendering must be identical regardless of terminal
// environment. We force FORCE_COLOR=1 so that HAS_COLOR in theme.ts resolves to
// true before any UI module imports evaluate at module-load time. Without this,
// buttonFocused and similar helpers emit "[brackets]" as a no-color fallback
// instead of ANSI background colors, causing snapshot mismatches across machines.

process.env['FORCE_COLOR'] = '1';

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const SHOULD_UPDATE = process.env['UPDATE_SNAPSHOTS'] === '1';

interface SnapStore {
  [key: string]: string;
}

function snapPathFor(metaUrl: string): string {
  return fileURLToPath(metaUrl) + '.snap';
}

function loadSnap(path: string): SnapStore {
  try {
    if (!readFileSync(path, 'utf-8').trim()) return {};
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return {};
  }
}

function writeSnap(path: string, store: SnapStore): void {
  const tmp = path + '.tmp';
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', 'utf-8');
  renameSync(tmp, path);
}

/**
 * Compare actual output against a stored snapshot (raw, including ANSI codes).
 * Run with UPDATE_SNAPSHOTS=1 to create or update all snapshot files.
 */
export function matchSnapshot(actual: string, name: string, metaUrl: string): void {
  const snapPath = snapPathFor(metaUrl);
  const store = loadSnap(snapPath);

  if (SHOULD_UPDATE) {
    store[name] = actual;
    writeSnap(snapPath, store);
    return;
  }

  const expected = store[name];
  if (expected === undefined) {
    assert.fail(`No snapshot for "${name}". Run with UPDATE_SNAPSHOTS=1 to create snapshots.`);
  }

  assert.equal(actual, expected, `Snapshot mismatch for "${name}"`);
}

/**
 * Compare actual output against a stored snapshot, but strip ANSI escape
 * sequences before comparing. Use this as the default — it is cross-platform
 * safe and produces readable .snap files.
 *
 * Strips: \\x1b[...m (SGR), \\x1b]... (OSC), \\x1b[... (other CSI).
 * Keeps: plain text, newlines, printable ASCII/Unicode.
 */
export function matchStrippedSnapshot(actual: string, name: string, metaUrl: string): void {
  // Strip all ANSI escape sequences for comparison
  const stripped = actual
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '') // CSI sequences
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '') // OSC sequences
    .replace(/\x1b[PX^_][^\x1b]*\x1b\\/g, ''); // DCS/SOS/PM/APC sequences
  matchSnapshot(stripped, name, metaUrl);
}

/**
 * testUtils.ts — Shared test helpers for babel-cli UI tests.
 *
 * Provides env-var sandboxing (withEnv) used by terminal probe, theme,
 * and latency probe tests. Centralized to avoid triplication across
 * test files.
 */

import { resetTerminalProbe } from './terminalProbe.js';

/** Clear env vars that force a11y/plain output (strip ANSI, skip alt-screen). */
export const ANSI_TEST_ENV: Record<string, string | undefined> = {
  NO_COLOR: undefined,
  BABEL_A11Y: undefined,
};

/**
 * Run a test body with ANSI-friendly env (no NO_COLOR / BABEL_A11Y side effects).
 */
export function withAnsiTestEnv(fn: () => void, resetFn: () => void = resetTerminalProbe): void {
  withEnv(ANSI_TEST_ENV, fn, resetFn);
}

/**
 * Save and restore a set of env vars around a test body.
 *
 * Applies `overrides` before calling `fn()`, then restores original values
 * in a `finally` block. Calls `resetFn()` before the test body and during
 * cleanup so downstream caches reflect the restored env.
 *
 * @param overrides — env vars to set (use `undefined` to unset)
 * @param fn        — test body
 * @param resetFn   — optional reset hook (defaults to `resetTerminalProbe`)
 */
export function withEnv(
  overrides: Record<string, string | undefined>,
  fn: () => void,
  resetFn: () => void = resetTerminalProbe,
): void {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
  }
  try {
    for (const [key, val] of Object.entries(overrides)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
    resetFn();
    fn();
  } finally {
    for (const [key, val] of Object.entries(saved)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
    resetFn();
  }
}

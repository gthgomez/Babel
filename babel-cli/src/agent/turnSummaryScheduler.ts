/**
 * B2: Decision summaries every K turns.
 *
 * Every K turns (default 5; BABEL_CHAT_SUMMARY_EVERY, 0 disables), request a
 * short decision summary (hypothesis, files of interest, next tool, blockers;
 * ≤5 bullets / ≤400 tokens), store in turn_summaries on disk/payload.
 *
 * Prefer Flash/investigate model for summary completion; skip when budget
 * remaining is low. Do not keep full summary history in active context
 * (last 2 max if any).
 */

import { isTruthyEnvFlag } from '../utils/envFlags.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface TurnSummary {
  /** The chat turn index (0-based) this summary corresponds to. */
  turn: number;
  /** What the model believes is happening / the root cause. */
  hypothesis: string;
  /** Files the model is currently focused on. */
  files_of_interest: string[];
  /** The next tool the model intends to use. */
  next_tool: string;
  /** Any blockers or obstacles the model has encountered. */
  blockers: string[];
  /** ISO-8601 timestamp of when the summary was captured. */
  ts: string;
}

/** Outcome of requesting a turn summary from the model. */
export interface TurnSummaryRequestResult {
  /** The parsed summary, or null if the model call failed or was skipped. */
  summary: TurnSummary | null;
  /** True when the request was skipped (budget low, env disabled). */
  skipped: boolean;
  /** Human-readable skip reason for debugging. */
  skipReason?: string;
}

/** Hook signature for requesting a summary from the model.
 *  Mockable so callers can test without a real model. */
export type SummaryCompletionHook = (
  turn: number,
  conversationSummary: string,
) => Promise<TurnSummary | null>;

// ── Store ──────────────────────────────────────────────────────────────────

export class TurnSummaryStore {
  private _entries: TurnSummary[] = [];

  push(entry: TurnSummary): void {
    this._entries.push(entry);
  }

  /** Return all stored summaries. */
  toJSON(): TurnSummary[] {
    return [...this._entries];
  }

  /** Return the last N summaries for context injection.
   *  Brief says max 2 in active context. */
  lastInContext(n = 2): TurnSummary[] {
    return this._entries.slice(-n);
  }

  get length(): number {
    return this._entries.length;
  }

  clear(): void {
    this._entries = [];
  }
}

// ── Scheduler ──────────────────────────────────────────────────────────────

/**
 * Pure scheduler: returns true when summaries should fire.
 * - turn: current 0-based turn index
 * - k: interval (every K turns); 0 = disabled
 */
export function shouldRequestTurnSummary(turn: number, k: number): boolean {
  if (k <= 0) return false;
  // Fire at turn indices k, 2k, 3k, … (turn is 0-based, so turn+1 is 1-based)
  return (turn + 1) % k === 0;
}

/**
 * Read BABEL_CHAT_SUMMARY_EVERY from env.
 * Returns 0 when disabled; default is 5.
 */
export function resolveSummaryInterval(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env['BABEL_CHAT_SUMMARY_EVERY'];
  if (raw === undefined || raw === null || raw.trim() === '') return 5;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 5;
  return Math.floor(n);
}

/**
 * Cost-aware budget gate: skip summaries when remaining budget is low.
 *
 * @param costLimitUsd — the session cost limit (0 = unlimited)
 * @param spentUsd — total spent so far
 * @param threshold — fraction of budget below which we skip (default 0.10 = 10%)
 */
export function shouldSkipForBudget(
  costLimitUsd: number,
  spentUsd: number,
  threshold = 0.1,
): boolean {
  if (costLimitUsd <= 0) return false; // no limit set → never skip
  const remaining = costLimitUsd - spentUsd;
  if (remaining <= 0) return true;
  return remaining < costLimitUsd * threshold;
}

/**
 * Build a lightweight conversation prompt to request a turn summary.
 * Kept under 400 tokens so the summary completion call is cheap.
 */
export function buildSummaryRequestPrompt(turn: number): string {
  return [
    `[SYSTEM] You are at turn ${turn + 1}. Provide a brief decision summary:`,
    '- Hypothesis: what you believe the root cause / situation is',
    '- Files of interest: which files you are focused on',
    '- Next tool: what tool you plan to use next',
    '- Blockers: any obstacles or unknowns',
    'Keep the response ≤5 bullets and ≤400 tokens.',
    'Respond in this format:',
    '```json',
    '{',
    '  "hypothesis": "...",',
    '  "files_of_interest": ["file1.ts", "file2.ts"],',
    '  "next_tool": "read_file",',
    '  "blockers": ["..."],',
    '  "turn": ' + String(turn) + ',',
    '  "ts": "' + new Date().toISOString() + '"',
    '}',
    '```',
  ].join('\n');
}

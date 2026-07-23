/**
 * B4: Prompt stack fingerprint — non-secret provenance snapshot per session.
 *
 * Captures which prompt/policy configuration produced a given result so
 * post-hoc failure analysis can answer "what prompt stack was this run on?"
 * without logging secrets or API keys.
 */

import { createHash } from 'node:crypto';
import type { ChatTaskClass, ChatTaskTune } from '../config/chatTaskClass.js';

/** B4: Prompt stack fingerprint type. */
export interface PromptFingerprint {
  /** Task class active for this session. */
  task_class: string;
  /** Whether phase-gated tools are enabled. */
  phase_gated_tools: boolean;
  /** Turns with zero writes before hard stop (0 = disabled). */
  zero_write_hard_stop: number;
  /** Consecutive zero-write turns before force-mutate. */
  force_mutate_turns: number;
  /** First 16 hex characters of SHA-256 of the system prompt. */
  system_prompt_sha256: string;
  /** Playbook ID when one was selected; omitted when no playbook is active. */
  playbook_id?: string;
  /** Only BABEL_CHAT_* env flags (key/token names and secret-looking values redacted). */
  env_flags: Record<string, string>;
}

export type PromptFingerprintInput = {
  systemPrompt: string;
  taskClass: ChatTaskClass;
  tune: ChatTaskTune;
  playbookId?: string | null;
  env?: NodeJS.ProcessEnv;
};

/** Build a fingerprint for the current session configuration. */
export function buildPromptFingerprint(input: PromptFingerprintInput): PromptFingerprint {
  const fp: PromptFingerprint = {
    task_class: input.tune.class,
    phase_gated_tools: input.tune.phaseGatedToolsDefault,
    zero_write_hard_stop: input.tune.zeroWriteHardStopTurns,
    force_mutate_turns: input.tune.forceMutateTurns,
    system_prompt_sha256: sha256Prefix(input.systemPrompt),
    env_flags: collectChatEnvFlags(input.env ?? process.env),
  };
  if (input.playbookId) {
    fp.playbook_id = input.playbookId;
  }
  return fp;
}

/** SHA-256 of text, truncated to first 16 hex characters. */
export function sha256Prefix(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Collect BABEL_CHAT_* env flags.
 * Values matching key/secret patterns are redacted.
 * Never includes keys containing KEY, TOKEN, SECRET, PASSWORD (case-insensitive).
 */
export function collectChatEnvFlags(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('BABEL_CHAT_')) continue;
    if (value == null || value === '') continue;
    if (isSecretKeyName(key)) continue;
    if (isSecretLookingValue(value)) {
      out[key] = '[redacted]';
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * True when the env-var key contains KEY, TOKEN, SECRET, or PASSWORD.
 * Case-insensitive so it catches mixed-case variants.
 */
export function isSecretKeyName(key: string): boolean {
  const upper = key.toUpperCase();
  return (
    upper.includes('KEY') ||
    upper.includes('TOKEN') ||
    upper.includes('SECRET') ||
    upper.includes('PASSWORD')
  );
}

/**
 * True when the value looks like a secret token or API key.
 * Catches: base64-like long strings, JWT-like tokens, and common key prefixes
 * (sk-, api-, dsk-, etc.).
 */
export function isSecretLookingValue(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;

  // Known secret prefixes
  if (/^(sk-|api-|dsk-|key-|pat-|ghp_|gho_|ghu_|ghs_|ghr_)/i.test(trimmed)) {
    return true;
  }
  // JWT-like (three base64url segments separated by dots)
  if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(trimmed)) {
    return true;
  }
  // Long base64url-like strings (≥40 chars, no spaces, typical API key shape)
  if (trimmed.length >= 40 && /^[A-Za-z0-9+/=_-]{40,}$/.test(trimmed)) {
    return true;
  }
  return false;
}

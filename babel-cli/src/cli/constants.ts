import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MODEL_POLICY_TIERS } from '../modelPolicy.js';

// ── Mode Taxonomy ─────────────────────────────────────────────────────────
// Babel has two execution engines, each with two modes:
//
//   Conversational Agent (ChatEngine) — multi-turn tool loop, streaming:
//     chat           Interactive TUI, conversational, suitable for dev work
//     chat-headless  Same engine, JSON/headless output, suitable for CI/testing
//                    (stable alias; preferred long-term: `babel chat --headless`)
//
//   Governed Pipeline (v9 Orchestrator) — staged plan→review→execute:
//     plan           Plan-only: shows a detailed plan, waits for user approval
//     deep           Full pipeline: orchestrate → plan → review → execute
//
// CLI argv still maps a few legacy names (deprecation warnings):
//   default  → chat
//   verified → deep
//   manual   → plan
// PipelineModeSchema (Zod) hard-cuts to live modes only — no legacy enum values.
// ──────────────────────────────────────────────────────────────────────────

export const VALID_MODES = ['chat', 'chat-headless', 'plan', 'deep'] as const;
export type ValidMode = (typeof VALID_MODES)[number];

/** Legacy mode names mapped to their modern equivalents (CLI argv only). */
export const LEGACY_MODE_MAP: Record<string, ValidMode> = {
  default: 'chat',
  verified: 'deep',
  manual: 'plan',
  direct: 'chat',
  autonomous: 'deep',
  parallel_swarm: 'deep',
};

/** Notes for legacy modes that need user review before full removal. */
export const LEGACY_MODE_NOTES: Record<string, string> = {
  verified:
    'Mode "verified" is now an alias for "deep". Use --mode deep for the full governed pipeline.',
  manual: 'Mode "manual" is now an alias for "plan". Use --mode plan for plan-only workflows.',
};

/**
 * Resolve a mode string to a canonical ValidMode.
 * Legacy mode names are mapped to their modern equivalents with a deprecation warning.
 * Unknown modes throw an error with a helpful message.
 */
export function resolveMode(raw: string): { mode: ValidMode; deprecated?: boolean; note?: string } {
  const normalized = raw.toLowerCase().trim();
  // Direct match against current modes
  if ((VALID_MODES as readonly string[]).includes(normalized)) {
    return { mode: normalized as ValidMode };
  }
  // Legacy alias
  const mapped = LEGACY_MODE_MAP[normalized];
  if (mapped !== undefined) {
    const result: { mode: ValidMode; deprecated: true; note?: string } = {
      mode: mapped,
      deprecated: true,
    };
    const noteText = LEGACY_MODE_NOTES[normalized];
    if (noteText !== undefined) {
      result.note = noteText;
    }
    return result;
  }
  throw new Error(
    `Invalid mode: "${raw}". Supported modes: ${VALID_MODES.join(', ')}. ` +
      `Legacy modes (${Object.keys(LEGACY_MODE_MAP).join(', ')}) are deprecated.`,
  );
}

export const VALID_MODEL_TIERS = [...MODEL_POLICY_TIERS] as const;

/**
 * Static fallback project list used when the dynamic WorkspaceScanner
 * is unavailable (e.g., during early startup before BABEL_ROOT is resolved).
/** Projects are discovered dynamically via WorkspaceScanner. */
export type ValidProject = string;

export const VALID_ORCHESTRATORS = ['v9'] as const;
export type ValidOrchestrator = (typeof VALID_ORCHESTRATORS)[number];

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function findBabelRoot(startDir: string): string {
  let current = resolve(startDir);
  while (true) {
    if (existsSync(join(current, 'prompt_catalog.yaml'))) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return resolve(startDir, '../../..');
    }
    current = parent;
  }
}

export const BABEL_ROOT = process.env['BABEL_ROOT'] ?? findBabelRoot(__dirname);
export const BABEL_RUNS_DIR = process.env['BABEL_RUNS_DIR'] ?? join(BABEL_ROOT, 'runs');

export {
  chatSessionDir,
  chatSessionsDir,
  resolveBabelRunsDir,
  threadDir,
  threadsDir,
  transcriptPath,
} from './runsLayout.js';

/**
 * Sanitize a path component so it is safe to use as a filesystem name segment.
 * Strips Windows drive-letter prefixes (C:, D:, etc.), replaces characters
 * that are invalid in Windows/NTFS filenames (< > : " | ? *), and normalizes
 * backslashes to forward slashes. Does NOT strip path separators — callers
 * should split on separators before passing individual segments.
 */
export function sanitizePathComponent(segment: string): string {
  return segment
    .replace(/^[A-Za-z]:(?=\\|$)/, '') // Strip Windows drive letter (e.g. "C:\" → "\")
    .replace(/[<>:"|?*]/g, '-') // Replace NTFS-invalid filename chars
    .replace(/\\/g, '/'); // Normalize to POSIX separators
}

/**
 * Sanitize a full path string by applying sanitizePathComponent to each
 * segment. Preserves the directory structure while cleaning each component.
 */
export function sanitizePath(fullPath: string): string {
  const segments = fullPath.split(/[/\\]+/).filter(Boolean);
  return segments.map(sanitizePathComponent).join('/');
}

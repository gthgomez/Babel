/**
 * sharedOptions.ts — Shared Commander.js option factories for CLI commands.
 *
 * Consolidates duplicated option parsing across coreCommands.ts (~4000 lines)
 * into reusable option builders. Each function returns a Commander.js Command
 * with common options pre-configured.
 *
 * This is Phase C3 of the critique remediation roadmap — extracting shared
 * patterns without breaking the existing command surface.
 */

import { Command } from 'commander';
import { VALID_MODES, resolveMode } from './constants.js';

// ── Common option sets ───────────────────────────────────────────────────────

/** Options shared by most diagnostic/read-only commands. */
export function withJsonOption(command: Command): Command {
  return command.option('--json', 'Emit structured JSON only');
}

/** Options shared by pipeline execution commands (run, resume, plan). */
export function withPipelineOptions(command: Command): Command {
  return command
    .option('--json', 'Emit structured JSON only')
    .option('--mode <mode>', 'Pipeline mode: chat | chat-headless | plan | deep', 'chat')
    .option(
      '--headless',
      'With chat mode: same as --mode chat-headless (CI/JSON; stable alias still supported)',
    )
    .option('--model <model>', 'Model family override')
    .option('--project-root <path>', 'Target project root directory');
}

/** Options shared by job/agent commands. */
export function withJobOptions(command: Command): Command {
  return command
    .option('--json', 'Emit structured JSON only')
    .option('--id <id>', 'Stable job/run identifier')
    .option('--execution-profile <profile>', 'Execution profile name');
}

/** Options for approval/administrative commands. */
export function withAdminOptions(command: Command): Command {
  return command
    .option('--json', 'Emit structured JSON only')
    .option('--force', 'Skip confirmation prompts');
}

/** Options for benchmark commands. */
export function withBenchmarkOptions(command: Command): Command {
  return command
    .option('--json', 'Emit structured JSON only')
    .option('--runs <n>', 'Number of runs', '1')
    .option('--output <path>', 'Results output path');
}

// ── Validation helpers ───────────────────────────────────────────────────────

/** Parse and validate --mode flag value. Uses centralized resolveMode from constants. */
export function parseModeFlag(value?: string): string {
  const mode = (value ?? 'chat').toLowerCase();
  const resolved = resolveMode(mode);
  if (resolved.deprecated && resolved.note) {
    process.stderr.write(`[DEPRECATED] ${resolved.note}\n`);
  }
  return resolved.mode;
}

/** Parse and validate --runs flag value. */
export function parseRunsFlag(value?: string): number {
  const parsed = Number.parseInt(value ?? '1', 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 100) {
    throw new Error(`Invalid --runs value: "${value}". Must be 1-100.`);
  }
  return parsed;
}

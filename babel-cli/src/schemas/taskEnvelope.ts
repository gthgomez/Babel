/**
 * taskEnvelope.ts — Structured goal envelope schema and loader
 *
 * Phase 3E: Defines the .babel/task-envelope.json contract for
 * constrained, governed task execution with explicit tool, path,
 * network, and approval policies.
 *
 * Phase 1a (Safety): Adds runtime enforcement via setActiveTaskEnvelope() /
 * getActiveTaskEnvelope() and enforceActiveTaskEnvelope(). The envelope
 * was previously advisory-only (formatTaskEnvelopeLines produced prompt text).
 * Now constraints are enforced at the executeTool() level.
 */

import { z } from 'zod';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EXECUTOR_TOOL_NAMES } from '../tools/toolContracts.js';

/** Set of known executor tool names for validation. */
const KNOWN_TOOL_SET = new Set<string>(EXECUTOR_TOOL_NAMES);

export const TaskEnvelopeSchema = z
  .object({
    /** Semantic version of the envelope format */
    schema_version: z.literal(1).default(1),
    /** The task goal / user request */
    goal: z.string().min(1, 'goal is required'),
    /** Execution mode */
    mode: z.enum(['read_only', 'plan_only', 'mutate_gated']).default('read_only'),
    /** Explicitly allowed tools. Empty = all tools allowed (subject to other policies). */
    allowedTools: z
      .array(z.string())
      .superRefine((tools, ctx) => {
        for (let i = 0; i < tools.length; i++) {
          const tool = tools[i];
          if (tool && !KNOWN_TOOL_SET.has(tool)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Unknown tool "${tool}". Must be one of: ${EXECUTOR_TOOL_NAMES.join(', ')}`,
              path: [i],
            });
          }
        }
      })
      .optional(),
    /** Explicitly denied tools. Takes precedence over allowedTools. */
    deniedTools: z
      .array(z.string())
      .superRefine((tools, ctx) => {
        for (let i = 0; i < tools.length; i++) {
          const tool = tools[i];
          if (tool && !KNOWN_TOOL_SET.has(tool)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Unknown tool "${tool}". Must be one of: ${EXECUTOR_TOOL_NAMES.join(', ')}`,
              path: [i],
            });
          }
        }
      })
      .optional(),
    /** Maximum number of file_write calls allowed. Undefined = unlimited. */
    maxFileWrites: z.number().int().positive().optional(),
    /** Paths the executor must not write to (glob patterns supported) */
    protectedPaths: z.array(z.string()).optional(),
    /** Approval policy for mutation operations */
    approvalPolicy: z.enum(['auto_safe', 'ask_before_mutation', 'ask_all']).default('auto_safe'),
    /** Network access level */
    networkAccess: z.enum(['none', 'read_only', 'full']).default('read_only'),
    /** Maximum wall-clock time in seconds. Undefined = no limit. */
    timeoutSeconds: z.number().int().positive().optional(),
    /** Required verifier commands that must run before completion */
    requiredVerifiers: z.array(z.string()).optional(),
  })
  .refine(
    (data) => {
      if (!data.allowedTools || !data.deniedTools) return true;
      const allowed = new Set(data.allowedTools);
      const overlap = data.deniedTools.filter((tool) => allowed.has(tool));
      return overlap.length === 0;
    },
    {
      message: 'allowedTools and deniedTools must not contain overlapping entries.',
      path: ['deniedTools'],
    },
  );

export type TaskEnvelope = z.infer<typeof TaskEnvelopeSchema>;

export interface TaskEnvelopeLoadResult {
  loaded: boolean;
  envelope?: TaskEnvelope;
  path?: string;
  error?: string;
}

/**
 * Load a task envelope from a directory or explicit path.
 * Looks for .babel/task-envelope.json in the given root, or reads the explicit file.
 */
export function loadTaskEnvelope(rootOrPath?: string): TaskEnvelopeLoadResult {
  const candidatePaths: string[] = [];

  if (rootOrPath) {
    // If it looks like a direct file path, try it directly
    if (rootOrPath.endsWith('.json')) {
      candidatePaths.push(resolve(rootOrPath));
    }
    // Always check .babel/task-envelope.json in the given root
    candidatePaths.push(join(rootOrPath, '.babel', 'task-envelope.json'));
  }

  // Also check current working directory
  candidatePaths.push(join(process.cwd(), '.babel', 'task-envelope.json'));

  const errors: string[] = [];

  for (const candidatePath of candidatePaths) {
    if (!existsSync(candidatePath)) continue;

    try {
      const raw = JSON.parse(readFileSync(candidatePath, 'utf-8')) as unknown;
      const parsed = TaskEnvelopeSchema.parse(raw);
      return { loaded: true, envelope: parsed, path: candidatePath };
    } catch (err) {
      errors.push(`[${candidatePath}] ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (errors.length > 0) {
    return {
      loaded: false,
      error: `Failed to parse task envelope at all candidate paths: ${errors.join('; ')}`,
    };
  }

  return { loaded: false };
}

/**
 * Convert a TaskEnvelope to human-readable prompt lines for injection
 * into the orchestrator task context.
 */
export function formatTaskEnvelopeLines(envelope: TaskEnvelope): string[] {
  const lines: string[] = [
    '',
    '--- TASK ENVELOPE CONSTRAINTS ---',
    `  Goal: ${envelope.goal}`,
    `  Mode: ${envelope.mode}`,
    `  Approval: ${envelope.approvalPolicy}`,
    `  Network: ${envelope.networkAccess}`,
  ];

  if (envelope.allowedTools && envelope.allowedTools.length > 0) {
    lines.push(`  Allowed tools: ${envelope.allowedTools.join(', ')}`);
  }
  if (envelope.deniedTools && envelope.deniedTools.length > 0) {
    lines.push(`  Denied tools: ${envelope.deniedTools.join(', ')}`);
  }
  if (envelope.maxFileWrites !== undefined) {
    lines.push(`  Max file writes: ${envelope.maxFileWrites}`);
  }
  if (envelope.protectedPaths && envelope.protectedPaths.length > 0) {
    lines.push(`  Protected paths: ${envelope.protectedPaths.join(', ')}`);
  }
  if (envelope.timeoutSeconds !== undefined) {
    lines.push(`  Timeout: ${envelope.timeoutSeconds}s`);
  }
  if (envelope.requiredVerifiers && envelope.requiredVerifiers.length > 0) {
    lines.push(`  Required verifiers: ${envelope.requiredVerifiers.join('; ')}`);
  }

  lines.push('');
  return lines;
}

// ─── Runtime enforcement (Phase 1a) ─────────────────────────────────────────

/** The currently active task envelope, set at pipeline start. */
let activeEnvelope: TaskEnvelope | null = null;

/** Per-run file_write counter for maxFileWrites enforcement. */
const fileWriteCounts = new Map<string, number>();

/**
 * Set the active task envelope for the current pipeline run.
 * Called once at pipeline startup before any tool dispatch.
 */
export function setActiveTaskEnvelope(envelope: TaskEnvelope | null): void {
  activeEnvelope = envelope;
}

/**
 * Get the currently active task envelope, or null if none is set.
 */
export function getActiveTaskEnvelope(): TaskEnvelope | null {
  return activeEnvelope;
}

/**
 * Reset file-write counter for a run (called when the envelope is set).
 */
export function resetFileWriteCount(runId: string): void {
  fileWriteCounts.delete(runId);
}

/**
 * Result of envelope enforcement. `null` means the tool call is allowed.
 * A non-null result means the call is blocked — return it as the ToolResult.
 */
export interface EnvelopeBlockResult {
  exit_code: number;
  stdout: string;
  stderr: string;
}

/** Known network-accessing tools. */
const NETWORK_TOOLS = new Set(['web_search', 'web_fetch', 'mcp_request']);

/** Known mutating tools. */
const MUTATION_TOOLS = new Set(['file_write', 'shell_exec', 'test_run']);

/**
 * Check a tool call against the active task envelope.
 * Returns null if allowed, or a block result if denied.
 */
export function enforceActiveTaskEnvelope(
  tool: string,
  runId: string,
  target?: string,
): EnvelopeBlockResult | null {
  const envelope = activeEnvelope;
  if (!envelope) return null;

  // 1. Denied tools — takes precedence
  if (envelope.deniedTools && envelope.deniedTools.length > 0) {
    if (envelope.deniedTools.includes(tool)) {
      return {
        exit_code: 1,
        stdout: '',
        stderr: `[ENVELOPE_DENIED] Tool "${tool}" is denied by the active task envelope.`,
      };
    }
  }

  // 2. Allowed tools — if set, all others are denied
  if (envelope.allowedTools && envelope.allowedTools.length > 0) {
    if (!envelope.allowedTools.includes(tool)) {
      return {
        exit_code: 1,
        stdout: '',
        stderr: `[ENVELOPE_DENIED] Tool "${tool}" is not in the envelope allowed-tools list. Allowed: ${envelope.allowedTools.join(', ')}`,
      };
    }
  }

  // 3. Network access gating
  if (envelope.networkAccess === 'none' && NETWORK_TOOLS.has(tool)) {
    return {
      exit_code: 1,
      stdout: '',
      stderr: `[ENVELOPE_DENIED] Network access is disabled (networkAccess: none). Tool "${tool}" requires network.`,
    };
  }

  // 4. Read-only mode — block all mutating tools
  if (envelope.mode === 'read_only' && MUTATION_TOOLS.has(tool)) {
    return {
      exit_code: 1,
      stdout: '',
      stderr: `[ENVELOPE_DENIED] Envelope mode is "read_only". Tool "${tool}" is a mutation tool.`,
    };
  }

  // 5. Plan-only mode — block all mutating tools
  if (envelope.mode === 'plan_only' && MUTATION_TOOLS.has(tool)) {
    return {
      exit_code: 1,
      stdout: '',
      stderr: `[ENVELOPE_DENIED] Envelope mode is "plan_only". Tool "${tool}" is a mutation tool.`,
    };
  }

  // 6. maxFileWrites enforcement
  if (tool === 'file_write' && envelope.maxFileWrites !== undefined) {
    const count = (fileWriteCounts.get(runId) ?? 0) + 1;
    if (count > envelope.maxFileWrites) {
      return {
        exit_code: 1,
        stdout: '',
        stderr: `[ENVELOPE_DENIED] File write limit exceeded: ${envelope.maxFileWrites} max, this would be write #${count}.`,
      };
    }
    fileWriteCounts.set(runId, count);
  }

  // 7. Protected paths
  if (target && envelope.protectedPaths && envelope.protectedPaths.length > 0) {
    for (const protectedPattern of envelope.protectedPaths) {
      if (target === protectedPattern || target.startsWith(protectedPattern)) {
        return {
          exit_code: 1,
          stdout: '',
          stderr: `[ENVELOPE_DENIED] Path "${target}" is protected by the active task envelope (matches "${protectedPattern}").`,
        };
      }
    }
  }

  return null;
}

/**
 * Clear envelope state between runs (best-effort cleanup).
 */
export function clearActiveTaskEnvelope(): void {
  activeEnvelope = null;
}

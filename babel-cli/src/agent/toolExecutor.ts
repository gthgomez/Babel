/**
 * Tool executor lane — maps normalized `AgentAction` values to `executeTool` calls.
 *
 * AgentAction → executeTool mapping (stable Wave 1 contract):
 *
 * | AgentAction.type | executeTool                         | Notes |
 * |------------------|-------------------------------------|-------|
 * | read_file        | file_read                           | read-only |
 * | list_dir         | directory_list                      | read-only |
 * | search           | semantic_search                     | read-only repo index |
 * | grep             | grep                                | read-only content search |
 * | glob             | glob                                | read-only path glob |
 * | write_file       | file_write                          | mutating |
 * | apply_patch      | file_write + shell_exec             | writes `.babel-lite/apply.patch`, then `git apply` |
 * | run_command      | shell_exec or test_run              | `test_run` when command looks like a test invocation |
 * | finish           | (none)                              | terminal — loop should verify + checkpoint |
 * | ask_approval     | (none)                              | terminal — loop should pause for user approval |
 */

import { isAbsolute, resolve } from 'node:path';

import {
  executeTool,
  type ToolCallRequest,
  type ToolContext,
  type ToolResult,
} from '../localTools.js';
import { isPathInside } from '../services/targetResolver.js';
import type { AgentAction } from './actions.js';
import { emitAgentEvent } from './events.js';
import { decideAction, type PermissionDecision, type PermissionPreset } from './policy.js';

const APPLY_PATCH_RELATIVE_PATH = '.babel-lite/apply.patch';

// ─── Budget & resource limits ────────────────────────────────────────────

export interface ToolExecutionBudget {
  perToolTimeoutMs: number;
  maxIterations: number;
}

export const DEFAULT_TOOL_BUDGET: ToolExecutionBudget = {
  perToolTimeoutMs: 120_000,
  maxIterations: 25,
};

export class ToolExecutionTimeoutError extends Error {
  constructor(tool: string, timeoutMs: number) {
    super(`Tool "${tool}" exceeded timeout of ${timeoutMs}ms`);
    this.name = 'ToolExecutionTimeoutError';
  }
}

export class ToolExecutionCapacityError extends Error {
  constructor(actionType: string, maxIterations: number, actual: number) {
    super(
      `Action "${actionType}" maps to ${actual} tool calls, exceeding limit of ${maxIterations}`,
    );
    this.name = 'ToolExecutionCapacityError';
  }
}

// ─── Patch validation constants ──────────────────────────────────────────

const MAX_PATCH_SIZE_BYTES = 1_048_576; // 1 MB
const MAX_PATCH_HUNKS = 100;

// ─── Circuit-breaker (per-session, keyed by runId) ──────────────────────

const sessionBlocks = new Map<string, number>();

function getCircuitBreakerLimit(): number {
  const env = process.env['BABEL_CIRCUIT_BREAKER_LIMIT'];
  return env?.trim() ? Math.max(1, parseInt(env, 10) || 5) : 5;
}

function incrementBlocks(runId: string): number {
  const current = (sessionBlocks.get(runId) ?? 0) + 1;
  sessionBlocks.set(runId, current);
  return current;
}

function resetBlocks(runId: string): void {
  sessionBlocks.delete(runId);
}

export function resetCircuitBreaker(): void {
  sessionBlocks.clear();
}

export function resetCircuitBreakerForRun(runId: string): void {
  sessionBlocks.delete(runId);
}

export function getCircuitBreakerState(runId?: string): {
  consecutiveBlocks: number;
  tripped: boolean;
} {
  const limit = getCircuitBreakerLimit();
  const blocks = runId ? (sessionBlocks.get(runId) ?? 0) : 0;
  return { consecutiveBlocks: blocks, tripped: blocks >= limit };
}

export type TerminalAgentAction = Extract<AgentAction, { type: 'finish' | 'ask_approval' }>;

export type MappedToolCall =
  | { kind: 'execute'; request: ToolCallRequest }
  | { kind: 'terminal'; action: TerminalAgentAction };

export interface ToolExecutionResult {
  action: AgentAction;
  terminal: boolean;
  results: ToolResult[];
}

export interface PolicyGatedExecutionResult extends ToolExecutionResult {
  policyDecision: PermissionDecision;
  policyBlocked: boolean;
}

export interface ToolExecutor {
  mapAction(action: AgentAction): MappedToolCall[];
  execute(
    action: AgentAction,
    context: ToolContext,
    budget?: ToolExecutionBudget,
  ): Promise<ToolExecutionResult>;
}

function looksLikeTestCommand(command: string): boolean {
  return /\b(npm\s+test|pnpm\s+test|yarn\s+test|pytest|jest|vitest|cargo\s+test|go\s+test|dotnet\s+test)\b/i.test(
    command,
  );
}

// ─── Patch target extraction ─────────────────────────────────────────────

/**
 * Parse unified diff headers to extract the set of files a patch would modify.
 * Returns absolute paths resolved against `projectRoot`, or empty array if
 * parsing fails (defense-in-depth: invalid patches are denied by validation
 * in executeActionWithPolicy, not here).
 */
function extractPatchTargetPaths(patchContent: string, projectRoot: string): string[] {
  return extractPatchRawTargets(patchContent).map((rawPath) =>
    isAbsolute(rawPath) ? resolve(rawPath) : resolve(projectRoot, rawPath),
  );
}

/**
 * Validate patch content before application.
 * Returns violations array — empty means safe to apply.
 */
export function validatePatchContent(patchContent: string, projectRoot: string): string[] {
  const violations: string[] = [];

  if (Buffer.byteLength(patchContent, 'utf8') > MAX_PATCH_SIZE_BYTES) {
    violations.push(
      `Patch size ${patchContent.length} exceeds limit of ${MAX_PATCH_SIZE_BYTES} bytes`,
    );
  }

  const hunkCount = (patchContent.match(/^@@\s+-?\d+(?:,\d+)?\s+\+?\d+(?:,\d+)?\s+@@/gm) ?? [])
    .length;
  if (hunkCount > MAX_PATCH_HUNKS) {
    violations.push(`Patch hunk count ${hunkCount} exceeds limit of ${MAX_PATCH_HUNKS}`);
  }

  if (hunkCount === 0) {
    violations.push('Patch contains no recognizable diff hunks');
  }

  const targetPaths = extractPatchTargetPaths(patchContent, projectRoot);
  for (const target of targetPaths) {
    if (!isPathInside(projectRoot, target)) {
      violations.push(`Patch target outside project_root: ${target}`);
    }
  }

  return violations;
}

// ─── Timeout helper ──────────────────────────────────────────────────────

/**
 * Race a tool promise against the outer execution budget. Foreground process
 * tools receive an onAbort callback that propagates this timeout to their
 * SafeExecutor child process instead of abandoning it in the background.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  toolName: string,
  externalSignal?: AbortSignal,
  onAbort?: () => void,
): Promise<T> {
  if (timeoutMs <= 0) return promise;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let timedOut = false;

  // Link external signal so external cancellation also aborts the tool.
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      clearTimeout(timer);
      onAbort?.();
      throw new ToolExecutionTimeoutError(toolName, timeoutMs);
    }
    externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  try {
    const result = await Promise.race([
      promise.then((r) => {
        if (timedOut) throw new ToolExecutionTimeoutError(toolName, timeoutMs);
        return r;
      }),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener(
          'abort',
          () => {
            timedOut = true;
            onAbort?.();
            // Suppress unhandled rejection from the abandoned promise
            promise.catch(() => {});
            reject(new ToolExecutionTimeoutError(toolName, timeoutMs));
          },
          { once: true },
        );
      }),
    ]);
    return result;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}

function runCommandToolRequest(
  action: Extract<AgentAction, { type: 'run_command' }>,
): ToolCallRequest {
  const base = {
    command: action.command,
    ...(action.cwd ? { working_directory: action.cwd } : {}),
  };

  // M9: Always dispatch as `shell_exec` — the sandbox's shellExec method
  // already applies the same execution profile checks regardless of tool name
  // (see checkExecutionProfileToolDenialWithTestRun). Routing through test_run
  // here was a bypass risk when the profile only disallowed shell_exec.
  return { tool: 'shell_exec', ...base };
}

/** Map one agent action to zero or more executor tool calls (terminal actions map to none). */
export function mapAgentActionToToolCalls(action: AgentAction): MappedToolCall[] {
  switch (action.type) {
    case 'read_file':
      return [{ kind: 'execute', request: { tool: 'file_read', path: action.path } }];
    case 'list_dir':
      return [{ kind: 'execute', request: { tool: 'directory_list', path: action.path } }];
    case 'search':
      return [{ kind: 'execute', request: { tool: 'semantic_search', query: action.query } }];
    case 'grep':
      return [
        {
          kind: 'execute',
          request: {
            tool: 'grep',
            pattern: action.pattern,
            ...(action.path !== undefined ? { path: action.path } : {}),
          },
        },
      ];
    case 'glob':
      return [{ kind: 'execute', request: { tool: 'glob', pattern: action.pattern } }];
    case 'write_file':
      return [
        {
          kind: 'execute',
          request: { tool: 'file_write', path: action.path, content: action.content },
        },
      ];
    case 'apply_patch':
      return [
        {
          kind: 'execute',
          request: {
            tool: 'file_write',
            path: APPLY_PATCH_RELATIVE_PATH,
            content: action.patch,
          },
        },
        {
          kind: 'execute',
          request: {
            tool: 'shell_exec',
            command: `git apply ${APPLY_PATCH_RELATIVE_PATH}`,
          },
        },
      ];
    case 'run_command':
      return [{ kind: 'execute', request: runCommandToolRequest(action) }];
    case 'git_context':
      return [
        {
          kind: 'execute',
          request: {
            tool: 'git_context',
            ...(action.format !== undefined ? { format: action.format } : {}),
            ...(action.path !== undefined ? { path: action.path } : {}),
            ...(action.max_lines !== undefined ? { max_lines: action.max_lines } : {}),
          },
        },
      ];
    case 'test_run':
      return [
        {
          kind: 'execute',
          request: {
            tool: 'test_run',
            command: action.command,
            ...(action.cwd ? { working_directory: action.cwd } : {}),
            ...(action.timeout_seconds !== undefined
              ? { timeout_seconds: action.timeout_seconds }
              : {}),
          },
        },
      ];
    case 'workspace_map':
      return [
        {
          kind: 'execute',
          request: {
            tool: 'workspace_map',
            ...(action.max_depth !== undefined ? { max_depth: action.max_depth } : {}),
            ...(action.max_files !== undefined ? { max_files: action.max_files } : {}),
          },
        },
      ];
    case 'finish':
    case 'ask_approval':
      return [{ kind: 'terminal', action }];
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

export function isTerminalAgentAction(action: AgentAction): action is TerminalAgentAction {
  return action.type === 'finish' || action.type === 'ask_approval';
}

export function createToolExecutor(
  deps: {
    executeTool?: typeof executeTool;
  } = {},
): ToolExecutor {
  const runTool = deps.executeTool ?? executeTool;

  return {
    mapAction(action: AgentAction): MappedToolCall[] {
      return mapAgentActionToToolCalls(action);
    },

    async execute(
      action: AgentAction,
      context: ToolContext,
      budget?: ToolExecutionBudget,
    ): Promise<ToolExecutionResult> {
      const mapped = mapAgentActionToToolCalls(action);
      const terminal = mapped.find(
        (entry): entry is Extract<MappedToolCall, { kind: 'terminal' }> =>
          entry.kind === 'terminal',
      );

      if (terminal) {
        return {
          action,
          terminal: true,
          results: [],
        };
      }

      const execEntries = mapped.filter(
        (entry): entry is Extract<MappedToolCall, { kind: 'execute' }> => entry.kind === 'execute',
      );

      // ── Iteration cap ──────────────────────────────────────────────
      if (budget && execEntries.length > budget.maxIterations) {
        throw new ToolExecutionCapacityError(action.type, budget.maxIterations, execEntries.length);
      }

      const effectiveTimeout = budget?.perToolTimeoutMs ?? 0;

      const results: ToolResult[] = [];
      for (const entry of execEntries) {
        const toolName = entry.request.tool;
        const toolController = new AbortController();
        const onParentAbort = () => toolController.abort();
        if (context.signal?.aborted) toolController.abort();
        else context.signal?.addEventListener('abort', onParentAbort, { once: true });
        try {
          const promise = runTool(entry.request, {
            ...context,
            signal: toolController.signal,
          });
          const result =
            effectiveTimeout > 0
              ? await withTimeout(promise, effectiveTimeout, toolName, context.signal, () =>
                  toolController.abort(),
                )
              : await promise;
          results.push(result);
        } catch (error) {
          if (error instanceof ToolExecutionTimeoutError) {
            emitAgentEvent({
              type: 'tool_timeout',
              action: action.type,
              tool: toolName,
              timeoutMs: effectiveTimeout,
            });
          }
          throw error;
        } finally {
          context.signal?.removeEventListener('abort', onParentAbort);
        }
      }

      return {
        action,
        terminal: false,
        results,
      };
    },
  };
}

export const defaultToolExecutor = createToolExecutor();

function policyBlockedToolResult(
  action: AgentAction,
  decision: PermissionDecision,
  reason?: string,
): ToolResult {
  const message =
    reason ??
    (decision === 'deny'
      ? `Policy denied ${action.type}`
      : `Policy requires approval before ${action.type}`);
  return {
    exit_code: 1,
    stdout: '',
    stderr: message,
  };
}

function projectRootForScope(preset: PermissionPreset): string | null {
  const raw = process.env['BABEL_PROJECT_ROOT'];
  if (raw?.trim()) return resolve(raw);

  // Fail-closed for read_only: use cwd as scope boundary when
  // BABEL_PROJECT_ROOT is not explicitly configured. This ensures
  // scope checks are always active for read-only sessions rather
  // than silently skipped.
  if (preset === 'read_only') {
    emitAgentEvent({
      type: 'malformed_config',
      source: 'projectRootForScope',
      detail:
        'BABEL_PROJECT_ROOT not set — using process.cwd() as scope boundary for read_only preset',
      severity: 'warn',
    });
    return resolve(process.cwd());
  }

  return null;
}

function pathsFromAgentAction(action: AgentAction): string[] {
  switch (action.type) {
    case 'read_file':
    case 'list_dir':
    case 'write_file':
      return [action.path];
    case 'grep':
      return action.path !== undefined ? [action.path] : [];
    case 'glob':
      // Resolve relative patterns to detect traversal attempts
      return [isAbsolute(action.pattern) ? action.pattern : resolve(process.cwd(), action.pattern)];
    case 'apply_patch':
      return extractPatchRawTargets(action.patch);
    default:
      return [];
  }
}

/**
 * Extract raw (unresolved) target paths from unified diff patch headers.
 * Returns paths as they appear in the diff (e.g. "src/file.ts" or "/absolute/path").
 * These are later resolved + validated by findOutOfScopeTarget / isPathInside.
 */
function extractPatchRawTargets(patchContent: string): string[] {
  const headerRe = /^[-+]{3}\s+([ab]\/)?(\S+)/gm;
  const targets = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = headerRe.exec(patchContent)) !== null) {
    const rawPath = match[2] ?? '';
    if (!rawPath || rawPath === '/dev/null') continue;
    targets.add(rawPath);
  }
  return [...targets];
}

function resolveScopedPath(projectRoot: string, rawPath: string): string {
  return isAbsolute(rawPath) ? resolve(rawPath) : resolve(projectRoot, rawPath);
}

function findOutOfScopeTarget(action: AgentAction, projectRoot: string): string | null {
  for (const rawPath of pathsFromAgentAction(action)) {
    const resolved = resolveScopedPath(projectRoot, rawPath);
    if (!isPathInside(projectRoot, resolved)) {
      return resolved;
    }
  }
  return null;
}

function readOnlyScopeViolation(action: AgentAction, preset: PermissionPreset): string | null {
  if (preset !== 'read_only') {
    return null;
  }
  const projectRoot = projectRootForScope(preset);
  if (!projectRoot) {
    return null;
  }
  const violation = findOutOfScopeTarget(action, projectRoot);
  if (!violation) {
    return null;
  }
  return `Policy denied ${action.type}: tool target outside project_root (${violation})`;
}

/**
 * Execute one agent action after `decideAction()` — central policy gate for tool calls.
 * Deny and ask decisions block execution; allow proceeds through the tool executor.
 *
 * Includes circuit-breaker: consecutive policy blocks trip the breaker, causing all
 * further actions to return a terminal circuit-breaker result until reset.
 */
export async function executeActionWithPolicy(
  action: AgentAction,
  preset: PermissionPreset,
  context: ToolContext,
  deps: {
    executor?: ToolExecutor;
    decide?: typeof decideAction;
    budget?: ToolExecutionBudget;
    /** When policy returns `ask`, invoke this before blocking. Return true to execute. */
    onAskApproval?: (action: AgentAction) => Promise<boolean>;
  } = {},
): Promise<PolicyGatedExecutionResult> {
  const executor = deps.executor ?? defaultToolExecutor;
  const decide = deps.decide ?? decideAction;
  const budget = deps.budget ?? DEFAULT_TOOL_BUDGET;

  // ── Circuit-breaker: entry check ───────────────────────────────────
  const limit = getCircuitBreakerLimit();
  const currentBlocks = sessionBlocks.get(context.runId) ?? 0;
  if (currentBlocks >= limit) {
    emitAgentEvent({
      type: 'circuit_breaker',
      reason: `Session terminated: ${limit} consecutive policy blocks`,
      consecutiveBlocks: currentBlocks,
    });
    return {
      action,
      terminal: true,
      results: [
        {
          exit_code: 1,
          stdout: '',
          stderr:
            `[CIRCUIT_BREAKER] Session terminated: ${currentBlocks} consecutive policy blocks. ` +
            'This indicates the model is persistently attempting actions that policy disallows. ' +
            'Restart the session to reset the circuit breaker.',
        },
      ],
      policyDecision: 'deny',
      policyBlocked: true,
    };
  }

  let policyDecision = decide(action, preset);

  if (policyDecision === 'ask' && deps.onAskApproval) {
    const approved = await deps.onAskApproval(action);
    if (approved) {
      policyDecision = 'allow';
    } else {
      policyDecision = 'deny';
    }
  }

  if (policyDecision !== 'allow') {
    incrementBlocks(context.runId);
    emitAgentEvent({
      type: 'policy_decision',
      action: action.type,
      decision: policyDecision,
      preset,
      runId: context.runId,
      agentId: context.agentId,
    });
    return {
      action,
      terminal: isTerminalAgentAction(action),
      results: [
        policyBlockedToolResult(
          action,
          policyDecision,
          policyDecision === 'deny' && preset === 'ask_before_mutation'
            ? 'User denied approval'
            : undefined,
        ),
      ],
      policyDecision,
      policyBlocked: true,
    };
  }

  const scopeViolation = readOnlyScopeViolation(action, preset);
  if (scopeViolation) {
    incrementBlocks(context.runId);
    emitAgentEvent({
      type: 'scope_violation',
      action: action.type,
      target: scopeViolation,
      projectRoot: process.env['BABEL_PROJECT_ROOT'] ?? process.cwd(),
      preset,
    });
    return {
      action,
      terminal: isTerminalAgentAction(action),
      results: [policyBlockedToolResult(action, 'deny', scopeViolation)],
      policyDecision: 'deny',
      policyBlocked: true,
    };
  }

  // ── Patch content validation (H1 hardening) ────────────────────────
  if (action.type === 'apply_patch') {
    const projectRoot = projectRootForScope(preset) ?? resolve(process.cwd());
    const patchViolations = validatePatchContent(action.patch, projectRoot);
    if (patchViolations.length > 0) {
      incrementBlocks(context.runId);
      const detail = patchViolations.join('; ');
      emitAgentEvent({
        type: 'scope_violation',
        action: 'apply_patch',
        target: detail,
        projectRoot,
        preset,
      });
      return {
        action,
        terminal: false,
        results: [policyBlockedToolResult(action, 'deny', `Patch rejected: ${detail}`)],
        policyDecision: 'deny',
        policyBlocked: true,
      };
    }
  }

  // ── Successful execution: reset circuit-breaker ────────────────────
  resetBlocks(context.runId);

  const execution = await executor.execute(action, context, budget);
  return {
    ...execution,
    policyDecision,
    policyBlocked: false,
  };
}

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

import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { WorkspaceTransactionManager, type MutationBatchReceipt } from '../services/workspaceTransactions.js';
import { classifyToolEffect } from '../executor/contracts.js';
import { recordEffectIntent, recordEffectTerminal } from '../executor/effectLedger.js';
import {
  beginEffectTransaction,
  captureWorkspaceRevisionIdentity,
  checkToolCapability,
  commitEffectTransaction,
  reconcileEffectTransaction,
  rollbackEffectTransaction,
  type EffectTransactionRecord,
} from './capabilityBroker.js';

import {
  executeTool,
  type ToolCallRequest,
  type ToolContext,
  type ToolResult,
} from '../localTools.js';
import { isPathInside } from '../services/targetResolver.js';
import type { AgentAction } from './actions.js';
import { modelToolNameToExecutor } from './canonicalToolMapping.js';
import { emitAgentEvent } from './events.js';
import { decideAction, type PermissionDecision, type PermissionPreset } from './policy.js';
import { commandTextForAction, isCredentialTargetPath } from './autonomyEnforcement.js';
// Shared patch-target parser — one extractor for path-jail validation here
// and governance integrity checking in authority/wire.ts.
import { extractPatchRawTargets, extractPatchTargets } from '../authority/patchTargets.js';
import { loadLeaseFromEnv, type AutonomyLease } from '../authority/lease.js';
import { decideWithLease, invalidateLease, type LeaseContext } from '../authority/wire.js';
import type { BaselineManifest } from '../authority/integrity.js';
import type { AuthoritySessionContext } from '../authority/sessionContext.js';
import type { ReasonCode } from '../authority/reasonCodes.js';
import { actionRequestFromAction } from '../authority/actionRequest.js';
import { CAPABILITY_KINDS } from '../authority/capabilities.js';
import {
  reconcileGovernanceAfterEffect,
  snapshotGovernanceBytes,
} from '../authority/governanceReconcile.js';
import { runWithUnprivilegedChildEnv } from '../authority/unprivilegedChildEnv.js';
import { classifyAutonomyAction } from '../config/autonomyPolicy.js';

/**
 * Active lease, cached for the process lifetime. A broken lease env fails
 * LOUD at the first decision (fail-closed) rather than silently degrading.
 */
let cachedLease: AutonomyLease | null | undefined;
function activeLease(): AutonomyLease | null {
  if (cachedLease !== undefined) return cachedLease;
  cachedLease = loadLeaseFromEnv();
  return cachedLease;
}

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
  /** Authority reason when decideWithLease influenced the decision. */
  reasonCode?: ReasonCode | '';
  mutationPaths?: string[] | undefined;
  preBatchHash?: Record<string, string> | undefined;
  postBatchHash?: Record<string, string> | undefined;
  mutationReceipt?: MutationBatchReceipt | undefined;
  /** H4: revision-linked effect transaction record when a reconcilable mutation ran. */
  effectTransaction?: EffectTransactionRecord | undefined;
}

/** Extract primary target path from an AgentAction for capability checks. */
export function targetPathFromAction(action: AgentAction): string | undefined {
  if (action.type === 'write_file' || action.type === 'read_file' || action.type === 'list_dir') {
    return action.path;
  }
  if (action.type === 'grep' && action.path) return action.path;
  if (action.type === 'git_context' && action.path) return action.path;
  return undefined;
}

/** Stable idempotency key for a mutating action when caller does not supply one. */
export function defaultIdempotencyKeyForAction(action: AgentAction): string | undefined {
  if (action.type === 'write_file') return `write_file:${action.path}`;
  if (action.type === 'apply_patch') {
    const h = action.patch.length;
    return `apply_patch:len=${h}`;
  }
  if (action.type === 'run_command') return `run_command:${action.command.slice(0, 120)}`;
  if (action.type === 'test_run') return `test_run:${action.command.slice(0, 120)}`;
  return undefined;
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

// ─── Patch target extraction (shared utility: authority/patchTargets.ts) ──

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

  const targetPaths = extractPatchTargets(patchContent, projectRoot);
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
  const executorName = modelToolNameToExecutor(action.type);
  switch (action.type) {
    case 'read_file':
      return [{ kind: 'execute', request: { tool: (executorName ?? 'file_read') as 'file_read', path: action.path } }];
    case 'list_dir':
      return [{ kind: 'execute', request: { tool: (executorName ?? 'directory_list') as 'directory_list', path: action.path } }];
    case 'search':
      return [{ kind: 'execute', request: { tool: (executorName ?? 'semantic_search') as 'semantic_search', query: action.query } }];
    case 'grep':
      return [
        {
          kind: 'execute',
          request: {
            tool: (executorName ?? 'grep') as 'grep',
            pattern: action.pattern,
            ...(action.path !== undefined ? { path: action.path } : {}),
          },
        },
      ];
    case 'glob':
      return [{ kind: 'execute', request: { tool: (executorName ?? 'glob') as 'glob', pattern: action.pattern } }];
    case 'write_file':
      return [
        {
          kind: 'execute',
          request: { tool: (executorName ?? 'file_write') as 'file_write', path: action.path, content: action.content },
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
            tool: (executorName ?? 'git_context') as 'git_context',
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
            tool: (executorName ?? 'test_run') as 'test_run',
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
            tool: (executorName ?? 'workspace_map') as 'workspace_map',
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

function readOnlyEffectViolation(action: AgentAction, preset: PermissionPreset): string | null {
  if (preset !== 'read_only') return null;
  const effectClass = classifyToolEffect(action.type);
  return effectClass === 'read_only'
    ? null
    : `Plan/read-only policy denied ${action.type}: effect class ${effectClass} is not read-only`;
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
    /**
     * Compatibility-only: honored only when the PDP/legacy composite already
     * returned `ask`. Cannot mint a capability the lease denied.
     */
    onAskApproval?: (action: AgentAction) => Promise<boolean>;
    /** H4: optional completed idempotency keys for double-mutation deny. */
    completedIdempotencyKeys?: readonly string[];
    /** H4: optional protected paths. */
    protectedPaths?: readonly string[];
    /** Execution mode for capability broker (default chat). */
    mode?: 'chat' | 'plan' | 'deep';
    /** H4: dirty working tree — refuse reconcilable mutations when true. */
    dirtyTree?: boolean;
    /** H4: isolation required for this profile. */
    isolationRequired?: boolean;
    /** H4: isolation (e.g. Docker) currently available. */
    isolationAvailable?: boolean;
    /** H4: explicit host fallback allowed (must be true to escalate). */
    hostFallbackAllowed?: boolean;
    /** H4: explicit idempotency key for this invocation (defaults from action). */
    idempotencyKey?: string;
    /** V2 authority: explicit lease override (defaults to the env lease). */
    lease?: AutonomyLease | null;
    /**
     * Frozen session authority. When present, lease + baseline come from this
     * snapshot and per-call baseline refresh is ignored.
     */
    authoritySession?: AuthoritySessionContext;
    /** V2 authority: policy-integrity baseline (tests / non-session callers). */
    baseline?: BaselineManifest;
    /** V2 authority: repo root used for baseline drift checks. */
    baselineRepoRoot?: string;
    /** Injectable clock for lease expiry. */
    now?: Date | number;
    /** B2: final authorization check after policy/approval but before an effect ledger intent. */
    onDispatchAuthorized?: () => { allowed: boolean; message?: string };
    /** B2: invoked immediately before executor.execute after durable effect intent persistence. */
    onBeforeExecutorExecute?: () => void;
    /** H4: task / plan-step linkage for effect transaction records. */
    taskId?: string;
    planStepId?: string;
  } = {},
): Promise<PolicyGatedExecutionResult> {
  const executor = deps.executor ?? defaultToolExecutor;
  // V2 authority: the default decision path consults the PDP when a lease is
  // active (env or explicit override). Additive — no lease → legacy behavior.
  const session = deps.authoritySession;
  const lease = session
    ? session.lease
    : deps.lease !== undefined
      ? deps.lease
      : activeLease();
  // Session-owned snapshot wins. Per-call baseline is only for tests /
  // non-session callers — it cannot refresh a live session context.
  const baseline =
    session
      ? session.baseline
        ? { repoRoot: session.repoRoot, manifest: session.baseline }
        : undefined
      : deps.baseline !== undefined && deps.baselineRepoRoot !== undefined
        ? { repoRoot: deps.baselineRepoRoot, manifest: deps.baseline }
        : undefined;
  const leaseCtx: LeaseContext = {
    lease,
    ...(baseline ? { baseline } : {}),
    ...(session?.repoRoot || context.babelRoot
      ? { cwd: session?.repoRoot || context.babelRoot }
      : {}),
    ...(session ? { authoritySession: session } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  };
  let lastReasonCode: ReasonCode | '' = '';
  const decide: typeof decideAction =
    deps.decide ??
    ((action, preset) => {
      const r = decideWithLease(action, preset, leaseCtx);
      lastReasonCode = r.reasonCode;
      return r.decision;
    });
  const budget = deps.budget ?? DEFAULT_TOOL_BUDGET;

  // ── H4 capability broker: classify + authorize before policy decide ──
  // Skip non-tool terminal/control actions (finish, ask_approval).
  const toolName = action.type;
  const isControlAction = toolName === 'finish' || toolName === 'ask_approval';
  let effectClass = classifyToolEffect(
    toolName === 'search' ? 'semantic_search' : toolName,
  );
  const idempotencyKey =
    deps.idempotencyKey ?? defaultIdempotencyKeyForAction(action);
  const targetPath = targetPathFromAction(action);
  if (!isControlAction) {
    const classifyName = toolName === 'search' ? 'semantic_search' : toolName;
    effectClass = classifyToolEffect(classifyName);
    const mode = deps.mode ?? 'chat';
    const cap = checkToolCapability({
      toolName: classifyName,
      effectClass,
      allowedEffects:
        mode === 'plan'
          ? ['read_only']
          : [
              'read_only',
              'idempotent',
              'reconcilable_mutation',
              'non_idempotent_local_effect',
              // Unknown tools classify as external_side_effect and are denied.
            ],
      mode,
      ...(targetPath !== undefined ? { targetPath } : {}),
      ...(deps.protectedPaths ? { protectedPaths: deps.protectedPaths } : {}),
      ...(deps.completedIdempotencyKeys
        ? { completedIdempotencyKeys: deps.completedIdempotencyKeys }
        : {}),
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
      ...(deps.dirtyTree !== undefined ? { dirtyTree: deps.dirtyTree } : {}),
      ...(deps.isolationRequired !== undefined
        ? { isolationRequired: deps.isolationRequired }
        : {}),
      ...(deps.isolationAvailable !== undefined
        ? { isolationAvailable: deps.isolationAvailable }
        : {}),
      ...(deps.hostFallbackAllowed !== undefined
        ? { hostFallbackAllowed: deps.hostFallbackAllowed }
        : {}),
    });
    if (!cap.allowed) {
      // Capability denials count toward the circuit breaker (same as policy deny).
      incrementBlocks(context.runId);
      emitAgentEvent({
        type: 'policy_decision',
        action: toolName,
        decision: 'deny',
        preset,
        runId: context.runId,
        agentId: context.agentId,
      });
      return {
        action,
        terminal: false,
        results: [
          {
            exit_code: 1,
            stdout: '',
            stderr: `[CAPABILITY_DENIED:${cap.denial ?? 'unknown'}] ${cap.message ?? 'not allowed'}`,
          },
        ],
        policyDecision: 'deny',
        policyBlocked: true,
      };
    }
  }

  // ── Circuit-breaker: entry check (before the A–D layer — a tripped
  // session must terminate, not re-enter per-class denial paths) ────────
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

  // ── Autonomy A–D classification (P0-A/C/D) ────────────────────────────
  // The capability broker above classifies by tool NAME. This layer classifies
  // by command SEMANTICS (run_command/test_run text) and by target PATH for
  // credential stores, mapping onto the canonical A–D taxonomy:
  //   Class D (credential exposure)   → deterministic deny, no approval path
  //   Class C (privileged)            → lease/PDP only. Missing membership
  //     is deny. TTY/CI is not authority.
  // Class A/B actions pass through to the authority decide path unchanged
  // (the lease-aware PDP composite below is the decision authority).
  if (!isControlAction) {
    const autonomyClass = classifyAutonomyAction(toolName, commandTextForAction(action));
    const target = targetPathFromAction(action);
    // apply_patch has no single target path — inspect the patch headers so a
    // patch touching a credential store denies like a direct write_file.
    const patchCredentialTargets =
      action.type === 'apply_patch' ? extractPatchRawTargets(action.patch) : [];
    const credentialTarget =
      (target !== undefined && isCredentialTargetPath(target)) ||
      patchCredentialTargets.some((t) => t !== undefined && isCredentialTargetPath(t));
    if (autonomyClass === 'd_forbidden' || credentialTarget) {
      incrementBlocks(context.runId);
      emitAgentEvent({
        type: 'policy_decision',
        action: toolName,
        decision: 'deny',
        preset,
        runId: context.runId,
        agentId: context.agentId,
        rule: 'AUTONOMY_CLASS_D',
      });
      return {
        action,
        terminal: isTerminalAgentAction(action),
        results: [
          {
            exit_code: 1,
            stdout: '',
            stderr:
              `[AUTONOMY_DENIED:CLASS_D] ` +
              (credentialTarget
                ? `Target path "${target}" is a credential store.`
                : 'Command semantics expose credentials.') +
              ' Class D actions require explicit exceptional operator instruction and are never auto-approved.',
          },
        ],
        policyDecision: 'deny',
        policyBlocked: true,
      };
    }
    // Privileged (Class C) actions fall through to decideWithLease.
    // Missing lease membership is DENY_MISSING_AUTHORITY, not ASK.
  }

  let policyDecision = decide(action, preset);
  const policyDecisionId = randomUUID();

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
      ...(lastReasonCode ? { rule: lastReasonCode } : {}),
    });
    return {
      action,
      terminal: isTerminalAgentAction(action),
      results: [
        policyBlockedToolResult(
          action,
          policyDecision,
          lastReasonCode
            ? `Policy denied ${action.type}: ${lastReasonCode}`
            : policyDecision === 'deny' && preset === 'ask_before_mutation'
              ? 'User denied approval'
              : undefined,
        ),
      ],
      policyDecision,
      policyBlocked: true,
      ...(lastReasonCode ? { reasonCode: lastReasonCode } : {}),
    };
  }

  const scopeViolation = readOnlyScopeViolation(action, preset);
  const effectViolation = readOnlyEffectViolation(action, preset);
  if (scopeViolation || effectViolation) {
    incrementBlocks(context.runId);
    emitAgentEvent({
      type: 'scope_violation',
      action: action.type,
      target: scopeViolation ?? effectViolation ?? action.type,
      projectRoot: process.env['BABEL_PROJECT_ROOT'] ?? process.cwd(),
      preset,
    });
    return {
      action,
      terminal: isTerminalAgentAction(action),
      results: [policyBlockedToolResult(action, 'deny', scopeViolation ?? effectViolation ?? undefined)],
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
  const dispatchAuthorization = deps.onDispatchAuthorized?.();
  if (dispatchAuthorization && !dispatchAuthorization.allowed) {
    incrementBlocks(context.runId);
    return {
      action,
      terminal: false,
      results: [{
        exit_code: 1,
        stdout: '',
        stderr: `[RECOVERY_RECONCILIATION_REQUIRED] ${dispatchAuthorization.message ?? 'Reconcile the prior unknown effect before retrying'}`,
      }],
      policyDecision: 'deny',
      policyBlocked: true,
    };
  }

  let txPaths: string[] = [];
  if (action.type === 'write_file') {
    txPaths = [isAbsolute(action.path) ? action.path : resolve(process.cwd(), action.path)];
  } else if (action.type === 'apply_patch') {
    txPaths = extractPatchTargets(action.patch, projectRootForScope(preset) ?? resolve(process.cwd()));
  }

  let batchTx: Awaited<ReturnType<typeof WorkspaceTransactionManager.beginBatch>> | null = null;
  let effectIntent: ReturnType<typeof recordEffectIntent> | null = null;
  let effectTx: EffectTransactionRecord | null = null;
  const scopedContext = context as ToolContext & { projectRoot?: string; cwd?: string };
  const workspaceRoot = scopedContext.projectRoot ?? scopedContext.cwd ?? process.cwd();
  if (txPaths.length > 0) {
    batchTx = await WorkspaceTransactionManager.beginBatch(txPaths, { sessionId: context.runId });
    // H4: begin revision-linked effect transaction (linked to task/plan step/idempotency).
    effectTx = beginEffectTransaction({
      tool_name: action.type,
      effect_class: effectClass,
      paths: txPaths,
      policy_decision_id: policyDecisionId,
      pre_revision: { compositeTreeHash: batchTx.preRevisionHash },
      ...(deps.taskId ? { task_id: deps.taskId } : {}),
      ...(deps.planStepId ? { plan_step_id: deps.planStepId } : {}),
      ...(idempotencyKey !== undefined ? { idempotency_key: idempotencyKey } : {}),
      ...(deps.isolationRequired && deps.isolationAvailable === false && deps.hostFallbackAllowed
        ? {
            boundary_escalation: {
              kind: 'host_execution' as const,
              reason: 'isolation_unavailable_explicit_host_fallback',
              explicit: true,
            },
          }
        : {}),
    });
    if (context.runDir) {
      effectIntent = recordEffectIntent({
        runDir: context.runDir,
        sessionId: context.runId,
        turnId: null,
        mutationBatchId: batchTx.batchId,
        effectClass: classifyToolEffect(action.type),
        toolName: action.type,
        targetPaths: txPaths,
        preImageHashes: batchTx.preBatchHash,
        ...(action.type === 'write_file'
          ? { intendedContent: action.content }
          : action.type === 'apply_patch'
            ? { intendedContent: action.patch }
            : {}),
      });
    }
  } else if (
    effectClass === 'non_idempotent_local_effect' ||
    effectClass === 'external_side_effect'
  ) {
    // Shell / external: still open a reconciliation record (no file pre-images).
    const preRevision = captureWorkspaceRevisionIdentity(workspaceRoot);
    effectTx = beginEffectTransaction({
      tool_name: action.type,
      effect_class: effectClass,
      paths: [],
      shell_side: true,
      pre_revision: preRevision,
      policy_decision_id: policyDecisionId,
      ...(deps.taskId ? { task_id: deps.taskId } : {}),
      ...(deps.planStepId ? { plan_step_id: deps.planStepId } : {}),
      ...(idempotencyKey !== undefined ? { idempotency_key: idempotencyKey } : {}),
    });
    if (context.runDir) {
      effectIntent = recordEffectIntent({
        runDir: context.runDir,
        sessionId: context.runId,
        turnId: null,
        mutationBatchId: effectTx.transaction_id,
        effectClass,
        toolName: action.type,
        targetPaths: [],
        preImageHashes: { workspace: preRevision.compositeTreeHash },
      });
    }
  }

  const mayMutateViaSubprocess =
    action.type === 'run_command' || action.type === 'test_run' || action.type === 'apply_patch';
  const governanceRepoRoot = session?.repoRoot || context.babelRoot;
  const governanceSnapshot =
    mayMutateViaSubprocess && governanceRepoRoot
      ? snapshotGovernanceBytes(
          governanceRepoRoot,
          session?.persistPath ? [session.persistPath] : [],
        )
      : null;

  try {
    deps.onBeforeExecutorExecute?.();
    const mapped = actionRequestFromAction(action);
    const isolateLocal =
      mapped !== null && CAPABILITY_KINDS[mapped.capability] === 'local';
    const execution = isolateLocal
      ? await runWithUnprivilegedChildEnv(() => executor.execute(action, context, budget))
      : await executor.execute(action, context, budget);

    if (governanceSnapshot && governanceRepoRoot) {
      const recon = reconcileGovernanceAfterEffect({
        repoRoot: governanceRepoRoot,
        before: governanceSnapshot,
        ...(session ? { session } : {}),
      });
      if (recon.mutated) {
        incrementBlocks(context.runId);
        if (session?.lease) invalidateLease(session.lease.leaseId);
        const restoreNote =
          recon.failed.length > 0
            ? `restore failed (${recon.failed.map((f) => f.reason).join(', ')}); session invalidated`
            : 'restored and authority session invalidated';
        return {
          action,
          terminal: false,
          results: [
            {
              exit_code: 1,
              stdout: '',
              stderr:
                `[DENY_POLICY_SELF_MUTATION] Subprocess mutated governance state ` +
                `(${recon.changed.join(', ')}); ${restoreNote}.`,
            },
          ],
          policyDecision: 'deny',
          policyBlocked: true,
          reasonCode: 'DENY_POLICY_SELF_MUTATION',
        };
      }
    }

    const toolFailed = execution.results.some((result) => result.exit_code !== 0);

    if (toolFailed) {
      if (effectIntent && context.runDir) {
        recordEffectTerminal(context.runDir, effectIntent, {
          status: 'failed',
          error: 'tool returned a nonzero exit code',
        });
      }
      if (effectTx) {
        if (batchTx) {
          let rollbackResult: 'success' | 'failed' | 'partial' = 'failed';
          try {
            const undo = await WorkspaceTransactionManager.undoLastMutationBatch(batchTx);
            rollbackResult = undo.verification ? 'success' : 'partial';
          } catch {
            rollbackResult = 'failed';
          }
          effectTx = rollbackEffectTransaction(effectTx, rollbackResult);
        } else {
          const postRevision = captureWorkspaceRevisionIdentity(workspaceRoot);
          effectTx = {
            ...reconcileEffectTransaction(effectTx),
            post_revision: postRevision,
          };
        }
      }
      return {
        ...execution,
        policyDecision,
        policyBlocked: false,
        ...(effectTx ? { effectTransaction: effectTx } : {}),
      };
    }

    if (batchTx) {
      batchTx = await WorkspaceTransactionManager.commitBatch(batchTx);
      if (effectIntent && context.runDir) {
        recordEffectTerminal(context.runDir, effectIntent, {
          status: 'completed',
          postImageHashes: batchTx.postBatchHash,
        });
      }
      if (effectTx) {
        effectTx = commitEffectTransaction(effectTx, {
          compositeTreeHash: batchTx.postRevisionHash ?? batchTx.preRevisionHash,
        });
      }
    } else if (effectTx) {
      const postRevision = captureWorkspaceRevisionIdentity(workspaceRoot);
      effectTx = commitEffectTransaction(effectTx, postRevision);
      if (effectIntent && context.runDir) {
        recordEffectTerminal(context.runDir, effectIntent, {
          status: 'completed',
          postImageHashes: { workspace: postRevision.compositeTreeHash },
        });
      }
    }

    return {
      ...execution,
      policyDecision,
      policyBlocked: false,
      ...(effectTx ? { effectTransaction: effectTx } : {}),
      ...(batchTx ? {
        mutationPaths: txPaths,
        preBatchHash: batchTx.preBatchHash,
        postBatchHash: batchTx.postBatchHash,
        mutationReceipt: {
          batchId: batchTx.batchId,
          ...(batchTx.sessionId ? { sessionId: batchTx.sessionId } : {}),
          startingRevision: batchTx.preRevisionHash,
          ...(batchTx.postRevisionHash ? { endingRevision: batchTx.postRevisionHash } : {}),
          affectedFiles: [...txPaths],
          preImageHashes: { ...batchTx.preBatchHash },
          postImageHashes: { ...batchTx.postBatchHash },
          changedBytes: batchTx.changedBytes,
          status: batchTx.status,
        },
      } : {})
    };
  } catch (error) {
    if (effectIntent && context.runDir) {
      recordEffectTerminal(context.runDir, effectIntent, {
        status: context.signal?.aborted ? 'cancelled' : 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (effectTx) {
      // True rollback result — never assume success.
      let rollbackResult: 'success' | 'failed' | 'partial' = 'failed';
      if (batchTx) {
        try {
          const undo = await WorkspaceTransactionManager.undoLastMutationBatch(batchTx);
          rollbackResult = undo.verification ? 'success' : 'partial';
        } catch {
          rollbackResult = 'failed';
        }
      }
      effectTx = rollbackEffectTransaction(effectTx, rollbackResult);
    }
    throw error;
  }
}

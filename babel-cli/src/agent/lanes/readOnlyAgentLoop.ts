/**
 * Read-only agent tool loop for ask/plan/report lanes (Wave A).
 *
 * This module is the authoritative in-process read-port factory: it fixes the
 * typed policy to `read_only`, scopes project-root state, and disables index
 * warming while the loop is active. That is an application invariant inside
 * this process, not a hostile-process or OS security boundary.
 *
 * Bounded multi-turn: provider actions → parseAgentActions → executeActionWithPolicy
 * → observations for synthesis prompt + session_loop_steps + tool_call_log.
 */

import { BABEL_ROOT } from '../../cli/constants.js';
import {
  buildDiscoveryAnchorWarmupActions,
  resolveDiscoveryAnchorPaths,
} from '../../services/discoveryAnchors.js';
import type { EvidenceBundle } from '../../evidence.js';
import { runWithPrimaryOnlyFallback } from '../../execute.js';
import type { ToolCallLog } from '../../schemas/agentContracts.js';
import type { ToolContext, ToolResult } from '../../localTools.js';
import { runWithProjectRoot } from '../../localTools.js';
import {
  compileObservation,
  formatCompiledObservation,
} from '../codingLoop/observationCompiler.js';
import { AgentActionsEnvelopeSchema, parseAgentActions, type AgentAction } from '../actions.js';
import type { LiteSessionVerb } from '../contracts.js';
import type { PermissionPreset } from '../policy.js';
import { buildSessionLoopSteps, type SmallFixLoopStep } from './smallFixLoop.js';
import {
  executeActionWithPolicy,
  isTerminalAgentAction,
  mapAgentActionToToolCalls,
  defaultToolExecutor,
  type ToolExecutor,
} from '../toolExecutor.js';
import type { SessionLoopStepPayload } from '../sessionLoop.js';
import type { SmallFixProvider } from '../../services/smallFix.js';
import type { LiteToolStreamSink } from '../../ui/liteToolStream.js';
import {
  createChildBudgetController,
  type ChildBudgetLimiter,
  type InheritedChildAllowance,
} from '../childBudget.js';

export const DEFAULT_READ_ONLY_LOOP_MAX_ROUNDS = 8;

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const fail = () => reject(new Error('Aborted by user or parent'));
    if (signal.aborted) {
      fail();
      return;
    }
    signal.addEventListener('abort', fail, { once: true });
  });
}

export interface ReadOnlyAgentLoopInput {
  verb: Extract<LiteSessionVerb, 'ask' | 'plan' | 'report' | 'fix'>;
  task: string;
  projectRoot: string;
  seedPaths?: string[];
  toolContext: ToolContext;
  evidence?: EvidenceBundle;
  provider?: SmallFixProvider;
  useDeterministicMock?: boolean;
  maxRounds?: number;
  executor?: ToolExecutor;
  preset?: PermissionPreset;
  toolStream?: LiteToolStreamSink;
  /** P-5: Model override for sub-agent LLM calls (e.g. 'deepseek-v4-flash'). */
  model?: string;
  /** Optional abort signal from the parent ChatEngine. */
  abortSignal?: AbortSignal;
  /** Optional deterministic action resolver for tests / scripted turns. */
  actionResolver?: (prompt: string, round: number) => Promise<AgentAction[]>;
  /** Extra instructions from the advertised sub_agent contract. */
  additionalInstructions?: string;
  /** Bounded allowance inherited from the parent delegation point. */
  inheritedAllowance?: InheritedChildAllowance;
  /** Parent callback for durable task-cost checkpointing. */
  onUsageRecorded?: () => void;
}

export interface ReadOnlyAgentLoopResult {
  steps: SmallFixLoopStep[];
  sessionLoopSteps: SessionLoopStepPayload[];
  toolCallLog: ToolCallLog[];
  observations: string;
  stepsExecuted: number;
  degraded: boolean;
  policyBlocked: boolean;
  blockedReason: string | null;
  /** Whether the loop completed normally via a terminal action (finish/ask_approval). */
  completed: boolean;
  /** True when the loop reached maxRounds without executing a terminal action. */
  roundExhausted: boolean;
  /** True when the child stopped because it needs operator permission. */
  needsApproval?: boolean;
  /** Original provider/transport error when the loop degraded on a live turn. */
  providerError?: string | null;
  /** True when the child stopped at an inherited parent wall/cost boundary. */
  inheritedBudgetExceeded?: boolean;
  inheritedBudgetLimiter?: ChildBudgetLimiter;
}

function agentActionToolName(action: AgentAction): string {
  const mapped = mapAgentActionToToolCalls(action).find((entry) => entry.kind === 'execute');
  return mapped?.kind === 'execute' ? mapped.request.tool : action.type;
}

function agentActionTarget(action: AgentAction): string {
  switch (action.type) {
    case 'read_file':
    case 'write_file':
      return action.path;
    case 'list_dir':
      return action.path;
    case 'search':
      return action.query;
    case 'grep':
      return action.path ? `${action.pattern} @ ${action.path}` : action.pattern;
    case 'glob':
      return action.pattern;
    case 'run_command':
      return action.command;
    case 'apply_patch':
      return action.patch.slice(0, 120);
    case 'finish':
      return action.summary;
    case 'ask_approval':
      return action.reason;
    case 'git_context':
      return action.path ?? action.format ?? 'git';
    case 'test_run':
      return action.command;
    case 'workspace_map':
      return `depth=${action.max_depth ?? 'default'}`;
    default: {
      const exhaustive: never = action;
      return String(exhaustive);
    }
  }
}

function formatToolResultObservation(
  action: AgentAction,
  result: ToolResult,
  spillDir?: string,
): string {
  return formatCompiledObservation(
    compileObservation({
      tool: agentActionToolName(action),
      target: agentActionTarget(action),
      exitCode: result.exit_code,
      stdout: result.stdout,
      stderr: result.stderr,
      ...(spillDir ? { spillDir } : {}),
    }),
  );
}

export function buildToolCallLogFromSteps(steps: SmallFixLoopStep[], startStep = 1): ToolCallLog[] {
  const entries: ToolCallLog[] = [];
  let stepNumber = startStep;
  for (const loopStep of steps) {
    if (loopStep.phase === 'finish' || loopStep.phase === 'blocked') {
      continue;
    }
    const result = loopStep.toolResults[loopStep.toolResults.length - 1];
    if (!result) {
      continue;
    }
    entries.push({
      step: stepNumber,
      tool: agentActionToolName(loopStep.action) as ToolCallLog['tool'],
      target: agentActionTarget(loopStep.action),
      exit_code: result.exit_code,
      stdout: result.stdout,
      stderr: result.stderr,
      verified: result.exit_code === 0 && !loopStep.policyBlocked,
    });
    stepNumber += 1;
  }
  return entries;
}

export function formatReadOnlyObservations(steps: SmallFixLoopStep[], spillDir?: string): string {
  const chunks: string[] = [];
  for (const loopStep of steps) {
    if (loopStep.phase === 'finish' || loopStep.phase === 'blocked') {
      continue;
    }
    const result = loopStep.toolResults[loopStep.toolResults.length - 1];
    if (!result) {
      continue;
    }
    chunks.push(formatToolResultObservation(loopStep.action, result, spillDir));
  }
  return chunks.length > 0 ? chunks.join('\n\n') : 'No runtime tool observations were recorded.';
}

export function buildReadOnlyAgentTurnPrompt(input: {
  verb: ReadOnlyAgentLoopInput['verb'];
  task: string;
  projectRoot: string;
  round: number;
  maxRounds: number;
  priorObservations: string;
  allowedTools: string[];
  additionalInstructions?: string;
}): string {
  return [
    '# Babel Lite Read-Only Discovery',
    '',
    'You are in a read-only discovery loop. Return one JSON object with an `actions` array.',
    'Allowed action types: read_file, list_dir, search, grep, glob, finish, ask_approval.',
    'Do not emit write_file, apply_patch, or run_command.',
    '',
    'Shape:',
    '{"actions":[{"type":"list_dir","path":"."},{"type":"read_file","path":"src/example.ts"},{"type":"finish","summary":"done","verification":[]}]}',
    '',
    `Lane: ${input.verb === 'fix' ? 'fix (read-only discovery)' : input.verb}`,
    `Round: ${input.round}/${input.maxRounds}`,
    `Project root: ${input.projectRoot}`,
    `Allowed tools: ${input.allowedTools.join(', ')}`,
    '',
    `Task: ${input.task}`,
    ...(input.additionalInstructions
      ? ['', '# Additional Instructions', input.additionalInstructions]
      : []),
    '',
    '# Prior Tool Observations',
    input.priorObservations.trim().length > 0 ? input.priorObservations : '(none yet)',
    '',
    'Request the next minimal actions needed to answer responsibly, then finish when enough context is gathered.',
  ].join('\n');
}

function buildDeterministicMockActions(
  seedPaths: string[],
  verb?: ReadOnlyAgentLoopInput['verb'],
): AgentAction[] {
  const actions: AgentAction[] = [{ type: 'list_dir', path: '.' }];
  if (verb === 'fix') {
    actions.push({ type: 'search', query: 'failing test fix scope' });
    actions.push({ type: 'grep', pattern: 'export|test', path: 'src' });
  }
  for (const path of seedPaths) {
    actions.push({ type: 'read_file', path });
  }
  actions.push({
    type: 'finish',
    summary: 'Read-only discovery complete',
    verification: [],
  });
  return actions;
}

function phaseForExecutedAction(action: AgentAction, index: number): SmallFixLoopStep['phase'] {
  if (
    action.type === 'read_file' ||
    action.type === 'list_dir' ||
    action.type === 'search' ||
    action.type === 'grep' ||
    action.type === 'glob'
  ) {
    return index === 0 ? 'observe' : 'observe';
  }
  return 'observe';
}

async function executeActionBatch(
  actions: AgentAction[],
  preset: PermissionPreset,
  toolContext: ToolContext,
  executor: ToolExecutor,
  steps: SmallFixLoopStep[],
  startIndex: number,
  toolStream?: LiteToolStreamSink,
  signal?: AbortSignal,
  budgetLimiter?: () => ChildBudgetLimiter | null,
): Promise<{
  terminal: boolean;
  policyBlocked: boolean;
  blockedReason: string | null;
  needsApproval: boolean;
  inheritedBudgetLimiter?: ChildBudgetLimiter;
}> {
  let policyBlocked = false;
  let blockedReason: string | null = null;

  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index];
    if (!action) {
      continue;
    }
    if (signal?.aborted) {
      return {
        terminal: true,
        policyBlocked: false,
        blockedReason: 'Aborted by user or parent',
        needsApproval: false,
      };
    }
    const inheritedLimiter = budgetLimiter?.();
    if (inheritedLimiter) {
      return {
        terminal: true,
        policyBlocked: false,
        blockedReason: null,
        needsApproval: false,
        inheritedBudgetLimiter: inheritedLimiter,
      };
    }
    if (isTerminalAgentAction(action)) {
      if (action.type === 'ask_approval') {
        steps.push({
          phase: 'blocked',
          action,
          policyDecision: 'ask',
          policyBlocked: true,
          toolResults: [],
        });
        return {
          terminal: true,
          policyBlocked: true,
          blockedReason: action.reason,
          needsApproval: true,
        };
      }
      steps.push({
        phase: 'finish',
        action,
        policyDecision: 'allow',
        policyBlocked: false,
        toolResults: [],
      });
      return { terminal: true, policyBlocked, blockedReason, needsApproval: false };
    }

    const toolName = agentActionToolName(action);
    const toolTarget = agentActionTarget(action);
    toolStream?.emit({ tool: toolName, target: toolTarget, status: 'running', phase: 'discover' });
    const execution = await executeActionWithPolicy(
      action,
      preset,
      { ...toolContext, ...(signal ? { signal } : {}) },
      { executor },
    );
    const toolResult = execution.results[execution.results.length - 1];
    toolStream?.emit({
      tool: toolName,
      target: toolTarget,
      status: execution.policyBlocked
        ? 'blocked'
        : toolResult && toolResult.exit_code === 0
          ? 'pass'
          : 'fail',
      phase: 'discover',
    });
    steps.push({
      phase: phaseForExecutedAction(action, startIndex + index),
      action: execution.action,
      policyDecision: execution.policyDecision,
      policyBlocked: execution.policyBlocked,
      toolResults: execution.results,
    });

    if (execution.policyBlocked) {
      policyBlocked = true;
      blockedReason =
        execution.results[execution.results.length - 1]?.stderr ?? 'Policy blocked tool execution';
      steps.push({
        phase: 'blocked',
        action: {
          type: 'ask_approval',
          reason: blockedReason,
          requested_action: action,
        },
        policyDecision: execution.policyDecision,
        policyBlocked: true,
        toolResults: execution.results,
      });
      return { terminal: true, policyBlocked: true, blockedReason, needsApproval: false };
    }
    const postActionLimiter = budgetLimiter?.();
    if (postActionLimiter) {
      return {
        terminal: true,
        policyBlocked: false,
        blockedReason: null,
        needsApproval: false,
        inheritedBudgetLimiter: postActionLimiter,
      };
    }
    if (signal?.aborted) {
      return {
        terminal: true,
        policyBlocked: false,
        blockedReason: 'Aborted by user or parent',
        needsApproval: false,
      };
    }
  }

  return { terminal: false, policyBlocked, blockedReason, needsApproval: false };
}

async function resolveLiveActionTurn(
  prompt: string,
  evidence: EvidenceBundle | undefined,
  model?: string,
  abortSignal?: AbortSignal,
  budgetGuard?: () => ChildBudgetLimiter | null,
  onUsageRecorded?: () => void,
): Promise<AgentAction[]> {
  const envelope = await runWithPrimaryOnlyFallback(prompt, AgentActionsEnvelopeSchema, {
    ...(evidence !== undefined ? { evidence } : {}),
    stage: 'executor',
    schemaName: 'AgentActionsEnvelopeSchema',
    maxCliAttempts: 2,
    ...(model ? { model } : {}),
    ...(abortSignal ? { signal: abortSignal } : {}),
    ...(budgetGuard ? { budgetGuard } : {}),
    ...(onUsageRecorded ? { onUsageRecorded } : {}),
  });
  return envelope.actions;
}

export async function runReadOnlyAgentLoop(
  input: ReadOnlyAgentLoopInput,
): Promise<ReadOnlyAgentLoopResult> {
  // This lane is a read port. Caller-supplied presets must not widen its
  // authority (especially for the fix-discovery verb).
  const preset: PermissionPreset = 'read_only';
  const executor = input.executor ?? defaultToolExecutor;
  const maxRounds = input.maxRounds ?? DEFAULT_READ_ONLY_LOOP_MAX_ROUNDS;
  const anchorPaths = resolveDiscoveryAnchorPaths(input.projectRoot, input.seedPaths);
  const useDeterministicMock =
    input.useDeterministicMock === true ||
    input.provider === 'mock' ||
    process.env['BABEL_LITE_OFFLINE'] === '1';

  const steps: SmallFixLoopStep[] = [];
  const previousNoIndexWrites = process.env['BABEL_READ_ONLY_NO_INDEX_WRITE'];
  const scopedToolContext: ToolContext = {
    ...input.toolContext,
    projectRoot: input.projectRoot,
  };
  const budgetController = createChildBudgetController(
    input.inheritedAllowance,
    input.abortSignal,
  );
  const effectiveAbortSignal = budgetController.signal;
  let inheritedBudgetLimiter: ChildBudgetLimiter | undefined;
  // Semantic indexing creates/updates SQLite state. Read-only discovery may
  // query an already-open index, but must never warm or rebuild one.
  process.env['BABEL_READ_ONLY_NO_INDEX_WRITE'] = '1';

  try {
    return await runWithProjectRoot(input.projectRoot, async () => {
    if (useDeterministicMock) {
    inheritedBudgetLimiter = budgetController.limiter() ?? undefined;
    if (inheritedBudgetLimiter) {
      return {
        steps,
        sessionLoopSteps: buildSessionLoopSteps(steps),
        toolCallLog: [],
        observations: `Inherited parent ${inheritedBudgetLimiter} budget exhausted`,
        stepsExecuted: 0,
        degraded: true,
        policyBlocked: false,
        blockedReason: `Inherited parent ${inheritedBudgetLimiter} budget exhausted`,
        completed: false,
        roundExhausted: false,
        needsApproval: false,
        providerError: null,
        inheritedBudgetExceeded: true,
        inheritedBudgetLimiter,
      };
    }
    const mockActions = buildDeterministicMockActions(anchorPaths, input.verb);
    const batch = await executeActionBatch(
      mockActions,
      preset,
      scopedToolContext,
      executor,
      steps,
      0,
      input.toolStream,
      effectiveAbortSignal,
      () => budgetController.limiter(),
    );
    inheritedBudgetLimiter = batch.inheritedBudgetLimiter;
    const toolCallLog = buildToolCallLogFromSteps(steps);
    const mockResult = {
      steps,
      sessionLoopSteps: buildSessionLoopSteps(steps),
      toolCallLog,
      observations: formatReadOnlyObservations(steps, input.toolContext.runDir),
      stepsExecuted: toolCallLog.length,
      degraded: anchorPaths.length === 0 || effectiveAbortSignal.aborted,
      policyBlocked: batch.policyBlocked,
      blockedReason: effectiveAbortSignal.aborted
        ? 'Aborted by user or parent'
        : batch.blockedReason,
      completed: !effectiveAbortSignal.aborted,
      roundExhausted: false,
      needsApproval: batch.needsApproval,
      providerError: null,
      ...(inheritedBudgetLimiter
        ? {
            inheritedBudgetExceeded: true,
            inheritedBudgetLimiter,
            completed: false,
          }
        : {}),
    };
    return mockResult;
    }

  let priorObservations = '';
  let round = 0;
  let policyBlocked = false;
  let blockedReason: string | null = null;
  let degraded = false;
  let terminalReached = false;
  let needsApproval = false;
  let providerError: string | null = null;

  const warmupActions = buildDiscoveryAnchorWarmupActions(anchorPaths);
  const warmupBatch = await executeActionBatch(
    warmupActions,
    preset,
    scopedToolContext,
    executor,
    steps,
    0,
    input.toolStream,
    effectiveAbortSignal,
    () => budgetController.limiter(),
  );
  inheritedBudgetLimiter = warmupBatch.inheritedBudgetLimiter;
  if (inheritedBudgetLimiter) {
    return {
      steps,
      sessionLoopSteps: buildSessionLoopSteps(steps),
      toolCallLog: buildToolCallLogFromSteps(steps),
      observations: formatReadOnlyObservations(steps, input.toolContext.runDir),
      stepsExecuted: buildToolCallLogFromSteps(steps).length,
      degraded: true,
      policyBlocked: false,
      blockedReason: `Inherited parent ${inheritedBudgetLimiter} budget exhausted`,
      completed: false,
      roundExhausted: false,
      needsApproval: false,
      providerError: null,
      inheritedBudgetExceeded: true,
      inheritedBudgetLimiter,
    };
  }
  priorObservations = formatReadOnlyObservations(steps, input.toolContext.runDir);
  policyBlocked = warmupBatch.policyBlocked;
  blockedReason = warmupBatch.blockedReason;
  needsApproval = warmupBatch.needsApproval;
  if (warmupBatch.terminal) {
    const toolCallLog = buildToolCallLogFromSteps(steps);
    const warmupBlockedResult = {
      steps,
      sessionLoopSteps: buildSessionLoopSteps(steps),
      toolCallLog,
      observations: priorObservations,
      stepsExecuted: toolCallLog.length,
      degraded: anchorPaths.length === 0 || effectiveAbortSignal.aborted,
      policyBlocked,
      blockedReason: effectiveAbortSignal.aborted
        ? 'Aborted by user or parent'
        : blockedReason,
      completed: !effectiveAbortSignal.aborted,
      roundExhausted: false,
      needsApproval,
      providerError: null,
    };
    return warmupBlockedResult;
  }

  while (round < maxRounds) {
    inheritedBudgetLimiter = budgetController.limiter() ?? undefined;
    if (inheritedBudgetLimiter) {
      break;
    }
    if (effectiveAbortSignal.aborted) {
      degraded = true;
      blockedReason = blockedReason ?? 'Aborted by user or parent';
      break;
    }
    round += 1;
    let actions: AgentAction[];
    try {
      const prompt = buildReadOnlyAgentTurnPrompt({
        verb: input.verb,
        task: input.task,
        projectRoot: input.projectRoot,
        round,
        maxRounds,
        priorObservations,
        allowedTools: ['directory_list', 'file_read', 'semantic_search', 'grep', 'glob'],
        ...(input.additionalInstructions
          ? { additionalInstructions: input.additionalInstructions }
          : {}),
      });
      if (input.actionResolver) {
        const resolved = input.actionResolver(prompt, round);
        actions = await Promise.race([resolved, waitForAbort(effectiveAbortSignal)]);
      } else {
        actions = await resolveLiveActionTurn(
          prompt,
          input.evidence,
          input.model,
          effectiveAbortSignal,
          () => budgetController.limiter(),
          input.onUsageRecorded,
        );
      }
    } catch (err) {
      degraded = true;
      const message = err instanceof Error ? err.message : String(err);
      inheritedBudgetLimiter = budgetController.limiter() ?? undefined;
      if (inheritedBudgetLimiter) {
        break;
      }
      if (effectiveAbortSignal.aborted || /abort/i.test(message)) {
        blockedReason = blockedReason ?? 'Aborted by user or parent';
      } else {
        providerError = message;
        blockedReason = blockedReason ?? message;
      }
      break;
    }

    const batch = await executeActionBatch(
      actions,
      preset,
      scopedToolContext,
      executor,
      steps,
      steps.length,
      input.toolStream,
      effectiveAbortSignal,
      () => budgetController.limiter(),
    );
    inheritedBudgetLimiter = batch.inheritedBudgetLimiter;
    priorObservations = formatReadOnlyObservations(steps, input.toolContext.runDir);
    policyBlocked = batch.policyBlocked;
    blockedReason = batch.blockedReason;
    needsApproval = batch.needsApproval;
    if (batch.terminal) {
      if (inheritedBudgetLimiter) break;
      if (effectiveAbortSignal.aborted) {
        degraded = true;
        blockedReason = blockedReason ?? 'Aborted by user or parent';
        break;
      }
      terminalReached = true;
      break;
    }
  }

  const roundExhausted =
    !inheritedBudgetLimiter && !terminalReached && !policyBlocked && !providerError && round >= maxRounds;
  if (roundExhausted) {
    degraded = true;
    priorObservations += '\n[Discovery incomplete: round limit reached without finish]';
  }

  if (
    steps.length === 0 &&
    !providerError &&
    !inheritedBudgetLimiter &&
    !effectiveAbortSignal.aborted
  ) {
    degraded = true;
    steps.push({
      phase: 'observe',
      action: { type: 'list_dir', path: '.' },
      policyDecision: 'allow',
      policyBlocked: false,
      toolResults: [],
    });
    steps.push({
      phase: 'finish',
      action: {
        type: 'finish',
        summary: 'Discovery skipped; using static context only.',
        verification: [],
      },
      policyDecision: 'allow',
      policyBlocked: false,
      toolResults: [],
    });
    terminalReached = true;
  }

  const toolCallLog = buildToolCallLogFromSteps(steps);
  const baseObservations = formatReadOnlyObservations(steps, input.toolContext.runDir);
  const finalObservations = [
    baseObservations,
    roundExhausted ? '[Discovery incomplete: round limit reached without finish]' : '',
    providerError ? `[Provider error: ${providerError}]` : '',
  ]
    .filter((part) => part && part.trim().length > 0)
    .join('\n');
  const loopResult = {
    steps,
    sessionLoopSteps: buildSessionLoopSteps(steps),
    toolCallLog,
    observations: finalObservations,
    stepsExecuted: toolCallLog.length,
    degraded,
    policyBlocked,
    blockedReason,
    completed: terminalReached,
    roundExhausted,
    needsApproval,
    providerError,
    ...(inheritedBudgetLimiter
      ? {
          inheritedBudgetExceeded: true,
          inheritedBudgetLimiter,
          completed: false,
          roundExhausted: false,
        }
      : {}),
  };
    return loopResult;
    });
  } finally {
    budgetController.dispose();
    if (previousNoIndexWrites === undefined) {
      delete process.env['BABEL_READ_ONLY_NO_INDEX_WRITE'];
    } else {
      process.env['BABEL_READ_ONLY_NO_INDEX_WRITE'] = previousNoIndexWrites;
    }
  }
}

export function mergeDiscoveryAndSynthesisSessionSteps(input: {
  discoverySteps: SessionLoopStepPayload[];
  act: 'pass' | 'fail' | 'blocked';
  verify: 'pass' | 'fail' | 'blocked';
  terminal: 'finish' | 'blocked';
}): SessionLoopStepPayload[] {
  const observeSteps = input.discoverySteps.filter((step) => step.phase === 'observe');
  const merged: SessionLoopStepPayload[] =
    observeSteps.length > 0
      ? observeSteps
      : [
          {
            phase: 'observe',
            status: 'pass',
            policy_decision: 'allow',
          },
        ];
  merged.push({
    phase: 'act',
    status: input.act,
    policy_decision: 'allow',
  });
  merged.push({
    phase: 'verify',
    status: input.verify,
    policy_decision: 'allow',
  });
  merged.push({
    phase: input.terminal,
    status: input.terminal === 'finish' ? 'pass' : 'blocked',
    policy_decision: 'allow',
  });
  return merged;
}

export function buildReadOnlyToolContext(input: {
  verb: ReadOnlyAgentLoopInput['verb'];
  runId: string;
  runDir: string;
  signal?: AbortSignal;
}): ToolContext {
  return {
    agentId: `lite-${input.verb}`,
    runId: input.runId,
    runDir: input.runDir,
    babelRoot: BABEL_ROOT,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  };
}

/**
 * Read-only agent tool loop for ask/plan/report lanes (Wave A).
 *
 * Bounded multi-turn: provider actions → parseAgentActions → executeActionWithPolicy
 * → observations for synthesis prompt + session_loop_steps + tool_call_log.
 */

import { BABEL_ROOT } from '../../cli/constants.js';
import {
  buildDiscoveryAnchorWarmupActions,
  resolveDiscoveryAnchorPaths,
} from '../../services/discoveryAnchors.js';
import { ensureSemanticIndexForProject } from '../../tools/chronicleMemory.js';
import type { EvidenceBundle } from '../../evidence.js';
import { runWithPrimaryOnlyFallback } from '../../execute.js';
import type { ToolCallLog } from '../../schemas/agentContracts.js';
import type { ToolContext, ToolResult } from '../../localTools.js';
import { AgentActionsEnvelopeSchema, parseAgentActions, type AgentAction } from '../actions.js';
import type { LiteSessionVerb } from '../contracts.js';
import { presetForVerb } from '../policy.js';
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

export const DEFAULT_READ_ONLY_LOOP_MAX_ROUNDS = 8;

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

function trimObservation(text: string, maxChars = 1200): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n...[truncated]`;
}

function formatToolResultObservation(action: AgentAction, result: ToolResult): string {
  const tool = agentActionToolName(action);
  const target = agentActionTarget(action);
  const body =
    result.stdout.trim().length > 0
      ? result.stdout
      : result.stderr.trim().length > 0
        ? result.stderr
        : '(no output)';
  return [`### ${tool} ${target}`, `exit_code: ${result.exit_code}`, trimObservation(body)].join(
    '\n',
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

export function formatReadOnlyObservations(steps: SmallFixLoopStep[]): string {
  const chunks: string[] = [];
  for (const loopStep of steps) {
    if (loopStep.phase === 'finish' || loopStep.phase === 'blocked') {
      continue;
    }
    const result = loopStep.toolResults[loopStep.toolResults.length - 1];
    if (!result) {
      continue;
    }
    chunks.push(formatToolResultObservation(loopStep.action, result));
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
): Promise<{ terminal: boolean; policyBlocked: boolean; blockedReason: string | null }> {
  let policyBlocked = false;
  let blockedReason: string | null = null;

  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index];
    if (!action) {
      continue;
    }
    if (isTerminalAgentAction(action)) {
      if (action.type === 'ask_approval') {
        steps.push({
          phase: 'blocked',
          action,
          policyDecision: 'ask',
          policyBlocked: false,
          toolResults: [],
        });
        return { terminal: true, policyBlocked: false, blockedReason: action.reason };
      }
      steps.push({
        phase: 'finish',
        action,
        policyDecision: 'allow',
        policyBlocked: false,
        toolResults: [],
      });
      return { terminal: true, policyBlocked, blockedReason };
    }

    const toolName = agentActionToolName(action);
    const toolTarget = agentActionTarget(action);
    toolStream?.emit({ tool: toolName, target: toolTarget, status: 'running', phase: 'discover' });
    const execution = await executeActionWithPolicy(action, preset, toolContext, { executor });
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
      return { terminal: true, policyBlocked: true, blockedReason };
    }
  }

  return { terminal: false, policyBlocked, blockedReason };
}

async function resolveLiveActionTurn(
  prompt: string,
  evidence: EvidenceBundle | undefined,
  model?: string,
): Promise<AgentAction[]> {
  const envelope = await runWithPrimaryOnlyFallback(prompt, AgentActionsEnvelopeSchema, {
    ...(evidence !== undefined ? { evidence } : {}),
    stage: 'executor',
    schemaName: 'AgentActionsEnvelopeSchema',
    maxCliAttempts: 2,
    ...(model ? { model } : {}),
  });
  return envelope.actions;
}

export async function runReadOnlyAgentLoop(
  input: ReadOnlyAgentLoopInput,
): Promise<ReadOnlyAgentLoopResult> {
  const preset = input.preset ?? presetForVerb(input.verb);
  const executor = input.executor ?? defaultToolExecutor;
  const maxRounds = input.maxRounds ?? DEFAULT_READ_ONLY_LOOP_MAX_ROUNDS;
  const anchorPaths = resolveDiscoveryAnchorPaths(input.projectRoot, input.seedPaths);
  const useDeterministicMock =
    input.useDeterministicMock === true ||
    input.provider === 'mock' ||
    process.env['BABEL_LITE_OFFLINE'] === '1';

  const steps: SmallFixLoopStep[] = [];
  const previousProjectRoot = process.env['BABEL_PROJECT_ROOT'];
  process.env['BABEL_PROJECT_ROOT'] = input.projectRoot;
  try {
    await ensureSemanticIndexForProject(input.projectRoot);
  } catch {
    // Discovery can still proceed with list/read/grep/glob even if indexing fails.
  }

  if (useDeterministicMock) {
    const mockActions = buildDeterministicMockActions(anchorPaths, input.verb);
    const batch = await executeActionBatch(
      mockActions,
      preset,
      input.toolContext,
      executor,
      steps,
      0,
      input.toolStream,
    );
    const toolCallLog = buildToolCallLogFromSteps(steps);
    const mockResult = {
      steps,
      sessionLoopSteps: buildSessionLoopSteps(steps),
      toolCallLog,
      observations: formatReadOnlyObservations(steps),
      stepsExecuted: toolCallLog.length,
      degraded: anchorPaths.length === 0,
      policyBlocked: batch.policyBlocked,
      blockedReason: batch.blockedReason,
    };
    if (previousProjectRoot === undefined) {
      delete process.env['BABEL_PROJECT_ROOT'];
    } else {
      process.env['BABEL_PROJECT_ROOT'] = previousProjectRoot;
    }
    return mockResult;
  }

  let priorObservations = '';
  let round = 0;
  let policyBlocked = false;
  let blockedReason: string | null = null;
  let degraded = false;

  const warmupActions = buildDiscoveryAnchorWarmupActions(anchorPaths);
  const warmupBatch = await executeActionBatch(
    warmupActions,
    preset,
    input.toolContext,
    executor,
    steps,
    0,
    input.toolStream,
  );
  priorObservations = formatReadOnlyObservations(steps);
  policyBlocked = warmupBatch.policyBlocked;
  blockedReason = warmupBatch.blockedReason;
  if (warmupBatch.terminal) {
    const toolCallLog = buildToolCallLogFromSteps(steps);
    const warmupBlockedResult = {
      steps,
      sessionLoopSteps: buildSessionLoopSteps(steps),
      toolCallLog,
      observations: priorObservations,
      stepsExecuted: toolCallLog.length,
      degraded: anchorPaths.length === 0,
      policyBlocked,
      blockedReason,
    };
    if (previousProjectRoot === undefined) {
      delete process.env['BABEL_PROJECT_ROOT'];
    } else {
      process.env['BABEL_PROJECT_ROOT'] = previousProjectRoot;
    }
    return warmupBlockedResult;
  }

  while (round < maxRounds) {
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
      });
      actions = await resolveLiveActionTurn(prompt, input.evidence, input.model);
    } catch {
      degraded = true;
      break;
    }

    const batch = await executeActionBatch(
      actions,
      preset,
      input.toolContext,
      executor,
      steps,
      steps.length,
      input.toolStream,
    );
    priorObservations = formatReadOnlyObservations(steps);
    policyBlocked = batch.policyBlocked;
    blockedReason = batch.blockedReason;
    if (batch.terminal) {
      break;
    }
  }

  if (steps.length === 0) {
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
  }

  const toolCallLog = buildToolCallLogFromSteps(steps);
  const loopResult = {
    steps,
    sessionLoopSteps: buildSessionLoopSteps(steps),
    toolCallLog,
    observations: formatReadOnlyObservations(steps),
    stepsExecuted: toolCallLog.length,
    degraded,
    policyBlocked,
    blockedReason,
  };
  if (previousProjectRoot === undefined) {
    delete process.env['BABEL_PROJECT_ROOT'];
  } else {
    process.env['BABEL_PROJECT_ROOT'] = previousProjectRoot;
  }
  return loopResult;
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

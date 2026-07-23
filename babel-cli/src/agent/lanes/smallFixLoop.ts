/**
 * Small-fix observe→act loop — policy-gated mutation steps for daily fix intent.
 *
 * Bounded loop: observe file state → write_file (policy) → run_command verifier (policy)
 * → terminal finish or blocked step for session-shaped JSON output.
 */

import type { ToolContext, ToolResult } from '../../localTools.js';
import type { AgentAction } from '../actions.js';
import { decideAction, presetForVerb } from '../policy.js';
import type { PermissionPreset } from '../policy.js';
import type { SessionLoopPhase, SessionLoopStepPayload } from '../sessionLoop.js';

export type { SessionLoopPhase, SessionLoopStepPayload };
import {
  defaultToolExecutor,
  executeActionWithPolicy,
  type PolicyGatedExecutionResult,
  type ToolExecutor,
} from '../toolExecutor.js';

export type SmallFixLoopPhase = SessionLoopPhase;

export interface SmallFixLoopStep {
  phase: SmallFixLoopPhase;
  action: AgentAction;
  policyDecision: SessionLoopStepPayload['policy_decision'];
  policyBlocked: boolean;
  toolResults: ToolResult[];
}

export interface SmallFixMutationLoopInput {
  targetFile: string;
  projectRoot: string;
  verifierCommand: string;
  replacementContent: string;
  toolContext: ToolContext;
  executor?: ToolExecutor;
  /** Defaults to `presetForVerb('fix')` — workspace_write in production. */
  preset?: PermissionPreset;
  decide?: typeof decideAction;
}

export interface SmallFixMutationLoopResult {
  steps: SmallFixLoopStep[];
  sessionLoopSteps: SessionLoopStepPayload[];
  writeResult: ToolResult | null;
  testResult: ToolResult | null;
  policyBlocked: boolean;
  blockedReason: string | null;
}

export function buildSessionLoopSteps(steps: SmallFixLoopStep[]): SessionLoopStepPayload[] {
  const payloads = steps
    .filter((step) => step.phase === 'observe' || step.phase === 'act' || step.phase === 'verify')
    .map((step) => ({
      phase: step.phase,
      status: step.policyBlocked
        ? ('blocked' as const)
        : step.toolResults.some((result) => result.exit_code !== 0)
          ? ('fail' as const)
          : ('pass' as const),
      policy_decision: step.policyDecision,
    }));
  const terminal = steps.find((step) => step.phase === 'finish' || step.phase === 'blocked');
  if (terminal) {
    payloads.push({
      phase: terminal.phase,
      status: terminal.phase === 'finish' ? 'pass' : 'blocked',
      policy_decision: terminal.policyDecision,
    });
  }
  return payloads;
}

function appendTerminalStep(steps: SmallFixLoopStep[], blocked: boolean, reason: string): void {
  const blockedAction: AgentAction = {
    type: 'ask_approval',
    reason,
    requested_action: { type: 'read_file', path: '.' },
  };
  steps.push({
    phase: blocked ? 'blocked' : 'finish',
    action: blocked
      ? blockedAction
      : { type: 'finish', summary: 'Small-fix session loop complete', verification: [] },
    policyDecision: 'allow',
    policyBlocked: false,
    toolResults: [],
  });
}

function primaryToolResult(execution: PolicyGatedExecutionResult): ToolResult | null {
  return execution.results[execution.results.length - 1] ?? null;
}

function stepFromExecution(
  phase: SmallFixLoopPhase,
  execution: PolicyGatedExecutionResult,
): SmallFixLoopStep {
  return {
    phase,
    action: execution.action,
    policyDecision: execution.policyDecision,
    policyBlocked: execution.policyBlocked,
    toolResults: execution.results,
  };
}

/**
 * Run the bounded small-fix mutation loop with policy enforcement on each act step.
 */
export async function runSmallFixMutationLoop(
  input: SmallFixMutationLoopInput,
): Promise<SmallFixMutationLoopResult> {
  const preset = input.preset ?? presetForVerb('fix');
  const executor = input.executor ?? defaultToolExecutor;
  const policyDeps = { executor, ...(input.decide !== undefined ? { decide: input.decide } : {}) };
  const steps: SmallFixLoopStep[] = [];

  steps.push({
    phase: 'observe',
    action: { type: 'read_file', path: input.targetFile },
    policyDecision: 'allow',
    policyBlocked: false,
    toolResults: [],
  });

  const writeAction: AgentAction = {
    type: 'write_file',
    path: input.targetFile,
    content: input.replacementContent,
  };
  const writeExecution = await executeActionWithPolicy(
    writeAction,
    preset,
    input.toolContext,
    policyDeps,
  );
  steps.push(stepFromExecution('act', writeExecution));

  if (writeExecution.policyBlocked) {
    const blockedReason = primaryToolResult(writeExecution)?.stderr ?? 'Policy blocked file write';
    appendTerminalStep(steps, true, blockedReason);
    return {
      steps,
      sessionLoopSteps: buildSessionLoopSteps(steps),
      writeResult: primaryToolResult(writeExecution),
      testResult: null,
      policyBlocked: true,
      blockedReason,
    };
  }

  const writeResult = primaryToolResult(writeExecution);
  if (!writeResult || writeResult.exit_code !== 0) {
    appendTerminalStep(
      steps,
      true,
      writeResult?.stderr || writeResult?.stdout || 'File write failed',
    );
    return {
      steps,
      sessionLoopSteps: buildSessionLoopSteps(steps),
      writeResult,
      testResult: null,
      policyBlocked: false,
      blockedReason: null,
    };
  }

  const verifyAction: AgentAction = {
    type: 'run_command',
    command: input.verifierCommand,
    cwd: input.projectRoot,
  };
  const verifyExecution = await executeActionWithPolicy(
    verifyAction,
    preset,
    input.toolContext,
    policyDeps,
  );
  steps.push(stepFromExecution('verify', verifyExecution));

  if (verifyExecution.policyBlocked) {
    const blockedReason = primaryToolResult(verifyExecution)?.stderr ?? 'Policy blocked verifier';
    appendTerminalStep(steps, true, blockedReason);
    return {
      steps,
      sessionLoopSteps: buildSessionLoopSteps(steps),
      writeResult,
      testResult: primaryToolResult(verifyExecution),
      policyBlocked: true,
      blockedReason,
    };
  }

  const testResult = primaryToolResult(verifyExecution);
  const verifyFailed = !testResult || testResult.exit_code !== 0;
  appendTerminalStep(
    steps,
    verifyFailed,
    verifyFailed ? `${input.verifierCommand} failed` : 'Verifier passed',
  );

  return {
    steps,
    sessionLoopSteps: buildSessionLoopSteps(steps),
    writeResult,
    testResult,
    policyBlocked: false,
    blockedReason: null,
  };
}

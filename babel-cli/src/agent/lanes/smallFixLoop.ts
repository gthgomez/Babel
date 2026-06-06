/**
 * Small-fix observe→act loop MVP — policy-gated mutation steps for `bl fix`.
 *
 * Single-turn loop: observe file state → write_file (policy) → observe result
 * → run_command verifier (policy) → return tool results for checkpoint/verify UX.
 */

import type { ToolContext, ToolResult } from '../../localTools.js';
import type { AgentAction } from '../actions.js';
import { decideAction, presetForVerb } from '../policy.js';
import type { PermissionDecision, PermissionPreset } from '../policy.js';
import {
  defaultToolExecutor,
  executeActionWithPolicy,
  type PolicyGatedExecutionResult,
  type ToolExecutor,
} from '../toolExecutor.js';

export type SmallFixLoopPhase = 'observe' | 'act' | 'verify';

export interface SmallFixLoopStep {
  phase: SmallFixLoopPhase;
  action: AgentAction;
  policyDecision: PermissionDecision;
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
  writeResult: ToolResult | null;
  testResult: ToolResult | null;
  policyBlocked: boolean;
  blockedReason: string | null;
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
    return {
      steps,
      writeResult: primaryToolResult(writeExecution),
      testResult: null,
      policyBlocked: true,
      blockedReason: primaryToolResult(writeExecution)?.stderr ?? 'Policy blocked file write',
    };
  }

  const writeResult = primaryToolResult(writeExecution);
  if (!writeResult || writeResult.exit_code !== 0) {
    return {
      steps,
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
    return {
      steps,
      writeResult,
      testResult: primaryToolResult(verifyExecution),
      policyBlocked: true,
      blockedReason: primaryToolResult(verifyExecution)?.stderr ?? 'Policy blocked verifier',
    };
  }

  return {
    steps,
    writeResult,
    testResult: primaryToolResult(verifyExecution),
    policyBlocked: false,
    blockedReason: null,
  };
}

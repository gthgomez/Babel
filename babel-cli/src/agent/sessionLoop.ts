import type { PermissionDecision } from './policy.js';

export type SessionLoopPhase = 'observe' | 'act' | 'verify' | 'finish' | 'blocked';

export interface SessionLoopStepPayload {
  phase: SessionLoopPhase;
  status: 'pass' | 'fail' | 'blocked';
  policy_decision: PermissionDecision;
}

const READ_ONLY_POLICY: PermissionDecision = 'allow';

function step(
  phase: SessionLoopPhase,
  status: 'pass' | 'fail' | 'blocked',
): SessionLoopStepPayload {
  return {
    phase,
    status,
    policy_decision: READ_ONLY_POLICY,
  };
}

/**
 * Build session-shaped steps for read-only ask/plan lanes: observe → act → verify → finish.
 */
export function buildReadOnlySessionLoopSteps(input: {
  observe: 'pass' | 'fail' | 'blocked';
  act: 'pass' | 'fail' | 'blocked';
  verify: 'pass' | 'fail' | 'blocked';
  terminal?: 'finish' | 'blocked';
}): SessionLoopStepPayload[] {
  const steps = [
    step('observe', input.observe),
    step('act', input.act),
    step('verify', input.verify),
  ];
  const terminal =
    input.terminal ??
    (input.act === 'blocked' || input.verify === 'blocked' || input.act === 'fail'
      ? 'blocked'
      : 'finish');
  steps.push(step(terminal, terminal === 'finish' ? 'pass' : 'blocked'));
  return steps;
}

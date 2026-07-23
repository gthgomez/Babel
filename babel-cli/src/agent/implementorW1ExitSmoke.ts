/**
 * Wave 1 residual exit smokes (offline, no live LLM).
 *
 * Exit gate items still open after W1-T10 metric gate:
 * 2. Plan→execute path once end-to-end with linked ids
 * 3. Phase-gate write blocks visible and counted (helpers + baseline start)
 *
 * Pure simulation of the operator path:
 *   /mode hard-plan → plan body → /execute-plan handoff → implement turn
 * plus phase-gate write-block counter visibility.
 */

import {
  createChatPlanExecuteHandoff,
  evaluateHardPlanModeGate,
  formatPlanHandoffUserMessage,
  resolveForceMutateTurnsForHandoff,
} from './planExecuteMode.js';
import {
  comparePhaseGateWriteBlockBaseline,
  countPhaseGateWriteBlocks,
  formatWhyStopped,
} from './implementorPolicy.js';
import { evaluatePhaseToolGate } from './phaseToolPolicy.js';
import { syncBlockedAttemptsFromToolLog } from './chatEngineObservability.js';
import { BlockedAttemptLedger } from './blockedAttemptLedger.js';
import { PolicyEventLog } from './policyEventLog.js';
import type { ObservabilityHandles } from './chatEngineObservability.js';

export interface W1ExitSmokeResult {
  id: string;
  description: string;
  pass: boolean;
  fail_reasons: string[];
  details: Record<string, unknown>;
}

/** Exit #2 — hard plan blocks writes; execute handoff carries linked ids + elevated mutate. */
export function runPlanExecuteLinkedIdSmoke(opts?: {
  sessionId?: string;
  planBody?: string;
  baseForceMutateTurns?: number;
}): W1ExitSmokeResult {
  const id = 'W1-exit-2-plan-execute-linked-id';
  const description =
    'Plan→execute end-to-end with plan_id + linked_event_id and elevated force-mutate';
  const fail_reasons: string[] = [];
  const sessionId = opts?.sessionId ?? 'sess_interactive_w1_exit';
  const planBody =
    opts?.planBody ??
    '1. Edit babel-cli/src/agent/example.ts to fix off-by-one\n2. Run unit test for example';
  const baseForce = opts?.baseForceMutateTurns ?? 5;

  // Hard plan: mutations blocked
  const blockedWrite = evaluateHardPlanModeGate({
    toolName: 'str_replace',
    hardPlanMode: true,
  });
  const blockedSub = evaluateHardPlanModeGate({
    toolName: 'sub_agent',
    hardPlanMode: true,
    isMutationSubAgent: true,
  });
  const allowRead = evaluateHardPlanModeGate({
    toolName: 'read_file',
    hardPlanMode: true,
  });
  if (!blockedWrite.blocked) fail_reasons.push('hard-plan did not block str_replace');
  if (!blockedSub.blocked) fail_reasons.push('hard-plan did not block mutation sub_agent');
  if (allowRead.blocked) fail_reasons.push('hard-plan incorrectly blocked read_file');

  // /execute-plan: create handoff linked to session/event id (REPL uses interactiveSessionId)
  const handoff = createChatPlanExecuteHandoff({
    planBody,
    linkedEventId: sessionId,
    elevatedMutate: true,
    planId: 'plan_w1_exit_smoke',
    now: new Date('2026-07-15T14:00:00.000Z'),
  });

  if (!handoff.planId) fail_reasons.push('missing planId');
  if (handoff.linkedEventId !== sessionId) {
    fail_reasons.push(`linkedEventId mismatch: ${handoff.linkedEventId}`);
  }
  if (!handoff.elevatedMutate) fail_reasons.push('elevatedMutate not set');

  const userMsg = formatPlanHandoffUserMessage(handoff);
  if (!userMsg.includes('plan_id:')) fail_reasons.push('handoff message missing plan_id');
  if (!userMsg.includes(handoff.planId)) fail_reasons.push('handoff message missing plan id value');
  if (!userMsg.includes(`linked_event_id: ${sessionId}`)) {
    fail_reasons.push('handoff message missing linked_event_id');
  }
  if (!userMsg.includes('IMPLEMENT mode')) fail_reasons.push('handoff message missing IMPLEMENT mode');
  if (!userMsg.includes('example.ts')) fail_reasons.push('handoff message missing plan body');

  const forceTurns = resolveForceMutateTurnsForHandoff(baseForce, handoff);
  if (forceTurns !== 1) {
    fail_reasons.push(`expected elevated force-mutate turns=1, got ${forceTurns}`);
  }

  // After execute, hard plan is off — mutations allowed
  const implementWrite = evaluateHardPlanModeGate({
    toolName: 'str_replace',
    hardPlanMode: false,
  });
  if (implementWrite.blocked) {
    fail_reasons.push('implement mode still blocks str_replace');
  }

  return {
    id,
    description,
    pass: fail_reasons.length === 0,
    fail_reasons,
    details: {
      planId: handoff.planId,
      linkedEventId: handoff.linkedEventId,
      forceMutateTurns: forceTurns,
      hardPlanBlockedWrite: blockedWrite.blocked,
      implementAllowsWrite: !implementWrite.blocked,
    },
  };
}

/** Exit #3 — phase-gate write blocks counted, visible, and baseline comparison started. */
export function runPhaseGateWriteBlockVisibilitySmoke(): W1ExitSmokeResult {
  const id = 'W1-exit-3-phase-gate-write-block-visibility';
  const description =
    'Phase-gate write blocks visible in why-stopped, counted in metrics, baseline comparison started';
  const fail_reasons: string[] = [];

  // Gate itself blocks writes in investigate
  const gate = evaluatePhaseToolGate({
    toolName: 'str_replace',
    phase: 'investigate',
    enabled: true,
  });
  if (!gate.blocked) fail_reasons.push('phase-gate did not block write in investigate');
  if (!gate.observation?.includes('phase-gate blocked write')) {
    fail_reasons.push('phase-gate observation missing “write blocked” wording');
  }

  // Simulate chatEngine recording path: policy event + tool log → ledger sync
  const policyLog = new PolicyEventLog();
  policyLog.record({
    at_turn: 1,
    kind: 'phase_gate_block',
    detail: 'phase=investigate',
    tool: 'str_replace',
  });
  policyLog.record({
    at_turn: 1,
    kind: 'phase_gate_block',
    detail: 'phase=investigate',
    tool: 'write_file',
  });
  // Non-write phase-gate (verify search) should not inflate write-block count preferentially
  policyLog.record({
    at_turn: 2,
    kind: 'phase_gate_block',
    detail: 'phase=verify',
    tool: 'grep',
  });

  const toolCallLog = [
    {
      tool: 'str_replace',
      target: 'src/a.ts',
      detail: 'phase-gate',
      error: 'blocked',
      index: 0,
      exit_code: 1,
    },
    {
      tool: 'write_file',
      target: 'src/b.ts',
      detail: 'phase-gate',
      error: 'blocked',
      index: 1,
      exit_code: 1,
    },
  ];
  const ledger = new BlockedAttemptLedger();
  const handles = {
    toolCallLog,
    engineRunDir: '',
    policyEventLog: policyLog,
    routingReceiptLog: { toJSON: () => [] },
    observationTails: { record: () => {}, toJSON: () => [] },
    blockedAttemptLedger: ledger,
    logIndexToTurn: new Map<number, number>([
      [0, 1],
      [1, 1],
    ]),
    turnIndex: 1,
    turnToolCallLogStart: 0,
    lastPhase: 'investigate' as const,
  } as unknown as ObservabilityHandles;
  syncBlockedAttemptsFromToolLog(handles, 0);

  const metrics = countPhaseGateWriteBlocks({
    policyEvents: policyLog.toJSON(),
    blockedAttempts: ledger.toJSON(),
  });
  if (metrics.phase_gate_write_block_count !== 2) {
    fail_reasons.push(
      `expected phase_gate_write_block_count=2, got ${metrics.phase_gate_write_block_count}`,
    );
  }
  if (metrics.phase_gate_block_count < 2) {
    fail_reasons.push(`expected phase_gate_block_count>=2, got ${metrics.phase_gate_block_count}`);
  }
  if (!metrics.visibility_line?.includes('write blocked: phase-gate')) {
    fail_reasons.push(`visibility_line missing write blocked wording: ${metrics.visibility_line}`);
  }

  const why = formatWhyStopped({
    status: 'BLOCKED',
    hasAnyWrites: false,
    lastPolicyEvents: policyLog.toJSON(),
    blockedAttempts: ledger.toJSON(),
    topBlockedReason: 'phase-gate',
  });
  if (!why.includes('write blocked: phase-gate')) {
    fail_reasons.push('formatWhyStopped missing write blocked: phase-gate');
  }
  if (!why.includes('phase_gate_block') && !why.includes('Phase-gate events')) {
    fail_reasons.push('formatWhyStopped missing phase-gate event summary');
  }

  const baseline = comparePhaseGateWriteBlockBaseline({
    currentWriteBlocks: metrics.phase_gate_write_block_count,
  });
  if (!baseline.baseline_started) fail_reasons.push('baseline comparison not started');
  if (baseline.baseline !== null) {
    fail_reasons.push('first baseline should report baseline=null (just established)');
  }

  const next = comparePhaseGateWriteBlockBaseline({
    currentWriteBlocks: 1,
    baselineWriteBlocks: metrics.phase_gate_write_block_count,
  });
  if (next.improved !== true) fail_reasons.push('expected improved=true when write blocks drop');
  if (next.delta !== -1) fail_reasons.push(`expected delta=-1, got ${next.delta}`);

  return {
    id,
    description,
    pass: fail_reasons.length === 0,
    fail_reasons,
    details: {
      phase_gate_write_block_count: metrics.phase_gate_write_block_count,
      phase_gate_block_count: metrics.phase_gate_block_count,
      visibility_line: metrics.visibility_line,
      baseline_note: baseline.note,
      improved_note: next.note,
      ledger_phase_gate: ledger.countsByReason().byReason['phase-gate'] ?? 0,
    },
  };
}

/** Run residual Wave 1 exit smokes (items 2–3). */
export function runW1ResidualExitSmokes(): {
  pass: boolean;
  results: W1ExitSmokeResult[];
} {
  const results = [runPlanExecuteLinkedIdSmoke(), runPhaseGateWriteBlockVisibilitySmoke()];
  return {
    pass: results.every((r) => r.pass),
    results,
  };
}

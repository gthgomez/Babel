/** Chat bindings for continuation; permissions, durable admission and completion stay separate. */
import { createRunControl, type DispatchRequest, type RunControl, type StopRequest } from '../runtime/run-control.js';
import type { ChatActionResult, ChatCallbacks, ChatEngineActionExecutorHost } from './chatEngineContracts.js';
import { paritySettleToolNotStarted } from './chatEngineParityBridge.js';

export interface ChatSubmissionControlHost {
  engineRunId: string;
  parity: { turnId: string | null };
  activeSubmissionGeneration: number;
  runControl: RunControl | null;
  abortController: AbortController;
  _cancelled: boolean;
  isSubmissionCurrent(generation: number): boolean;
}

export function initializeChatSubmissionControl(host: ChatSubmissionControlHost, generation: number): void {
  if (!host.isSubmissionCurrent(generation)) throw new Error('RUN_CONTROL_OWNER_RETIRED');
  const turnId = host.parity.turnId;
  if (!turnId) throw new Error('RUN_CONTROL_CANONICAL_TURN_MISSING');
  if (host.runControl?.owner.generation === generation) {
    if (host.runControl.owner.turnId !== turnId) throw new Error('RUN_CONTROL_TURN_REBOUND');
    return;
  }
  const control = createRunControl({ runId: host.engineRunId, turnId, generation });
  host.runControl = control;
  host.abortController = { signal: control.signal, abort: () => {
    control.requestStop({ owner: control.owner, kind: 'cancelled', reasonCode: 'cancelled', source: 'user' });
  } };
  if (host._cancelled) control.requestStop({ owner: control.owner, kind: 'cancelled', reasonCode: 'cancelled', source: 'user' });
}

export function activateChatSubmissionGeneration(host: ChatSubmissionControlHost, generation: number): void {
  if (host.activeSubmissionGeneration === generation) return;
  host.runControl?.requestStop({ owner: host.runControl.owner, kind: 'superseded', reasonCode: 'submission_superseded', source: 'supersession' });
  host.activeSubmissionGeneration = generation;
  host._cancelled = false;
}

/** Interpret only trusted executor fields, including the existing terminal policy breaker. */
export function acceptToolStop(control: RunControl | undefined, result: { stopRequest?: StopRequest; terminal: boolean; policyBlocked: boolean }): void {
  const request = result.stopRequest ?? (result.terminal && result.policyBlocked && control
    ? { owner: control.owner, kind: 'blocked' as const, reasonCode: 'permission_denied', source: 'executor' as const }
    : undefined);
  if (request) control?.requestStop(request);
}

/** One presentation/lifecycle projection for a host-confirmed unstarted action. */
export function settlePreventedChatAction(input: {
  host: ChatEngineActionExecutorHost;
  control?: RunControl | undefined;
  notStarted?: DispatchRequest | undefined;
  tool: string;
  target: string;
  toolId: number;
  meta: { index: number; idempotencyKey?: string };
  callbacks: ChatCallbacks;
}): ChatActionResult | null {
  const { host, control, notStarted, tool, target, toolId, meta, callbacks } = input;
  if (!control?.stop() || !notStarted || notStarted.kind !== 'tool' ||
    notStarted.owner.runId !== control.owner.runId || notStarted.owner.turnId !== control.owner.turnId ||
    notStarted.owner.generation !== control.owner.generation) return null;
  const callId = meta.idempotencyKey ?? host._streamNativeToolCallIds[meta.index] ?? `tool_call_${host._turnIndex}_${meta.index}`;
  // Governed adapters propagate prevention only if none of their leaf writes
  // started. Project that host-owned relationship onto the existing parent id.
  paritySettleToolNotStarted(host.parity, { id: callId, name: tool, action_index: meta.index, target_summary: target },
    host.engineRunDir, 'run_stopped_before_dispatch', { ...notStarted, operationId: callId });
  callbacks.onToolComplete?.(toolId, 'not started', 'submission stopped', 1);
  return { index: meta.index, observation: `### ${tool} ${target}\nnot_started: submission stopped`,
    ...(control.stop() ? { stopRequest: control.stop()! } : {}),
  };
}

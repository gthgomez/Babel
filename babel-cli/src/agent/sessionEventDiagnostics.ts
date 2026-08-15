/**
 * Actionable diagnostics for fail-closed session-event lifecycle violations.
 * Never embeds tool content, arguments, or command output.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionEvent } from './sessionEvents.js'

export const SESSION_EVENT_LIFECYCLE_ERROR_CLASS = 'SESSION_EVENT_LIFECYCLE_CAUSALITY' as const

export interface SessionEventLifecycleMatch {
  seq: number
  kind: string
  tool_call_id: string
  idempotency_key: string
  tool_name: string
}

export interface SessionEventLifecycleDiagnostic {
  error_class: typeof SESSION_EVENT_LIFECYCLE_ERROR_CLASS
  candidate_kind: string
  turn_id: string | null
  tool_call_id: string
  idempotency_key: string
  tool_name: string
  candidate_seq: number
  matching_by_id: SessionEventLifecycleMatch[]
  matching_by_key: SessionEventLifecycleMatch[]
  matching_full_identity: SessionEventLifecycleMatch[]
  recent_lifecycle_events: SessionEventLifecycleMatch[]
  batch_id?: string
  action_index?: number
  reason: string
}

function asToolLifecycle(event: SessionEvent): SessionEventLifecycleMatch | null {
  if (
    event.kind !== 'tool_proposed' &&
    event.kind !== 'tool_started' &&
    event.kind !== 'tool_completed' &&
    event.kind !== 'tool_failed' &&
    event.kind !== 'tool_cancelled'
  ) {
    return null
  }
  return {
    seq: event.seq,
    kind: event.kind,
    tool_call_id: event.tool_call_id,
    idempotency_key: event.idempotency_key,
    tool_name: event.tool_name,
  }
}

export function buildToolLifecycleCausalityDiagnostic(input: {
  priorEvents: readonly SessionEvent[]
  candidate: {
    kind: string
    turn_id?: string | null
    tool_call_id?: unknown
    idempotency_key?: unknown
    tool_name?: unknown
    batch_id?: unknown
    action_index?: unknown
  }
  candidateSeq: number
  reason: string
}): SessionEventLifecycleDiagnostic {
  const toolCallId = typeof input.candidate.tool_call_id === 'string' ? input.candidate.tool_call_id : ''
  const idempotencyKey =
    typeof input.candidate.idempotency_key === 'string' ? input.candidate.idempotency_key : ''
  const toolName = typeof input.candidate.tool_name === 'string' ? input.candidate.tool_name : ''
  const lifecycle = input.priorEvents
    .map(asToolLifecycle)
    .filter((event): event is SessionEventLifecycleMatch => event !== null)

  const diagnostic: SessionEventLifecycleDiagnostic = {
    error_class: SESSION_EVENT_LIFECYCLE_ERROR_CLASS,
    candidate_kind: input.candidate.kind,
    turn_id: input.candidate.turn_id ?? null,
    tool_call_id: toolCallId,
    idempotency_key: idempotencyKey,
    tool_name: toolName,
    candidate_seq: input.candidateSeq,
    matching_by_id: lifecycle.filter((event) => event.tool_call_id === toolCallId),
    matching_by_key: lifecycle.filter((event) => event.idempotency_key === idempotencyKey),
    matching_full_identity: lifecycle.filter(
      (event) =>
        event.tool_call_id === toolCallId &&
        event.idempotency_key === idempotencyKey &&
        event.tool_name === toolName,
    ),
    recent_lifecycle_events: lifecycle.slice(-12),
    reason: input.reason,
  }
  if (typeof input.candidate.batch_id === 'string') diagnostic.batch_id = input.candidate.batch_id
  if (typeof input.candidate.action_index === 'number') diagnostic.action_index = input.candidate.action_index
  return diagnostic
}

export class SessionEventLifecycleCausalityError extends Error {
  readonly code = SESSION_EVENT_LIFECYCLE_ERROR_CLASS
  readonly diagnostic: SessionEventLifecycleDiagnostic

  constructor(message: string, diagnostic: SessionEventLifecycleDiagnostic) {
    super(message)
    this.name = 'SessionEventLifecycleCausalityError'
    this.diagnostic = diagnostic
  }
}

export function formatOperatorLifecycleFailureMessage(
  diagnostic: SessionEventLifecycleDiagnostic,
): string {
  const eventRef = diagnostic.candidate_seq >= 0 ? `event seq ${diagnostic.candidate_seq}` : 'the rejected append'
  return [
    'Internal session-state consistency failure',
    'No further tool execution performed',
    'Run evidence preserved',
    `Inspect diagnostics for ${eventRef}`,
  ].join('. ')
}

export function persistSessionEventLifecycleDiagnostic(
  runDir: string | undefined,
  diagnostic: SessionEventLifecycleDiagnostic,
): string | null {
  if (!runDir) return null
  const dir = join(runDir, 'diagnostics')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `lifecycle-${diagnostic.candidate_seq}-${Date.now()}.json`)
  writeFileSync(path, `${JSON.stringify(diagnostic, null, 2)}\n`, 'utf-8')
  return path
}

export function captureSessionEventAppendFailure(
  error: unknown,
  runDir?: string,
): { operatorMessage: string; diagnosticPath: string | null } | null {
  if (!(error instanceof SessionEventLifecycleCausalityError)) return null
  const diagnosticPath = persistSessionEventLifecycleDiagnostic(runDir, error.diagnostic)
  return {
    operatorMessage: formatOperatorLifecycleFailureMessage(error.diagnostic),
    diagnosticPath,
  }
}

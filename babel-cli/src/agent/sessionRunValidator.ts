/**
 * Gold-standard validator for a persisted Babel chat run.
 * Reads the canonical session-events.jsonl ledger and reports invariant failures.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  inspectSessionEventLogFromDir,
  type SessionEvent,
  type SessionEventLog,
} from './sessionEvents.js'
import { chatSessionDir } from '../cli/runsLayout.js'

export type SessionRunValidatorStatus = 'PASS' | 'FAIL'

export interface SessionRunValidatorFinding {
  invariant: string
  event?: { seq: number; kind: string; event_id?: string }
  related_events?: Array<{ seq: number; kind: string }>
  explanation: string
}

export interface SessionRunValidatorResult {
  status: SessionRunValidatorStatus
  run_dir: string
  session_id?: string
  event_count: number
  findings: SessionRunValidatorFinding[]
  metrics: {
    tool_count: number
    tool_batch_count: number
    open_tool_count: number
    progress_interventions: number
    turn_ended_count: number
  }
}

type ToolLifecycleKind =
  | 'tool_proposed'
  | 'tool_started'
  | 'tool_completed'
  | 'tool_failed'
  | 'tool_cancelled'

function isToolLifecycle(event: SessionEvent): event is SessionEvent & {
  kind: ToolLifecycleKind
  tool_call_id: string
  idempotency_key: string
  tool_name: string
} {
  return (
    event.kind === 'tool_proposed' ||
    event.kind === 'tool_started' ||
    event.kind === 'tool_completed' ||
    event.kind === 'tool_failed' ||
    event.kind === 'tool_cancelled'
  )
}

function identityKey(event: {
  idempotency_key: string
  tool_call_id: string
  tool_name: string
}): string {
  return `${event.idempotency_key}\0${event.tool_call_id}\0${event.tool_name}`
}

function finding(
  invariant: string,
  explanation: string,
  event?: SessionEvent,
  related?: SessionEvent[],
): SessionRunValidatorFinding {
  return {
    invariant,
    ...(event
      ? { event: { seq: event.seq, kind: event.kind, event_id: event.event_id } }
      : {}),
    ...(related && related.length > 0
      ? { related_events: related.map((item) => ({ seq: item.seq, kind: item.kind })) }
      : {}),
    explanation,
  }
}

/** Validate an in-memory session event log against the gold-standard lifecycle contract. */
export function validateSessionEventLog(
  log: SessionEventLog,
  runDir = '',
): SessionRunValidatorResult {
  const findings: SessionRunValidatorFinding[] = []
  const eventIds = new Set<string>()
  let expectedSeq = 0
  const byIdentity = new Map<string, SessionEvent[]>()
  const byCallId = new Map<string, SessionEvent[]>()
  let progressInterventions = 0
  let turnEnded = 0

  for (const event of log.events) {
    if (event.seq !== expectedSeq) {
      findings.push(
        finding(
          'sequence_gaps',
          `seq ${event.seq} is not the next contiguous value (expected ${expectedSeq})`,
          event,
        ),
      )
    }
    expectedSeq = event.seq + 1
    if (eventIds.has(event.event_id)) {
      findings.push(finding('duplicate_event_ids', `event_id ${event.event_id} is duplicated`, event))
    }
    eventIds.add(event.event_id)

    if (event.kind === 'turn_ended') turnEnded += 1
    if (event.kind === 'progress_recovery' && event.intervention !== 'none') {
      progressInterventions += 1
    }

    if (!isToolLifecycle(event)) continue
    const key = identityKey(event)
    const group = byIdentity.get(key) ?? []
    group.push(event)
    byIdentity.set(key, group)
    const idGroup = byCallId.get(event.tool_call_id) ?? []
    idGroup.push(event)
    byCallId.set(event.tool_call_id, idGroup)
  }

  const turnEndedByTurn = new Map<string, SessionEvent[]>()
  for (const event of log.events) {
    if (event.kind !== 'turn_ended') continue
    const turnKey = event.turn_id ?? 'null'
    const group = turnEndedByTurn.get(turnKey) ?? []
    group.push(event)
    turnEndedByTurn.set(turnKey, group)
  }
  for (const [turnKey, terminals] of turnEndedByTurn) {
    if (terminals.length > 1) {
      findings.push(
        finding(
          'turn_terminal_duplication',
          `turn ${turnKey} has ${terminals.length} turn_ended events`,
          terminals[1],
          terminals,
        ),
      )
    }
  }

  let toolCount = 0
  let openToolCount = 0
  for (const [key, events] of byIdentity) {
    const proposals = events.filter((event) => event.kind === 'tool_proposed')
    const starts = events.filter((event) => event.kind === 'tool_started')
    const terminals = events.filter(
      (event) =>
        event.kind === 'tool_completed' ||
        event.kind === 'tool_failed' ||
        event.kind === 'tool_cancelled',
    )
    const first = events[0]
    if (!first || !isToolLifecycle(first)) continue
    toolCount += 1

    if (proposals.length !== 1) {
      findings.push(
        finding(
          'proposal_count',
          `identity ${key.replace(/\0/g, '/')} has ${proposals.length} tool_proposed events`,
          first,
          events,
        ),
      )
    }
    if (starts.length > 1) {
      findings.push(finding('orphan_tool_starts', 'more than one tool_started for one identity', first, starts))
    }
    if (terminals.length > 1) {
      findings.push(finding('duplicate_terminals', 'more than one terminal for one identity', terminals[1], terminals))
    }

    const notStarted = terminals.filter(
      (event) => event.kind === 'tool_cancelled' && event.recovery_state === 'TOOL_NOT_STARTED',
    )
    if (notStarted.length > 0 && starts.length !== 0) {
      findings.push(
        finding(
          'invalid_TOOL_NOT_STARTED_state',
          'TOOL_NOT_STARTED cancellation must not have a tool_started predecessor',
          notStarted[0],
          starts,
        ),
      )
    }
    if (terminals.length === 1 && notStarted.length === 0 && starts.length !== 1) {
      findings.push(
        finding(
          'orphan_normal_tool_terminals',
          'normal terminal requires exactly one prior tool_started',
          terminals[0],
          events,
        ),
      )
    }
    if (starts.length === 1 && terminals.length === 0) {
      openToolCount += 1
      findings.push(
        finding(
          'orphan_tool_starts',
          'tool_started has no terminal (interrupted or append failure)',
          starts[0],
          events,
        ),
      )
    }
    if (proposals.length === 1 && starts.length === 0 && terminals.length === 0) {
      openToolCount += 1
      findings.push(
        finding('unreconciled_unknown_effects', 'tool_proposed never started or cancelled', proposals[0], events),
      )
    }

    const idSiblings = byCallId.get(first.tool_call_id) ?? []
    const nameDrift = idSiblings.filter((event) => isToolLifecycle(event) && event.tool_name !== first.tool_name)
    if (nameDrift.length > 0) {
      findings.push(
        finding(
          'tool_name_drift',
          `tool_call_id ${first.tool_call_id} is reused with a different tool_name`,
          nameDrift[0],
          idSiblings,
        ),
      )
    }
    const keyDrift = idSiblings.filter(
      (event) => isToolLifecycle(event) && event.idempotency_key !== first.idempotency_key,
    )
    if (keyDrift.length > 0) {
      findings.push(
        finding(
          'idempotency_key_drift',
          `tool_call_id ${first.tool_call_id} is reused with a different idempotency_key`,
          keyDrift[0],
          idSiblings,
        ),
      )
    }
  }

  return {
    status: findings.length === 0 ? 'PASS' : 'FAIL',
    run_dir: runDir,
    session_id: log.session_id,
    event_count: log.events.length,
    findings,
    metrics: {
      tool_count: toolCount,
      tool_batch_count: log.events.filter((event) => event.kind === 'tool_proposed').length > 0
        ? new Set(
            log.events
              .filter((event) => event.kind === 'tool_proposed')
              .map((event) => event.ts.slice(0, 19)),
          ).size
        : 0,
      open_tool_count: openToolCount,
      progress_interventions: progressInterventions,
      turn_ended_count: turnEnded,
    },
  }
}

export function resolveSessionRunDir(runIdOrDir: string): string {
  if (existsSync(join(runIdOrDir, 'session-events.jsonl'))) return runIdOrDir
  const asChat = chatSessionDir(runIdOrDir)
  if (existsSync(join(asChat, 'session-events.jsonl'))) return asChat
  return runIdOrDir
}

/** Validate a persisted chat-session or explicit run directory. */
export function validateSessionRun(runIdOrDir: string): SessionRunValidatorResult {
  const runDir = resolveSessionRunDir(runIdOrDir)
  const inspected = inspectSessionEventLogFromDir(runDir)
  if (inspected.kind === 'missing') {
    return {
      status: 'FAIL',
      run_dir: runDir,
      event_count: 0,
      findings: [
        {
          invariant: 'session_events_present',
          explanation: `session-events.jsonl is missing at ${inspected.path}`,
        },
      ],
      metrics: {
        tool_count: 0,
        tool_batch_count: 0,
        open_tool_count: 0,
        progress_interventions: 0,
        turn_ended_count: 0,
      },
    }
  }
  if (inspected.kind === 'invalid') {
    return {
      status: 'FAIL',
      run_dir: runDir,
      event_count: 0,
      findings: [
        {
          invariant: 'session_events_parseable',
          explanation: inspected.error.message,
        },
      ],
      metrics: {
        tool_count: 0,
        tool_batch_count: 0,
        open_tool_count: 0,
        progress_interventions: 0,
        turn_ended_count: 0,
      },
    }
  }
  return validateSessionEventLog(inspected.log, runDir)
}

export function formatSessionRunValidatorText(result: SessionRunValidatorResult): string {
  if (result.status === 'PASS') return 'PASS'
  const lines = ['FAIL']
  for (const item of result.findings) {
    lines.push(`  invariant: ${item.invariant}`)
    if (item.event) lines.push(`  event: seq=${item.event.seq} kind=${item.event.kind}`)
    if (item.related_events && item.related_events.length > 0) {
      lines.push(
        `  related events: ${item.related_events.map((event) => `${event.seq}:${event.kind}`).join(', ')}`,
      )
    }
    lines.push(`  explanation: ${item.explanation}`)
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}

/** True when a diagnostics sidecar exists for the run. */
export function runHasLifecycleDiagnostics(runDir: string): boolean {
  const dir = join(runDir, 'diagnostics')
  if (!existsSync(dir)) return false
  return readdirSync(dir).some((name) => name.startsWith('lifecycle-') && name.endsWith('.json'))
}

export function readRunFileIfPresent(runDir: string, name: string): string | null {
  const path = join(runDir, name)
  if (!existsSync(path)) return null
  return readFileSync(path, 'utf-8')
}

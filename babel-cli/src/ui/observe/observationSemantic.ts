/**
 * ObservationSemanticState — durable meaning of a TUI frame.
 *
 * Not a dump of turnViewProjector. Maps SessionEvent kinds that the
 * projector currently drops (blocked tools, stall/recovery, mutations).
 */

import type { SessionEvent } from '../../agent/sessionEvents.js'
import { mapOutcomeToStatus } from '../../interactive/projection/canonicalEvents.js'
import { projectTurnViewStateFromSessionEvents } from '../../interactive/projection/turnViewProjector.js'
import type { TerminalOutcome } from '../../schemas/agentContracts.js'

export type ToolLifecycleState =
  | 'proposed'
  | 'started'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'cancelled'

export interface ObservationTool {
  id: string
  name: string
  target: string
  state: ToolLifecycleState
  exitCode: number | null
}

export interface ObservationProjectionSnapshot {
  reviewStatus: string
  statusLabel: string
  userInput: string
  assistantAnswer: string
  isTerminal: boolean
}

export interface ObservationSemanticState {
  turnId: string | null
  terminalStatus: string
  lastTool: ObservationTool | null
  toolAttempts: number
  toolCompleted: number
  toolFailed: number
  toolBlocked: number
  workspaceMutationCount: number
  changedPaths: string[]
  progressRecoveryCount: number
  stallCycle: number
  semanticEventSeq: number
  /** Projector snapshot beside the lifecycle oracle — not the screen. */
  projection: ObservationProjectionSnapshot | null
}

const EMPTY: ObservationSemanticState = {
  turnId: null,
  terminalStatus: 'ready',
  lastTool: null,
  toolAttempts: 0,
  toolCompleted: 0,
  toolFailed: 0,
  toolBlocked: 0,
  workspaceMutationCount: 0,
  changedPaths: [],
  progressRecoveryCount: 0,
  stallCycle: 0,
  semanticEventSeq: 0,
  projection: null,
}

interface ProjectionAccumulator {
  reviewStatus: string
  userInput: string
  assistantAnswer: string
  isTerminal: boolean
  terminalOutcome: TerminalOutcome
}

interface ReducerState {
  tools: Map<string, ObservationTool>
  changed: Set<string>
  turnId: string | null
  terminalStatus: string
  toolAttempts: number
  toolCompleted: number
  toolFailed: number
  toolBlocked: number
  progressRecoveryCount: number
  seq: number
  projection: ProjectionAccumulator
}

/** Incremental semantic reducer used by the live observation hook. */
export interface ObservationSemanticReducer {
  /** Apply one newly appended durable event and return the current state. */
  apply(event: SessionEvent): ObservationSemanticState
  /** Return the current state without replaying prior events. */
  current(): ObservationSemanticState
}

/**
 * Create an incremental observation reducer.
 *
 * The lifecycle state mirrors reduceObservationSemantic. The projection
 * snapshot mirrors the subset of the canonical projector persisted by the
 * observation plane, without replaying the complete event list after every
 * append.
 */
export function createObservationSemanticReducer(): ObservationSemanticReducer {
  const state: ReducerState = {
    tools: new Map<string, ObservationTool>(),
    changed: new Set<string>(),
    turnId: null,
    terminalStatus: 'in_progress',
    toolAttempts: 0,
    toolCompleted: 0,
    toolFailed: 0,
    toolBlocked: 0,
    progressRecoveryCount: 0,
    seq: 0,
    projection: {
      reviewStatus: 'in_progress',
      userInput: '',
      assistantAnswer: '',
      isTerminal: false,
      terminalOutcome: 'NO_CHANGE_REQUIRED',
    },
  }

  return {
    apply(event: SessionEvent): ObservationSemanticState {
      applyEvent(state, event)
      applyProjectionEvent(state.projection, event)
      return snapshot(state)
    },
    current: () => snapshot(state),
  }
}

function applyEvent(state: ReducerState, ev: SessionEvent): void {
  state.seq += 1
  if ('turn_id' in ev && typeof ev.turn_id === 'string') state.turnId = ev.turn_id

  switch (ev.kind) {
    case 'user_submitted':
      state.turnId = ev.turn_id ?? state.turnId
      state.terminalStatus = 'in_progress'
      break
    case 'tool_proposed':
      state.toolAttempts += 1
      state.tools.set(ev.tool_call_id, {
        id: ev.tool_call_id,
        name: ev.tool_name,
        target: ev.target_summary ?? '',
        state: 'proposed',
        exitCode: null,
      })
      break
    case 'tool_started':
      upsertTool(state.tools, ev.tool_call_id, ev.tool_name, ev.target_summary ?? '', 'started', null)
      break
    case 'tool_completed':
      state.toolCompleted += 1
      upsertTool(
        state.tools,
        ev.tool_call_id,
        ev.tool_name,
        ev.target_summary ?? '',
        'completed',
        ev.exit_code ?? 0,
      )
      break
    case 'tool_failed':
      state.toolFailed += 1
      upsertTool(
        state.tools,
        ev.tool_call_id,
        ev.tool_name,
        ev.target_summary ?? '',
        'failed',
        ev.exit_code ?? 1,
      )
      break
    case 'tool_cancelled': {
      const blocked = isBlockedCancel(ev.reason)
      if (blocked) state.toolBlocked += 1
      upsertTool(
        state.tools,
        ev.tool_call_id,
        ev.tool_name,
        ev.target_summary ?? '',
        blocked ? 'blocked' : 'cancelled',
        null,
      )
      break
    }
    case 'policy_intervened': {
      if (isBlockPolicy(ev.action)) {
        state.toolBlocked += 1
        if (ev.detail) {
          const last = [...state.tools.values()].at(-1)
          if (last && (last.state === 'proposed' || last.state === 'started')) last.state = 'blocked'
        }
      }
      break
    }
    case 'mutation_batch':
      for (const path of ev.paths) state.changed.add(path)
      break
    case 'progress_recovery':
      state.progressRecoveryCount += 1
      state.terminalStatus = 'stalled'
      break
    case 'completion_decision':
      state.terminalStatus = ev.final_outcome || ev.requested_outcome
      break
    case 'turn_ended':
      if (state.terminalStatus === 'in_progress') state.terminalStatus = 'completed'
      break
    default:
      break
  }
}

function applyProjectionEvent(state: ProjectionAccumulator, ev: SessionEvent): void {
  switch (ev.kind) {
    case 'user_submitted':
      state.userInput = ev.task_preview
      break
    case 'completion_decision': {
      const outcome = ev.final_outcome as TerminalOutcome
      if (isStrongerTerminal(state, outcome)) {
        state.terminalOutcome = outcome
        state.reviewStatus = mapOutcomeToStatus(outcome)
        state.isTerminal = true
      }
      if (ev.reason) state.assistantAnswer = ev.reason
      break
    }
    case 'turn_ended': {
      const rawOutcome = (ev as { outcome?: TerminalOutcome }).outcome
      const status = (ev as { status?: string }).status
      if (!rawOutcome && !status) break
      const outcome =
        rawOutcome ??
        (status === 'cancelled'
          ? 'CANCELLED'
          : status === 'blocked'
            ? 'BLOCKED_POLICY'
            : status === 'budget_exhausted'
              ? 'BUDGET_EXHAUSTED'
              : 'AGENT_FAILURE')
      if (isStrongerTerminal(state, outcome)) {
        state.terminalOutcome = outcome
        state.reviewStatus = status ?? mapOutcomeToStatus(outcome)
        state.isTerminal = true
      }
      break
    }
    default:
      break
  }
}

function isStrongerTerminal(state: ProjectionAccumulator, outcome: TerminalOutcome): boolean {
  return (
    !state.isTerminal ||
    outcome === 'CANCELLED' ||
    outcome === 'VERIFIED_COMPLETE' ||
    outcome === 'BLOCKED_POLICY' ||
    outcome === 'BUDGET_EXHAUSTED' ||
    outcome === 'INFRA_FAILURE' ||
    outcome === 'AGENT_FAILURE' ||
    (state.terminalOutcome === 'NO_CHANGE_REQUIRED' && outcome !== 'NO_CHANGE_REQUIRED')
  )
}

function snapshot(state: ReducerState): ObservationSemanticState {
  const lastTool = [...state.tools.values()].at(-1) ?? null
  return {
    turnId: state.turnId,
    terminalStatus: state.terminalStatus,
    lastTool: lastTool ? { ...lastTool } : null,
    toolAttempts: state.toolAttempts,
    toolCompleted: state.toolCompleted,
    toolFailed: state.toolFailed,
    toolBlocked: state.toolBlocked,
    workspaceMutationCount: state.changed.size,
    changedPaths: [...state.changed],
    progressRecoveryCount: state.progressRecoveryCount,
    stallCycle: state.progressRecoveryCount,
    semanticEventSeq: state.seq,
    projection: {
      reviewStatus: state.projection.reviewStatus,
      statusLabel: state.projection.isTerminal ? state.projection.reviewStatus : 'working',
      userInput: state.projection.userInput,
      assistantAnswer: state.projection.assistantAnswer,
      isTerminal: state.projection.isTerminal,
    },
  }
}

/**
 * Reduce session events into observation semantics.
 *
 * @param events Durable session event log
 */
export function reduceObservationSemantic(events: readonly SessionEvent[]): ObservationSemanticState {
  const tools = new Map<string, ObservationTool>()
  const changed = new Set<string>()
  let turnId: string | null = null
  let terminalStatus = 'in_progress'
  let toolAttempts = 0
  let toolCompleted = 0
  let toolFailed = 0
  let toolBlocked = 0
  let progressRecoveryCount = 0
  let seq = 0

  for (const ev of events) {
    seq += 1
    if ('turn_id' in ev && typeof ev.turn_id === 'string') turnId = ev.turn_id

    switch (ev.kind) {
      case 'user_submitted':
        turnId = ev.turn_id ?? turnId
        terminalStatus = 'in_progress'
        break
      case 'tool_proposed':
        toolAttempts += 1
        tools.set(ev.tool_call_id, {
          id: ev.tool_call_id,
          name: ev.tool_name,
          target: ev.target_summary ?? '',
          state: 'proposed',
          exitCode: null,
        })
        break
      case 'tool_started':
        upsertTool(tools, ev.tool_call_id, ev.tool_name, ev.target_summary ?? '', 'started', null)
        break
      case 'tool_completed':
        toolCompleted += 1
        upsertTool(
          tools,
          ev.tool_call_id,
          ev.tool_name,
          ev.target_summary ?? '',
          'completed',
          ev.exit_code ?? 0,
        )
        break
      case 'tool_failed':
        toolFailed += 1
        upsertTool(
          tools,
          ev.tool_call_id,
          ev.tool_name,
          ev.target_summary ?? '',
          'failed',
          ev.exit_code ?? 1,
        )
        break
      case 'tool_cancelled': {
        const blocked = isBlockedCancel(ev.reason)
        if (blocked) toolBlocked += 1
        upsertTool(
          tools,
          ev.tool_call_id,
          ev.tool_name,
          ev.target_summary ?? '',
          blocked ? 'blocked' : 'cancelled',
          null,
        )
        break
      }
      case 'policy_intervened': {
        if (isBlockPolicy(ev.action)) {
          toolBlocked += 1
          if (ev.detail) {
            const last = [...tools.values()].at(-1)
            if (last && (last.state === 'proposed' || last.state === 'started')) {
              last.state = 'blocked'
            }
          }
        }
        break
      }
      case 'mutation_batch':
        for (const p of ev.paths) changed.add(p)
        break
      case 'progress_recovery':
        progressRecoveryCount += 1
        terminalStatus = 'stalled'
        break
      case 'completion_decision':
        terminalStatus = ev.final_outcome || ev.requested_outcome
        break
      case 'turn_ended':
        if (terminalStatus === 'in_progress') terminalStatus = 'completed'
        break
      default:
        break
    }
  }

  const lastTool = [...tools.values()].at(-1) ?? null
  let projection: ObservationProjectionSnapshot | null = null
  try {
    const view = projectTurnViewStateFromSessionEvents(events)
    projection = {
      reviewStatus: view.reviewCard.status,
      statusLabel: view.statusBar.statusLabel,
      userInput: view.transcriptCell.userInput,
      assistantAnswer: view.transcriptCell.assistantAnswer,
      isTerminal: view.isTerminal,
    }
  } catch {
    projection = null
  }
  return {
    turnId,
    terminalStatus,
    lastTool,
    toolAttempts,
    toolCompleted,
    toolFailed,
    toolBlocked,
    workspaceMutationCount: changed.size,
    changedPaths: [...changed],
    progressRecoveryCount,
    stallCycle: progressRecoveryCount,
    semanticEventSeq: seq,
    projection,
  }
}

/**
 * Empty observation semantic state.
 */
export function emptyObservationSemantic(): ObservationSemanticState {
  return { ...EMPTY, changedPaths: [], projection: null }
}

function upsertTool(
  tools: Map<string, ObservationTool>,
  id: string,
  name: string,
  target: string,
  state: ToolLifecycleState,
  exitCode: number | null,
): void {
  const prev = tools.get(id)
  tools.set(id, {
    id,
    name,
    target: target || prev?.target || '',
    state,
    exitCode,
  })
}

function isBlockedCancel(reason: string | undefined): boolean {
  if (!reason) return false
  const r = reason.toLowerCase()
  return r.includes('block') || r.includes('policy') || r.includes('denied') || r.includes('refused')
}

function isBlockPolicy(action: string): boolean {
  const a = action.toLowerCase()
  return a.includes('block') || a.includes('deny') || a.includes('refuse')
}

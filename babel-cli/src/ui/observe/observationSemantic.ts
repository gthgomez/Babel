/**
 * ObservationSemanticState — durable meaning of a TUI frame.
 *
 * Not a dump of turnViewProjector. Maps SessionEvent kinds that the
 * projector currently drops (blocked tools, stall/recovery, mutations).
 */

import type { SessionEvent } from '../../agent/sessionEvents.js'
import { projectTurnViewStateFromSessionEvents } from '../../interactive/projection/turnViewProjector.js'

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

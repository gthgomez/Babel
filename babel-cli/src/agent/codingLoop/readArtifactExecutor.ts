import type { ChatEngineActionExecutorHost, ChatCallbacks } from '../chatEngineContracts.js'
import { formatChatToolObservation, type ChatToolAction } from '../chatToolDefinitions.js'
import type { ToolResult } from '../../localTools.js'
import { readRunOutput, registerRunOutput } from './runOutputArtifacts.js'

type ArtifactAction = Extract<ChatToolAction, { type: 'read_artifact' }>
export interface RunArtifactAccess {
  read(action: ArtifactAction, signal?: AbortSignal): string
  writeSpill(name: string, content: string): string
}

/** Format command evidence with enrollment scoped to its captured dispatch. */
export function formatRegisteredToolObservation(
  action: ChatToolAction, result: ToolResult, access: RunArtifactAccess, toolCallId: string,
): string {
  return formatChatToolObservation(action, { stdout: result.stdout, stderr: result.stderr, exitCode: result.exit_code },
    { toolCallId, writeSpill: access.writeSpill })
}

/** Capture the dispatching durable owner before any operation can suspend. */
export function captureRunArtifactAccess(
  host: ChatEngineActionExecutorHost, generation: number, callId: string, tool: string,
): RunArtifactAccess {
  const runDir = host.engineRunDir
  const allowance = host.taskAllowance
  const owner = allowance?.acceptedTaskId ? { sessionId: host.engineRunId,
    taskOwnerId: allowance.taskOwnerId, acceptedTaskId: allowance.acceptedTaskId } : null
  const requireOwner = () => {
    if (!owner || !host.isSubmissionCurrent(generation)
      || host.taskAllowance?.taskOwnerId !== owner.taskOwnerId
      || host.taskAllowance.acceptedTaskId !== owner.acceptedTaskId) throw new Error('ARTIFACT_DENIED')
    return owner
  }
  return {
    read: (action, signal) => readRunOutput({ runDir, owner: requireOwner(), artifactId: action.artifact_id,
      ...(action.start_line !== undefined ? { startLine: action.start_line } : {}),
      ...(action.end_line !== undefined ? { endLine: action.end_line } : {}),
      ...(action.start_column !== undefined ? { startColumn: action.start_column } : {}),
      ...(action.query !== undefined ? { query: action.query } : {}), ...(signal ? { signal } : {}),
    }),
    writeSpill: (_name, content) => `babel-artifact://${registerRunOutput({ runDir,
      owner: requireOwner(), content, tool, callId }).id}`,
  }
}

/** The normal dispatcher owns admission and terminal error handling. */
export function executeReadArtifactAction(input: {
  host: ChatEngineActionExecutorHost; action: ArtifactAction; access: RunArtifactAccess
  callbacks: ChatCallbacks; meta: { index: number; idempotencyKey?: string }; toolId: number
  ownerGeneration: number; signal?: AbortSignal
}): { index: number; observation: string } {
  const { host, action, meta, callbacks, toolId } = input
  host.persistToolStartedAtExecutorDispatch(action, meta)
  const observation = input.access.read(action, input.signal)
  if (!host.isSubmissionCurrent(input.ownerGeneration)) return host.settleStaleActionResult(
    'read_artifact', action.artifact_id, meta.index, 'artifact owner replaced',
  )
  host.toolCallLog.push({ tool: 'read_artifact', target: action.artifact_id,
    index: meta.index, exit_code: 0, detail: 'registered task output' })
  callbacks.onToolComplete?.(toolId, 'registered task output', undefined, 0)
  return { index: meta.index, observation }
}

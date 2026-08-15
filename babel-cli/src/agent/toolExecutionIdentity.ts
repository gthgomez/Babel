/**
 * Immutable tool-execution identity for durable lifecycle correlation.
 *
 * A tool's identity is the original action index + provider/synthetic call id.
 * Completion order of parallel reads must never rewrite that identity.
 */

export interface ToolExecutionIdentity {
  batchId: string
  actionIndex: number
  toolCallId: string
  idempotencyKey: string
  toolName: string
}

export interface DurableToolLogRow {
  tool: string
  target: string
  index: number
  detail?: string
  error?: string
  exit_code?: number
  stdout?: string
  stderr?: string
}

export interface DurableToolCallProjection {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface DurableToolResultProjection {
  tool_call_id: string
  tool_name: string
  content: string
  target: string
  exit_code?: number
  contentHash?: string
  action_index: number
  batch_id: string
  identity: ToolExecutionIdentity
}

export interface DurableToolBatchProjection {
  batchId: string
  toolCalls: DurableToolCallProjection[]
  results: DurableToolResultProjection[]
  parallelCompletionReorders: number
}

export function resolveActionToolCallId(input: {
  actionIndex: number
  turn: number
  providerToolCallIds?: ReadonlyArray<string | undefined>
  streamNativeToolCallIds?: ReadonlyArray<string | undefined>
}): string {
  const fromProvider = input.providerToolCallIds?.[input.actionIndex]
  if (fromProvider) return fromProvider
  const fromStream = input.streamNativeToolCallIds?.[input.actionIndex]
  if (fromStream) return fromStream
  return `tool_call_${input.turn}_${input.actionIndex}`
}

/** Count how many log rows appear before a lower original action index. */
export function countParallelCompletionReorders(
  turnSlice: ReadonlyArray<DurableToolLogRow>,
): number {
  let reorders = 0
  for (let i = 0; i < turnSlice.length; i++) {
    for (let j = i + 1; j < turnSlice.length; j++) {
      if (turnSlice[i]!.index > turnSlice[j]!.index) reorders += 1
    }
  }
  return reorders
}

/**
 * Project durable proposal/terminal identities from the observability log.
 *
 * Always key IDs by each row's original `index`, never by slice position.
 * The positional reconstruction is retained only as a documented anti-pattern
 * for regression tests (`projectDurableToolBatchBySlicePosition`).
 */
export function projectDurableToolBatch(input: {
  turnSlice: ReadonlyArray<DurableToolLogRow>
  actions?: ReadonlyArray<Record<string, unknown>>
  turn: number
  batchId?: string
  providerToolCallIds?: ReadonlyArray<string | undefined>
  streamNativeToolCallIds?: ReadonlyArray<string | undefined>
  contentHashFor?: (toolName: string, content: string) => string | undefined
}): DurableToolBatchProjection {
  const batchId = input.batchId ?? `batch_${input.turn}`
  const toolCalls: DurableToolCallProjection[] = []
  const results: DurableToolResultProjection[] = []

  for (const row of input.turnSlice) {
    const actionIndex = row.index
    const toolCallId = resolveActionToolCallId({
      actionIndex,
      turn: input.turn,
      ...(input.providerToolCallIds ? { providerToolCallIds: input.providerToolCallIds } : {}),
      ...(input.streamNativeToolCallIds
        ? { streamNativeToolCallIds: input.streamNativeToolCallIds }
        : {}),
    })
    const action = input.actions?.[actionIndex]
    const argsObj: Record<string, unknown> = action
      ? Object.fromEntries(Object.entries(action).filter(([key]) => key !== 'type'))
      : { target: row.target }
    const content = row.stdout ?? row.stderr ?? row.detail ?? ''
    const identity: ToolExecutionIdentity = {
      batchId,
      actionIndex,
      toolCallId,
      idempotencyKey: toolCallId,
      toolName: row.tool,
    }
    toolCalls.push({
      id: toolCallId,
      type: 'function',
      function: { name: row.tool, arguments: JSON.stringify(argsObj) },
    })
    const hashed = input.contentHashFor?.(row.tool, content)
    results.push({
      tool_call_id: toolCallId,
      tool_name: row.tool,
      content,
      target: row.target,
      ...(row.exit_code !== undefined ? { exit_code: row.exit_code } : {}),
      ...(hashed !== undefined ? { contentHash: hashed } : {}),
      action_index: actionIndex,
      batch_id: batchId,
      identity,
    })
  }

  return {
    batchId,
    toolCalls,
    results,
    parallelCompletionReorders: countParallelCompletionReorders(input.turnSlice),
  }
}

/**
 * Historical (buggy) projection: treat slice position as the action index.
 * Kept only so tests can prove the incident topology fails the lifecycle validator.
 */
export function projectDurableToolBatchBySlicePosition(input: {
  turnSlice: ReadonlyArray<DurableToolLogRow>
  turn: number
  providerToolCallIds?: ReadonlyArray<string | undefined>
  streamNativeToolCallIds?: ReadonlyArray<string | undefined>
}): DurableToolBatchProjection {
  const fakeRows = input.turnSlice.map((row, position) => ({ ...row, index: position }))
  return projectDurableToolBatch({
    turnSlice: fakeRows,
    turn: input.turn,
    ...(input.providerToolCallIds ? { providerToolCallIds: input.providerToolCallIds } : {}),
    ...(input.streamNativeToolCallIds
      ? { streamNativeToolCallIds: input.streamNativeToolCallIds }
      : {}),
  })
}

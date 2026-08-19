/**
 * Durable tool-call identity: pair results to the original request/action
 * index, never to completion-order array position.
 *
 * ChatEngine's live path is `projectDurableToolBatch` / `resolveActionToolCallId`.
 * These helpers wrap that shipped implementation so tests drive the same code.
 */

import {
  projectDurableToolBatch,
  resolveActionToolCallId,
} from '../toolExecutionIdentity.js'

export interface IndexedToolResult {
  index: number
  tool: string
  target?: string
  content?: string
  exit_code?: number
  error?: string
}

export interface PairedToolResult<T extends IndexedToolResult = IndexedToolResult> {
  actionIndex: number
  toolCallId: string
  result: T
}

/**
 * Resolve the durable id for an original action index.
 *
 * Provider/stream ids are indexed by the request order they were announced,
 * which matches action index — not the order completions arrive.
 */
export function resolveDurableToolCallId(input: {
  actionIndex: number
  providerIds?: readonly (string | undefined)[]
  streamIds?: readonly (string | undefined)[]
  turn: number
}): string {
  return resolveActionToolCallId({
    actionIndex: input.actionIndex,
    turn: input.turn,
    ...(input.providerIds ? { providerToolCallIds: input.providerIds } : {}),
    ...(input.streamIds ? { streamNativeToolCallIds: input.streamIds } : {}),
  })
}

/**
 * Pair completion-order results back to original request identity.
 */
export function pairToolResultsByActionIdentity<T extends IndexedToolResult>(
  results: readonly T[],
  resolveId: (actionIndex: number) => string,
): Array<PairedToolResult<T>> {
  return [...results]
    .sort((a, b) => a.index - b.index)
    .map((result) => ({
      actionIndex: result.index,
      toolCallId: resolveId(result.index),
      result,
    }))
}

/**
 * Replay/rebuild check: every durable result stays paired with its
 * original provider call after completions arrive in reverse order.
 */
export function rebuildPairedToolTurn(input: {
  requests: Array<{ actionIndex: number; providerId: string; tool: string; target?: string }>
  completionsInArrivalOrder: Array<{ actionIndex: number; content: string; exit_code?: number }>
  turn: number
}): {
  paired: Array<PairedToolResult<IndexedToolResult>>
  providerById: Map<string, string>
  lifecycleOk: boolean
} {
  const providerIds: string[] = []
  for (const req of input.requests) {
    providerIds[req.actionIndex] = req.providerId
  }
  const results: IndexedToolResult[] = input.completionsInArrivalOrder.map((c) => {
    const req = input.requests.find((r) => r.actionIndex === c.actionIndex)
    return {
      index: c.actionIndex,
      tool: req?.tool ?? 'unknown',
      target: req?.target ?? '',
      content: c.content,
      ...(c.exit_code !== undefined ? { exit_code: c.exit_code } : {}),
    }
  })
  const projected = projectDurableToolBatch({
    turnSlice: results.map((r) => ({
      tool: r.tool,
      target: r.target ?? '',
      index: r.index,
      ...(r.content !== undefined ? { stdout: r.content } : {}),
      ...(r.exit_code !== undefined ? { exit_code: r.exit_code } : {}),
    })),
    turn: input.turn,
    providerToolCallIds: providerIds,
  })
  const paired = pairToolResultsByActionIdentity(results, (actionIndex) => {
    const hit = projected.results.find((r) => r.action_index === actionIndex)
    return hit?.tool_call_id ?? resolveDurableToolCallId({ actionIndex, providerIds, turn: input.turn })
  })
  const providerById = new Map<string, string>()
  for (const p of paired) {
    providerById.set(p.toolCallId, p.result.tool)
  }
  const lifecycleOk =
    paired.length === input.requests.length &&
    paired.every((p) => {
      const req = input.requests.find((r) => r.actionIndex === p.actionIndex)
      return req !== undefined && p.toolCallId === req.providerId && p.result.tool === req.tool
    })
  return { paired, providerById, lifecycleOk }
}

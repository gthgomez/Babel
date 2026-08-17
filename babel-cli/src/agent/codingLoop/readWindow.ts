/**
 * Range-aware file-read window selection and injection-dedupe keys.
 *
 * Cache keys are path + requested range, never path-only. A prior full read
 * of unchanged bytes must not suppress a different range request.
 */

import { normalizeReadCacheKey } from '../readThrashPolicy.js'

/** Default first-window size when the model asks for an unbounded full read. */
export const DEFAULT_READ_WINDOW_LINES = 200

export type ReadRangeRequest =
  | { kind: 'full' }
  | { kind: 'range'; startLine: number; endLine: number }

export interface ReadWindow {
  startLine: number
  endLine: number
  totalLines: number
  lines: string[]
  numberedText: string
  truncated: boolean
  remainingBefore: number
  remainingAfter: number
}

export interface ReadCacheEntry {
  hash: string
  timestamp: number
  requestKey: string
}

export type ReadInjectionCache = Map<string, ReadCacheEntry>

export interface ReadInjectionDecision {
  skip: boolean
  reason: 'miss' | 'identical_full_served' | 'identical_range_served' | 'hash_changed'
  cacheKey: string
}

/**
 * Build a stable injection key from a normalized path and the requested window.
 *
 * @param pathKey - already-normalized path (see normalizeReadCacheKey)
 * @param request - full file or explicit line range
 */
export function makeReadInjectionKey(pathKey: string, request: ReadRangeRequest): string {
  if (request.kind === 'full') return `${pathKey}::full`
  const start = Math.max(1, Math.floor(request.startLine))
  const end = Math.max(start, Math.floor(request.endLine))
  return `${pathKey}::${start}-${end}`
}

/**
 * Normalize a project path for the read-injection cache.
 */
export function readPathKey(filePath: string, projectRoot?: string): string {
  return normalizeReadCacheKey(filePath, projectRoot)
}

/**
 * Select a documented line window from file text.
 *
 * Unbounded full reads of large files return only the first
 * `maxLines` and name what remains. Explicit ranges always return
 * every requested line when the start is in range — `maxLines` is
 * never applied to a range request. `truncated` means the returned
 * window is shorter than what was asked for, not that more file
 * exists outside a fully served range.
 */
export function selectReadWindow(
  content: string,
  request: ReadRangeRequest,
  opts?: { maxLines?: number },
): ReadWindow {
  const rawLines = splitFileLines(content)
  const totalLines = rawLines.length
  const maxLines = opts?.maxLines ?? DEFAULT_READ_WINDOW_LINES

  let startLine: number
  let endLine: number
  let truncated: boolean
  if (request.kind === 'range') {
    const requestedStart = Math.max(1, Math.floor(request.startLine))
    const requestedEnd = Math.max(requestedStart, Math.floor(request.endLine))
    startLine = requestedStart
    if (startLine > totalLines) {
      return {
        startLine,
        endLine: startLine - 1,
        totalLines,
        lines: [],
        numberedText: '',
        truncated: true,
        remainingBefore: totalLines,
        remainingAfter: 0,
      }
    }
    // Never cap an explicit range to DEFAULT_READ_WINDOW_LINES.
    endLine = Math.min(requestedEnd, totalLines)
    truncated = endLine < requestedEnd
  } else {
    startLine = 1
    endLine = Math.min(totalLines, maxLines)
    truncated = endLine < totalLines
  }

  const lines = rawLines.slice(startLine - 1, endLine)
  const numberedText = lines
    .map((line, i) => `${startLine + i}:${line}`)
    .join('\n')
  const remainingBefore = startLine - 1
  const remainingAfter = Math.max(0, totalLines - endLine)

  return {
    startLine,
    endLine,
    totalLines,
    lines,
    numberedText,
    truncated,
    remainingBefore,
    remainingAfter,
  }
}

/**
 * Describe the returned window and what remains for the model.
 */
export function formatReadWindowBanner(target: string, window: ReadWindow): string {
  const range = `${window.startLine}-${window.endLine}`
  const around: string[] = []
  if (window.remainingBefore > 0) around.push(`${window.remainingBefore} lines before`)
  if (window.remainingAfter > 0) around.push(`${window.remainingAfter} lines after`)
  const aroundText = around.length > 0 ? around.join(', ') : ''

  if (!window.truncated && aroundText.length === 0) {
    return `returned lines ${range} of ${window.totalLines} (complete file)`
  }
  if (!window.truncated) {
    return (
      `returned requested lines ${range} of ${window.totalLines} in full` +
      ` (${aroundText} remain; use read_range to inspect them)`
    )
  }
  return (
    `returned lines ${range} of ${window.totalLines}` +
    (aroundText ? ` (${aroundText} remain; use read_range to inspect them)` : ' (requested range clipped)')
  )
}

/**
 * Model-facing observation for a successful windowed read.
 */
export function formatReadObservation(
  tool: string,
  target: string,
  window: ReadWindow,
): string {
  const banner = formatReadWindowBanner(target, window)
  const body = window.numberedText.length > 0 ? window.numberedText : '(empty window)'
  return [
    `### ${tool} ${target} ${window.startLine}-${window.endLine}`,
    `exit_code: 0`,
    banner,
    '```',
    body,
    '```',
  ].join('\n')
}

/**
 * Decide whether a requested read may skip re-injection.
 *
 * Identical full reads of unchanged bytes may skip. Range requests never
 * skip merely because a prior read of the same path hashed equal.
 */
export function decideReadInjection(input: {
  pathKey: string
  fileHash: string
  request: ReadRangeRequest
  cache: ReadInjectionCache
}): ReadInjectionDecision {
  const cacheKey = makeReadInjectionKey(input.pathKey, input.request)
  const cached = input.cache.get(cacheKey)
  if (!cached) {
    return { skip: false, reason: 'miss', cacheKey }
  }
  if (cached.hash !== input.fileHash) {
    return { skip: false, reason: 'hash_changed', cacheKey }
  }
  return {
    skip: true,
    reason: input.request.kind === 'full' ? 'identical_full_served' : 'identical_range_served',
    cacheKey,
  }
}

/**
 * Record that a request was served so a later identical request may skip.
 */
export function rememberReadInjection(
  cache: ReadInjectionCache,
  cacheKey: string,
  fileHash: string,
  now = Date.now(),
): void {
  cache.set(cacheKey, { hash: fileHash, timestamp: now, requestKey: cacheKey })
}

/**
 * Drop every cached window for a path after the file is mutated.
 */
export function invalidateReadCacheForPath(
  cache: ReadInjectionCache,
  pathKey: string,
): void {
  const prefix = `${pathKey}::`
  for (const key of [...cache.keys()]) {
    if (key === pathKey || key.startsWith(prefix)) {
      cache.delete(key)
    }
  }
}

/**
 * Evaluate a read against cache + content. This is the function ChatEngine
 * calls so tests drive the shipped path.
 */
export function evaluateReadRequest(input: {
  pathKey: string
  fileHash: string
  content: string
  request: ReadRangeRequest
  cache: ReadInjectionCache
  maxLines?: number
  now?: number
}): {
  decision: ReadInjectionDecision
  window: ReadWindow
} {
  const decision = decideReadInjection(input)
  const window = selectReadWindow(input.content, input.request, {
    ...(input.maxLines !== undefined ? { maxLines: input.maxLines } : {}),
  })
  if (!decision.skip) {
    rememberReadInjection(input.cache, decision.cacheKey, input.fileHash, input.now)
  }
  return { decision, window }
}

function splitFileLines(content: string): string[] {
  if (content.length === 0) return ['']
  return content.split(/\r?\n/)
}

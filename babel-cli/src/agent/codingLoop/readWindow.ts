/**
 * Range-aware file-read window selection and injection-dedupe keys.
 *
 * Cache keys are path + requested range, never path-only. A prior full read
 * of unchanged bytes must not suppress a different range request.
 */

import { normalizeReadCacheKey } from '../readThrashPolicy.js'
import { compileObservation, formatCompiledObservation } from './observationCompiler.js'
import { open, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'

/** Default first-window size when the model asks for an unbounded full read. */
export const DEFAULT_READ_WINDOW_LINES = 200
/** Hard cap for a single explicit read_range to prevent pathological injection. */
export const EXPLICIT_RANGE_LINE_CAP = 1000
/** Bound retained selected content independently of the file's total size. */
export const READ_WINDOW_BYTE_CAP = 1024 * 1024
/** Keep a single pathological line from dominating a selected window. */
export const READ_WINDOW_LINE_BYTE_CAP = 256 * 1024

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
  requestedStartLine?: number
  requestedEndLine?: number
  nextSuggestedStartLine?: number
  nextSuggestedEndLine?: number
  byteTruncated?: boolean
  sourceBytes?: number
  returnedBytes?: number
}

export interface StreamedReadWindow {
  window: ReadWindow
  fileHash: string
  sourceBytes: number
}

/**
 * Read a line range with bounded retained memory while hashing and counting the
 * complete file. The source is re-statted through the same open descriptor so
 * a concurrent replacement or write cannot be reported as a stable snapshot.
 */
export async function readFileWindow(
  filePath: string,
  request: ReadRangeRequest,
  options: {
    signal?: AbortSignal
    maxBytes?: number
    maxLineBytes?: number
    chunkBytes?: number
    explicitRangeCap?: number
  } = {},
): Promise<StreamedReadWindow> {
  options.signal?.throwIfAborted()
  const file = await open(filePath, 'r')
  try {
    const before = await file.stat({ bigint: true })
    if (!before.isFile()) throw new Error('read_range target is not a regular file')
    const selectedStart = request.kind === 'range' ? Math.max(1, Math.floor(request.startLine)) : 1
    const requestedEnd = request.kind === 'range'
      ? Math.max(selectedStart, Math.floor(request.endLine))
      : Number.MAX_SAFE_INTEGER
    const rangeCap = options.explicitRangeCap ?? EXPLICIT_RANGE_LINE_CAP
    const selectedEnd = request.kind === 'range'
      ? Math.min(requestedEnd, selectedStart + rangeCap - 1)
      : DEFAULT_READ_WINDOW_LINES
    const maxBytes = options.maxBytes ?? READ_WINDOW_BYTE_CAP
    const maxLineBytes = options.maxLineBytes ?? READ_WINDOW_LINE_BYTE_CAP
    const hash = createHash('sha256')
    const lines: string[] = []
    let numberedBytes = 0
    let totalLines = 0
    let sourceBytes = 0
    let byteTruncated = false
    let outputCapHit = false
    let storedEndLine = selectedStart - 1
    let pending = Buffer.alloc(0)
    let pendingOverflow = false

    const keepLinePart = (part: Buffer): void => {
      const room = Math.max(0, maxLineBytes - pending.length)
      if (part.length > room) pendingOverflow = true
      if (room > 0) pending = Buffer.concat([pending, part.subarray(0, room)])
    }
    const finishLine = (): void => {
      totalLines += 1
      const selected = totalLines >= selectedStart && totalLines <= selectedEnd
      if (selected) {
        let lineBytes = pending
        if (!pendingOverflow && lineBytes.at(-1) === 0x0d) lineBytes = lineBytes.subarray(0, -1)
        let line = lineBytes.toString('utf8')
        if (pendingOverflow) {
          byteTruncated = true
          line += ' …[line clipped at byte limit]'
        }
        const row = `${totalLines}:${line}`
        const rowBytes = Buffer.byteLength(row) + (lines.length > 0 ? 1 : 0)
        if (!outputCapHit && numberedBytes + rowBytes <= maxBytes) {
          lines.push(row)
          numberedBytes += rowBytes
          storedEndLine = totalLines
        } else {
          byteTruncated = true
          outputCapHit = true
        }
      }
      pending = Buffer.alloc(0)
      pendingOverflow = false
    }

    const stream = file.createReadStream({
      autoClose: false,
      highWaterMark: options.chunkBytes ?? 64 * 1024,
      ...(options.signal ? { signal: options.signal } : {}),
    })
    for await (const chunk of stream) {
      options.signal?.throwIfAborted()
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      sourceBytes += bytes.length
      hash.update(bytes)
      let start = 0
      for (let index = 0; index < bytes.length; index += 1) {
        if (bytes[index] !== 0x0a) continue
        keepLinePart(bytes.subarray(start, index))
        finishLine()
        start = index + 1
      }
      keepLinePart(bytes.subarray(start))
    }
    if (pending.length > 0 || pendingOverflow) finishLine()

    const after = await file.stat({ bigint: true })
    const pathAfter = await stat(filePath, { bigint: true })
    if (
      before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs ||
      BigInt(sourceBytes) !== after.size || pathAfter.dev !== after.dev || pathAfter.ino !== after.ino
    ) {
      throw new Error('read_range target changed during the read')
    }

    const endLine = Math.min(storedEndLine, totalLines)
    const actualStart = lines.length > 0 ? selectedStart : selectedStart
    const numberedText = lines.join('\n')
    const clippedRange = requestedEnd > selectedEnd || requestedEnd > totalLines
    const truncated = clippedRange || byteTruncated || endLine < selectedEnd
    const remainingBefore = Math.min(totalLines, selectedStart - 1)
    const remainingAfter = Math.max(0, totalLines - endLine)
    const nextSuggestedStartLine = remainingAfter > 0 ? endLine + 1 : undefined
    const nextSuggestedEndLine = nextSuggestedStartLine !== undefined
      ? Math.min(totalLines, nextSuggestedStartLine + rangeCap - 1)
      : undefined
    const window: ReadWindow = {
      startLine: actualStart,
      endLine,
      totalLines,
      lines: lines.map((row) => row.slice(row.indexOf(':') + 1)),
      numberedText,
      truncated,
      remainingBefore,
      remainingAfter,
      ...(request.kind === 'range' ? { requestedStartLine: selectedStart, requestedEndLine: requestedEnd } : {}),
      ...(nextSuggestedStartLine !== undefined ? { nextSuggestedStartLine } : {}),
      ...(nextSuggestedEndLine !== undefined ? { nextSuggestedEndLine } : {}),
      byteTruncated,
      sourceBytes,
      returnedBytes: numberedBytes,
    }
    // Preserve empty/out-of-range behavior used by selectReadWindow.
    if (request.kind === 'range' && selectedStart > totalLines) {
      window.endLine = selectedStart - 1
      window.remainingBefore = totalLines
      window.remainingAfter = 0
      window.truncated = true
    }
    return { window, fileHash: hash.digest('hex'), sourceBytes }
  } finally {
    await file.close()
  }
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
export function makeReadInjectionKey(
  pathKey: string,
  request: ReadRangeRequest,
  contextEpoch = 0,
): string {
  const epochKey = `::epoch=${Math.max(0, Math.floor(contextEpoch))}`
  if (request.kind === 'full') return `${pathKey}::full${epochKey}`
  const start = Math.max(1, Math.floor(request.startLine))
  const end = Math.max(start, Math.floor(request.endLine))
  return `${pathKey}::${start}-${end}${epochKey}`
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
 * `maxLines` and name what remains. Explicit ranges return every
 * requested line up to `explicitRangeCap` (default 1000). `truncated`
 * means the returned window is shorter than what was asked for.
 */
export function selectReadWindow(
  content: string,
  request: ReadRangeRequest,
  opts?: { maxLines?: number; explicitRangeCap?: number },
): ReadWindow {
  const rawLines = splitFileLines(content)
  const totalLines = rawLines.length
  const maxLines = opts?.maxLines ?? DEFAULT_READ_WINDOW_LINES
  const explicitRangeCap = opts?.explicitRangeCap ?? EXPLICIT_RANGE_LINE_CAP

  let startLine: number
  let endLine: number
  let truncated: boolean
  let requestedStartLine: number | undefined
  let requestedEndLine: number | undefined
  if (request.kind === 'range') {
    const requestedStart = Math.max(1, Math.floor(request.startLine))
    const requestedEnd = Math.max(requestedStart, Math.floor(request.endLine))
    requestedStartLine = requestedStart
    requestedEndLine = requestedEnd
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
        requestedStartLine,
        requestedEndLine,
      }
    }
    const availableEnd = Math.min(requestedEnd, totalLines)
    const uncappedCount = availableEnd - startLine + 1
    if (uncappedCount > explicitRangeCap) {
      endLine = startLine + explicitRangeCap - 1
      truncated = true
    } else {
      endLine = availableEnd
      truncated = requestedEnd > totalLines
    }
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
  const nextSuggestedStartLine = remainingAfter > 0 ? endLine + 1 : undefined
  const nextSuggestedEndLine =
    nextSuggestedStartLine !== undefined
      ? Math.min(totalLines, nextSuggestedStartLine + explicitRangeCap - 1)
      : undefined

  return {
    startLine,
    endLine,
    totalLines,
    lines,
    numberedText,
    truncated,
    remainingBefore,
    remainingAfter,
    ...(requestedStartLine !== undefined ? { requestedStartLine } : {}),
    ...(requestedEndLine !== undefined ? { requestedEndLine } : {}),
    ...(nextSuggestedStartLine !== undefined ? { nextSuggestedStartLine } : {}),
    ...(nextSuggestedEndLine !== undefined ? { nextSuggestedEndLine } : {}),
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
  const nextHint =
    window.nextSuggestedStartLine !== undefined && window.nextSuggestedEndLine !== undefined
      ? `; next suggested range ${window.nextSuggestedStartLine}-${window.nextSuggestedEndLine}`
      : ''
  const explicitRequested =
    window.requestedStartLine !== undefined && window.requestedEndLine !== undefined
      ? `${window.requestedStartLine}-${window.requestedEndLine}`
      : undefined

  if (!window.truncated && aroundText.length === 0) {
    return `returned lines ${range} of ${window.totalLines} (complete file)`
  }
  if (!window.truncated) {
    return (
      `returned requested lines ${range} of ${window.totalLines} in full` +
      ` (${aroundText} remain; use read_range to inspect them)`
    )
  }
  if (explicitRequested && explicitRequested !== range) {
    return (
      `requested range ${explicitRequested}; returned range ${range} of ${window.totalLines}` +
      (aroundText ? ` (${aroundText} remain${nextHint})` : ` (requested range clipped${nextHint})`)
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
  completeness?: {
    complete: boolean;
    original_bytes: number;
    returned_bytes: number;
  },
): string {
  const banner =
    window.byteTruncated
      ? `returned lines ${window.startLine}-${window.endLine} of ${window.totalLines} (content byte-capped: ${window.returnedBytes ?? 0} of ${window.sourceBytes ?? 0} source bytes returned; one or more selected lines were clipped or omitted)`
      : completeness && !completeness.complete
        ? `returned lines ${window.startLine}-${window.endLine} of at least ${window.totalLines} (source byte-capped: ${completeness.returned_bytes} of ${completeness.original_bytes} bytes; use read_range to inspect more)`
      : formatReadWindowBanner(target, window)
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
 * Compile a failed file read with its real status and bounded output.
 *
 * @param input - failed read result and stable tool identity
 * @returns model-facing failure observation
 */
export function formatReadFailureObservation(input: {
  tool?: string
  target: string
  exitCode: number
  stdout?: string
  stderr?: string
  toolCallId?: string
  spillDir?: string
}): string {
  return formatCompiledObservation(
    compileObservation({
      tool: input.tool ?? 'read_file',
      target: input.target,
      exitCode: input.exitCode,
      stdout: input.stdout ?? '',
      stderr: input.stderr ?? '',
      ...(input.toolCallId !== undefined ? { toolCallId: input.toolCallId } : {}),
      ...(input.spillDir !== undefined ? { spillDir: input.spillDir } : {}),
    }),
  )
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
  contextEpoch?: number
}): ReadInjectionDecision {
  const cacheKey = makeReadInjectionKey(input.pathKey, input.request, input.contextEpoch)
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
  contextEpoch?: number
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
  const lines = content.split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()
  return lines
}

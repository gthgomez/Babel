/**
 * Unique-location edit apply: exact → unique whitespace-normalized → reject
 * ambiguity. Preserves line endings and a leading BOM. Surfaces the actual
 * changed range as a model-visible diff.
 */

export type LineEnding = 'lf' | 'crlf' | 'cr'

export interface EditApplySuccess {
  ok: true
  content: string
  startLine: number
  endLine: number
  matchKind: 'exact' | 'line_trim' | 'whitespace_normalized'
  diff: string
  lineEnding: LineEnding
}

export interface EditApplyFailure {
  ok: false
  reason: 'not_found' | 'ambiguous' | 'empty_old_str'
  message: string
  matchCount: number
}

export type EditApplyResult = EditApplySuccess | EditApplyFailure

/**
 * Apply old → new at a unique location, or fail explicitly.
 */
export function applyUniqueEdit(input: {
  content: string
  oldStr: string
  newStr: string
}): EditApplyResult {
  const oldStr = input.oldStr
  const newStr = input.newStr
  if (oldStr.length === 0) {
    return {
      ok: false,
      reason: 'empty_old_str',
      message: 'str_replace: old_str is empty',
      matchCount: 0,
    }
  }

  const bom = input.content.startsWith('\uFEFF') ? '\uFEFF' : ''
  const body = bom ? input.content.slice(1) : input.content
  const lineEnding = detectLineEnding(body)
  const normalizedOld = normalizeToLf(oldStr)
  const normalizedNew = normalizeToLf(newStr)
  const normalizedBody = normalizeToLf(body)

  const exact = locateExact(normalizedBody, normalizedOld)
  if (exact.kind === 'ambiguous') {
    return {
      ok: false,
      reason: 'ambiguous',
      message: `str_replace: old_str matches ${exact.count} locations — make it more specific`,
      matchCount: exact.count,
    }
  }

  let matchStart = -1
  let matchedLength = 0
  let matchKind: EditApplySuccess['matchKind'] = 'exact'
  if (exact.kind === 'unique') {
    matchStart = exact.index
    matchedLength = exact.matchedLength
    matchKind = 'exact'
  } else {
    const trimmed = locateNormalized(normalizedBody, normalizedOld, 'line_trim')
    if (trimmed.kind === 'ambiguous') {
      return {
        ok: false,
        reason: 'ambiguous',
        message: `str_replace: old_str matches ${trimmed.count} locations after line-trim — make it more specific`,
        matchCount: trimmed.count,
      }
    }
    if (trimmed.kind === 'unique') {
      matchStart = trimmed.index
      matchedLength = trimmed.matchedLength
      matchKind = 'line_trim'
    } else {
      const ws = locateNormalized(normalizedBody, normalizedOld, 'whitespace')
      if (ws.kind === 'ambiguous') {
        return {
          ok: false,
          reason: 'ambiguous',
          message: `str_replace: old_str matches ${ws.count} locations after whitespace normalize — make it more specific`,
          matchCount: ws.count,
        }
      }
      if (ws.kind === 'unique') {
        matchStart = ws.index
        matchedLength = ws.matchedLength
        matchKind = 'whitespace_normalized'
      }
    }
  }

  if (matchStart < 0) {
    return {
      ok: false,
      reason: 'not_found',
      message: 'str_replace: old_str not found in file',
      matchCount: 0,
    }
  }

  const matchEnd = matchStart + matchedLength
  const nextBody = normalizedBody.slice(0, matchStart) + normalizedNew + normalizedBody.slice(matchEnd)
  const restored = restoreLineEnding(nextBody, lineEnding)
  const startLine = lineNumberAt(normalizedBody, matchStart)
  const replacedLineCount = Math.max(1, normalizedNew.split('\n').length)
  const endLine = startLine + replacedLineCount - 1
  const diff = formatChangedRangeDiff({
    before: normalizedBody,
    after: nextBody,
    start: matchStart,
    oldLength: matchEnd - matchStart,
    newLength: normalizedNew.length,
  })

  return {
    ok: true,
    content: bom + restored,
    startLine,
    endLine,
    matchKind,
    diff,
    lineEnding,
  }
}

/**
 * Detect the dominant line ending so replacements do not convert the file.
 */
export function detectLineEnding(content: string): LineEnding {
  const crlf = (content.match(/\r\n/g) ?? []).length
  const lfOnly = (content.match(/(?<!\r)\n/g) ?? []).length
  const crOnly = (content.match(/\r(?!\n)/g) ?? []).length
  if (crlf >= lfOnly && crlf >= crOnly && crlf > 0) return 'crlf'
  if (crOnly > lfOnly && crOnly > 0) return 'cr'
  return 'lf'
}

export function formatEditObservation(
  target: string,
  result: EditApplyResult,
): string {
  if (!result.ok) {
    return `### str_replace ${target}\nError: ${result.message}`
  }
  return [
    `### str_replace ${target} (lines ${result.startLine}-${result.endLine}, ${result.matchKind})`,
    'exit_code: 0',
    'changed_range:',
    '```diff',
    result.diff,
    '```',
  ].join('\n')
}

function normalizeToLf(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

function restoreLineEnding(text: string, ending: LineEnding): string {
  if (ending === 'crlf') return text.replace(/\n/g, '\r\n')
  if (ending === 'cr') return text.replace(/\n/g, '\r')
  return text
}

type LocateHit =
  | { kind: 'unique'; index: number; matchedLength: number }
  | { kind: 'ambiguous'; count: number }
  | { kind: 'none' }

function locateExact(body: string, oldStr: string): LocateHit {
  const first = body.indexOf(oldStr)
  if (first < 0) return { kind: 'none' }
  const last = body.lastIndexOf(oldStr)
  if (last !== first) {
    let count = 0
    let idx = first
    while (idx >= 0) {
      count += 1
      idx = body.indexOf(oldStr, idx + oldStr.length)
    }
    return { kind: 'ambiguous', count }
  }
  return { kind: 'unique', index: first, matchedLength: oldStr.length }
}

function locateNormalized(
  body: string,
  oldStr: string,
  mode: 'line_trim' | 'whitespace',
): LocateHit {
  const oldNorm = normalizeBlock(oldStr, mode)
  if (!oldNorm) return { kind: 'none' }
  const hits: Array<{ index: number; matchedLength: number }> = []
  const bodyLines = body.split('\n')
  const oldLines = oldStr.split('\n')
  const window = Math.max(1, oldLines.length)

  const consider = (size: number): void => {
    if (size < 1 || size > bodyLines.length) return
    for (let i = 0; i <= bodyLines.length - size; i++) {
      const slice = bodyLines.slice(i, i + size).join('\n')
      if (normalizeBlock(slice, mode) === oldNorm) {
        hits.push({
          index: offsetOfLine(bodyLines, i),
          matchedLength: slice.length,
        })
      }
    }
  }

  consider(window)
  // Longer/shorter windows of ±1 for line-trim only when the nominal
  // window missed. The recorded length is the located slice, not oldStr.
  if (hits.length === 0 && mode === 'line_trim') {
    consider(window - 1)
    consider(window + 1)
  }
  if (hits.length === 0) return { kind: 'none' }
  if (hits.length > 1) return { kind: 'ambiguous', count: hits.length }
  return { kind: 'unique', index: hits[0]!.index, matchedLength: hits[0]!.matchedLength }
}

function normalizeBlock(text: string, mode: 'line_trim' | 'whitespace'): string {
  if (mode === 'line_trim') {
    return text
      .split('\n')
      .map((l) => l.trimEnd())
      .join('\n')
      .trim()
  }
  return text.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim()
}

function offsetOfLine(lines: string[], lineIndex: number): number {
  let offset = 0
  for (let i = 0; i < lineIndex; i++) {
    offset += (lines[i] ?? '').length + 1
  }
  return offset
}

function lineNumberAt(text: string, index: number): number {
  if (index <= 0) return 1
  return text.slice(0, index).split('\n').length
}

function formatChangedRangeDiff(input: {
  before: string
  after: string
  start: number
  oldLength: number
  newLength: number
}): string {
  const oldBlock = input.before.slice(input.start, input.start + input.oldLength)
  const newBlock = input.after.slice(input.start, input.start + input.newLength)
  const startLine = lineNumberAt(input.before, input.start)
  const oldLines = oldBlock.split('\n')
  const newLines = newBlock.split('\n')
  const header = `@@ -${startLine},${oldLines.length} +${startLine},${newLines.length} @@`
  const removed = oldLines.map((l) => `-${l}`)
  const added = newLines.map((l) => `+${l}`)
  return [header, ...removed, ...added].join('\n')
}

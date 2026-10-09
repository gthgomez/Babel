/**
 * Strict unified-diff parser + transactional hunk applier with an Aider-style
 * fallback ladder (udiff coder semantics, ported):
 *
 *   1. exact context match
 *   2. whitespace-stripped match (line-trim, then whitespace-normalized)
 *   3. fuzzy anchored apply (drop context lines around the change, port of
 *      Aider's apply_partial_hunk)
 *   4. hunk marked failed — never silently skipped
 *
 * Whole-patch semantics are transactional: any hunk hard-fails and nothing is
 * applied. Callers receive full per-hunk failure diagnostics.
 */

export type MatchStrategy = 'exact' | 'line_trim' | 'whitespace_normalized' | 'fuzzy_anchored' | 'append'

export interface PatchHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  /** Patch body lines without the leading op character. */
  lines: { op: ' ' | '-' | '+'; text: string }[]
  /** True when the hunk explicitly removes the trailing newline. */
  noNewlineAtEof: boolean
}

export interface PatchFileSection {
  oldPath: string
  newPath: string
  /** True when the section creates a file (/dev/null old path). */
  createsFile: boolean
  hunks: PatchHunk[]
}

export interface ParseSuccess {
  ok: true
  files: PatchFileSection[]
}

export interface ParseFailure {
  ok: false
  reason: 'empty_patch' | 'no_file_header' | 'bad_hunk_header' | 'bad_hunk_body' | 'hunk_count_mismatch'
  message: string
  /** 1-based line number in the patch text where the error was found. */
  lineNo: number
}

export type ParseResult = ParseSuccess | ParseFailure

export interface HunkFailure {
  file: string
  hunkIndex: number
  oldStart: number
  strategy: MatchStrategy
  reason: 'not_found' | 'ambiguous'
  message: string
}

export interface PatchApplySuccess {
  ok: true
  /** new content keyed by the patch's target path (as written in the patch). */
  results: { path: string; content: string; appliedHunks: number; strategies: MatchStrategy[] }[]
}

export interface PatchApplyFailure {
  ok: false
  failures: HunkFailure[]
  /** Diagnostic block listing every failed hunk and the lines it expected. */
  diagnostics: string
}

export type PatchApplyResult = PatchApplySuccess | PatchApplyFailure

// ── Parsing ────────────────────────────────────────────────────────────────

interface HunkHeaderCounts {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
}

export function parseHunkHeader(line: string): HunkHeaderCounts | null {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
  if (!match) return null
  // Unified diff omits ",1" for single-line ranges; a missing count means 1.
  // An explicit ",0" only appears for empty files and means 0.
  return {
    oldStart: Number(match[1]),
    oldLines: match[2] !== undefined ? Number(match[2]) : 1,
    newStart: Number(match[3]),
    newLines: match[4] !== undefined ? Number(match[4]) : 1,
  }
}

function stripTimestamp(path: string): string {
  // `--- a/file.ts\t2026-01-01 ...` → `a/file.ts`
  const tab = path.indexOf('\t')
  return tab >= 0 ? path.slice(0, tab) : path
}

function normalizePatchPath(raw: string): string | null {
  let p = stripTimestamp(raw).trim()
  if (p === '/dev/null') return null
  if (p.startsWith('a/')) p = p.slice(2)
  else if (p.startsWith('b/')) p = p.slice(2)
  return p
}

/**
 * Parse a unified diff into per-file sections. Strict: anything that is not a
 * well-formed unified diff is a parse error — never a silent guess.
 */
export function parseUnifiedDiff(patchText: string): ParseResult {
  if (patchText.trim().length === 0) {
    return { ok: false, reason: 'empty_patch', message: 'apply_patch: patch text is empty', lineNo: 1 }
  }
  const rawLines = patchText.split('\n')
  // A trailing newline produces a final empty element; drop it.
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop()

  const files: PatchFileSection[] = []
  let current: PatchFileSection | null = null
  let hunk: PatchHunk | null = null
  let seenOld = false
  let seenNew = false
  let lastPath: string | null = null

  for (let i = 0; i < rawLines.length; i++) {
    const lineNo = i + 1
    const line = rawLines[i] ?? ''

    if (hunk !== null) {
      if (line.startsWith('\\')) {
        hunk.noNewlineAtEof = true
        continue
      }
      // '--- '/'+++ ' lines are ambiguous with '-'/'+' hunk lines. When the
      // hunk's declared counts are already satisfied, a file header ends the
      // hunk; a genuine deletion/addition of a '-- ...' line can only appear
      // while counts are still open.
      if (/^(--- |\+\+\+ )/.test(line)) {
        const oldCount = hunk.lines.filter((l) => l.op === ' ' || l.op === '-').length
        const newCount = hunk.lines.filter((l) => l.op === ' ' || l.op === '+').length
        if (oldCount === hunk.oldLines && newCount === hunk.newLines) {
          hunk = null
          // fall through to header handling below
        }
      }
    }
    if (hunk !== null) {
      const op = line[0]
      if (op === ' ' || op === '-' || op === '+' || line === '') {
        // An entirely empty line inside a hunk is an empty context line
        // (common when trailing whitespace is stripped by transports).
        hunk.lines.push({ op: (op === undefined || line === '' ? ' ' : op) as ' ' | '-' | '+', text: line === '' ? '' : line.slice(1) })
        continue
      }
      // Any other line ends the hunk; validate counts before falling through.
      const countError = validateHunkCounts(hunk, lineNo)
      if (countError) return countError
      hunk = null
    }

    if (line.startsWith('--- ')) {
      // A new '---' header flushes the previous completed section (multi-file
      // patches do not always carry an intervening `diff` line).
      if (current !== null && current.hunks.length > 0) files.push(current)
      const path = normalizePatchPath(line.slice(4))
      if (path === null) {
        seenOld = true
        current = { oldPath: '', newPath: '', createsFile: true, hunks: [] }
      } else {
        seenOld = true
        current = { oldPath: path, newPath: path, createsFile: false, hunks: [] }
      }
      continue
    }
    if (line.startsWith('+++ ')) {
      if (!seenOld || current === null) {
        return {
          ok: false,
          reason: 'no_file_header',
          message: `apply_patch: '+++' header at line ${lineNo} without a preceding '---' header`,
          lineNo,
        }
      }
      const path = normalizePatchPath(line.slice(4))
      if (path !== null) {
        current.newPath = path
        if (current.oldPath === '') current.oldPath = path
      }
      seenNew = true
      continue
    }
    if (line.startsWith('@@')) {
      const counts = parseHunkHeader(line)
      if (!counts) {
        return {
          ok: false,
          reason: 'bad_hunk_header',
          message: `apply_patch: malformed hunk header at line ${lineNo}: "${line}"`,
          lineNo,
        }
      }
      if (current === null) {
        // Header-only hunks (no ---/+++) carry the previous file's path, like
        // Aider's get_edits: fall back to the last seen path.
        if (lastPath === null) {
          return {
            ok: false,
            reason: 'no_file_header',
            message: `apply_patch: hunk header at line ${lineNo} has no preceding '---'/'+++' file header`,
            lineNo,
          }
        }
        current = { oldPath: lastPath, newPath: lastPath, createsFile: false, hunks: [] }
      }
      current.hunks.push({ ...counts, lines: [], noNewlineAtEof: false })
      hunk = current.hunks[current.hunks.length - 1] ?? null
      if (current.oldPath) lastPath = current.oldPath
      continue
    }
    if (line.startsWith('diff ')) {
      // A new `diff` line flushes the previous section.
      if (current !== null && current.hunks.length > 0) files.push(current)
      current = null
      seenOld = false
      seenNew = false
      continue
    }
    if (
      line.startsWith('index ') ||
      line.startsWith('new file mode') ||
      line.startsWith('deleted file mode') ||
      line.startsWith('similarity ') ||
      line.startsWith('rename from') ||
      line.startsWith('rename to') ||
      line.startsWith('Binary files')
    ) {
      continue
    }
    return {
      ok: false,
      reason: 'bad_hunk_body',
      message: `apply_patch: unexpected line ${lineNo} outside hunk context: "${line.slice(0, 80)}"`,
      lineNo,
    }
  }
  if (hunk !== null) {
    const countError = validateHunkCounts(hunk, rawLines.length)
    if (countError) return countError
  }
  if (current !== null && current.hunks.length > 0) files.push(current)

  if (files.length === 0) {
    return {
      ok: false,
      reason: 'no_file_header',
      message: 'apply_patch: no hunks found — patch contains no applicable file sections',
      lineNo: 1,
    }
  }
  return { ok: true, files }
}

function validateHunkCounts(hunk: PatchHunk, lineNo: number): ParseFailure | null {
  const old = hunk.lines.filter((l) => l.op === ' ' || l.op === '-').length
  const neu = hunk.lines.filter((l) => l.op === ' ' || l.op === '+').length
  if (old !== hunk.oldLines || neu !== hunk.newLines) {
    return {
      ok: false,
      reason: 'hunk_count_mismatch',
      message:
        `apply_patch: hunk at line ${lineNo} declares -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} ` +
        `but body contains ${old} old / ${neu} new lines`,
      lineNo,
    }
  }
  return null
}

// ── Line comparison levels ─────────────────────────────────────────────────

function lineTrim(s: string): string {
  return s.trim()
}

function whitespaceNormalized(s: string): string {
  return s.trim().replace(/\s+/g, ' ')
}

function makeComparator(strategy: 'exact' | 'line_trim' | 'whitespace_normalized'): (a: string, b: string) => boolean {
  if (strategy === 'exact') return (a, b) => a === b
  if (strategy === 'line_trim') return (a, b) => lineTrim(a) === lineTrim(b)
  return (a, b) => whitespaceNormalized(a) === whitespaceNormalized(b)
}

// ── Location ───────────────────────────────────────────────────────────────

interface LocateResult {
  kind: 'found'
  index: number
  strategy: 'exact' | 'line_trim' | 'whitespace_normalized'
}
interface LocateMiss {
  kind: 'not_found'
  strategy: 'exact' | 'line_trim' | 'whitespace_normalized'
}
interface LocateAmbiguous {
  kind: 'ambiguous'
  count: number
  strategy: 'exact' | 'line_trim' | 'whitespace_normalized'
}

function locateSequence(
  contentLines: string[],
  seq: string[],
  strategy: 'exact' | 'line_trim' | 'whitespace_normalized',
  hintIndex: number,
): LocateResult | LocateMiss | LocateAmbiguous {
  if (seq.length === 0) return { kind: 'found', index: hintIndex, strategy }
  const cmp = makeComparator(strategy)
  const matches: number[] = []
  // Prefer the declared hunk position: scan an expanding window around the
  // hint first, then the remainder of the file. Uniqueness is still global.
  const maxOffset = Math.max(contentLines.length, hintIndex + seq.length)
  for (let offset = 0; offset <= maxOffset; offset++) {
    for (const start of offset === 0 ? [hintIndex] : [hintIndex - offset, hintIndex + offset]) {
      if (start < 0 || start + seq.length > contentLines.length) continue
      if (matches.includes(start)) continue
      let ok = true
      for (let i = 0; i < seq.length; i++) {
        if (!cmp(contentLines[start + i] ?? '', seq[i] ?? '')) {
          ok = false
          break
        }
      }
      if (ok) matches.push(start)
    }
    // Early exit only for the hinted hit: once we have a match at the declared
    // position and full-file scan is still required for uniqueness, continue.
  }
  if (matches.length === 1) return { kind: 'found', index: matches[0] ?? 0, strategy }
  if (matches.length > 1) return { kind: 'ambiguous', count: matches.length, strategy }
  return { kind: 'not_found', strategy }
}

// ── Hunk application ───────────────────────────────────────────────────────

function beforeLines(hunk: PatchHunk): string[] {
  return hunk.lines.filter((l) => l.op === ' ' || l.op === '-').map((l) => l.text)
}

function afterLines(hunk: PatchHunk): string[] {
  return hunk.lines.filter((l) => l.op === ' ' || l.op === '+').map((l) => l.text)
}

interface Section {
  preceding: { op: ' ' | '-'; text: string }[]
  changes: { op: ' ' | '-' | '+'; text: string }[]
  following: { op: ' ' | '-'; text: string }[]
}

function splitSections(hunk: PatchHunk): Section {
  const lines = hunk.lines
  let firstChange = lines.findIndex((l) => l.op !== ' ')
  if (firstChange < 0) firstChange = lines.length
  let lastChange = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]
    if (l && l.op !== ' ') {
      lastChange = i
      break
    }
  }
  return {
    preceding: lines.slice(0, firstChange).filter((l): l is { op: ' '; text: string } => l?.op === ' '),
    changes: lines.slice(firstChange, lastChange + 1),
    following: lines
      .slice(lastChange + 1)
      .filter((l): l is { op: ' '; text: string } => l?.op === ' '),
  }
}

export interface HunkApplyOutcome {
  ok: true
  content: string
  strategy: MatchStrategy
}
export interface HunkApplyFail {
  ok: false
  reason: 'not_found' | 'ambiguous'
  strategy: MatchStrategy
  message: string
}

export type HunkApplyResult = HunkApplyOutcome | HunkApplyFail

/**
 * Apply one hunk to file content using the fallback ladder. Ported from
 * Aider's udiff coder: directly_apply_hunk (exact → whitespace-flexible) then
 * apply_partial_hunk (progressively drop context lines).
 */
export function applyHunk(content: string, hunk: PatchHunk): HunkApplyResult {
  const lineEnding = content.includes('\r\n') ? '\r\n' : '\n'
  const bom = content.startsWith('\uFEFF') ? '\uFEFF' : ''
  const body = bom ? content.slice(1) : content
  const trailingNewline = body.endsWith('\n') || body.length === 0
  const contentLines = body.length === 0 ? [] : body.replace(/\n$/, '').split('\n')
  const hint = Math.max(0, hunk.oldStart - 1)

  const before = beforeLines(hunk)
  const after = afterLines(hunk)

  // New-file / append semantics (Aider do_replace: empty before → append).
  if (before.every((l) => l.trim() === '') && hunk.oldStart === 0) {
    const newContent = joinLines(after, lineEnding, trailingNewline && !hunk.noNewlineAtEof)
    return { ok: true, content: bom + newContent, strategy: 'append' }
  }

  // Ladder levels 1–2: full before-sequence match at decreasing strictness.
  for (const strategy of ['exact', 'line_trim', 'whitespace_normalized'] as const) {
    const located = locateSequence(contentLines, before, strategy, hint)
    if (located.kind === 'found') {
      const newLines = [...contentLines]
      newLines.splice(located.index, before.length, ...after)
      return {
        ok: true,
        content: bom + joinLines(newLines, lineEnding, trailingNewline && !hunk.noNewlineAtEof),
        strategy,
      }
    }
    if (located.kind === 'ambiguous') {
      return {
        ok: false,
        reason: 'ambiguous',
        strategy,
        message: `hunk @@ -${hunk.oldStart},${hunk.oldLines} matches ${located.count} locations after ${strategy} comparison — add context to disambiguate`,
      }
    }
  }

  // Level 3: fuzzy anchored apply — drop context lines (Aider
  // apply_partial_hunk). Requires a unique match of the reduced sequence.
  if (before.some((l) => l.trim() !== '')) {
    const section = splitSections(hunk)
    const lenPrec = section.preceding.length
    const lenFoll = section.following.length
    const useAll = lenPrec + lenFoll
    for (let drop = 0; drop <= useAll; drop++) {
      const use = useAll - drop
      for (let usePrec = Math.min(lenPrec, use); usePrec >= 0; usePrec--) {
        const useFoll = use - usePrec
        if (useFoll < 0 || useFoll > lenFoll) continue
        if (usePrec === 0 && useFoll === 0 && before.every((l) => l.trim() === '')) continue
        const prec = section.preceding.slice(lenPrec - usePrec).map((l) => l.text)
        const foll = section.following.slice(0, useFoll).map((l) => l.text)
        const reducedBefore = [...prec, ...section.changes.filter((l) => l.op !== '+').map((l) => l.text), ...foll]
        const reducedAfter = [...prec, ...section.changes.filter((l) => l.op !== '-').map((l) => l.text), ...foll]
        for (const strategy of ['exact', 'line_trim'] as const) {
          const located = locateSequence(contentLines, reducedBefore, strategy, hint)
          if (located.kind === 'found') {
            const newLines = [...contentLines]
            newLines.splice(located.index, reducedBefore.length, ...reducedAfter)
            return {
              ok: true,
              content: bom + joinLines(newLines, lineEnding, trailingNewline && !hunk.noNewlineAtEof),
              strategy: 'fuzzy_anchored',
            }
          }
          if (located.kind === 'ambiguous') {
            return {
              ok: false,
              reason: 'ambiguous',
              strategy: 'fuzzy_anchored',
              message: `hunk @@ -${hunk.oldStart},${hunk.oldLines} reduced form matches ${located.count} locations — add context to disambiguate`,
            }
          }
        }
      }
    }
  }

  return {
    ok: false,
    reason: 'not_found',
    strategy: 'fuzzy_anchored',
    message:
      `hunk @@ -${hunk.oldStart},${hunk.oldLines} does not apply: these ` +
      `${before.length} lines are not present (exact, whitespace-stripped, or fuzzy-anchored):\n${before.map((l) => ' ' + l).join('\n')}`,
  }
}

function joinLines(lines: string[], lineEnding: string, trailingNewline: boolean): string {
  const joined = lines.join(lineEnding)
  return trailingNewline && lines.length > 0 ? joined + lineEnding : joined
}

// ── Whole-file / whole-patch application ───────────────────────────────────

export interface PreparedFileContent {
  path: string
  originalContent: string
}

/**
 * Apply a parsed patch to in-memory file contents. Transactional: if any hunk
 * fails, nothing is applied and full diagnostics are returned.
 */
export function applyPatchInMemory(
  files: PatchFileSection[],
  readContent: (path: string) => string,
): PatchApplyResult {
  const failures: HunkFailure[] = []
  const results: { path: string; content: string; appliedHunks: number; strategies: MatchStrategy[] }[] = []

  for (const file of files) {
    const path = file.newPath || file.oldPath
    const content = readContent(path)
    let current = content
    const strategies: MatchStrategy[] = []
    for (let h = 0; h < file.hunks.length; h++) {
      const hunk = file.hunks[h]
      if (!hunk) continue
      const outcome = applyHunk(current, hunk)
      if (!outcome.ok) {
        failures.push({
          file: path,
          hunkIndex: h,
          oldStart: hunk.oldStart,
          strategy: outcome.strategy,
          reason: outcome.reason,
          message: outcome.message,
        })
        continue
      }
      current = outcome.content
      strategies.push(outcome.strategy)
    }
    results.push({ path, content: current, appliedHunks: strategies.length, strategies })
  }

  if (failures.length > 0) {
    const diagnostics = failures
      .map(
        (f) =>
          `HUNK FAILED (not applied): ${f.file} hunk #${f.hunkIndex + 1} (@@ -${f.oldStart}) via ${f.strategy}: ${f.reason}\n${f.message}`,
      )
      .join('\n\n')
    return { ok: false, failures, diagnostics }
  }
  return { ok: true, results }
}

// ── Reverse patch (for round-trip verification) ────────────────────────────

/** Build the patch that undoes `patchText`: swaps paths and -/+ operations. */
export function reverseParsedPatch(files: PatchFileSection[]): PatchFileSection[] {
  return files.map((file) => ({
    oldPath: file.newPath,
    newPath: file.oldPath,
    createsFile: false,
    hunks: file.hunks.map((hunk) => ({
      oldStart: hunk.newStart,
      oldLines: hunk.newLines,
      newStart: hunk.oldStart,
      newLines: hunk.oldLines,
      noNewlineAtEof: hunk.noNewlineAtEof,
      lines: hunk.lines.map((l) => ({ op: l.op === '-' ? ('+' as const) : l.op === '+' ? ('-' as const) : l.op, text: l.text })),
    })),
  }))
}

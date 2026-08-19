/**
 * Canonical model-facing observation compiler for shell/test/compiler tools.
 *
 * Stdout and stderr stay independent. Long output keeps a useful tail plus a
 * model-reachable raw spill. Parsers are best-effort and never fatal.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'

export const OBSERVATION_HEAD_CHARS = 1800
export const OBSERVATION_TAIL_CHARS = 1800
export const OBSERVATION_SPILL_THRESHOLD = 2400

export interface CompiledFailure {
  test?: string
  file?: string
  line?: number
  column?: number
  message: string
  parser: string
}

export interface CompiledObservation {
  tool: string
  target: string
  command?: string
  cwd?: string
  exitCode: number
  stdoutPresent: boolean
  stderrPresent: boolean
  stdoutHead: string
  stdoutTail: string
  stderrHead: string
  stderrTail: string
  failures: CompiledFailure[]
  parserName?: string
  rawSpillPath?: string
  summary: string
}

export interface CompileObservationInput {
  tool: string
  target: string
  command?: string
  cwd?: string
  exitCode: number
  stdout?: string
  stderr?: string
  toolCallId?: string
  spillDir?: string
  writeSpill?: (name: string, content: string) => string
  /** When true, do not persist a model-readable raw spill. */
  denyRawSpill?: boolean
}

/**
 * Compile a tool result into structured, model-visible evidence.
 */
export function compileObservation(input: CompileObservationInput): CompiledObservation {
  const stdout = input.stdout ?? ''
  const stderr = input.stderr ?? ''
  const stdoutPresent = stdout.trim().length > 0
  const stderrPresent = stderr.trim().length > 0
  const combined = buildRawRecord(input.command ?? input.target, input.exitCode, stdout, stderr)
  const parsed = parseStructuredFailures(stdout, stderr, input.tool, input.command ?? input.target)
  const spillPath = persistSpillIfNeeded(input, combined)

  const stdoutParts = splitHeadTail(stdout)
  const stderrParts = splitHeadTail(stderr)
  const summary = buildSummary(input.exitCode, parsed.failures, stdoutPresent, stderrPresent)

  return {
    tool: input.tool,
    target: input.target,
    ...(input.command !== undefined ? { command: input.command } : {}),
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    exitCode: input.exitCode,
    stdoutPresent,
    stderrPresent,
    stdoutHead: stdoutParts.head,
    stdoutTail: stdoutParts.tail,
    stderrHead: stderrParts.head,
    stderrTail: stderrParts.tail,
    failures: parsed.failures,
    ...(parsed.parserName !== undefined ? { parserName: parsed.parserName } : {}),
    ...(spillPath !== undefined ? { rawSpillPath: spillPath } : {}),
    summary,
  }
}

/**
 * Render a compiled observation for the model. Never drops stderr because
 * stdout exists. Long streams include both head and tail.
 */
export function formatCompiledObservation(compiled: CompiledObservation): string {
  const lines: string[] = [
    `### ${compiled.tool} ${compiled.target}`,
    `exit_code: ${compiled.exitCode}`,
    `summary: ${compiled.summary}`,
  ]
  if (compiled.command) lines.push(`command: ${compiled.command}`)
  if (compiled.cwd) lines.push(`cwd: ${compiled.cwd}`)
  if (compiled.parserName) lines.push(`parser: ${compiled.parserName}`)
  if (compiled.failures.length > 0) {
    lines.push('failures:')
    for (const failure of compiled.failures.slice(0, 12)) {
      const loc = [failure.file, failure.line].filter((v) => v !== undefined).join(':')
      const test = failure.test ? ` ${failure.test}` : ''
      lines.push(`  - [${failure.parser}]${loc ? ` ${loc}` : ''}${test}: ${failure.message}`)
    }
  }
  appendStream(lines, 'stdout', compiled.stdoutPresent, compiled.stdoutHead, compiled.stdoutTail)
  appendStream(lines, 'stderr', compiled.stderrPresent, compiled.stderrHead, compiled.stderrTail)
  if (compiled.rawSpillPath) {
    lines.push(`raw_output: ${compiled.rawSpillPath}`)
    lines.push('(read or grep the raw_output path for the full lossless record)')
  }
  return lines.join('\n')
}

/**
 * Compact verifier receipt summary: identity + meaningful result, not a 200-char prefix.
 */
export function formatVerifierReceiptSummary(input: {
  verifierId: string
  command: string
  exitCode: number
  stdout?: string
  stderr?: string
}): string {
  const compiled = compileObservation({
    tool: 'verifier',
    target: input.command,
    command: input.command,
    exitCode: input.exitCode,
    stdout: input.stdout ?? '',
    stderr: input.stderr ?? '',
  })
  const status = input.exitCode === 0 ? 'green' : 'red'
  const failBits = compiled.failures
    .slice(0, 5)
    .map((f) => f.test ?? f.message)
    .join('; ')
  const parts = [
    `verifier_id: ${input.verifierId}`,
    `status: ${status}`,
    `exit_code: ${input.exitCode}`,
    `summary: ${compiled.summary}`,
  ]
  if (failBits) parts.push(`failures: ${failBits}`)
  if (compiled.stderrPresent) {
    parts.push(`stderr_tail: ${clip(compiled.stderrTail || compiled.stderrHead, 400)}`)
  }
  if (compiled.stdoutPresent && compiled.failures.length === 0 && input.exitCode !== 0) {
    parts.push(`stdout_tail: ${clip(compiled.stdoutTail || compiled.stdoutHead, 400)}`)
  }
  return parts.join('\n')
}

export interface FailureParseResult {
  failures: CompiledFailure[]
  parserName?: string
}

/**
 * Best-effort parsers. Failure to match still leaves head+tail+spill intact.
 */
export function parseStructuredFailures(
  stdout: string,
  stderr: string,
  tool?: string,
  command?: string,
): FailureParseResult {
  const text = `${stdout}\n${stderr}`
  const cmd = `${tool ?? ''} ${command ?? ''}`

  const jest = parseJestVitest(text)
  if (jest.length > 0) return { failures: jest, parserName: 'jest_vitest' }

  const pytest = parsePytest(text)
  if (pytest.length > 0) return { failures: pytest, parserName: 'pytest' }

  const tsc = parseTsc(text)
  if (tsc.length > 0 && /tsc|typecheck|typescript/i.test(cmd + text)) {
    return { failures: tsc, parserName: 'tsc' }
  }

  const cargo = parseCargo(text)
  if (cargo.length > 0) return { failures: cargo, parserName: 'cargo' }

  const go = parseGo(text)
  if (go.length > 0) return { failures: go, parserName: 'go' }

  const node = parseNodeTrace(text)
  if (node.length > 0) return { failures: node, parserName: 'node_trace' }

  if (tsc.length > 0) return { failures: tsc, parserName: 'tsc' }

  const generic = parseGenericFileLine(text)
  if (generic.length > 0) return { failures: generic, parserName: 'generic_file_line' }

  return { failures: [] }
}

function parseJestVitest(text: string): CompiledFailure[] {
  const failures: CompiledFailure[] = []
  const failBlock = /●\s+(.+?)\n[\s\S]*?(?:Expected|Error|Received|AssertionError)[:\s]+([^\n]+)/g
  let match: RegExpExecArray | null
  while ((match = failBlock.exec(text)) !== null) {
    failures.push({
      test: match[1]!.trim(),
      message: match[2]!.trim(),
      parser: 'jest_vitest',
    })
  }
  const failAt = /(?:FAIL|✗|×)\s+(\S+\.(?:test|spec)\.[jt]sx?)/g
  const files = new Set<string>()
  while ((match = failAt.exec(text)) !== null) {
    files.add(match[1]!)
  }
  const loc = /^\s+at\s+.+\((\S+\.(?:test|spec)\.[jt]sx?):(\d+):(\d+)\)/m.exec(text)
  if (failures.length === 0 && (files.size > 0 || /Tests:\s+\d+\s+failed/i.test(text))) {
    const file = loc?.[1] ?? [...files][0]
    failures.push({
      ...(file ? { file } : {}),
      ...(loc?.[2] ? { line: Number(loc[2]) } : {}),
      message: extractAssertionMessage(text) ?? 'test suite failed',
      parser: 'jest_vitest',
    })
  } else if (loc && failures[0] && !failures[0].file) {
    if (loc[1]) failures[0].file = loc[1]
    if (loc[2]) failures[0].line = Number(loc[2])
  }
  return uniqueFailures(failures)
}

function parsePytest(text: string): CompiledFailure[] {
  const failures: CompiledFailure[] = []
  const failed = /FAILED\s+(\S+\.py(?:::\S+)?)(?:\s+-\s+(.+))?/g
  let match: RegExpExecArray | null
  while ((match = failed.exec(text)) !== null) {
    const spec = match[1]!
    const [file, test] = spec.includes('::') ? spec.split(/::/, 2) : [spec, undefined]
    failures.push({
      ...(file ? { file } : {}),
      ...(test ? { test } : {}),
      message: (match[2] ?? extractAssertionMessage(text) ?? 'pytest failed').trim(),
      parser: 'pytest',
    })
  }
  const eLoc = /^\s*(\S+\.py):(\d+):\s+in\s+(\S+)/m.exec(text)
  if (eLoc && failures[0] && !failures[0].line) {
    if (eLoc[1]) failures[0].file = eLoc[1]
    failures[0].line = Number(eLoc[2])
    if (!failures[0].test && eLoc[3]) failures[0].test = eLoc[3]
  }
  if (failures.length === 0 && /={3,}\s+\d+\s+failed/i.test(text)) {
    failures.push({
      message: extractAssertionMessage(text) ?? 'pytest failed',
      parser: 'pytest',
    })
  }
  return uniqueFailures(failures)
}

function parseTsc(text: string): CompiledFailure[] {
  const failures: CompiledFailure[] = []
  const re = /(\S+\.tsx?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    failures.push({
      file: match[1]!,
      line: Number(match[2]),
      column: Number(match[3]),
      message: `${match[4]}: ${match[5]}`.trim(),
      parser: 'tsc',
    })
  }
  return uniqueFailures(failures)
}

function parseNodeTrace(text: string): CompiledFailure[] {
  const loc = /^\s*at\s+.+\((\S+\.[cm]?js):(\d+):(\d+)\)/m.exec(text)
    ?? /^\s*at\s+(\S+\.[cm]?js):(\d+):(\d+)/m.exec(text)
  const err = /^(?:Error|TypeError|ReferenceError|AssertionError):\s*(.+)$/m.exec(text)
  if (!loc && !err) return []
  return [
    {
      ...(loc?.[1] ? { file: loc[1] } : {}),
      ...(loc?.[2] ? { line: Number(loc[2]) } : {}),
      message: err?.[1]?.trim() ?? 'node runtime error',
      parser: 'node_trace',
    },
  ]
}

function parseGo(text: string): CompiledFailure[] {
  const failures: CompiledFailure[] = []
  const failRe = /--- FAIL:\s+(\S+)\s+\([^)]+\)/g
  let match: RegExpExecArray | null
  while ((match = failRe.exec(text)) !== null) {
    failures.push({
      test: match[1]!,
      message: 'go test failed',
      parser: 'go',
    })
  }
  const loc = /^\s*(\S+\.go):(\d+):/m.exec(text)
  if (loc && failures[0]) {
    if (loc[1]) failures[0].file = loc[1]
    failures[0].line = Number(loc[2])
  }
  const build = /(\S+\.go):(\d+):(\d+):\s+(.+)/.exec(text)
  if (failures.length === 0 && build && /#\s|undefined:|declared and not used/i.test(text)) {
    failures.push({
      file: build[1]!,
      line: Number(build[2]),
      column: Number(build[3]),
      message: build[4]!.trim(),
      parser: 'go',
    })
  }
  return uniqueFailures(failures)
}

function parseCargo(text: string): CompiledFailure[] {
  const failures: CompiledFailure[] = []
  const testRe = /test\s+(\S+)\s+\.\.\.\s+FAILED/g
  let match: RegExpExecArray | null
  while ((match = testRe.exec(text)) !== null) {
    failures.push({
      test: match[1]!,
      message: 'cargo test failed',
      parser: 'cargo',
    })
  }
  const errRe = /error(?:\[E\d+\])?:\s+(.+)\n\s+-->\s+(\S+):(\d+):(\d+)/g
  while ((match = errRe.exec(text)) !== null) {
    failures.push({
      file: match[2]!,
      line: Number(match[3]),
      column: Number(match[4]),
      message: match[1]!.trim(),
      parser: 'cargo',
    })
  }
  return uniqueFailures(failures)
}

function parseGenericFileLine(text: string): CompiledFailure[] {
  const failures: CompiledFailure[] = []
  const re = /(\S+\.[A-Za-z0-9]+):(\d+)(?::(\d+))?:\s*(.+)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    const file = match[1]!
    if (/node_modules|^\d+$/.test(file)) continue
    failures.push({
      file,
      line: Number(match[2]),
      ...(match[3] ? { column: Number(match[3]) } : {}),
      message: match[4]!.trim(),
      parser: 'generic_file_line',
    })
    if (failures.length >= 8) break
  }
  return uniqueFailures(failures)
}

function extractAssertionMessage(text: string): string | undefined {
  const patterns = [
    /Expected[:\s]+([^\n]+)/i,
    /AssertionError[:\s]+([^\n]+)/,
    /Error[:\s]+([^\n]+)/,
    /E\s+AssertionError[:\s]+([^\n]+)/,
  ]
  for (const re of patterns) {
    const m = re.exec(text)
    if (m?.[1]) return m[1].trim()
  }
  return undefined
}

function uniqueFailures(failures: CompiledFailure[]): CompiledFailure[] {
  const seen = new Set<string>()
  const out: CompiledFailure[] = []
  for (const f of failures) {
    const key = `${f.parser}|${f.file ?? ''}|${f.line ?? ''}|${f.test ?? ''}|${f.message}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(f)
  }
  return out
}

function splitHeadTail(text: string): { head: string; tail: string } {
  if (text.length <= OBSERVATION_HEAD_CHARS + OBSERVATION_TAIL_CHARS) {
    return { head: text, tail: text.length > OBSERVATION_HEAD_CHARS ? text.slice(-OBSERVATION_TAIL_CHARS) : '' }
  }
  return {
    head: text.slice(0, OBSERVATION_HEAD_CHARS),
    tail: text.slice(-OBSERVATION_TAIL_CHARS),
  }
}

function appendStream(
  lines: string[],
  label: 'stdout' | 'stderr',
  present: boolean,
  head: string,
  tail: string,
): void {
  if (!present) {
    lines.push(`${label}: (empty)`)
    return
  }
  const needsTail = tail.length > 0 && tail !== head
  lines.push(`${label}_head:`)
  lines.push(clip(head, OBSERVATION_HEAD_CHARS))
  if (needsTail) {
    lines.push(`${label}_tail:`)
    lines.push(clip(tail, OBSERVATION_TAIL_CHARS))
  }
}

function buildSummary(
  exitCode: number,
  failures: CompiledFailure[],
  stdoutPresent: boolean,
  stderrPresent: boolean,
): string {
  if (exitCode === 0) {
    return `ok (stdout=${stdoutPresent ? 'yes' : 'no'}, stderr=${stderrPresent ? 'yes' : 'no'})`
  }
  if (failures.length > 0) {
    return `${failures.length} structured failure(s); exit ${exitCode}`
  }
  return `exit ${exitCode}; stdout=${stdoutPresent ? 'yes' : 'no'}; stderr=${stderrPresent ? 'yes' : 'no'}`
}

function buildRawRecord(
  command: string,
  exitCode: number,
  stdout: string,
  stderr: string,
): string {
  return [
    `command: ${command}`,
    `exit_code: ${exitCode}`,
    '--- stdout ---',
    stdout,
    '--- stderr ---',
    stderr,
    '',
  ].join('\n')
}

export function isCredentialDeniedOutput(stderr: string | undefined): boolean {
  if (!stderr) return false
  return /DENY_CREDENTIAL_READ|AUTONOMY_DENIED:CLASS_D|credential store/i.test(stderr)
}

export function resolveContainedSpillPath(spillDir: string, fileName: string): string | null {
  const root = resolve(spillDir)
  const safeName = sanitizeId(fileName)
  const candidate = resolve(root, safeName)
  const rel = relative(root, candidate)
  if (rel.startsWith('..') || isAbsolute(rel)) return null
  if (normalize(candidate) !== candidate && candidate.includes(`..${sep}`)) return null
  return candidate
}

function persistSpillIfNeeded(
  input: CompileObservationInput,
  combined: string,
): string | undefined {
  if (input.denyRawSpill === true) return undefined
  if (isCredentialDeniedOutput(input.stderr)) return undefined
  const large =
    (input.stdout?.length ?? 0) + (input.stderr?.length ?? 0) >= OBSERVATION_SPILL_THRESHOLD
  if (!large) return undefined
  const name = `tool-output-${sanitizeId(input.toolCallId ?? input.tool)}.log`
  if (input.writeSpill) {
    return input.writeSpill(name, combined)
  }
  if (input.spillDir) {
    const path = resolveContainedSpillPath(input.spillDir, name)
    if (!path) return undefined
    mkdirSync(input.spillDir, { recursive: true })
    writeFileSync(path, combined, { encoding: 'utf8', mode: 0o600 })
    return path
  }
  return undefined
}

export function sanitizeSpillId(id: string): string {
  return sanitizeId(id)
}

function sanitizeId(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/\.{2,}/g, '_').replace(/^\.+/, '')
  return (cleaned.length > 0 ? cleaned : 'tool').slice(0, 80)
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n…(${text.length - max} more chars)`
}

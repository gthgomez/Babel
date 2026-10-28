import { stripVTControlCharacters } from 'node:util'
import { statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { createHash } from 'node:crypto'
import { parseStructuredFailures } from './observationCompiler.js'
import { recoveryTargetIdentity } from './recoveryIdentity.js'
import type { RecoveryCandidateBinding } from './workingState.js'
import { proposeTestImports, corroboratesTestImport, type TestImportCandidate } from './testImportBridge.js'

export interface LocalizationCandidate {
  path: string
  line?: number
  column?: number
  /** Diagnostic token that must occur in inspected source. */
  relation: string
  source: 'structured_location' | 'test_identity' | 'diagnostic_symbol' | 'import_call' | 'file_read'
  fromTestPath?: string
}

export interface FailureLocalization {
  phase: 'LOCALIZE_FAILURE' | 'localized' | 'exhausted'
  failureSignature: string
  binding: RecoveryCandidateBinding
  candidates: LocalizationCandidate[]
  testHints: string[]
  calls: number
  rounds: number
  inspected: string[]
  acceptedPath?: string
  observationDigest?: string
  importCandidates?: TestImportCandidate[]
}


function diagnosticToken(message: string): string | null {
  const quoted = /['"`]([A-Za-z_$][\w$]{2,})['"`]/.exec(message)?.[1]
  return quoted ?? null
}

/** Controller-captured diagnostics yield candidates, never mutation scope. */
export function captureLocalizationCandidates(input: {
  projectRoot: string
  stdout: string
  stderr: string
  tool: string
  command: string
}): LocalizationCandidate[] {
  const parsed = parseStructuredFailures(input.stdout, input.stderr, input.tool, input.command)
  const candidates: LocalizationCandidate[] = []
  const raw = stripVTControlCharacters(`${input.stdout}\n${input.stderr}`)
  for (const failure of parsed.failures.slice(0, 8)) {
    const path = failure.file ? recoveryTargetIdentity(input.projectRoot, failure.file) : null
    if (!path) continue
    try {
      if (!statSync(join(input.projectRoot, path)).isFile()) continue
    } catch { continue }
    const frame = new RegExp(`\\bat\\s+([A-Za-z_$][\\w.$]*)\\s+\\([^\\n]*${escapeRegExp(basename(path))}:\\d+:\\d+\\)`).exec(raw)
    const testLocation = /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(path)
    const relation = (testLocation ? failure.test : null) ?? diagnosticToken(failure.message) ?? frame?.[1]?.split('.').at(-1) ??
      (failure.test && /[A-Za-z_$][\w$]{2,}/.test(failure.test) ? failure.test : null)
    if (!relation) continue
    candidates.push({
      path, relation,
      ...(failure.line && Number.isSafeInteger(failure.line) ? { line: failure.line } : {}),
      ...(failure.column && Number.isSafeInteger(failure.column) ? { column: failure.column } : {}),
      source: testLocation && failure.test ? 'test_identity' : 'structured_location',
    })
  }
  // Additional named frames are bounded candidates; they still need a read.
  const frames = /^\s*(?:at\s+)?([A-Za-z_$][\w.$]*)\s+\(([^()\r\n]+\.[cm]?[jt]sx?):(\d+):(\d+)\)/gm
  let frameMatch: RegExpExecArray | null
  while ((frameMatch = frames.exec(raw)) !== null && candidates.length < 8) {
    const symbol = frameMatch[1]?.split('.').at(-1)
    const path = frameMatch[2] ? recoveryTargetIdentity(input.projectRoot, frameMatch[2]) : null
    if (!symbol || !path || candidates.some((candidate) => candidate.path === path)) continue
    try {
      if (!statSync(join(input.projectRoot, path)).isFile()) continue
    } catch { continue }
    candidates.push({ path, relation: symbol, line: Number(frameMatch[3]), source: 'structured_location' })
  }
  return [...new Map(candidates.map((candidate) => [candidate.path, candidate])).values()].slice(0, 8)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function startFailureLocalization(
  failureSignature: string,
  binding: RecoveryCandidateBinding,
  candidates: LocalizationCandidate[],
  testHints: string[] = [],
): FailureLocalization {
  return { phase: 'LOCALIZE_FAILURE', failureSignature, binding, candidates, testHints, calls: 0, rounds: 0, inspected: [] }
}

/** Extract bounded test-name hints from controller-captured verifier output. */
export function captureLocalizationTestHints(input: { stdout: string; stderr: string; tool: string; command: string }): string[] {
  const parsed = parseStructuredFailures(input.stdout, input.stderr, input.tool, input.command)
  const names = parsed.failures.map((failure) => failure.test ?? '')
  const commandTest = /([A-Za-z_$][\w$-]*)\.(?:test|spec)\.[jt]sx?/.exec(input.command)?.[1]
  if (commandTest) names.push(commandTest)
  const diagnosticCalls = `${input.stdout}\n${input.stderr}`.match(/\b[A-Za-z_$][\w$]{2,}\s*\(/g) ?? []
  names.push(...diagnosticCalls.map((call) => call.replace(/\s*\($/, '')))
  const excluded = new Set(['test', 'tests', 'failed', 'failure', 'should', 'suite', 'expect', 'expected'])
  return [...new Set(names.flatMap((name) => name.match(/[A-Za-z_$][\w$]{2,}/g) ?? [])
    .filter((token) => !excluded.has(token.toLowerCase())))].slice(0, 4)
}

/** A bounded glob may propose a test file only when its pattern cites a captured test hint. */
export function discoverTestCandidates(
  state: FailureLocalization,
  projectRoot: string,
  pattern: string,
  output: string,
): FailureLocalization {
  if (state.phase !== 'LOCALIZE_FAILURE' || state.testHints.length === 0 ||
      !state.testHints.some((hint) => pattern.toLowerCase().includes(hint.toLowerCase()))) return state
  const candidates = [...state.candidates]
  const paths = output.match(/[A-Za-z0-9_./\\-]+\.(?:test|spec)\.[jt]sx?/g) ?? []
  for (const raw of paths.slice(0, 32)) {
    const path = recoveryTargetIdentity(projectRoot, raw)
    if (!path || candidates.some((candidate) => candidate.path === path)) continue
    const stem = basename(path).replace(/\.(?:test|spec)\.[jt]sx?$/i, '').toLowerCase()
    const hint = state.testHints.find((item) => stem === item.toLowerCase())
    if (!hint) continue
    try { if (!statSync(join(projectRoot, path)).isFile()) continue } catch { continue }
    candidates.push({ path, relation: hint, source: 'test_identity' })
    if (candidates.length >= 8) break
  }
  return { ...state, candidates }
}

/** Count the attempt before dispatch, so failed/cancelled calls retain budget. */
export function beginLocalizationCall(state: FailureLocalization, target?: string): FailureLocalization {
  const calls = Math.min(Number.MAX_SAFE_INTEGER, state.calls + 1)
  const newTarget = target && !state.inspected.includes(target)
  const inspected = newTarget ? [...state.inspected, target].slice(-96) : state.inspected
  const rounds = Math.min(Number.MAX_SAFE_INTEGER, state.rounds + (newTarget ? 1 : 0))
  return { ...state, calls, rounds, inspected, phase: state.phase === 'exhausted' ? 'LOCALIZE_FAILURE' : state.phase }
}

/** Only a successful, related file read promotes a diagnostic candidate. */
export function finishLocalizationCall(
  state: FailureLocalization,
  action: { type: string; target?: string; content?: string; succeeded: boolean; startLine?: number; projectRoot?: string },
): FailureLocalization {
  if (state.phase !== 'LOCALIZE_FAILURE' && !(state.phase === 'localized' && state.importCandidates?.length)) return state
  const target = action.target ?? ''
  let candidate: LocalizationCandidate | undefined = state.phase === 'localized'
    ? state.importCandidates?.find(item => item.path === target && corroboratesTestImport(action.content ?? '', item.relation, item.source))
    : state.candidates.find((item) => item.path === target)
  // Search output proposes a location; a bounded file read corroborates it.
  const contentBearing = action.type === 'read_file' || action.type === 'read_range'
  const content = action.content ?? ''
  if (!candidate && state.phase === 'LOCALIZE_FAILURE' && contentBearing && action.succeeded && action.projectRoot && target &&
      recoveryTargetIdentity(action.projectRoot, target) === target) {
    try {
      if (statSync(join(action.projectRoot, target)).isFile()) {
        const symbol = state.testHints.find((hint) =>
          new RegExp(`\\b(?:function\\s+|(?:const|let|var)\\s+)${escapeRegExp(hint)}\\b`).test(content))
        if (symbol) candidate = { path: target, relation: symbol, source: 'diagnostic_symbol' }
      }
    } catch { /* missing or replaced path stays unlocalized */ }
  }
  const bridgeCandidate = candidate?.source === 'import_call' || candidate?.source === 'file_read'
  const related = candidate && contentBearing && action.succeeded && action.content !== undefined &&
    (candidate.source === 'file_read' || content.trim().length > 0) &&
    (!bridgeCandidate || action.type === 'read_file') &&
    (!bridgeCandidate || (action.projectRoot && recoveryTargetIdentity(action.projectRoot, target) === target)) &&
    (candidate.source === 'file_read' || new RegExp(`(?<![\\w$])${escapeRegExp(candidate.relation)}(?![\\w$])`, 'i').test(content)) &&
    (!candidate.line || (
      (action.startLine ?? 1) <= candidate.line &&
      (action.startLine ?? 1) + content.split(/\r?\n/).length - 1 >= candidate.line
    ))
  if (related) {
    return {
      ...state, phase: 'localized',
      candidates: candidate && !state.candidates.some((item) => item.path === candidate.path)
        ? [candidate, ...state.candidates].slice(0, 8) : state.candidates,
      acceptedPath: target,
      observationDigest: createHash('sha256').update(content).digest('hex'),
      importCandidates: candidate?.source === 'test_identity' && action.type === 'read_file' && action.projectRoot && (action.startLine ?? 1) === 1
        ? proposeTestImports({content, testPath: target, testName: candidate.relation, projectRoot: action.projectRoot,
          ...(candidate.line ? {line: candidate.line} : {}), ...(candidate.column ? {column: candidate.column} : {})}) : [],
    }
  }
  return {
    ...state,
    phase: state.phase,
  }
}

export function advanceFailureLocalization(
  state: FailureLocalization,
  action: { type: string; target?: string; content?: string; succeeded: boolean; startLine?: number; projectRoot?: string },
): FailureLocalization {
  return finishLocalizationCall(beginLocalizationCall(state, action.target), action)
}

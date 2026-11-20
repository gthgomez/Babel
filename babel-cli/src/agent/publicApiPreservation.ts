/**
 * Public API preservation constraints.
 *
 * "Do not change public APIs" is a preservation obligation, not a read-only
 * task and not just a classification hint. Admission freezes a digest of the
 * project's exported surface in contract provenance; completion recomputes it
 * and refuses certification when an export on a frozen file changed. The freeze
 * compares export NAMES only; declaration signatures and bodies are not
 * compared. Deletions, renames and (strictly) additions to a frozen file are
 * violations. New files and files without exports at admission are not observed.
 * The scan is capped at 800 files (max 2 MB each) using a deterministic bounded
 * DFS that skips `node_modules`, `.git`, `dist`, `build`, `coverage`, `runs`,
 * `artifacts`, `runtime`, `vendor` and dot directories, then sorts paths.
 */
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join, posix } from 'node:path'
import { sha256Canonical } from '../acceptance/canonical.js'
import type { TaskContractProvenanceRecord } from './taskContract.js'
import { stripJsComments } from './verifierBehaviorEvidence.js'
import { stripFencedCodeBodies } from '../config/chatTaskClass.js'

export const PUBLIC_API_FREEZE_REF_PREFIX = 'babel:public-api-freeze:v1:'
export const PUBLIC_API_FREEZE_REF_PREFIX_V2 = 'babel:public-api-freeze:v2:'
export const PUBLIC_API_PRESERVATION_STRATEGY =
  'public API preservation constraint (enforced by the frozen export surface at completion)'

/**
 * `exact` forbids any surface change; `compatible` permits additive exports
 * while still refusing removals, renames and signature-visible rewrites of the
 * frozen list entries. Omission defaults to `exact` (fail closed).
 */
export type PublicApiPreservationMode = 'exact' | 'compatible'
const SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/i
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', 'runs', 'artifacts',
  'runtime', 'vendor', '.next', '.turbo', '.cache',
])
const MAX_FILES = 800
const MAX_FILE_BYTES = 2_000_000

export interface PublicApiSurface {
  files: Record<string, string[]>
  digest: string
}

function exportNames(content: string): string[] {
  const code = stripJsComments(content)
  const names = new Set<string>()
  const declaration =
    /^\s*export\s+(?:declare\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/gm
  for (const match of code.matchAll(declaration)) names.add(`name:${match[1]!}`)
  if (/^\s*export\s+default\b/m.test(code)) names.add('default')
  for (const match of code.matchAll(/^\s*export\s*\{([^}]*)\}/gm)) {
    names.add(`list:${match[1]!.replace(/\s+/g, ' ').trim()}`)
  }
  for (const match of code.matchAll(/^\s*(?:module\.exports|exports)\.([A-Za-z_$][\w$]*)\s*=/gm)) {
    names.add(`cjs:${match[1]!}`)
  }
  for (const match of code.matchAll(/^\s*module\.exports\s*=\s*\{([\s\S]{0,4000}?)\}/gm)) {
    names.add(`cjs-object:${match[1]!.replace(/\s+/g, ' ').trim()}`)
  }
  return [...names].sort()
}

/** Deterministic exported-surface snapshot for a project tree. */
export function computePublicApiSurface(projectRoot: string): PublicApiSurface | null {
  let root: string
  try { root = realpathSync.native(projectRoot) } catch { return null }
  const files: Record<string, string[]> = {}
  const pending: string[] = ['']
  let scanned = 0
  while (pending.length > 0 && scanned < MAX_FILES) {
    const relative = pending.pop()!
    const absolute = relative ? join(root, relative) : root
    let entries
    try { entries = readdirSync(absolute, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (scanned >= MAX_FILES) break
      const child = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) pending.push(child)
        continue
      }
      if (!entry.isFile() || !SOURCE_EXTENSION.test(entry.name)) continue
      const path = join(root, child)
      let size = 0
      try { size = statSync(path).size } catch { continue }
      if (size > MAX_FILE_BYTES) continue
      let content: string
      try { content = readFileSync(path, 'utf8') } catch { continue }
      scanned += 1
      const names = exportNames(content)
      if (names.length > 0) files[child.replace(/\\/g, '/')] = names
    }
  }
  const ordered = Object.fromEntries(Object.entries(files).sort(([left], [right]) => left.localeCompare(right)))
  return { files: ordered, digest: sha256Canonical(ordered) }
}

/**
 * A user-stated preservation clause about the public surface. Both denial and
 * "keep ... unchanged" forms count; unrelated ordinary wording does not.
 */
export function hasPublicApiPreservationClause(rawTaskText: string): boolean {
  return isPublicApiPreservationStatement(stripFencedCodeBodies(rawTaskText))
}

const PUBLIC_SURFACE_NOUN = String.raw`(?:(?:public|exported)\s+(?:api|apis|interface|interfaces|surface|contract|contracts|exports?)|existing\s+exports?)`

function preservationPatterns(): RegExp[] {
  return [
    new RegExp(String.raw`\b(?:do\s+not|don'?t|never|must\s+not|should\s+not)\s+(?:change|modify|break|alter|touch|remove|rename)\b[^.\n;]{0,80}\b${PUBLIC_SURFACE_NOUN}\b`, 'i'),
    new RegExp(String.raw`\b(?:keep|preserve|maintain)\b[^.\n;]{0,40}\b${PUBLIC_SURFACE_NOUN}\b[^.\n;]{0,30}\b(?:unchanged|stable|compatible|intact)`, 'i'),
    new RegExp(String.raw`\b(?:without|no)\s+(?:public\s+)?(?:api|interface)\s+(?:changes?|breaks?)`, 'i'),
  ]
}

/** True when this text is itself a public-surface preservation constraint. */
export function isPublicApiPreservationStatement(taskText: string): boolean {
  return preservationPatterns().some(pattern => pattern.test(taskText))
}

function preservationMatch(sentence: string): { start: number; end: number } | null {
  for (const pattern of preservationPatterns()) {
    const match = pattern.exec(sentence)
    if (match) return { start: match.index, end: match.index + match[0].length }
  }
  return null
}

/**
 * Preservation semantics named by the task text. Exact wording ("do not
 * change", "keep ... unchanged") forbids additions; compatibility wording
 * ("do not break", "backward compatible") permits additive exports. Any
 * unclassified text defaults to exact.
 */
export function publicApiPreservationMode(rawTaskText: string): PublicApiPreservationMode {
  const text = stripFencedCodeBodies(rawTaskText)
  const surface = PUBLIC_SURFACE_NOUN
  const exact = new RegExp(String.raw`\b(?:do\s+not|don'?t|never|must\s+not|should\s+not)\s+(?:change|modify|alter|touch|remove|rename)\b[^.\n;]{0,80}\b${surface}`, 'i').test(text) ||
    new RegExp(String.raw`\b(?:keep|preserve|maintain)\b[^.\n;]{0,40}\b${surface}\b[^.\n;]{0,30}\b(?:unchanged|stable|intact)`, 'i').test(text) ||
    new RegExp(String.raw`\b(?:without|no)\s+(?:public\s+)?(?:api|interface)\s+changes?\b`, 'i').test(text)
  if (exact) return 'exact'
  const compatible = /\b(?:backward|backwards)[-\s]?compatible\b/i.test(text) ||
    new RegExp(String.raw`\bwithout\s+breaking\b[^.\n;]{0,40}\b${surface}`, 'i').test(text) ||
    new RegExp(String.raw`\b(?:without|no)\s+(?:public\s+)?(?:api|interface)\s+breaks?\b`, 'i').test(text) ||
    new RegExp(String.raw`\b(?:do\s+not|don'?t|never|must\s+not|should\s+not)\s+break\b[^.\n;]{0,80}\b${surface}`, 'i').test(text) ||
    new RegExp(String.raw`\b(?:keep|preserve|maintain)\b[^.\n;]{0,40}\b${surface}\b[^.\n;]{0,30}\bcompatible`, 'i').test(text)
  return compatible ? 'compatible' : 'exact'
}

/** Exports the task explicitly asks to add; only these may extend an exact surface. */
export function requestedExportNames(rawTaskText: string): string[] {
  const text = stripFencedCodeBodies(rawTaskText)
  const names = new Set<string>()
  for (const pattern of [
    /\badd\s+(?:an|a|the)?\s*export\s+(?:named\s+|called\s+)?[`"']?([A-Za-z_$][\w$]*)[`"']?/gi,
    /\badd\s+(?:(?:an|a|the)\s+)?[`"']?([A-Za-z_$][\w$]*)[`"']?\s+export\b/gi,
    /\bexport\s+[`"']([A-Za-z_$][\w$]*)[`"']/gi,
  ]) {
    for (const match of text.matchAll(pattern)) {
      const name = match[1]!
      if (!/^(?:a|an|the|new|export|exports|for|to|of|in|with|on|by|from|as|at|and|or)$/i.test(name)) names.add(name)
    }
  }
  return [...names].sort()
}

/**
 * Split a criterion that states a behavior and a separate preservation
 * clause. The behavioral remainder stays mandatory; only the preservation
 * clause becomes a non-required invariant. Text that cannot be attributed to
 * exactly one clause (two preservation clauses) stays whole and mandatory.
 */
export interface PublicApiPreservationSplit {
  behavior: string | null
  preservation: string
}

export function splitPublicApiPreservationStatement(
  taskText: string,
): PublicApiPreservationSplit | null {
  const sentences = taskText
    .split(/(?<=[.!?])\s+/)
    .map(sentence => sentence.trim())
    .filter(sentence => sentence.length > 0)
  const matched = sentences.map(sentence => preservationMatch(sentence))
  const indexes = matched.flatMap((match, index) => match ? [index] : [])
  if (indexes.length !== 1) return null
  const index = indexes[0]!
  const sentence = sentences[index]!
  const match = matched[index]!
  const behavior = [
    ...sentences.slice(0, index),
    sentence.slice(0, match.start),
    sentence.slice(match.end),
    ...sentences.slice(index + 1),
  ]
    .join(' ')
    .replace(/[\s,;:!?]+/g, ' ')
    .replace(/[.!?]+\s*$/, '')
    .replace(/^(?:and|but|while|yet|also|then|please|kindly)\b/i, '')
    .replace(/\b(?:and|but|while|yet|also|then|please|kindly)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
  const afterMatch = sentence.slice(match.end)
  const terminal = /^\s*[.!?]\s*$/.test(afterMatch) ? afterMatch.trim() : ''
  const preservation = `${sentence.slice(match.start, match.end).trim()}${terminal}`
  if (behavior.length === 0 || !/[A-Za-z0-9]/.test(behavior)) {
    return { behavior: null, preservation }
  }
  if (!/[A-Za-z]/.test(behavior)) return null
  return { behavior, preservation }
}

export function publicApiFreezeRef(
  surface: PublicApiSurface,
  options: { mode?: PublicApiPreservationMode } = {},
): string {
  const payload = Buffer.from(JSON.stringify({
    mode: options.mode ?? 'exact',
    files: surface.files,
  }), 'utf8').toString('base64url')
  return `${PUBLIC_API_FREEZE_REF_PREFIX_V2}${surface.digest}:${payload}`
}

interface FrozenPublicApi {
  digest: string | null
  paths: string[]
  mode: PublicApiPreservationMode
  files: Record<string, string[]> | null
  corrupt?: boolean
}

function unreadableFreeze(): FrozenPublicApi {
  return { digest: null, paths: [], mode: 'exact', files: null, corrupt: true }
}

function frozenPublicApiSurface(records: readonly TaskContractProvenanceRecord[]): FrozenPublicApi | null {
  const v2 = records.find(item => item.ref.startsWith(PUBLIC_API_FREEZE_REF_PREFIX_V2))
  if (v2) {
    const payload = v2.ref.slice(PUBLIC_API_FREEZE_REF_PREFIX_V2.length)
    const separator = payload.indexOf(':')
    if (separator <= 0) return unreadableFreeze()
    try {
      const decoded: unknown = JSON.parse(Buffer.from(payload.slice(separator + 1), 'base64url').toString('utf8'))
      if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) return unreadableFreeze()
      const record = decoded as { mode?: unknown; files?: unknown }
      if (record.mode !== 'exact' && record.mode !== 'compatible') return unreadableFreeze()
      if (record.files === null || typeof record.files !== 'object' || Array.isArray(record.files)) return unreadableFreeze()
      const files: Record<string, string[]> = {}
      for (const [path, names] of Object.entries(record.files as Record<string, unknown>)) {
        if (!Array.isArray(names) || !names.every(name => typeof name === 'string')) return unreadableFreeze()
        files[path] = [...names]
      }
      return { digest: payload.slice(0, separator), paths: Object.keys(files), mode: record.mode, files }
    } catch {
      return unreadableFreeze()
    }
  }
  const record = records.find(item => item.ref.startsWith(PUBLIC_API_FREEZE_REF_PREFIX))
  if (!record) return null
  const payload = record.ref.slice(PUBLIC_API_FREEZE_REF_PREFIX.length)
  const separator = payload.indexOf(':')
  if (separator <= 0) return unreadableFreeze()
  try {
    const paths = JSON.parse(Buffer.from(payload.slice(separator + 1), 'base64url').toString('utf8'))
    if (!Array.isArray(paths) || !paths.every(path => typeof path === 'string')) return unreadableFreeze()
    return { digest: payload.slice(0, separator), paths, mode: 'exact', files: null }
  } catch {
    return unreadableFreeze()
  }
}

function listMembers(entry: string): string[] | null {
  if (entry.startsWith('list:')) {
    return entry.slice('list:'.length)
      .replace(/^\{|\}$/g, '')
      .split(',')
      .map(member => member.trim())
      .filter(member => member.length > 0)
  }
  if (entry.startsWith('cjs-object:')) {
    return entry.slice('cjs-object:'.length)
      .split(',')
      .map(member => member.split(':')[0]?.trim() ?? '')
      .filter(member => member.length > 0)
  }
  return null
}

function exportedName(entry: string): string | null {
  if (entry.startsWith('name:')) return entry.slice('name:'.length)
  if (entry.startsWith('cjs:')) return entry.slice('cjs:'.length)
  return null
}

/** Compare frozen names with current names under the recorded mode. */
function surfaceViolation(
  frozenNames: readonly string[],
  currentNames: readonly string[],
  mode: PublicApiPreservationMode,
  requested: ReadonlySet<string>,
): string | null {
  const current = new Set(currentNames)
  const frozen = new Set(frozenNames)
  for (const entry of frozenNames) {
    const members = listMembers(entry)
    if (members) {
      const currentMembers = new Set(currentNames.flatMap(candidate => listMembers(candidate) ?? []))
      for (const member of members) {
        if (!currentMembers.has(member)) return `public API surface changed: member ${member} was removed or renamed`
      }
      continue
    }
    if (!current.has(entry)) return `public API surface changed: export ${entry} was removed or renamed`
  }
  for (const entry of currentNames) {
    if (frozen.has(entry)) continue
    const members = listMembers(entry)
    if (members) {
      const frozenMembers = new Set(frozenNames.flatMap(candidate => listMembers(candidate) ?? []))
      for (const member of members) {
        if (frozenMembers.has(member)) continue
        if (mode === 'compatible' || requested.has(member)) continue
        return `public API surface changed: member ${member} was added under an exact preservation constraint`
      }
      continue
    }
    const name = exportedName(entry)
    if (mode === 'compatible') continue
    if (name && requested.has(name)) continue
    return `public API surface changed: export ${entry} was added under an exact preservation constraint`
  }
  return null
}

/** Surface digest limited to the frozen paths; new files are not violations. */
function digestForPaths(projectRoot: string, paths: readonly string[]): string | null {
  const root = (() => { try { return realpathSync.native(projectRoot) } catch { return null } })()
  if (!root) return null
  const files: Record<string, string[]> = {}
  for (const relative of paths) {
    let content: string
    try { content = readFileSync(join(root, relative), 'utf8') } catch { return null }
    files[relative] = exportNames(content)
  }
  const ordered = Object.fromEntries(Object.entries(files).sort(([left], [right]) => left.localeCompare(right)))
  return sha256Canonical(ordered)
}

/**
 * Completion check: the frozen export surface must remain intact. Exact mode
 * also refuses additions; compatibility mode permits additive exports but still
 * refuses every removal, rename or changed export list entry.
 */
export function publicApiPreservationViolation(input: {
  records: readonly TaskContractProvenanceRecord[]
  projectRoot: string
  requestedExports?: readonly string[]
}): string | null {
  const frozen = frozenPublicApiSurface(input.records)
  if (!frozen) return null
  if (frozen.corrupt) return 'public API preservation record is unreadable'
  if (frozen.files) {
    const requested = new Set(input.requestedExports ?? [])
    const root = (() => { try { return realpathSync.native(input.projectRoot) } catch { return null } })()
    if (!root) return 'public API preservation could not inspect the candidate tree'
    for (const relative of frozen.paths) {
      let content: string
      try { content = readFileSync(join(root, relative), 'utf8') } catch {
        return `public API preservation could not inspect ${relative}`
      }
      const violation = surfaceViolation(
        frozen.files[relative] ?? [],
        exportNames(content),
        frozen.mode,
        requested,
      )
      if (violation) return violation
    }
    return null
  }
  const current = digestForPaths(input.projectRoot, frozen.paths)
  if (!current) return 'public API preservation could not inspect the candidate tree'
  if (current === frozen.digest) return null
  return 'public API surface changed despite the stated preservation constraint'
}

/** Project-relative source paths the frozen surface covers (diagnostics only). */
export function publicApiSurfacePaths(projectRoot: string): string[] {
  const surface = computePublicApiSurface(projectRoot)
  if (!surface) return []
  return Object.keys(surface.files).map(path => posix.normalize(path)).sort()
}

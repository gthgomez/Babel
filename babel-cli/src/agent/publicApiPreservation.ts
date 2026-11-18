/**
 * Public API preservation constraints.
 *
 * "Do not change public APIs" is a preservation obligation, not a read-only
 * task and not just a classification hint. Admission freezes a digest of the
 * project's exported surface in contract provenance; completion recomputes it
 * and refuses certification when an existing export disappeared or changed.
 * Deletions and renames are violations; additions remain allowed.
 */
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join, posix } from 'node:path'
import { sha256Canonical } from '../acceptance/canonical.js'
import type { TaskContractProvenanceRecord } from './taskContract.js'
import { stripJsComments } from './verifierBehaviorEvidence.js'
import { stripFencedCodeBodies } from '../config/chatTaskClass.js'

export const PUBLIC_API_FREEZE_REF_PREFIX = 'babel:public-api-freeze:v1:'
export const PUBLIC_API_PRESERVATION_STRATEGY =
  'public API preservation constraint (enforced by the frozen export surface at completion)'
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

/** True when this text is itself a public-surface preservation constraint. */
export function isPublicApiPreservationStatement(taskText: string): boolean {
  const surface = String.raw`(?:public|exported)\s+(?:api|apis|interface|interfaces|surface|contract|contracts|exports?)`
  return new RegExp(String.raw`\b(?:do\s+not|don'?t|never|must\s+not|should\s+not)\s+(?:change|modify|break|alter|touch|remove|rename)\b[^.\n;]{0,80}\b${surface}`, 'i').test(taskText) ||
    new RegExp(String.raw`\b(?:keep|preserve|maintain)\b[^.\n;]{0,40}\b${surface}\b[^.\n;]{0,30}\b(?:unchanged|stable|compatible|intact)`, 'i').test(taskText) ||
    new RegExp(String.raw`\b(?:without|no)\s+(?:public\s+)?(?:api|interface)\s+(?:changes?|breaks?)`, 'i').test(taskText)
}

export function publicApiFreezeRef(surface: PublicApiSurface): string {
  const paths = Object.keys(surface.files)
  return `${PUBLIC_API_FREEZE_REF_PREFIX}${surface.digest}:${Buffer.from(JSON.stringify(paths), 'utf8').toString('base64url')}`
}

interface FrozenPublicApi {
  digest: string
  paths: string[]
}

function frozenPublicApiSurface(records: readonly TaskContractProvenanceRecord[]): FrozenPublicApi | null {
  const record = records.find(item => item.ref.startsWith(PUBLIC_API_FREEZE_REF_PREFIX))
  if (!record) return null
  const payload = record.ref.slice(PUBLIC_API_FREEZE_REF_PREFIX.length)
  const separator = payload.indexOf(':')
  if (separator <= 0) return null
  try {
    const paths = JSON.parse(Buffer.from(payload.slice(separator + 1), 'base64url').toString('utf8'))
    if (!Array.isArray(paths) || !paths.every(path => typeof path === 'string')) return null
    return { digest: payload.slice(0, separator), paths }
  } catch {
    return null
  }
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
 * Completion check: a frozen public surface must still be present byte-for-byte
 * in its export names. Additions are allowed; removals/renames are not.
 */
export function publicApiPreservationViolation(input: {
  records: readonly TaskContractProvenanceRecord[]
  projectRoot: string
}): string | null {
  const frozen = frozenPublicApiSurface(input.records)
  if (!frozen) return null
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

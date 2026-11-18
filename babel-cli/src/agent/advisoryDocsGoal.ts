/**
 * Non-executable documentation goals.
 *
 * A task may legitimately ask for prose ("update README.md so it shows
 * parseSum usage"). That goal cannot be satisfied by a test receipt, but it
 * must not block every other completed obligation forever either. Admission
 * marks such a goal `required: false` and records it in provenance; completion
 * then mechanically checks that the named file exists on the candidate
 * revision and contains a distinctive token from the goal. Absence is still a
 * failure - the goal is never silently dropped.
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { sha256Canonical } from '../acceptance/canonical.js'
import type { AcceptanceRequirementV1 } from './taskContract.js'

export const ADVISORY_DOC_STRATEGY =
  'advisory documentation goal (recorded; mechanically checked at completion)'
export const ADVISORY_DOC_REF_PREFIX = 'babel:advisory-doc-goal:v1:'

const DOC_EXTENSIONS = /\.(?:md|mdx|markdown|txt|rst|adoc|asciidoc)$/i
const PATH_TOKEN_RE =
  /(?:^|[\s`"'(])((?:\.{1,2}\/)?[A-Za-z0-9_@.-]+(?:\/[A-Za-z0-9_@.-]+)*\.[A-Za-z0-9]{1,12})(?=$|[\s`"'),;:])/g
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'must', 'should', 'will', 'from',
  'update', 'change', 'write', 'document', 'documents', 'show', 'shows', 'explain',
  'explains', 'example', 'examples', 'usage', 'readme', 'file', 'files', 'make',
  'ensure', 'into', 'have', 'has', 'are', 'its', 'all', 'any', 'not',
])

function normalizeProjectPath(value: string): string {
  return posix.normalize(value.replace(/\\/g, '/')).replace(/^\.\//, '')
}

function distinctiveTokens(description: string): string[] {
  const expectation = description.match(/\bso\b([\s\S]{1,240})$/i)?.[1] ?? description
  const tokens = expectation.split(/[^A-Za-z0-9_$.-]+/).map(token => token.trim())
  const identifiers = tokens.filter(token => /[a-z][A-Z]|_|\d/.test(token) && token.length >= 3)
  const candidates = identifiers.length > 0
    ? identifiers
    : tokens.filter(token => token.length >= 4 && !STOPWORDS.has(token.toLowerCase()))
  return [...new Set(candidates)]
}

export interface AdvisoryDocsGoal {
  path: string
  tokens: string[]
}

/** A documentation target named by the goal itself. */
export function advisoryDocsGoal(description: string): AdvisoryDocsGoal | null {
  const paths = [...description.matchAll(PATH_TOKEN_RE)]
    .map(match => normalizeProjectPath(match[1]!))
    .filter(path => DOC_EXTENSIONS.test(path))
  const unique = [...new Set(paths)]
  if (unique.length !== 1) return null
  const tokens = distinctiveTokens(description)
  if (tokens.length === 0) return null
  return { path: unique[0]!, tokens }
}

/** Lexical containment; the file may still need to be created by the candidate. */
function lexicallyContained(relativePath: string): boolean {
  return !relativePath.startsWith('../') && !relativePath.includes('/../') && !/^[A-Za-z]:|^\//.test(relativePath)
}

/** Paths escaping the project root are never admitted as documentation targets. */
function contained(projectRoot: string, relativePath: string): string | null {
  if (!lexicallyContained(relativePath)) return null
  const absolute = join(projectRoot, relativePath)
  try {
    const root = realpathSync.native(projectRoot)
    const resolved = realpathSync.native(absolute)
    const path = posix.relative(root.replace(/\\/g, '/'), resolved.replace(/\\/g, '/'))
    if (!path || path.startsWith('../') || posix.isAbsolute(path)) return null
    return path
  } catch {
    return null
  }
}

/**
 * Downgrade only a documentation goal that names one existing-or-creatable file
 * and at least one distinctive token. Unparseable goals stay required.
 */
export function markAdvisoryDocsGoals(input: {
  criteria: readonly AcceptanceRequirementV1[]
  sources: readonly { criterion_id: string; status: string }[]
  projectRoot: string
  exists?: (path: string) => boolean
}): { criteria: AcceptanceRequirementV1[]; refs: string[] } {
  const exists = input.exists ?? existsSync
  let changed = false
  const refs: string[] = []
  const criteria = input.criteria.map(criterion => {
    if (!criterion.required) return criterion
    if (!criterion.verification.verifier_id.startsWith('meaning:')) return criterion
    const source = input.sources.find(item => item.criterion_id === criterion.id)
    if (source?.status !== 'inferred') return criterion
    const goal = advisoryDocsGoal(criterion.description)
    if (!goal) return criterion
    const lexicalPath = goal.path
    if (!lexicallyContained(lexicalPath) && !exists(join(input.projectRoot, lexicalPath))) return criterion
    changed = true
    refs.push(`${ADVISORY_DOC_REF_PREFIX}${sha256Canonical({
      criterion_id: criterion.id,
      path: lexicalPath,
      tokens: goal.tokens,
    }).slice(0, 32)}`)
    return { ...criterion, required: false, verification_strategy: ADVISORY_DOC_STRATEGY }
  })
  return { criteria: changed ? criteria : [...input.criteria], refs }
}

/**
 * Mechanical completion check for advisory documentation goals. A missing
 * file or a missing distinctive token is a violation; it never certifies.
 */
export function advisoryDocsViolations(input: {
  acceptance: readonly AcceptanceRequirementV1[]
  projectRoot: string
  readFile?: (path: string) => string | null
}): string[] {
  const read = input.readFile ?? ((path: string) => {
    try { return readFileSync(path, 'utf8') } catch { return null }
  })
  const violations: string[] = []
  for (const criterion of input.acceptance) {
    if (criterion.required || criterion.verification_strategy !== ADVISORY_DOC_STRATEGY) continue
    const goal = advisoryDocsGoal(criterion.description)
    if (!goal) {
      violations.push(`${criterion.id}: advisory documentation goal has no checkable target`)
      continue
    }
    const lexical = contained(input.projectRoot, goal.path) ?? goal.path
    const content = read(join(input.projectRoot, lexical))
    if (content === null) {
      violations.push(`${criterion.id}: documentation target ${goal.path} is missing`)
      continue
    }
    if (!goal.tokens.some(token => content.includes(token))) {
      violations.push(`${criterion.id}: documentation target ${goal.path} does not mention the requested behavior`)
    }
  }
  return violations
}

/** True when the acceptance contains a recorded advisory documentation goal. */
export function hasAdvisoryDocsGoal(acceptance: readonly AcceptanceRequirementV1[]): boolean {
  return acceptance.some(criterion =>
    !criterion.required && criterion.verification_strategy === ADVISORY_DOC_STRATEGY,
  )
}

function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory() } catch { return false }
}

/** Documentation targets are only inspected inside a real project directory. */
export function isProjectDirectory(projectRoot: string): boolean {
  return isDirectory(projectRoot) && existsSync(dirname(projectRoot))
}

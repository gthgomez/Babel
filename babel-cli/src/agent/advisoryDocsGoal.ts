/**
 * Non-executable documentation goals.
 *
 * A task may legitimately ask for prose ("update README.md so it shows
 * parseSum usage"). A lexical token in an unrelated or unchanged file is not
 * evidence of the requested artifact, so the goal stays mandatory: partial
 * source delivery is preserved, but completion cannot be certified until a
 * host-supported observation exists. The mechanical check below never
 * certifies by itself; it only distinguishes a missing/irrelevant target from
 * a present one.
 */
import { readFileSync, realpathSync } from 'node:fs'
import { join, posix } from 'node:path'
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
 * Record the documentation obligation and its mechanical target. The criterion
 * stays required: a matching token is a diagnostic, not proof of a requested
 * runnable example. Admission only adds provenance here.
 */
export function markAdvisoryDocsGoals(input: {
  criteria: readonly AcceptanceRequirementV1[]
  sources: readonly { criterion_id: string; status: string }[]
  projectRoot: string
}): { criteria: AcceptanceRequirementV1[]; refs: string[] } {
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
    if (!lexicallyContained(lexicalPath)) return criterion
    changed = true
    refs.push(`${ADVISORY_DOC_REF_PREFIX}${sha256Canonical({
      criterion_id: criterion.id,
      path: lexicalPath,
      tokens: goal.tokens,
    }).slice(0, 32)}`)
    return { ...criterion, verification_strategy: ADVISORY_DOC_STRATEGY }
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
    if (criterion.verification_strategy !== ADVISORY_DOC_STRATEGY) continue
    const goal = advisoryDocsGoal(criterion.description)
    if (!goal) {
      violations.push(`${criterion.id}: advisory documentation goal has no checkable target`)
      continue
    }
    if (!lexicallyContained(goal.path)) {
      violations.push(`${criterion.id}: documentation target ${goal.path} escapes the project root`)
      continue
    }
    const lexical = contained(input.projectRoot, goal.path)
    if (!lexical) {
      violations.push(`${criterion.id}: documentation target ${goal.path} is missing or unsafe`)
      continue
    }
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

/** True when the acceptance contains a mechanically checked documentation goal. */
export function hasAdvisoryDocsGoal(acceptance: readonly AcceptanceRequirementV1[]): boolean {
  return acceptance.some(criterion => criterion.verification_strategy === ADVISORY_DOC_STRATEGY)
}

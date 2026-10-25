import { sha256Canonical } from '../acceptance/canonical.js'
import type { AcceptanceRequirementV1, TaskContractProvenanceRecord, TaskContractV1 } from './taskContract.js'

/** Frozen replay / amendments recorded under v1 provenance. */
export const ACCEPTANCE_MEANING_REF_V1 = 'task-acceptance-meaning:v1'
/** Fresh admissions: provisional inferred capture from authenticated active prose. */
export const ACCEPTANCE_MEANING_REF_V2 = 'task-acceptance-meaning:v2'
/** @deprecated Use ACCEPTANCE_MEANING_REF_V1; default export alias preserves v1 replay. */
export const ACCEPTANCE_MEANING_REF = ACCEPTANCE_MEANING_REF_V1

export type TaskAcceptanceMeaningVersion = 1 | 2

const MAX_INPUT_CHARS = 65_536
const MAX_CRITERIA = 128
const MAX_CRITERION_CHARS = 4096
export type AcceptanceMeaningStatus = 'explicit' | 'inferred' | 'unresolved'
export interface AcceptanceMeaningSource {
  criterion_id: string
  status: AcceptanceMeaningStatus
  input_digest: string
  start: number
  end: number
}
export interface TaskAcceptanceMeaning {
  criteria: AcceptanceRequirementV1[]
  sources: AcceptanceMeaningSource[]
  provenance: TaskContractProvenanceRecord[]
  unresolved: boolean
  /** Active user prose only; evidence regions never become query authority. */
  activeProse: string[]
  structurallyComplete: boolean
  /** Provenance registry version used for this interpretation. */
  interpretation_version: TaskAcceptanceMeaningVersion
}

function sortCriteriaBySourceSpan(
  criteria: AcceptanceRequirementV1[],
  sources: AcceptanceMeaningSource[],
): void {
  if (criteria.length <= 1) return
  const order = new Map(criteria.map((item, index) => [item.id, index]))
  const startFor = (id: string) => sources.find(source => source.criterion_id === id)?.start ?? order.get(id)!
  criteria.sort((left, right) => startFor(left.id) - startFor(right.id) || order.get(left.id)! - order.get(right.id)!)
  sources.sort((left, right) => left.start - right.start || left.end - right.end)
}

type InterpretOptions = {
  version: TaskAcceptanceMeaningVersion
  meaningRef: string
  /** v2: join authenticated active prose spans as provisional inferred requirements. */
  admitActiveProseSpans: boolean
  /** v1: empty criteria → unresolved placeholder. v2: only structural incompleteness. */
  unresolvedWhenEmpty: boolean
}

function interpretTaskAcceptance(request: string, opts: InterpretOptions): TaskAcceptanceMeaning {
  const inputDigest = sha256Canonical(request)
  const criteria: AcceptanceRequirementV1[] = []
  const sources: AcceptanceMeaningSource[] = []
  const activeProse: string[] = []
  const seen = new Set<string>()
  let incomplete = request.length > MAX_INPUT_CHARS
  const add = (description: string, status: AcceptanceMeaningStatus, start: number, end: number) => {
    const normalized = description.trim()
    if (!normalized || seen.has(normalized)) return
    if (normalized.length > MAX_CRITERION_CHARS || criteria.length >= MAX_CRITERIA) {
      incomplete = true
      return
    }
    seen.add(normalized)
    const id = `acceptance:${sha256Canonical({ description: normalized, status }).slice(0, 32)}`
    criteria.push({
      id, description: normalized, type: 'custom', required: true,
      verification: { kind: 'custom', verifier_id: `meaning:${id}:${inputDigest.slice(0, 16)}` },
      verification_strategy: status === 'explicit'
        ? 'Independent evidence for this requirement bound to the active contract and candidate revision.'
        : status === 'inferred'
          ? 'Proposed meaning requires confirmation and independent evidence bound to the active contract and candidate revision.'
          : 'Acceptance meaning is unresolved; a finished response or successful command cannot satisfy this requirement.',
    })
    sources.push({ criterion_id: id, status, input_digest: inputDigest, start, end })
  }
  if (!incomplete) {
    let offset = 0, fence = '', fenceLength = 0, example = false, requirementRegion = false
    let sectionDepth = 1, exampleDepth = 1
    let exclusionDepth: number | undefined
    let plainExample = false, plainExclusion = false
    let listIndent: number | undefined
    const inferred: { text: string; start: number; end: number }[] = []
    const admissibleProse: { start: number; end: number; text: string }[] = []
    for (const raw of request.split('\n')) {
      const line = raw.replace(/\r$/, ''), start = offset, end = offset + line.length
      offset += raw.length + 1
      const delimiter = line.match(/^\s{0,3}(`{3,}|~{3,})/)
      if (delimiter) {
        const token = delimiter[1]!
        if (!fence) { fence = token[0]!; fenceLength = token.length }
        else if (token[0] === fence && token.length >= fenceLength && line.slice(delimiter[0].length).trim() === '') fence = ''
        continue
      }
      if (fence || /^\s*>/.test(line)) continue
      const headingDepth = line.match(/^\s{0,3}(#{1,6})\s+/)?.[1]?.length
      const heading = line.replace(/^\s{0,3}#{1,6}\s+/, '').replace(/\s+#+\s*$/, '').trim()
        .replace(/^(\*\*|__)(.+?)\1(?=\s*:|\s*$)/, '$2')
      const plainRequirements = /^ {0,3}\S/.test(line) && /^(?:acceptance criteria|requirements?)\s*:?\s*$/i.test(heading)
      if (exclusionDepth !== undefined) {
        if (headingDepth === undefined ? !(plainExclusion && plainRequirements) : headingDepth > exclusionDepth) continue
        exclusionDepth = undefined
      }
      if (example) {
        if (headingDepth === undefined ? !(plainExample && plainRequirements) : headingDepth > exampleDepth) continue
        example = false
      }
      if (headingDepth !== undefined) sectionDepth = headingDepth
      if (/^(?:acceptance criteria|requirements?)\s*:?\s*$/i.test(heading)) { activeProse.push(line.trim()); example = false; requirementRegion = true; listIndent = undefined; continue }
      if (/^(?:(?:for )?examples?(?: (?:input|output|text|code)| of [^:]{1,100})?|sample(?: (?:input|output|text|code))?|logs?|quoted (?:text|content))(?:\s*:|\s*$)/i.test(heading)) { example = true; exampleDepth = sectionDepth; plainExample = headingDepth === undefined; continue }
      if (/^(?:non[-\s]*goals?|out[-\s]+of[-\s]+scope|exclusions?|not required)(?:\s*:|\s*$)/i.test(heading)) { activeProse.push(line.trim()); exclusionDepth = sectionDepth; plainExclusion = headingDepth === undefined; continue }
      // Frozen v1 records active lines before heading/list handling, including blanks.
      if (opts.version === 1) activeProse.push(line.trim())
      if (/^\s{0,3}#{1,6}\s+/.test(line)) {
        if (opts.version === 2) activeProse.push(line.trim())
        example = false
        listIndent = undefined
        continue
      }
      if (/^\s{0,3}(?:also|additionally|and)\b[\s,:]*/i.test(line)) {
        requirementRegion = true
        if (/^\s{0,3}(?:also|additionally|and)\b[\s,:]*require\s*:\s*$/i.test(line)) {
          if (opts.version === 2) activeProse.push(line.trim())
          continue
        }
      }
      const bullet = line.match(/^( *)(?:[-*+•]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.+?)\s*$/)
      if (bullet) {
        const indent = bullet[1]!.length
        listIndent ??= indent
        if (indent > listIndent || indent > 3) { incomplete = true; continue }
        if (opts.version === 2) activeProse.push(line.trim())
        add(bullet[2]!, 'explicit', start, end)
        continue
      }
      const inline = line.match(/^\s{0,3}(?:acceptance criteria|requirements?)\s*:\s*(.+?)\s*$/i)
      if (inline) { requirementRegion = true; if (opts.version === 2) activeProse.push(line.trim()); add(inline[1]!, 'explicit', start, end); continue }
      const trimmedLine = line.trim()
      const lineIndent = line.match(/^( *)/)?.[1]?.length ?? 0
      const indentedCodeLine = lineIndent >= 4 || /^ {0,3}\t/.test(line)
      const listContinuation =
        listIndent !== undefined &&
        trimmedLine.length > 0 &&
        lineIndent > listIndent &&
        lineIndent < 4 &&
        !/^\s*(?:[-*+•]|\d+[.)])\s+/.test(line)
      if (opts.version === 2 && trimmedLine) activeProse.push(trimmedLine)
      if (opts.admitActiveProseSpans && trimmedLine && !indentedCodeLine) {
        admissibleProse.push({ start, end, text: trimmedLine })
      }
      if (/^\S/.test(line) && /\b(?:must|shall|should|needs? to|required to|ensure|preserve|reject|support|prevent)\b/i.test(line))
        inferred.push({ text: trimmedLine, start, end })
      else if (!opts.admitActiveProseSpans && (requirementRegion || listIndent !== undefined || inferred.length > 0) && trimmedLine) incomplete = true
      else if (opts.admitActiveProseSpans && trimmedLine && (listContinuation || indentedCodeLine)) incomplete = true
    }
    if (fence) incomplete = true
    for (const item of inferred) add(item.text, 'inferred', item.start, item.end)
    if (opts.admitActiveProseSpans && !incomplete && admissibleProse.length > 0) {
      const admitted = new Set(criteria.map(item => item.description))
      for (const span of admissibleProse) {
        if (admitted.has(span.text)) continue
        add(span.text, 'inferred', span.start, span.end)
        admitted.add(span.text)
      }
    }
    if (opts.version === 2) sortCriteriaBySourceSpan(criteria, sources)
  }
  const needsUnresolved =
    incomplete ||
    (opts.unresolvedWhenEmpty && !criteria.length) ||
    (opts.version === 2 && !criteria.length)
  if (needsUnresolved) {
    const unresolved = 'Clarify the observable acceptance requirements for this request.'
    const existing = criteria.findIndex(item => item.description === unresolved)
    if (existing >= 0) {
      criteria.splice(existing, 1)
      sources.splice(existing, 1)
      seen.delete(unresolved)
    }
    if (criteria.length >= MAX_CRITERIA) {
      criteria.pop()
      sources.pop()
    }
    add(unresolved, 'unresolved', 0, request.length)
  }
  return {
    criteria, sources, activeProse, structurallyComplete: !incomplete,
    interpretation_version: opts.version,
    provenance: sources.map(source => ({
      kind: 'derived_acceptance',
      ref: `${opts.meaningRef}:${source.status}:${source.input_digest}:${source.start}:${source.end}:${source.criterion_id}`,
    })),
    unresolved: sources.some(source => source.status === 'unresolved'),
  }
}

/** v1 replay semantics (frozen). */
export function inferTaskAcceptanceV1(request: string): TaskAcceptanceMeaning {
  return interpretTaskAcceptance(request, {
    version: 1,
    meaningRef: ACCEPTANCE_MEANING_REF_V1,
    admitActiveProseSpans: false,
    unresolvedWhenEmpty: true,
  })
}

/** v2 fresh admission: provisional inferred capture from active prose spans. */
export function inferTaskAcceptanceV2(request: string): TaskAcceptanceMeaning {
  return interpretTaskAcceptance(request, {
    version: 2,
    meaningRef: ACCEPTANCE_MEANING_REF_V2,
    admitActiveProseSpans: true,
    unresolvedWhenEmpty: false,
  })
}

/** Default export path preserves v1 outputs for existing callers and replay tests. */
export function inferTaskAcceptance(request: string): TaskAcceptanceMeaning {
  return inferTaskAcceptanceV1(request)
}

export function inferTaskAcceptanceForVersion(
  request: string,
  version: TaskAcceptanceMeaningVersion,
): TaskAcceptanceMeaning {
  return version === 2 ? inferTaskAcceptanceV2(request) : inferTaskAcceptanceV1(request)
}

export function acceptanceMeaningRefForVersion(version: TaskAcceptanceMeaningVersion): string {
  return version === 2 ? ACCEPTANCE_MEANING_REF_V2 : ACCEPTANCE_MEANING_REF_V1
}

export function isAcceptanceMeaningDerivedRef(ref: string): boolean {
  return ref.startsWith(`${ACCEPTANCE_MEANING_REF_V1}:`) || ref.startsWith(`${ACCEPTANCE_MEANING_REF_V2}:`)
}

export type AcceptanceMeaningVersionResolution =
  | { kind: 'version'; version: TaskAcceptanceMeaningVersion }
  | { kind: 'legacy_absent_ref'; version: 1 }

const ACCEPTANCE_MEANING_NAMESPACE_PREFIX = 'task-acceptance-meaning:'

function recordedMeaningVersionFlags(records: readonly TaskContractProvenanceRecord[]): { v1: boolean; v2: boolean } {
  let v1 = false
  let v2 = false
  for (const record of records) {
    if (record.kind !== 'derived_acceptance') continue
    const ref = record.ref
    if (ref.startsWith(`${ACCEPTANCE_MEANING_REF_V2}:`)) {
      v2 = true
      continue
    }
    if (ref.startsWith(`${ACCEPTANCE_MEANING_REF_V1}:`)) {
      v1 = true
      continue
    }
    if (ref.startsWith(ACCEPTANCE_MEANING_NAMESPACE_PREFIX)) {
      throw new Error('TASK_ACCEPTANCE_MEANING_VERSION_UNSUPPORTED: Malformed or unknown acceptance-meaning provenance ref')
    }
  }
  return { v1, v2 }
}

/**
 * Resolve interpretation version from recorded provenance. Mixed v1/v2 refs reject.
 * Absent per-criterion meaning refs fall back to v1 only for the explicit legacy placeholder shape.
 */
export function resolveAcceptanceMeaningVersion(
  records: readonly TaskContractProvenanceRecord[],
  contract?: TaskContractV1,
): AcceptanceMeaningVersionResolution {
  const { v1, v2 } = recordedMeaningVersionFlags(records)
  if (v1 && v2) {
    throw new Error('TASK_ACCEPTANCE_MEANING_VERSION_MIXED: Contract provenance records both v1 and v2 acceptance-meaning refs')
  }
  if (v2) return { kind: 'version', version: 2 }
  if (v1) return { kind: 'version', version: 1 }
  if (contract && isLegacyAcceptancePlaceholderContract(contract)) {
    return { kind: 'legacy_absent_ref', version: 1 }
  }
  throw new Error('TASK_ACCEPTANCE_MEANING_VERSION_UNSUPPORTED: Missing or unrecognized acceptance-meaning provenance')
}

export function requireAcceptanceMeaningVersion(
  records: readonly TaskContractProvenanceRecord[],
  contract?: TaskContractV1,
): TaskAcceptanceMeaningVersion {
  const resolved = resolveAcceptanceMeaningVersion(records, contract)
  return resolved.version
}

/** Legacy placeholder: no derived per-criterion meaning refs (historical generated seed). */
export function isLegacyAcceptancePlaceholderContract(contract: TaskContractV1): boolean {
  const description = 'Task acceptance criteria as stated in the user request'
  const placeholder: AcceptanceRequirementV1 = {
    id: 'acceptance:1', description, type: 'custom', required: true,
    verification_strategy: 'independent evidence bound to the candidate revision',
    verification: { kind: 'custom', verifier_id: 'verifier:custom:1', command_hash: sha256Canonical(description) },
  }
  return sha256Canonical(contract.acceptance) === sha256Canonical([placeholder]) &&
    sha256Canonical(contract.acceptance_criteria) === sha256Canonical([description]) &&
    !contract.provenance.records.some(record => record.ref.startsWith(ACCEPTANCE_MEANING_NAMESPACE_PREFIX))
}

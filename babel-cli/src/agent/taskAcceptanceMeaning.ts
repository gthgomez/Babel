import { sha256Canonical } from '../acceptance/canonical.js'
import type { AcceptanceRequirementV1, TaskContractProvenanceRecord, TaskContractV1 } from './taskContract.js'

/** Frozen replay / amendments recorded under v1 provenance. */
export const ACCEPTANCE_MEANING_REF_V1 = 'task-acceptance-meaning:v1'
/** Fresh admissions: provisional inferred capture from authenticated active prose. */
export const ACCEPTANCE_MEANING_REF_V2 = 'task-acceptance-meaning:v2'
/** Fresh admission with explicit behavioral-goal preservation and bounded evidence sections. */
export const ACCEPTANCE_MEANING_REF_V3 = 'task-acceptance-meaning:v3'
/** @deprecated Use ACCEPTANCE_MEANING_REF_V1; default export alias preserves v1 replay. */
export const ACCEPTANCE_MEANING_REF = ACCEPTANCE_MEANING_REF_V1

export type TaskAcceptanceMeaningVersion = 1 | 2 | 3

const MAX_INPUT_CHARS = 65_536
const MAX_CRITERIA = 128
const MAX_CRITERION_CHARS = 4096
const RAW_PYTHON_FUNCTION_DEFINITION = /^\s{0,3}(?:async\s+)?def\s+[A-Za-z_]\w*\s*\(/
const RAW_PYTHON_TOP_LEVEL_CODE = /^\s{0,3}(?:async\s+)?(?:def|class)\s+[A-Za-z_]\w*\b|^\s{0,3}@\w/
// A concrete behavioral objective in the user's opening request must not be
// displaced by a later, narrower command-only Requirements list.
const BEHAVIORAL_GOAL_LINE = /^\s{0,3}(?:please\s+)?(?:fix|change|update|implement|make|ensure|support)\b.{1,240}\bso\b.{1,240}\b(?:returns?|return|equals?|equal|produces?|outputs?|becomes?|is)\b.{1,160}[.!]?\s*$/i
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

function hasRawPythonFunctionDefinition(request: string): boolean {
  return request.split(/\r?\n/).some(line => RAW_PYTHON_FUNCTION_DEFINITION.test(line))
}

function preserveBehavioralGoal(
  meaning: TaskAcceptanceMeaning,
  request: string,
  meaningRef = ACCEPTANCE_MEANING_REF_V3,
): TaskAcceptanceMeaning {
  // Limit this bridge to a directly stated, observable opening goal. Do not
  // reinterpret examples, quoted text, fenced content, or arbitrary prose.
  // Keep carriage returns in each raw line so offset increments include the
  // full original CRLF separator. The semantic line text is normalized below.
  const lines = request.split('\n')
  let offset = 0
  let fence = ''
  let fenceLength = 0
  let sectionDepth = 1
  let exclusionDepth: number | undefined
  let exampleDepth: number | undefined
  let plainExclusion = false
  let plainExample = false
  let found: { text: string; start: number; end: number } | undefined
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '')
    const delimiter = line.match(/^\s{0,3}(`{3,}|~{3,})/)
    if (delimiter) {
      const token = delimiter[1]!
      if (!fence) { fence = token[0]!; fenceLength = token.length }
      else if (token[0] === fence && token.length >= fenceLength && line.slice(delimiter[0].length).trim() === '') {
        fence = ''
        fenceLength = 0
      }
      offset += raw.length + 1
      continue
    }
    if (fence || /^\s*>/.test(line)) { offset += raw.length + 1; continue }

    const headingDepth = line.match(/^\s{0,3}(#{1,6})\s+/)?.[1]?.length
    const heading = line.replace(/^\s{0,3}#{1,6}\s+/, '').replace(/\s+#+\s*$/, '').trim()
      .replace(/^(\*\*|__)(.+?)\1(?=\s*:|\s*$)/, '$2')
    const plainRequirements = /^ {0,3}\S/.test(line) && /^(?:acceptance criteria|requirements?)\s*:?\s*$/i.test(heading)
    if (exclusionDepth !== undefined) {
      if (headingDepth === undefined ? !(plainExclusion && plainRequirements) : headingDepth > exclusionDepth) {
        offset += raw.length + 1
        continue
      }
      exclusionDepth = undefined
    }
    if (exampleDepth !== undefined) {
      if (headingDepth === undefined ? !(plainExample && plainRequirements) : headingDepth > exampleDepth) {
        offset += raw.length + 1
        continue
      }
      exampleDepth = undefined
    }
    if (headingDepth !== undefined) sectionDepth = headingDepth
    if (/^(?:acceptance criteria|requirements?)\s*:?\s*$/i.test(heading)) break
    if (/^(?:non[-\s]*goals?|out[-\s]+of[-\s]+scope|exclusions?|not required)(?:\s*:|\s*$)/i.test(heading)) {
      exclusionDepth = sectionDepth
      plainExclusion = headingDepth === undefined
      offset += raw.length + 1
      continue
    }
    if (/^(?:(?:for )?examples?(?: (?:input|output|text|code)| of [^:]{1,100})?|sample(?: (?:input|output|text|code))?|logs?|quoted (?:text|content))(?:\s*:|\s*$)/i.test(heading)) {
      exampleDepth = sectionDepth
      plainExample = headingDepth === undefined
      offset += raw.length + 1
      continue
    }
    if (/^\s{0,3}(?:[-*+•]|\d+[.)])\s+/.test(line)) break
    if (line.trim() && !/^\s{0,3}#{1,6}\s+/.test(line) && BEHAVIORAL_GOAL_LINE.test(line)) {
      found = { text: line.trim(), start: offset, end: offset + line.length }
      break
    }
    offset += raw.length + 1
  }
  if (!found || meaning.criteria.some(item => item.description === found!.text)) return meaning

  // The parser already enforces this cap. If there is no room for the
  // additional obligation, combine it with the final criterion as one
  // unresolved requirement. The admitted contract therefore retains both
  // obligations and cannot certify either from unrelated command evidence.
  if (meaning.criteria.length >= MAX_CRITERIA) {
    const lastCriterion = meaning.criteria[MAX_CRITERIA - 1]!
    const lastSource = meaning.sources.find(source => source.criterion_id === lastCriterion.id)
    const combinedDescription = `${found.text} Also, ${lastCriterion.description}`
    const description = combinedDescription.length <= MAX_CRITERION_CHARS
      ? combinedDescription
      : 'Acceptance capture limit exceeded; the opening behavioral objective and displaced acceptance requirement remain unresolved and cannot be certified.'
    const id = `acceptance:${sha256Canonical({ description, status: 'unresolved' }).slice(0, 32)}`
    const inputDigest = sha256Canonical(request)
    const combined: AcceptanceRequirementV1 = {
      id,
      description,
      type: 'custom',
      required: true,
      verification: { kind: 'custom', verifier_id: `meaning:${id}:${inputDigest.slice(0, 16)}` },
      verification_strategy: 'Acceptance requirements exceeded the capture limit; both combined obligations require independent evidence before completion can be certified.',
    }
    const criteria = [...meaning.criteria]
    criteria[MAX_CRITERIA - 1] = combined
    const sources = meaning.sources.filter(source => source.criterion_id !== lastCriterion.id)
    sources.push({
      criterion_id: id,
      status: 'unresolved',
      input_digest: inputDigest,
      start: found.start,
      end: lastSource?.end ?? found.end,
    })
    return {
      ...meaning,
      criteria,
      sources,
      unresolved: true,
      structurallyComplete: false,
      provenance: [
        {
          kind: 'derived_acceptance',
          ref: `${meaningRef}:unresolved:${inputDigest}:${found.start}:${lastSource?.end ?? found.end}:${id}`,
        },
        ...meaning.provenance,
      ],
    }
  }

  const inputDigest = sha256Canonical(request)
  const id = `acceptance:${sha256Canonical({ description: found.text, status: 'inferred' }).slice(0, 32)}`
  const goal: AcceptanceRequirementV1 = {
    id,
    description: found.text,
    type: 'custom',
    required: true,
    verification: { kind: 'custom', verifier_id: `meaning:${id}:${inputDigest.slice(0, 16)}` },
    verification_strategy: 'The explicit behavioral goal remains a separate requirement; a command-only success does not prove it unless that exact behavior is covered by an authorized verifier.',
  }
  const source: AcceptanceMeaningSource = {
    criterion_id: id,
    status: 'inferred',
    input_digest: inputDigest,
    start: found.start,
    end: found.end,
  }
  return {
    ...meaning,
    criteria: [goal, ...meaning.criteria],
    sources: [source, ...meaning.sources],
    provenance: [
      {
        kind: 'derived_acceptance',
        ref: `${meaningRef}:inferred:${inputDigest}:${found.start}:${found.end}:${id}`,
      },
      ...meaning.provenance,
    ],
  }
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
    let rawPythonFunctionBody = false
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
      if (opts.version === 2) {
        if (!rawPythonFunctionBody && RAW_PYTHON_FUNCTION_DEFINITION.test(line)) {
          rawPythonFunctionBody = true
          continue
        }
        if (rawPythonFunctionBody) {
          const indentation = line.match(/^[ \t]*/)?.[0].length ?? 0
          if (!line.trim() || indentation > 0 || RAW_PYTHON_TOP_LEVEL_CODE.test(line)) continue
          rawPythonFunctionBody = false
        }
      }
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

function relabelMeaningProvenanceV1ToV2(
  provenance: TaskAcceptanceMeaning['provenance'],
): TaskAcceptanceMeaning['provenance'] {
  const v1Prefix = `${ACCEPTANCE_MEANING_REF_V1}:`
  const v2Prefix = `${ACCEPTANCE_MEANING_REF_V2}:`
  return provenance.map((record) => ({
    ...record,
    ref: record.ref.startsWith(v1Prefix)
      ? record.ref.replace(v1Prefix, v2Prefix)
      : record.ref,
  }))
}

/** Promote a v1 projection to v2 admission without changing criteria, sources, or unresolved shape. */
function promoteV1ProjectionToV2Admission(legacy: TaskAcceptanceMeaning): TaskAcceptanceMeaning {
  return {
    ...legacy,
    interpretation_version: 2,
    provenance: relabelMeaningProvenanceV1ToV2(legacy.provenance),
  }
}

/**
 * v2 fresh admission: use v1 when it already yields real criteria or structural incompleteness;
 * otherwise fall back to provisional active-prose capture (short vague requests only).
 */
export function inferTaskAcceptanceV2(request: string): TaskAcceptanceMeaning {
  const legacy = inferTaskAcceptanceV1(request)
  if (hasRawPythonFunctionDefinition(request)) {
    const rawFunctionMeaning = interpretTaskAcceptance(request, {
      version: 2,
      meaningRef: ACCEPTANCE_MEANING_REF_V2,
      admitActiveProseSpans: true,
      unresolvedWhenEmpty: false,
    })
    // Raw Python function examples are task data, not malformed acceptance prose.
    // Override the frozen v1 structural fallback only when v2 can account for
    // the rest of the request without losing an ambiguous requirement.
    if (rawFunctionMeaning.structurallyComplete) return rawFunctionMeaning
  }
  const hasRealCriterion = legacy.sources.some((source) => source.status !== 'unresolved')
  if (hasRealCriterion || !legacy.structurallyComplete) {
    return promoteV1ProjectionToV2Admission(legacy)
  }
  return interpretTaskAcceptance(request, {
    version: 2,
    meaningRef: ACCEPTANCE_MEANING_REF_V2,
    admitActiveProseSpans: true,
    unresolvedWhenEmpty: false,
  })
}

/** Fresh admission v3 adds the behavioral-goal obligation while v1/v2 remain stable for archived replay. */
export function inferTaskAcceptanceV3(request: string): TaskAcceptanceMeaning {
  const previous = inferTaskAcceptanceV2(request)
  const v2Prefix = `${ACCEPTANCE_MEANING_REF_V2}:`
  const v3Prefix = `${ACCEPTANCE_MEANING_REF_V3}:`
  const versioned: TaskAcceptanceMeaning = {
    ...previous,
    interpretation_version: 3,
    provenance: previous.provenance.map(record => ({
      ...record,
      ref: record.ref.startsWith(v2Prefix) ? record.ref.replace(v2Prefix, v3Prefix) : record.ref,
    })),
  }
  return preserveBehavioralGoal(versioned, request)
}

/** Default export path preserves v1 outputs for existing callers and replay tests. */
export function inferTaskAcceptance(request: string): TaskAcceptanceMeaning {
  return inferTaskAcceptanceV1(request)
}

export function inferTaskAcceptanceForVersion(
  request: string,
  version: TaskAcceptanceMeaningVersion,
): TaskAcceptanceMeaning {
  if (version === 3) return inferTaskAcceptanceV3(request)
  return version === 2 ? inferTaskAcceptanceV2(request) : inferTaskAcceptanceV1(request)
}

export function acceptanceMeaningRefForVersion(version: TaskAcceptanceMeaningVersion): string {
  return version === 3 ? ACCEPTANCE_MEANING_REF_V3 : version === 2 ? ACCEPTANCE_MEANING_REF_V2 : ACCEPTANCE_MEANING_REF_V1
}

export function isAcceptanceMeaningDerivedRef(ref: string): boolean {
  return ref.startsWith(`${ACCEPTANCE_MEANING_REF_V1}:`) || ref.startsWith(`${ACCEPTANCE_MEANING_REF_V2}:`) || ref.startsWith(`${ACCEPTANCE_MEANING_REF_V3}:`)
}

export type AcceptanceMeaningVersionResolution =
  | { kind: 'version'; version: TaskAcceptanceMeaningVersion }
  | { kind: 'legacy_absent_ref'; version: 1 }

const ACCEPTANCE_MEANING_NAMESPACE_PREFIX = 'task-acceptance-meaning:'

function recordedMeaningVersionFlags(records: readonly TaskContractProvenanceRecord[]): { v1: boolean; v2: boolean; v3: boolean } {
  let v1 = false
  let v2 = false
  let v3 = false
  for (const record of records) {
    if (record.kind !== 'derived_acceptance') continue
    const ref = record.ref
    if (ref.startsWith(`${ACCEPTANCE_MEANING_REF_V3}:`)) {
      v3 = true
      continue
    }
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
  return { v1, v2, v3 }
}

/**
 * Resolve interpretation version from recorded provenance. Mixed-version refs reject.
 * Absent per-criterion meaning refs fall back to v1 only for the explicit legacy placeholder shape.
 */
export function resolveAcceptanceMeaningVersion(
  records: readonly TaskContractProvenanceRecord[],
  contract?: TaskContractV1,
): AcceptanceMeaningVersionResolution {
  const { v1, v2, v3 } = recordedMeaningVersionFlags(records)
  if (Number(v1) + Number(v2) + Number(v3) > 1) {
    throw new Error('TASK_ACCEPTANCE_MEANING_VERSION_MIXED: Contract provenance records multiple acceptance-meaning versions')
  }
  if (v3) return { kind: 'version', version: 3 }
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

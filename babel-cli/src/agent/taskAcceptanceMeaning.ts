import { sha256Canonical } from '../acceptance/canonical.js'
import type { AcceptanceRequirementV1, TaskContractProvenanceRecord, TaskContractV1 } from './taskContract.js'

/** Frozen replay / amendments recorded under v1 provenance. */
export const ACCEPTANCE_MEANING_REF_V1 = 'task-acceptance-meaning:v1'
/** Fresh admissions: provisional inferred capture from authenticated active prose. */
export const ACCEPTANCE_MEANING_REF_V2 = 'task-acceptance-meaning:v2'
/** Frozen v3 behavioral-goal preservation and bounded evidence sections. */
export const ACCEPTANCE_MEANING_REF_V3 = 'task-acceptance-meaning:v3'
/** Fresh admission also preserves narrowly labeled opening behavioral goals. */
export const ACCEPTANCE_MEANING_REF_V4 = 'task-acceptance-meaning:v4'
/** @deprecated Use ACCEPTANCE_MEANING_REF_V1; default export alias preserves v1 replay. */
export const ACCEPTANCE_MEANING_REF = ACCEPTANCE_MEANING_REF_V1

export type TaskAcceptanceMeaningVersion = 1 | 2 | 3 | 4
const ACCEPTANCE_MEANING_REFS: ReadonlyMap<TaskAcceptanceMeaningVersion, string> = new Map([
  [1, ACCEPTANCE_MEANING_REF_V1],
  [2, ACCEPTANCE_MEANING_REF_V2],
  [3, ACCEPTANCE_MEANING_REF_V3],
  [4, ACCEPTANCE_MEANING_REF_V4],
])

const MAX_INPUT_CHARS = 65_536
const MAX_CRITERIA = 128
const MAX_CRITERION_CHARS = 4096
const RAW_PYTHON_FUNCTION_DEFINITION = /^\s{0,3}(?:async\s+)?def\s+[A-Za-z_]\w*\s*\(/
const RAW_PYTHON_TOP_LEVEL_CODE = /^\s{0,3}(?:async\s+)?(?:def|class)\s+[A-Za-z_]\w*\b|^\s{0,3}@\w/
// A concrete behavioral objective in the user's opening request must not be
// displaced by a later, narrower command-only Requirements list.
const BEHAVIORAL_GOAL_LINE = /^\s{0,3}(?:ACTION:\s*)?(?:please\s+)?(?:fix|repair|change|update|implement|make|ensure|support)\b.{1,240}\bso\b.{1,240}\b(?:returns?|return|equals?|equal|produces?|outputs?|becomes?|is|exports?)\b.{1,160}[.!]?\s*$/i
// A quantified outcome ("include every record") is directly observable even
// without a "so ... is" clause and must not be displaced by a command-only
// Requirements list.
const QUANTIFIED_BEHAVIORAL_GOAL_LINE = /^\s{0,3}(?:please\s+)?(?:fix|repair|change|update|implement|make|ensure|support|add|extend)\b.{1,240}\b(?:include|includes|excluding|exclude|excludes|return|returns|export|exports|cover|covers|handle|handles|preserve|preserves|keep)\b.{1,200}\b(?:every|all|each|any|none|only)\b.{0,120}[.!]?\s*$/i
// Additional operative goal lines in the same opening prose block. They are
// only admitted when at least one sibling line states an observable behavioral
// objective, so ordinary context or a lone vague instruction is unchanged.
const OPERATIVE_GOAL_LINE = /^\s{0,3}(?:ACTION:\s*)?(?:please\s+)?(?:(?:also|additionally|and)\b[\s,:]*)?(?:fix|repair|change|update|implement|make|ensure|support|add|remove|delete|create|refactor|migrate|upgrade|replace|rename|improve|document|write|apply|extend|adjust)\b.{1,300}$/i
const GOAL_LABEL = /^ {0,3}(?:(?:goal|objective):|\*\*(?:goal|objective):\*\*)[ \t]+/i
const OPENING_TASK_HEADING = /^ {0,3}#{1,6}[ \t]+task(?:[ \t]+#+)?[ \t]*$/i
const NON_OPERATIVE_GOAL_QUALIFIER = /\([ \t]*(?:example only|not required)(?:[ \t]*[;,][ \t]*(?:example only|not required))*[ \t]*\)[.!]?[ \t]*$/i
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

interface OpeningLabeledGoal {
  text: string
  start: number
  end: number
  operative: boolean
}

function labeledGoalBody(line: string): string | undefined {
  const prefix = line.match(GOAL_LABEL)?.[0]
  return prefix ? line.slice(prefix.length).trim() : undefined
}

function behaviorBeforeVerifierLink(body: string): string {
  // A marker written as part of a required output is not a verifier clause.
  // Scan only the v4 label projection; historical replay and command binding
  // retain their existing grammar and still reject ambiguous links.
  const separator = /[.;]\s+verified by:/iy
  const word = /[\p{L}\p{N}_]/u
  const codeSpanEnds = new Map<number, number>()
  const nextRunEnd = new Map<number, number>()
  for (const run of [...body.matchAll(/`+/g)].reverse()) {
    const width = run[0].length
    const end = nextRunEnd.get(width)
    if (end !== undefined) codeSpanEnds.set(run.index, end)
    nextRunEnd.set(width, run.index + width)
  }
  let quoteEnd = ''
  for (let i = 0; i < body.length; i++) {
    const char = body[i]!
    if (char === '\\') { i++; continue }
    // Matched code spans are opaque even inside a prose quote: a quote
    // character in the span must not close the surrounding literal.
    const codeEnd = codeSpanEnds.get(i)
    if (codeEnd !== undefined) { i = codeEnd - 1; continue }
    const afterWord = (char === "'" || char === '’') && word.test(body[i - 1] ?? '')
    if (quoteEnd) {
      if (char === quoteEnd && !(afterWord && word.test(body[i + 1] ?? ''))) quoteEnd = ''
      continue
    }
    if (char === '"' || (char === "'" && !afterWord)) quoteEnd = char
    else if (char === '“') quoteEnd = '”'
    else if (char === '‘') quoteEnd = '’'
    else if (char === '.' || char === ';') {
      separator.lastIndex = i
      if (separator.test(body)) return body.slice(0, i)
    }
  }
  return body
}

function isObservableGoal(line: string): boolean {
  return BEHAVIORAL_GOAL_LINE.test(line) || QUANTIFIED_BEHAVIORAL_GOAL_LINE.test(line)
}

function isOperativeBehavioralGoal(body: string): boolean {
  return isObservableGoal(body) && OPERATIVE_GOAL_LINE.test(body)
}

/** V4 comparison text: remove only a recognized behavioral goal's outer label. */
export function labeledBehavioralGoalText(line: string): string | undefined {
  const body = labeledGoalBody(line)
  return body && isOperativeBehavioralGoal(body) && !NON_OPERATIVE_GOAL_QUALIFIER.test(body)
    ? body
    : undefined
}

/** V4 opening framing, also used by task routing. Offsets refer to the original labeled line. */
export function findOpeningLabeledGoal(request: string): OpeningLabeledGoal | undefined {
  if (request.length > MAX_INPUT_CHARS) return undefined
  let start = 0
  let seenTaskHeading = false
  for (const raw of request.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.trim()) {
      if (!seenTaskHeading && OPENING_TASK_HEADING.test(line)) {
        seenTaskHeading = true
      } else {
        const text = labeledGoalBody(line)
        if (!text) return undefined
        const operative = !NON_OPERATIVE_GOAL_QUALIFIER.test(behaviorBeforeVerifierLink(text))
        if (operative && !isOperativeBehavioralGoal(text)) return undefined
        return { text, start, end: start + line.length, operative }
      }
    }
    start += raw.length + 1
  }
  return undefined
}

type V4GoalProjection = { opening: OpeningLabeledGoal | undefined }

function projectV4Criterion(
  description: string,
  status: AcceptanceMeaningStatus,
  start: number,
  opening: OpeningLabeledGoal | undefined,
): string | undefined {
  if (status === 'inferred' && opening?.start === start)
    return opening.operative ? opening.text : undefined
  if (status !== 'explicit') return description
  const body = labeledGoalBody(description)
  if (!body) return description
  // Keep a declared verifier clause verbatim. The binding stage compares its
  // behavior separately. Standalone labels are framing, so exact amendments
  // can recognize an unchanged goal without rewriting any literal in its body.
  const behavior = behaviorBeforeVerifierLink(body)
  if (NON_OPERATIVE_GOAL_QUALIFIER.test(behavior)) return undefined
  return behavior === body && isOperativeBehavioralGoal(body) ? body : description
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
  meaningRef: string,
  opening?: OpeningLabeledGoal,
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
  let behavioral = false
  const seenCandidate = new Set<string>()
  const candidates: { text: string; start: number; end: number; labeled: boolean }[] = []
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '')
    // Markdown indented code may use four spaces or a tab. Keep it outside
    // active task prose just like fenced code, including tab-plus-space forms.
    if (/^(?: {4,}| {0,3}\t)/.test(line)) { offset += raw.length + 1; continue }
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
    // Bullets are explicit acceptance criteria in the base interpretation;
    // this bridge never reinterprets them as opening goals.
    if (/^\s{0,3}(?:[-*+•]|\d+[.)])\s+/.test(line)) break
    if (line.trim() && headingDepth === undefined) {
      const labeled = opening?.start === offset && opening.operative ? opening : undefined
      if (!labeled && isObservableGoal(line)) behavioral = true
      if (labeled || OPERATIVE_GOAL_LINE.test(line)) {
        const text = labeled?.text ?? line.trim()
        if (!seenCandidate.has(text)) {
          seenCandidate.add(text)
          candidates.push({ text, start: offset, end: offset + line.length, labeled: labeled !== undefined })
        }
      }
    }
    offset += raw.length + 1
  }
  // A labeled goal retains only its own observable obligation. It does not
  // make neighboring imperatives operative as an unlabeled v3 goal would.
  if (candidates.length === 0) return meaning
  const existing = new Set(meaning.criteria.map(item => item.description))
  const preserved = candidates.filter(item =>
    (behavioral || item.labeled) && !existing.has(item.text) &&
    // The base projection can already have admitted the full labeled line.
    (!item.labeled || !existing.has(request.slice(item.start, item.end).trim())),
  )
  if (!preserved.length) return meaning
  const inputDigest = sha256Canonical(request)

  const makeCriterion = (found: { text: string }): AcceptanceRequirementV1 => {
    const id = `acceptance:${sha256Canonical({ description: found.text, status: 'inferred' }).slice(0, 32)}`
    return {
      id,
      description: found.text,
      type: 'custom',
      required: true,
      verification: { kind: 'custom', verifier_id: `meaning:${id}:${inputDigest.slice(0, 16)}` },
      verification_strategy: 'The explicit behavioral goal remains a separate requirement; a command-only success does not prove it unless that exact behavior is covered by an authorized verifier.',
    }
  }

  const room = Math.max(0, MAX_CRITERIA - meaning.criteria.length)
  const admitted = preserved.slice(0, room)
  const overflow = preserved.slice(admitted.length)
  const admittedCriteria = admitted.map(makeCriterion)
  const admittedSources: AcceptanceMeaningSource[] = admittedCriteria.map((item, index) => ({
    criterion_id: item.id,
    status: 'inferred',
    input_digest: inputDigest,
    start: admitted[index]!.start,
    end: admitted[index]!.end,
  }))
  const admittedProvenance: TaskContractProvenanceRecord[] = admittedCriteria.map((item, index) => ({
    kind: 'derived_acceptance',
    ref: `${meaningRef}:inferred:${inputDigest}:${admitted[index]!.start}:${admitted[index]!.end}:${item.id}`,
  }))

  let criteria = [...admittedCriteria, ...meaning.criteria]
  let sources = [...admittedSources, ...meaning.sources]
  let provenance = [...admittedProvenance, ...meaning.provenance]
  let unresolved = meaning.unresolved
  let structurallyComplete = meaning.structurallyComplete

  // The parser already enforces the cap. If there is no room for the
  // additional obligation(s), combine them with the final criterion as one
  // unresolved requirement. The admitted contract therefore retains every
  // obligation and cannot certify any of them from unrelated command evidence.
  if (overflow.length) {
    const lastCriterion = criteria[MAX_CRITERIA - 1]!
    const lastSource = sources.find(source => source.criterion_id === lastCriterion.id)
    const combinedDescription = `${overflow.map(item => item.text).join(' Also, ')} Also, ${lastCriterion.description}`
    const description = combinedDescription.length <= MAX_CRITERION_CHARS
      ? combinedDescription
      : 'Acceptance capture limit exceeded; the opening behavioral objectives and displaced acceptance requirement remain unresolved and cannot be certified.'
    const id = `acceptance:${sha256Canonical({ description, status: 'unresolved' }).slice(0, 32)}`
    const combined: AcceptanceRequirementV1 = {
      id,
      description,
      type: 'custom',
      required: true,
      verification: { kind: 'custom', verifier_id: `meaning:${id}:${inputDigest.slice(0, 16)}` },
      verification_strategy: 'Acceptance requirements exceeded the capture limit; both combined obligations require independent evidence before completion can be certified.',
    }
    criteria = [...criteria.slice(0, MAX_CRITERIA - 1), combined]
    sources = [...sources.filter(source => source.criterion_id !== lastCriterion.id), {
      criterion_id: id,
      status: 'unresolved',
      input_digest: inputDigest,
      start: overflow[0]!.start,
      end: lastSource?.end ?? overflow.at(-1)!.end,
    }]
    provenance = [{
      kind: 'derived_acceptance',
      ref: `${meaningRef}:unresolved:${inputDigest}:${overflow[0]!.start}:${lastSource?.end ?? overflow.at(-1)!.end}:${id}`,
    }, ...provenance]
    unresolved = true
    structurallyComplete = false
  }

  return {
    ...meaning,
    criteria,
    sources,
    provenance,
    unresolved,
    structurallyComplete,
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

function interpretTaskAcceptance(request: string, opts: InterpretOptions, v4?: V4GoalProjection): TaskAcceptanceMeaning {
  const inputDigest = sha256Canonical(request)
  const opening = v4?.opening
  const criteria: AcceptanceRequirementV1[] = []
  const sources: AcceptanceMeaningSource[] = []
  const activeProse: string[] = []
  const seen = new Set<string>()
  let incomplete = request.length > MAX_INPUT_CHARS
  const add = (description: string, status: AcceptanceMeaningStatus, start: number, end: number) => {
    const text = description.trim()
    const normalized = v4 ? projectV4Criterion(text, status, start, opening) : text
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
      if (opening?.start === start && !opening.operative) continue
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

function interpretV1Projection(request: string, v4?: V4GoalProjection): TaskAcceptanceMeaning {
  return interpretTaskAcceptance(request, {
    version: 1,
    meaningRef: ACCEPTANCE_MEANING_REF_V1,
    admitActiveProseSpans: false,
    unresolvedWhenEmpty: true,
  }, v4)
}

/** v1 replay semantics (frozen). */
export function inferTaskAcceptanceV1(request: string): TaskAcceptanceMeaning {
  return interpretV1Projection(request)
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

function interpretV2Projection(request: string, v4?: V4GoalProjection): TaskAcceptanceMeaning {
  const legacy = interpretV1Projection(request, v4)
  if (hasRawPythonFunctionDefinition(request)) {
    const rawFunctionMeaning = interpretTaskAcceptance(request, {
      version: 2,
      meaningRef: ACCEPTANCE_MEANING_REF_V2,
      admitActiveProseSpans: true,
      unresolvedWhenEmpty: false,
    }, v4)
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
  }, v4)
}

/**
 * v2 replay: use v1 when it already yields real criteria or structural incompleteness;
 * otherwise fall back to provisional active-prose capture (short vague requests only).
 */
export function inferTaskAcceptanceV2(request: string): TaskAcceptanceMeaning {
  return interpretV2Projection(request)
}

function inferTaskAcceptanceWithBehavioralGoals(request: string, version: 3 | 4): TaskAcceptanceMeaning {
  const v4 = version === 4 ? { opening: findOpeningLabeledGoal(request) } : undefined
  const previous = interpretV2Projection(request, v4)
  const v2Prefix = `${ACCEPTANCE_MEANING_REF_V2}:`
  const meaningRef = acceptanceMeaningRefForVersion(version)
  const versioned: TaskAcceptanceMeaning = {
    ...previous,
    interpretation_version: version,
    provenance: previous.provenance.map(record => ({
      ...record,
      ref: record.ref.startsWith(v2Prefix) ? record.ref.replace(v2Prefix, `${meaningRef}:`) : record.ref,
    })),
  }
  return preserveBehavioralGoal(versioned, request, meaningRef, v4?.opening)
}

/** Frozen v3 replay preserves the original behavioral-goal interpretation. */
export function inferTaskAcceptanceV3(request: string): TaskAcceptanceMeaning {
  return inferTaskAcceptanceWithBehavioralGoals(request, 3)
}

/** V4 preserves an observable opening goal with a Goal or Objective label. */
export function inferTaskAcceptanceV4(request: string): TaskAcceptanceMeaning {
  return inferTaskAcceptanceWithBehavioralGoals(request, 4)
}

/** Live acceptance admission and verifier dependency selection share this policy. */
export const inferFreshTaskAcceptance = inferTaskAcceptanceV4

/** Default export path preserves v1 outputs for existing callers and replay tests. */
export function inferTaskAcceptance(request: string): TaskAcceptanceMeaning {
  return inferTaskAcceptanceV1(request)
}

export function inferTaskAcceptanceForVersion(
  request: string,
  version: TaskAcceptanceMeaningVersion,
): TaskAcceptanceMeaning {
  if (version === 4) return inferTaskAcceptanceV4(request)
  if (version === 3) return inferTaskAcceptanceV3(request)
  return version === 2 ? inferTaskAcceptanceV2(request) : inferTaskAcceptanceV1(request)
}

export function acceptanceMeaningRefForVersion(version: TaskAcceptanceMeaningVersion): string {
  return ACCEPTANCE_MEANING_REFS.get(version) ?? ACCEPTANCE_MEANING_REF_V1
}

function versionOfAcceptanceMeaningRef(ref: string): TaskAcceptanceMeaningVersion | undefined {
  for (const [version, prefix] of ACCEPTANCE_MEANING_REFS) {
    if (ref.startsWith(`${prefix}:`)) return version
  }
  return undefined
}

export function isAcceptanceMeaningDerivedRef(ref: string): boolean {
  return versionOfAcceptanceMeaningRef(ref) !== undefined
}

export type AcceptanceMeaningVersionResolution =
  | { kind: 'version'; version: TaskAcceptanceMeaningVersion }
  | { kind: 'legacy_absent_ref'; version: 1 }

const ACCEPTANCE_MEANING_NAMESPACE_PREFIX = 'task-acceptance-meaning:'

function recordedMeaningVersions(records: readonly TaskContractProvenanceRecord[]): Set<TaskAcceptanceMeaningVersion> {
  const versions = new Set<TaskAcceptanceMeaningVersion>()
  for (const record of records) {
    if (record.kind !== 'derived_acceptance') continue
    const ref = record.ref
    const version = versionOfAcceptanceMeaningRef(ref)
    if (version !== undefined) {
      versions.add(version)
    } else if (ref.startsWith(ACCEPTANCE_MEANING_NAMESPACE_PREFIX)) {
      throw new Error('TASK_ACCEPTANCE_MEANING_VERSION_UNSUPPORTED: Malformed or unknown acceptance-meaning provenance ref')
    }
  }
  return versions
}

/**
 * Resolve interpretation version from recorded provenance. Mixed-version refs reject.
 * Absent per-criterion meaning refs fall back to v1 only for the explicit legacy placeholder shape.
 */
export function resolveAcceptanceMeaningVersion(
  records: readonly TaskContractProvenanceRecord[],
  contract?: TaskContractV1,
): AcceptanceMeaningVersionResolution {
  const versions = recordedMeaningVersions(records)
  if (versions.size > 1) {
    throw new Error('TASK_ACCEPTANCE_MEANING_VERSION_MIXED: Contract provenance records multiple acceptance-meaning versions')
  }
  const [version] = versions
  if (version !== undefined) return { kind: 'version', version }
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

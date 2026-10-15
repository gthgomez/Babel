import { sha256Canonical } from '../acceptance/canonical.js'
import type { AcceptanceRequirementV1, TaskContractProvenanceRecord } from './taskContract.js'

export const ACCEPTANCE_MEANING_REF = 'task-acceptance-meaning:v1'
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
}

/** Patch-blind meaning capture; source text never grants effects or proves a check. */
export function inferTaskAcceptance(request: string): TaskAcceptanceMeaning {
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
        // Child headings, including "Requirements", still belong to the example.
        if (headingDepth === undefined ? !(plainExample && plainRequirements) : headingDepth > exampleDepth) continue
        example = false
      }
      if (headingDepth !== undefined) sectionDepth = headingDepth
      if (/^(?:acceptance criteria|requirements?)\s*:?\s*$/i.test(heading)) { activeProse.push(line.trim()); example = false; requirementRegion = true; listIndent = undefined; continue }
      if (/^(?:(?:for )?examples?(?: (?:input|output|text|code)| of [^:]{1,100})?|sample(?: (?:input|output|text|code))?|logs?|quoted (?:text|content))(?:\s*:|\s*$)/i.test(heading)) { example = true; exampleDepth = sectionDepth; plainExample = headingDepth === undefined; continue }
      if (/^(?:non[-\s]*goals?|out[-\s]+of[-\s]+scope|exclusions?|not required)(?:\s*:|\s*$)/i.test(heading)) { activeProse.push(line.trim()); exclusionDepth = sectionDepth; plainExclusion = headingDepth === undefined; continue }
      activeProse.push(line.trim())
      if (/^\s{0,3}#{1,6}\s+/.test(line)) { example = false; listIndent = undefined; continue }
      if (/^\s{0,3}(?:also|additionally|and)\b[\s,:]*/i.test(line)) {
        requirementRegion = true
        if (/^\s{0,3}(?:also|additionally|and)\b[\s,:]*require\s*:\s*$/i.test(line)) continue
      }
      const bullet = line.match(/^( *)(?:[-*+•]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.+?)\s*$/)
      if (bullet) {
        const indent = bullet[1]!.length
        listIndent ??= indent
        if (indent > listIndent || indent > 3) { incomplete = true; continue }
        add(bullet[2]!, 'explicit', start, end)
        continue
      }
      const inline = line.match(/^\s{0,3}(?:acceptance criteria|requirements?)\s*:\s*(.+?)\s*$/i)
      if (inline) { requirementRegion = true; add(inline[1]!, 'explicit', start, end); continue }
      if (/^\S/.test(line) && /\b(?:must|shall|should|needs? to|required to|ensure|preserve|reject|support|prevent)\b/i.test(line))
        inferred.push({ text: line.trim(), start, end })
      else if ((requirementRegion || listIndent !== undefined || inferred.length > 0) && line.trim()) incomplete = true
    }
    if (fence) incomplete = true
    for (const item of inferred) add(item.text, 'inferred', item.start, item.end)
  }
  if (!criteria.length || incomplete) {
    // Never silently drop an over-limit or structurally ambiguous obligation.
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
    provenance: sources.map(source => ({
      kind: 'derived_acceptance',
      ref: `${ACCEPTANCE_MEANING_REF}:${source.status}:${source.input_digest}:${source.start}:${source.end}:${source.criterion_id}`,
    })),
    unresolved: sources.some(source => source.status === 'unresolved'),
  }
}

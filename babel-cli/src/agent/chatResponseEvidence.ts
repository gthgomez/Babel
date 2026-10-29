/** Narrow checks for explicit test-result claims, not a general prose evaluator. */
import { analyzeVerifierIdentity, satisfiesVerifierRequirement } from '../services/verifierIdentity.js'
import { verifierEvidenceCaveats } from './chatEngineVerifierAdapter.js'
import { strictCountPolicy } from './completionGatePolicy.js'
export type ResponseVerifierEvidence = {
  command: string; exit_code: number; authority?: boolean; stale?: boolean; scope?: string
  tests_total?: number; tests_skipped?: number; tests_passed?: number | undefined; tests_failed?: number
  capturedAt?: number
} | null

export function responseVerifierFacts(receipt: ResponseVerifierEvidence): string {
  if (!receipt || receipt.authority !== true) return 'No authoritative test execution is recorded.'
  return `Recorded verifier: ${receipt.command}; exit ${receipt.exit_code}; ${receipt.stale === false ? 'current' : 'stale or freshness unknown'}; scope ${receipt.scope ?? 'unknown'}; tests ${receipt.tests_total ?? 'unknown'}, skipped ${receipt.tests_skipped ?? 'unknown'}.`
}

const commandFamily = String.raw`(?:npm\s+test|node\s+--test|pytest|go\s+test|cargo\s+test)`
/** Extract explicit commands without interpreting surrounding prose as selectors. */
function commandAt(text: string, start: number): {command: string; end: number} | null {
  if (text[start] === '`') {
    const end = text.indexOf('`', start + 1)
    if (end < 0 || end - start > 500) return null
    return {command:text.slice(start + 1,end),end:end + 1}
  }
  const family = new RegExp(`^${commandFamily}\\b`, 'i').exec(text.slice(start))
  if (!family) return null
  let end = start + family[0].length
  for (let count = 0; count < 32 && end - start < 500; count++) {
    const token = /^[ \t]+("[^"\n]*"|'[^'\n]*'|[^\s;!?→—`,]+)/.exec(text.slice(end,start + 500))
    if (!token || /^(?:and|but|which|then|with|successfully|failed|passed|succeeded|exit|if|when|unless|provided|because|after|before|today|yesterday)[.:]?$/i.test(token[1]!)) break
    end += token[0].length
    if (/[.:]$/.test(token[1]!)) break
  }
  const command = text.slice(start,end).replace(/(?<=[\w"'])[.:]$/, '')
  return {command,end}
}

function* explicitClaims(prose: string) {
  const claims = new RegExp(String.raw`\b(?:(?<count>\d+)\s+)?(?<unit>tests?|test suite|suite)\s+(?:(?:all|already|now)\s+)*(?:pass(?:es|ed)?|(?:is|are|was|were)\s+(?:passing|green|successful))\b|(?<execution>\b(?:I\s+|we\s+)?(?:have\s+)?(?:ran|executed)\s+)(?=\x60?${commandFamily}\b)|\x60?${commandFamily}\b`, 'gi')
  for (let match; (match = claims.exec(prose));) {
    const generic = /^(?:\d+\s+)?(?:tests?|test suite|suite)\s/i.test(match[0])
    const parsed = generic ? null : commandAt(prose,match.groups?.execution ? claims.lastIndex : match.index)
    if (!generic && !parsed) continue
    const end = parsed?.end ?? claims.lastIndex
    const tail = prose.slice(end)
    const result = /^\s*(?:[→:—-]\s*)?(?:passed|succeeded|exit(?:\s+code)?\s*[:=]?\s*0)\b/i.exec(tail)
    if (!generic && !match.groups?.execution && !result) { claims.lastIndex = end; continue }
    yield {index:match.index,text:prose.slice(match.index,end + (result?.[0].length ?? 0)),
      unit: match.groups?.unit,
      count: match.groups?.count === undefined ? undefined : Number(match.groups.count),
      command:parsed?.command,tail,execution:!!match.groups?.execution}
    claims.lastIndex = end + (result?.[0].length ?? 0)
  }
}

/** Recommendations, hypotheticals and attributed examples are not execution claims. */
export function unsupportedTestClaim(answer: string, receipt: ResponseVerifierEvidence,
  ledger: readonly NonNullable<ResponseVerifierEvidence>[] = []): boolean {
  const current = new Map<string, NonNullable<ResponseVerifierEvidence>>()
  const ordered = [...ledger, ...(receipt ? [receipt] : [])]
    .sort((a, b) => (a.capturedAt ?? 0) - (b.capturedAt ?? 0))
  for (const entry of ordered) {
    for (const [key, earlier] of current)
      if (satisfiesVerifierRequirement(earlier.command, entry.command)) current.delete(key)
    current.set(analyzeVerifierIdentity(entry.command)?.identityKey ?? entry.command, entry)
  }
  const prose = answer.replace(/```[\s\S]*?```/g, '')
    .replace(/^\s*>.*$/gm, '')
    .replace(/\b(?:says?|said|claims?|claimed|wrote)\s*[: ,]*["“][^"”]*["”]/gi, '')
  let priorCommand: { command: string; end: number } | undefined
  for (const match of explicitClaims(prose)) {
    const prefix = prose.slice(0, match.index).split(/[.!?\n;]/).at(-1) ?? ''
    const tail = match.tail
    const suffix = tail.split(/[.!?\n;]/)[0] ?? ''
    if (/\b(?:if|whether|until|once|unless|when)\b/i.test(prefix) ||
        /^\s+(?:if|when|unless|provided)\b/i.test(suffix) ||
        /\b(?:no|not|never|cannot|can't|don't|didn't|haven't)\s+(?:\w+\s+){0,3}$/i.test(prefix) ||
        (/^\s*(?:do|does|did|have|has|are|were|was|can|could|would)\b/i.test(prefix) && /^[^.!\n]*\?/.test(tail)) ||
        /^\s*(?:(?:you(?: can| should)?|please|next,?|then|to)\s+)?(?:check|verify|ensure|make sure)\s+(?:that\s+)?$/i.test(prefix)) continue
    const numeric = match.count !== undefined
    if (numeric && !/^tests?$/i.test(match.unit ?? '')) return true
    const command = match.command ?? (numeric && priorCommand && !/[.!?\n;]/.test(prose.slice(priorCommand.end, match.index)) ? priorCommand.command : undefined)
    if (match.command) priorCommand = { command: match.command, end: match.index + match.text.length }
    const candidates = [...current.values()].filter(entry => entry.authority === true &&
      (command ? satisfiesVerifierRequirement(command, entry.command) :
        (analyzeVerifierIdentity(entry.command)?.family ?? 'unknown') !== 'unknown' &&
        strictCountPolicy(entry.command) === 'requires_executed_count'))
    if (!candidates.length) return true
    if (numeric && (candidates.length !== 1 || !Number.isSafeInteger(match.count) ||
      candidates[0]!.tests_passed !== match.count || candidates[0]!.tests_failed !== 0 ||
      (candidates[0]!.tests_passed ?? 0) > (candidates[0]!.tests_total ?? -1))) return true
    const scopePrefix = numeric && command && priorCommand ? prose.slice(priorCommand.end, match.index) : prefix
    // A red/stale receipt supports an execution report, not a passing/current result.
    const executionOnly = match.execution &&
      !/\b(?:successfully|passed|green|exit(?:\s+code)?\s*0)\b/i.test(suffix)
    const assertsPassingTests = !/\bexit(?:\s+code)?\s*[:=]?\s*0\b/i.test(match.text)
    if (!executionOnly && candidates.some(entry => entry.exit_code !== 0 || entry.stale !== false ||
        (((!command) || (numeric && /\b(?:all|(?:entire|whole|full)\s+(?:test\s+)?suite)\b/i.test(`${scopePrefix} ${match.text} ${suffix}`))) && entry.scope !== 'full_suite') ||
        (assertsPassingTests && (!Number.isFinite(entry.tests_total) ||
          (entry.tests_total ?? 0) <= (entry.tests_skipped ?? 0) ||
          verifierEvidenceCaveats({ exit_code: entry.exit_code,
            ...(entry.tests_total !== undefined ? { tests_total: entry.tests_total } : {}),
            ...(entry.tests_skipped !== undefined ? { tests_skipped: entry.tests_skipped } : {}),
          }).length > 0)))) return true
  }
  return false
}

/** Detect explicit completed file-work claims when this submission has no confirmed mutation.
 * This is a narrow delivery-honesty check, not an assessment of task correctness.
 */
export function unsupportedMutationClaim(answer: string, hasConfirmedMutation: boolean): boolean {
  if (hasConfirmedMutation) return false
  const prose = answer.replace(/```[\s\S]*?```/g, '')
    .replace(/^\s*>.*$/gm, '')
    .replace(/\b(?:says?|said|claims?|claimed|wrote)\s*[: ,]*["“][^"”]*["”]/gi, '')
  const verbs = String.raw`(?:updated|modified|changed|edited|created|wrote|saved|fixed|implemented|added|removed|deleted|renamed|patched)`
  const artifact = String.raw`(?:(?:(?:the|a|an)\s+)?(?:repository\s+map|repo(?:sitory)?|files?|code|implementation|source|patch|scripts?|modules?|bug|defect|[\w./\\-]+\.(?:[cm]?[jt]sx?|md|json|py|txt|html|css|csv))\b|\x60[^\x60\n]+\x60)`
  const claims = new RegExp(String.raw`\b(?:I|we)\s+(?:(?:have|just|now|already|successfully)\s+)*${verbs}\s+${artifact}|(?:^|[.!?\n])\s*(?:[-*]\s*)?${verbs}\s+${artifact}|${artifact}\s+(?:was|were|has been|have been)\s+(?:(?:just|now|successfully)\s+)*${verbs}\b`, 'gi')
  for (const claim of prose.matchAll(claims)) {
    const prefix = prose.slice(0, claim.index).split(/[.!?\n;]/).at(-1) ?? ''
    const remainder = prose.slice(claim.index! + claim[0].length)
    const tail = remainder.split(/[.!?\n;]/)[0] ?? ''
    if ((/\b(?:code|implementation|patch)\b/i.test(claim[0]) &&
          /^\s+(?:below|inline|in this (?:answer|response)|in the (?:example|code block))\b/i.test(tail)) ||
        /^\s*\?/.test(remainder) ||
        /\b(?:if|whether|unless|when|suppose|imagine)\b/i.test(prefix) ||
        /^\s+(?:if|when|unless|provided)\b/i.test(tail) ||
        /\b(?:no|not|never|cannot|can't|don't|didn't|haven't)\s+(?:\w+\s+){0,3}$/i.test(prefix) ||
        (/^\s*(?:do|does|did|have|has|was|were|can|could|would)\b/i.test(prefix) && /^[^.!;\n]*\?/.test(remainder)) ||
        /(?:^|\b)(?:check|verify|ensure|make sure)\s+(?:that\s+)?$/i.test(prefix) ||
        /\b(?:yesterday|previously|before this (?:task|session)|by (?:another|the previous))\b/i.test(tail)) continue
    return true
  }
  return false
}

export function responseEvidenceCorrection(receipt: ResponseVerifierEvidence, missingMutation = false, proposedAnswer = ''): string {
  if (missingMutation) return 'Response evidence correction: No confirmed file mutation is recorded for this submission. Your proposed answer claims a file change was completed. Correct the answer once: remove or qualify that claim, retain useful inspection findings and the requested output format. An already-correct file can be reported as needing no change. You may answer truthfully without running tools or making changes.'
  if (receipt?.authority === true && receipt.exit_code === 0 && receipt.stale === false && receipt.tests_total === 0) {
    return `Response evidence correction: ${responseVerifierFacts(receipt)} This receipt confirms ${receipt.command} executed and exited 0, but the runner reported zero tests. It is not evidence that a test suite passed. Claims about other commands need their own matching evidence; remove or qualify unsupported command claims. Retain the artifact summary, computation, and useful inspection findings. State the zero-test limitation plainly and provide a substantive answer in the requested format.`
  }
  if (/\b\d+\s+tests?\s+pass(?:es|ed)?\b/i.test(proposedAnswer) &&
      receipt?.authority === true && receipt.exit_code === 0 && receipt.stale === false &&
      (receipt.tests_total ?? 0) > (receipt.tests_skipped ?? 0) && receipt.tests_passed === undefined) {
    return `Response evidence correction: ${responseVerifierFacts(receipt)} This receipt confirms ${receipt.command} executed and exited 0; an exact pass count is not recorded. Remove numeric pass/fail claims. Claims about other commands need their own matching evidence; remove or qualify any unsupported ones. Report the recorded command, exit status, and count uncertainty. Retain the file-change summary, useful inspection findings, and requested output format. Do not replace the answer with a placeholder.`
  }
  return `Response evidence correction: ${responseVerifierFacts(receipt)} Your proposed answer claims tests ran or passed without matching evidence. Correct the answer once: remove or qualify that claim, retain any useful clarification and the requested output format. Reading test source is not running tests. You may answer truthfully without running tools or making changes.`
}

/** A punctuation-only reply after an evidence correction carries no usable task answer. */
export function isPunctuationOnlyAnswer(answer: string): boolean {
  return !/[\p{L}\p{N}]/u.test(answer)
}

/** Bounded answer correction after the host validates execution and mutation facts. */
export class ResponseEvidenceRetry {
  private evidenceRepairUsed = false
  private punctuationRepairUsed = false
  private priorGuidance = ''

  inspect(input: {
    answer: string
    receipt: ResponseVerifierEvidence
    ledger: readonly NonNullable<ResponseVerifierEvidence>[]
    hasConfirmedMutation: boolean
    turn: number
    maxTurns: number
  }): { kind: 'retry'; feedback: string; thought: string } | { kind: 'fail'; message: string } | null {
    const { answer, receipt, ledger, hasConfirmedMutation, turn, maxTurns } = input
    if (this.evidenceRepairUsed && isPunctuationOnlyAnswer(answer)) {
      if (this.punctuationRepairUsed || turn + 1 >= maxTurns)
        return { kind: 'fail', message: 'RESPONSE_EVIDENCE_INVALID: evidence correction produced no usable answer.' }
      this.punctuationRepairUsed = true
      return { kind: 'retry',
        feedback: `Your evidence correction contained only punctuation. Provide a substantive task answer now; do not return a placeholder. Follow the prior evidence correction and retain useful findings and accurate change/verification details. ${this.priorGuidance}`,
        thought: '[Requesting a substantive evidence-matched answer]' }
    }
    const missingMutation = unsupportedMutationClaim(answer, hasConfirmedMutation)
    if (!missingMutation && !unsupportedTestClaim(answer, receipt, ledger)) return null
    if (this.evidenceRepairUsed || turn + 1 >= maxTurns)
      return { kind: 'fail', message: 'RESPONSE_EVIDENCE_INVALID: repeated completion claims lack corresponding execution or mutation evidence.' }
    this.evidenceRepairUsed = true
    this.priorGuidance = responseEvidenceCorrection(receipt, missingMutation, answer)
    return { kind: 'retry', feedback: this.priorGuidance,
      thought: missingMutation ? '[Correcting an unsupported mutation claim]' : '[Correcting an unsupported test-result claim]' }
  }
}

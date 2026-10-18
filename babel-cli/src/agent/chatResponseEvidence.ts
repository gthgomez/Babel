/** Narrow checks for explicit test-result claims, not a general prose evaluator. */
import { analyzeVerifierIdentity, satisfiesVerifierRequirement } from '../services/verifierIdentity.js'
import { verifierEvidenceCaveats } from './chatEngineVerifierAdapter.js'
import { strictCountPolicy } from './completionGatePolicy.js'
export type ResponseVerifierEvidence = {
  command: string; exit_code: number; authority?: boolean; stale?: boolean; scope?: string
  tests_total?: number; tests_skipped?: number
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
  const command = text.slice(start,end).replace(/(?<=[\w"'])\.$/, '')
  return {command,end}
}

function* explicitClaims(prose: string) {
  const claims = new RegExp(String.raw`\b(?:tests?|test suite|suite)\s+(?:(?:all|already|now)\s+)*(?:pass(?:es|ed)?|(?:is|are|was|were)\s+(?:passing|green|successful))\b|(?<execution>\b(?:I\s+|we\s+)?(?:have\s+)?(?:ran|executed)\s+)(?=\x60?${commandFamily}\b)|\x60?${commandFamily}\b`, 'gi')
  for (let match; (match = claims.exec(prose));) {
    const generic = /^(?:tests?|test suite|suite)\s/i.test(match[0])
    const parsed = generic ? null : commandAt(prose,match.groups?.execution ? claims.lastIndex : match.index)
    if (!generic && !parsed) continue
    const end = parsed?.end ?? claims.lastIndex
    const tail = prose.slice(end)
    const result = /^\s*(?:[→:—-]\s*)?(?:passed|succeeded|exit(?:\s+code)?\s*[:=]?\s*0)\b/i.exec(tail)
    if (!generic && !match.groups?.execution && !result) { claims.lastIndex = end; continue }
    yield {index:match.index,text:prose.slice(match.index,end + (result?.[0].length ?? 0)),
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
  for (const match of explicitClaims(prose)) {
    const prefix = prose.slice(0, match.index).split(/[.!?\n;]/).at(-1) ?? ''
    const tail = match.tail
    const suffix = tail.split(/[.!?\n;]/)[0] ?? ''
    if (/\b(?:if|whether|until|once|unless|when)\b/i.test(prefix) ||
        /^\s+(?:if|when|unless|provided)\b/i.test(suffix) ||
        /\b(?:no|not|never|cannot|can't|don't|didn't|haven't)\s+(?:\w+\s+){0,3}$/i.test(prefix) ||
        (/^\s*(?:do|does|did|have|has|are|were|was|can|could|would)\b/i.test(prefix) && /^[^.!\n]*\?/.test(tail)) ||
        /^\s*(?:(?:you(?: can| should)?|please|next,?|then|to)\s+)?(?:check|verify|ensure|make sure)\s+(?:that\s+)?$/i.test(prefix)) continue
    const command = match.command
    const candidates = [...current.values()].filter(entry => entry.authority === true &&
      (command ? satisfiesVerifierRequirement(command, entry.command) :
        (analyzeVerifierIdentity(entry.command)?.family ?? 'unknown') !== 'unknown' &&
        strictCountPolicy(entry.command) === 'requires_executed_count'))
    if (!candidates.length) return true
    // A red/stale receipt supports an execution report, not a passing/current result.
    const executionOnly = match.execution &&
      !/\b(?:successfully|passed|green|exit(?:\s+code)?\s*0)\b/i.test(suffix)
    const assertsPassingTests = !/\bexit(?:\s+code)?\s*[:=]?\s*0\b/i.test(match.text)
    if (!executionOnly && candidates.some(entry => entry.exit_code !== 0 || entry.stale !== false ||
        (!command && entry.scope !== 'full_suite') ||
        (assertsPassingTests && (!Number.isFinite(entry.tests_total) ||
          (entry.tests_total ?? 0) <= (entry.tests_skipped ?? 0) ||
          verifierEvidenceCaveats({ exit_code: entry.exit_code,
            ...(entry.tests_total !== undefined ? { tests_total: entry.tests_total } : {}),
            ...(entry.tests_skipped !== undefined ? { tests_skipped: entry.tests_skipped } : {}),
          }).length > 0)))) return true
  }
  return false
}

export function responseEvidenceCorrection(receipt: ResponseVerifierEvidence): string {
  return `Response evidence correction: ${responseVerifierFacts(receipt)} Your proposed answer claims tests ran or passed without matching evidence. Correct the answer once: remove or qualify that claim, retain any useful clarification and the requested output format. Reading test source is not running tests. You may answer truthfully without running tools or making changes.`
}

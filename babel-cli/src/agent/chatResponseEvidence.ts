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
  const claims = /\b(?:tests?|test suite|suite)\s+(?:(?:all|already|now)\s+)*(?:pass(?:es|ed)?|(?:is|are|was|were)\s+(?:passing|green|successful))\b|\b(?:I\s+|we\s+)?(?:have\s+)?(?:ran|executed)\s+`?(npm\s+test|node\s+--test|pytest|go\s+test|cargo\s+test)\b|\b(npm\s+test|node\s+--test|pytest|go\s+test|cargo\s+test)`?\s*(?:[→:—-]\s*)?(?:passed|succeeded|exit(?:\s+code)?\s*[:=]?\s*0)\b/gi
  for (const match of prose.matchAll(claims)) {
    const prefix = prose.slice(0, match.index).split(/[.!?\n;]/).at(-1) ?? ''
    const tail = prose.slice(match.index + match[0].length)
    const suffix = tail.split(/[.!?\n;]/)[0] ?? ''
    if (/\b(?:if|whether|until|once|unless|when)\b/i.test(prefix) ||
        /^\s+(?:if|when|unless|provided)\b/i.test(suffix) ||
        /\b(?:no|not|never|cannot|can't|don't|didn't|haven't)\s+(?:\w+\s+){0,3}$/i.test(prefix) ||
        (/^\s*(?:do|does|did|have|has|are|were|was|can|could|would)\b/i.test(prefix) && /^[^.!\n]*\?/.test(tail)) ||
        /^\s*(?:(?:you(?: can| should)?|please|next,?|then|to)\s+)?(?:check|verify|ensure|make sure)\s+(?:that\s+)?$/i.test(prefix)) continue
    const command = match[1] ?? match[2]
    const candidates = [...current.values()].filter(entry => entry.authority === true &&
      (command ? satisfiesVerifierRequirement(command, entry.command) :
        (analyzeVerifierIdentity(entry.command)?.family ?? 'unknown') !== 'unknown' &&
        strictCountPolicy(entry.command) === 'requires_executed_count'))
    if (!candidates.length) return true
    // A red/stale receipt supports an execution report, not a passing/current result.
    const executionOnly = /\b(?:ran|executed)\b/i.test(match[0]) &&
      !/\b(?:successfully|passed|green|exit(?:\s+code)?\s*0)\b/i.test(prose.slice(match.index, match.index + match[0].length + 30).split(/[.!?\n;]/)[0] ?? '')
    const assertsPassingTests = !/\bexit(?:\s+code)?\s*[:=]?\s*0\b/i.test(match[0])
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

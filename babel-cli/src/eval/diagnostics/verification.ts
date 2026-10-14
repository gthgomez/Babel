export function verifierMisuse(command: string): boolean {
  const trimmed = command.trim().toLowerCase()
  return /^(cat|type|Get-Content)\b/i.test(trimmed)
}

export type VerificationProseGrade = 'supported' | 'unsupported' | 'no_claim' | 'unknown'
export type VerificationProseKind = 'tests' | 'all_tests' | 'verification' | 'typecheck' | 'build'

/** Bounded English verifier claims, graded from receipts; never completion authority. */
export function gradeVerificationProse(input: {
  answer: string | null
  transcriptComplete: boolean
  currentPassingEvidence: Readonly<Record<VerificationProseKind, boolean | null>>
}): VerificationProseGrade {
  if (input.answer === null || !input.transcriptComplete) return 'unknown'
  const claims = /\b(?:all\s+)?tests?\s+(?:have\s+)?passed\b|\b(?:verification|typecheck|build)\s+(?:passed|succeeded)\b/ig
  const matches = [...input.answer.matchAll(claims)]
  if (matches.length === 0) return 'no_claim'
  // Quoted/negated claims need semantic grading; do not turn ambiguity into
  // either a supported claim or a measured absence of misleading prose.
  if (input.answer.includes('```') || matches.some(match => /^\s*>/.test(
    input.answer!.slice(input.answer!.lastIndexOf('\n', match.index) + 1, match.index),
  ) || /["“`]/.test(input.answer!.slice(Math.max(0, match.index! - 1), match.index)) || /\b(?:cannot|couldn't|can't|not|never|whether|if)\b/i.test(
    input.answer!.slice(Math.max(0, match.index! - 60), match.index),
  ))) return 'unknown'
  const evidence = matches.map(match => {
    const text = match[0].toLowerCase()
    const kind: VerificationProseKind = text.startsWith('all ') ? 'all_tests'
      : text.startsWith('test') ? 'tests'
      : text.startsWith('typecheck') ? 'typecheck'
      : text.startsWith('build') ? 'build' : 'verification'
    return input.currentPassingEvidence[kind]
  })
  if (evidence.some(value => value === null || value === undefined)) return 'unknown'
  return evidence.every(Boolean) ? 'supported' : 'unsupported'
}

/** Blinded grading data only. These helpers do not establish grader independence. */
import { z } from 'zod'
import { assessmentDigest, outputDigest } from './harness-journey-checks.js'
import type { JourneyBlindAssessment } from './harness-journey-oracle.js'

export interface JourneyBlindJob {
  readonly rubricId: string
  readonly requirements: string
  readonly rubricSha256: string
  readonly subjectSha256: string
  readonly answer: string
  readonly artifact: Readonly<{ text: string; sha256: string }> | null
}

/** Project only content/criteria, excluding route, model and candidate names. */
export function createJourneyBlindJob(input: {
  id: string; oracleId: string; requirements: string; answer: string
  artifact?: { text: string; sha256?: string }
}): JourneyBlindJob {
  if (input.oracleId !== `${input.id.toLowerCase()}-v1` || !input.requirements.trim() || Buffer.byteLength(input.answer + (input.artifact?.text ?? ''), 'utf8') > 1_048_576) throw new Error('Invalid blind job binding')
  const artifact = input.artifact ? Object.freeze({ text: input.artifact.text, sha256: outputDigest(input.artifact.text) }) : null
  return Object.freeze({ rubricId: input.oracleId, requirements: input.requirements,
    rubricSha256: outputDigest(input.requirements), subjectSha256: assessmentDigest(input.answer, artifact?.sha256), answer: input.answer, artifact })
}

/** Caller obtains scores in a separate trusted context and protects its receipt. */
export function bindJourneyBlindAssessment(job: JourneyBlindJob, value: unknown, evidenceRef: string): JourneyBlindAssessment {
  const score = z.number().int().min(1).max(3)
  const parsed = z.object({ subjectSha256: z.string(), rubricSha256: z.string(), rubricId: z.string(), relevant: score, coherent: score, uncertainty: score }).strict().parse(value)
  if (!evidenceRef || parsed.subjectSha256 !== job.subjectSha256 || parsed.rubricId !== job.rubricId || parsed.rubricSha256 !== job.rubricSha256 ||
    job.rubricSha256 !== outputDigest(job.requirements) || job.subjectSha256 !== assessmentDigest(job.answer, job.artifact?.sha256) ||
    job.artifact && job.artifact.sha256 !== outputDigest(job.artifact.text)) throw new Error('Independent blind assessment binding mismatch')
  return { outputSha256: job.subjectSha256, rubricId: job.rubricId, relevant: parsed.relevant, coherent: parsed.coherent, uncertainty: parsed.uncertainty, evidenceRef }
}

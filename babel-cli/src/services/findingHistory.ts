import { z } from 'zod'
import { StructuredFindingSchema, type StructuredFinding } from './structuredFinding.js'
import type { BabelReviewAdjudicationRecord } from './babelReviewAdjudication.js'

const resolutionSchema = z.object({ state: z.enum(['fixed', 'not_reproduced', 'pre_existing', 'dismissed']),
  reason: z.string(), head_sha: z.string(), dependency_paths: z.array(z.string()), evidence_refs: z.array(z.string()),
  authority: z.literal('operator_recorded_not_independently_verified'), supersedes_defect_id: z.string().optional(),
  adjudication_id: z.uuid().optional(), adjudication_recorded_at: z.iso.datetime().optional(),
}).strict()
export const FindingHistorySchema = z.object({
  schema_version: z.literal(1), repository: z.string(), pr_number: z.number().int().positive(), head_sha: z.string().regex(/^[a-f0-9]{40}$/),
  defects: z.array(z.object({ defect_id: z.string().regex(/^[a-f0-9]{64}$/),
    state: z.enum(['new', 'still_open', 'not_observed', 'source_refuted', 'reopened', 'fixed', 'not_reproduced', 'pre_existing', 'dismissed']),
    observations: z.array(StructuredFindingSchema).min(1), resolution: resolutionSchema.optional(),
    observation_heads: z.array(z.object({ finding_instance_id: z.string().regex(/^[a-f0-9]{64}$/),
      head_sha: z.string().regex(/^[a-f0-9]{40}$/),
    }).strict()).default([]),
  }).strict()),
}).strict()
export type FindingHistory = z.infer<typeof FindingHistorySchema>

/** Include deleted and added paths for renames; NUL preserves literal names. */
export function readFindingDependencyChanges(git: (args: string[]) => string, previousHead: string, head: string): string[] {
  if (![previousHead, head].every(value => /^[a-f0-9]{40}$/.test(value))) throw new Error('FINDING_HISTORY_HEAD_INVALID')
  return git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', previousHead, head]).split('\0').filter(Boolean)
}

/** Advisory revision history, never merge authority. Missing observations are
 * not proof of a repair; operator dispositions retain their limited authority. */
export function reconcileFindingHistory(input: {
  repository: string; prNumber: number; headSha: string; findings: StructuredFinding[];
  previous?: FindingHistory; changedPaths: string[]; adjudications?: BabelReviewAdjudicationRecord[];
  changedPathsFromHead?: (headSha: string) => string[] | undefined;
}): FindingHistory {
  const previous = input.previous
  if (previous && (previous.repository !== input.repository || previous.pr_number !== input.prNumber)) throw new Error('FINDING_HISTORY_CANDIDATE_MISMATCH')
  const current = new Map<string, StructuredFinding[]>()
  for (const finding of input.findings) {
    const observations = current.get(finding.finding_fingerprint) ?? []
    observations.push(finding)
    current.set(finding.finding_fingerprint, observations)
  }
  const defects: FindingHistory['defects'] = []
  const ids = new Set([...(previous?.defects.map(item => item.defect_id) ?? []), ...current.keys()])
  for (const id of ids) {
    const prior = previous?.defects.find(item => item.defect_id === id)
    const fresh = current.get(id) ?? []
    const observations = [...(prior?.observations ?? [])]
    const observationHeads = [...(prior?.observation_heads ?? [])]
    for (const finding of fresh) if (!observations.some(item => item.finding_instance_id === finding.finding_instance_id)) observations.push(finding)
    for (const finding of fresh) if (!observationHeads.some(item => item.finding_instance_id === finding.finding_instance_id && item.head_sha === input.headSha)) {
      observationHeads.push({ finding_instance_id: finding.finding_instance_id, head_sha: input.headSha })
    }
    const latestLabel = (input.adjudications ?? []).filter(label => label.subject.kind === 'finding' && label.defect_lifecycle &&
      label.candidate.repository === input.repository && label.candidate.pr_number === input.prNumber &&
      observationHeads.some(item => item.finding_instance_id === label.subject.id && item.head_sha === label.candidate.head_sha) &&
      observations.some(item => item.finding_instance_id === label.subject.id))
      .sort((a, b) => Date.parse(a.recorded_at) - Date.parse(b.recorded_at) || a.id.localeCompare(b.id)).at(-1)
    const priorLabelTime = prior?.resolution?.adjudication_recorded_at
    const labelIsNewer = latestLabel && (!priorLabelTime || Date.parse(latestLabel.recorded_at) > Date.parse(priorLabelTime) ||
      (Date.parse(latestLabel.recorded_at) === Date.parse(priorLabelTime) && latestLabel.id > (prior?.resolution?.adjudication_id ?? '')))
    const newLabel = labelIsNewer && latestLabel.id !== prior?.resolution?.adjudication_id ? latestLabel : undefined
    const resolution = newLabel?.defect_lifecycle ? { ...newLabel.defect_lifecycle,
      head_sha: newLabel.candidate.head_sha, adjudication_id: newLabel.id, adjudication_recorded_at: newLabel.recorded_at,
      evidence_refs: newLabel.evidence.map(item => item.ref), authority: newLabel.authority } : prior?.resolution
    const changedPaths = resolution && resolution.head_sha !== input.headSha
      ? input.changedPathsFromHead ? input.changedPathsFromHead(resolution.head_sha)
        : resolution.head_sha === previous?.head_sha ? input.changedPaths : undefined
      : []
    const dependenciesChanged = resolution && resolution.head_sha !== input.headSha &&
      (!changedPaths || resolution.dependency_paths.some(path => changedPaths.includes(path)))
    const state = dependenciesChanged || (!newLabel && prior?.state === 'reopened') ? 'reopened'
      : resolution ? resolution.state
      : fresh.length ? fresh.every(item => item.verification_status === 'SOURCE_REFUTED') ? 'source_refuted' : prior ? 'still_open' : 'new'
      : 'not_observed'
    defects.push({ defect_id: id, state, observations, observation_heads: observationHeads, ...(resolution ? { resolution } : {}) })
  }
  return FindingHistorySchema.parse({ schema_version: 1, repository: input.repository, pr_number: input.prNumber,
    head_sha: input.headSha, defects })
}

import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { assertReviewStateOutsideGit, safeReviewPath, secretRiskReviewPath } from './babelReviewSnapshot.js'

const sha = z.string().regex(/^[a-f0-9]{40}$/)
const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/)
const reference = z.string().max(2000).refine(value => {
  if (value.startsWith('sha256:')) return /^sha256:[a-f0-9]{64}$/.test(value)
  if (value.startsWith('artifact:')) {
    const path = value.slice(9)
    return safeReviewPath(path) && !secretRiskReviewPath(path) && !/[\u0000-\u001f<>"|?*]/.test(path) && !path.split('/').some(part => part.toLowerCase() === '.git')
  }
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password && !url.search && !url.port && /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/.+/.test(url.pathname)
  } catch { return false }
}, 'Use a credential-free GitHub URL, artifact:relative/path, or sha256:digest')

/** Human/orchestrator labels are evidence references, never merge authorization or ground-truth proof. */
export const BabelReviewAdjudicationInput = z.object({
  execution_id: identifier,
  candidate: z.object({ repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/), pr_number: z.number().int().positive(), base_sha: sha, head_sha: sha }).strict(),
  subject: z.object({ kind: z.enum(['finding', 'missed_defect']), id: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  outcome: z.enum(['confirmed', 'false_positive', 'missed_defect', 'inconclusive']),
  evidence: z.array(z.object({ kind: z.enum(['test', 'reproduction', 'diff', 'review', 'merge', 'artifact']), ref: reference }).strict()).min(1).max(30),
  links: z.object({
    repair_execution_id: identifier.optional(), repair_head_sha: sha.optional(),
    test_runs: z.array(reference).min(1).max(30).optional(),
    rereview_execution_ids: z.array(identifier).min(1).max(10).optional(),
    merge_commit_sha: sha.optional(), merge_ref: reference.optional(),
  }).strict().optional(),
}).strict().refine(value => value.subject.kind === 'missed_defect' ? ['missed_defect', 'inconclusive'].includes(value.outcome) : value.outcome !== 'missed_defect', 'Subject and outcome must agree')

// The input schema is strict, so validate envelope and payload separately.
export function parseBabelReviewAdjudication(value: unknown) {
  const envelope = z.object({ schema_version: z.literal(1), kind: z.literal('babel_review_adjudication'), id: z.uuid(), recorded_at: z.iso.datetime(), authority: z.literal('operator_recorded_not_independently_verified') }).passthrough().parse(value)
  const { schema_version, kind, id, recorded_at, authority, ...payload } = envelope
  return { schema_version, kind, id, recorded_at, authority, ...BabelReviewAdjudicationInput.parse(payload) }
}
export type BabelReviewAdjudicationRecord = ReturnType<typeof parseBabelReviewAdjudication>

/** Secret-scan before writing; publish a new initialized file atomically without replacement. */
export function appendBabelReviewAdjudication(state: string, input: unknown, options: { scan: (json: string) => void; createId?: () => string; now?: () => Date }): BabelReviewAdjudicationRecord {
  const payload = BabelReviewAdjudicationInput.parse(input)
  const record = parseBabelReviewAdjudication({ schema_version: 1, kind: 'babel_review_adjudication', id: (options.createId ?? randomUUID)(), recorded_at: (options.now ?? (() => new Date()))().toISOString(), authority: 'operator_recorded_not_independently_verified', ...payload })
  const json = JSON.stringify(record, null, 2)
  if (Buffer.byteLength(json) > 128 * 1024) throw new Error('ADJUDICATION_SIZE_LIMIT')
  options.scan(json)
  const directory = assertReviewStateOutsideGit(join(assertReviewStateOutsideGit(state), 'adjudications'))
  const temporary = join(directory, `${record.id}.${randomUUID()}.tmp`)
  const target = join(directory, `${record.id}.json`)
  const fd = openSync(temporary, 'wx', 0o600)
  try { writeFileSync(fd, json); fsyncSync(fd) } finally { closeSync(fd) }
  // Hard-link publication fails on an existing id; it can never overwrite a label.
  linkSync(temporary, target)
  unlinkSync(temporary)
  return record
}

/** Read only explicit adjudication UUID files, retaining malformed records untouched. */
export function readBabelReviewAdjudications(state: string): { records: BabelReviewAdjudicationRecord[]; invalid_records: number } {
  if (!existsSync(state)) throw new Error('REVIEW_STATE_MISSING')
  assertReviewStateOutsideGit(state)
  if (!existsSync(join(state, 'adjudications'))) return { records: [], invalid_records: 0 }
  const directory = assertReviewStateOutsideGit(join(assertReviewStateOutsideGit(state), 'adjudications'))
  const records: BabelReviewAdjudicationRecord[] = []
  let invalid_records = 0
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!/^[a-f0-9-]{36}\.json$/i.test(entry.name)) continue
    const path = join(directory, entry.name)
    try {
      if (!entry.isFile() || entry.isSymbolicLink() || lstatSync(path).nlink !== 1 || lstatSync(path).size > 128 * 1024) throw new Error('INVALID_ADJUDICATION_FILE')
      const record = parseBabelReviewAdjudication(JSON.parse(readFileSync(path, 'utf8')))
      if (entry.name !== `${record.id}.json`) throw new Error('ADJUDICATION_ID_MISMATCH')
      records.push(record)
    } catch { invalid_records++ }
  }
  return { records, invalid_records }
}

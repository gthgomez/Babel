import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import { parseBabelChatVerdict } from './babelChatReview.js'
import { validateBabelReviewCalls } from './babelReviewObserver.js'
import type { HostReviewCandidate, HostReviewHandoffV2 } from './hostReviewController.js'

// Leave a one-hour publication/check margin inside the base gate's 24h policy.
export const REVIEW_FRESH_MS = 23 * 60 * 60 * 1000
// Child lease must outlive the child's wall (BABEL_CHAT_MAX_WALL_MS in
// babelReviewChild.ts, currently 12 min) so a live child never looks stale.
export const REVIEW_CHILD_LEASE_MS = 60 * 60 * 1000
const text = z.string().min(1).refine(v => v.trim().toLowerCase() !== 'unknown')
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const sha = z.string().regex(/^[a-f0-9]{40}$/)
const usage = z.object({ prompt_tokens: z.number().finite().nonnegative().nullable(), completion_tokens: z.number().finite().nonnegative().nullable(), total_tokens: z.number().finite().nonnegative().nullable(), latency_ms: z.number().finite().nonnegative().nullable() }).strict()
const toolTraces = z.array(z.object({
  tool: text,
  targetPath: z.string().optional(),
  args: z.record(z.string(), z.unknown()).optional(),
}).strict()).optional()
const provenance = z.enum(['LOCAL_UNAUTHENTICATED', 'TRUSTED_CONTROLLER_EVIDENCE', 'OWNER_AUTHENTICATED_GITHUB_EVIDENCE'])
const evidence = z.object({
  schema_version: z.literal(2), kind: z.literal('autonomous_review_evidence_v2'), repository: text, pr_number: z.number().int().positive(),
  base_sha: sha, head_sha: sha, task_id: text, task_hash: digest, builder_id: text, diff_numstat_digest: digest,
  reviewer_id: text, reviewer_class: z.literal('independent_readonly_ai'), execution_id: text,
  review_provider: z.literal('opencode-go'), reviewer_model: text, review_mode: z.literal('exact_diff'), reviewed_at: text,
  scope: z.array(text).min(1), verdict: z.enum(['APPROVE', 'BLOCK']), findings: z.array(z.string()), blocking_findings: z.array(z.string()),
  isolation: z.object({ mode: z.literal('readonly_sandbox'), candidate_write: z.literal(false), github_mutation: z.literal(false), merge: z.literal(false), controller_state_access: z.literal(false) }).strict(),
  // Controller-stamped provenance (ReviewEvidenceProvenance). Host caches keep
  // it; publication strips it because the trusted gate's evidence contract
  // derives provenance from the authenticated comment transport itself.
  provenance: provenance.optional(),
  usage: usage.optional(),
  // Host-side provenance emitted by the review controller. These stay in the
  // host cache but are stripped before publication: the trusted gate's
  // evidence contract does not admit host-private diagnostic fields.
  tool_traces: toolTraces,
  changes_diff_fully_read: z.boolean().optional(),
  harness: z.object({ name: z.literal('babel'), mode: z.literal('chat'), version: digest, source_sha: sha, execution_id: text }).strict(),
}).strict()
const handoffSchema = z.object({
  schema_version: z.literal(2), kind: z.literal('host_review_handoff_v2'), provenance: provenance.optional(), repository: text, pr_number: z.number().int().positive(),
  base_sha: sha, head_sha: sha, task_id: text, task_hash: digest, controller_run_id: text, reviews: z.tuple([evidence]),
}).strict()

/** Project a private handoff to the gate-admissible body. The controller-stamped
 *  provenance label and host-private diagnostics never leave the host: the
 *  trusted gate derives provenance from the authenticated comment transport,
 *  and rejects unknown fields. */
export function publicBabelReviewHandoff(handoff: HostReviewHandoffV2, legacy: boolean): Record<string, unknown> {
  const { provenance: _handoffProvenance, ...rest } = handoff as unknown as Record<string, unknown>
  const reviews = handoff.reviews.map((review) => {
    const { tool_traces: _traces, changes_diff_fully_read: _covered, provenance: _reviewProvenance, ...reviewRest } = review as unknown as Record<string, unknown>
    if (legacy) {
      const { harness: _harness, ...legacyRest } = reviewRest
      return legacyRest
    }
    return reviewRest
  })
  return { ...rest, reviews }
}

/** Validate cached evidence with the same complete candidate contract as a fresh launch. */
export function validateBabelReviewCache(value: unknown, expected: { candidate: HostReviewCandidate; model: string; round: string; version: string; sourceSha: string; now?: number }): HostReviewHandoffV2 {
  const parsed = handoffSchema.parse(value)
  const review = parsed.reviews[0]
  for (const field of ['repository', 'pr_number', 'base_sha', 'head_sha', 'task_id', 'task_hash'] as const) {
    if (parsed[field] !== expected.candidate[field] || review[field] !== expected.candidate[field]) throw new Error('CACHED_REVIEW_CANDIDATE_MISMATCH')
  }
  const age = (expected.now ?? Date.now()) - Date.parse(review.reviewed_at)
  if (!Number.isFinite(age) || age < 0 || age >= REVIEW_FRESH_MS) throw new Error('CACHED_REVIEW_STALE')
  if (parsed.controller_run_id !== expected.round || review.execution_id === parsed.controller_run_id ||
      review.harness.execution_id !== review.execution_id || review.harness.version !== expected.version || review.harness.source_sha !== expected.sourceSha ||
      review.reviewer_model !== expected.model || review.builder_id !== expected.candidate.builder_id ||
      review.reviewer_id.toLowerCase() === review.builder_id.toLowerCase() ||
      review.reviewer_id !== `babel-chat-${expected.model}-${review.execution_id}` ||
      review.diff_numstat_digest !== expected.candidate.diff_numstat_digest ||
      new Set(review.scope).size !== review.scope.length || JSON.stringify([...review.scope].sort()) !== JSON.stringify([...expected.candidate.scope].sort()) ||
      (review.verdict === 'APPROVE' && review.blocking_findings.length > 0)) throw new Error('CACHED_REVIEW_PROVENANCE_MISMATCH')
  const { usage: optionalUsage, ...fields } = review
  return { ...parsed, reviews: [{ ...fields, ...(optionalUsage ? { usage: optionalUsage } : {}) }] } as HostReviewHandoffV2
}

/** Bind the child's artifact and verdict to the exact execution, including every observed call. */
export function validateBabelReviewArtifact(value: unknown, expected: { executionId: string; model: string; scope: string[] }) {
  const artifact = z.object({
    schema_version: z.literal(1), harness: z.literal('babel'), mode: z.literal('chat'), status: z.literal('review_completed'),
    execution_id: z.literal(expected.executionId), model: z.literal(expected.model),
    payload: z.record(z.string(), z.unknown()), verdict: z.unknown(),
    calls: z.array(z.object({ status: z.enum(['completed', 'failed']), metadata: z.object({
      provider: z.literal('opencode-go'), observed_model_id: z.literal(expected.model).nullable(),
      prompt_tokens: z.number().finite().nonnegative().nullable(), completion_tokens: z.number().finite().nonnegative().nullable(), latency_ms: z.number().finite().nonnegative().nullable(),
    }).passthrough() }).passthrough()).min(1),
  }).passthrough().parse(value)
  validateBabelReviewCalls(artifact.calls, expected.model)
  const verdict = parseBabelChatVerdict(artifact.payload, expected.scope)
  if (JSON.stringify(verdict) !== JSON.stringify(artifact.verdict)) throw new Error('CHILD_VERDICT_MISMATCH')
  const sum = (field: 'prompt_tokens' | 'completion_tokens' | 'latency_ms') => artifact.calls.some(c => c.metadata[field] === null) ? null : artifact.calls.reduce((n, c) => n + c.metadata[field]!, 0)
  const prompt = sum('prompt_tokens'); const completion = sum('completion_tokens')
  return { verdict, usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt === null || completion === null ? null : prompt + completion, latency_ms: sum('latency_ms') } }
}

/** Atomically replace JSON only after the new bytes have reached the filesystem. */
export function atomicReviewJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  const fd = openSync(temporary, 'wx', 0o600)
  try { writeFileSync(fd, JSON.stringify(value, null, 2)); fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(temporary, path)
}

/** Source version includes untracked source bytes; nothing is logged or exposed. */
export function babelReviewVersion(shaValue: string, diff: string, untracked: Array<{ path: string; bytes: Uint8Array }>): string {
  const hash = createHash('sha256').update(shaValue).update('\0').update(diff)
  for (const entry of [...untracked].sort((a, b) => a.path.localeCompare(b.path))) hash.update('\0').update(entry.path).update('\0').update(createHash('sha256').update(entry.bytes).digest())
  return hash.digest('hex')
}

/** Reconcile an uncertain POST using the latest owner comment for this exact candidate. */
export function findPublishedBabelReview(comments: unknown[], ownerId: number, body: string): string | null {
  const marker = '<!-- babel-controller-ai-reviews-v2 -->'
  const desired = JSON.parse(body.slice(marker.length)) as Record<string, unknown>
  const candidates = z.array(z.object({ id: z.number(), body: z.string(), user: z.object({ id: z.number(), type: z.string() }), html_url: z.string().optional() }).passthrough()).parse(comments)
  for (const comment of candidates.sort((a, b) => b.id - a.id)) {
    if (comment.user.id !== ownerId || comment.user.type !== 'User' || !comment.body.startsWith(marker)) continue
    let handoff: Record<string, unknown>
    try { handoff = JSON.parse(comment.body.slice(marker.length)) as Record<string, unknown> } catch { return null }
    if (!['repository', 'pr_number', 'base_sha', 'head_sha'].every(k => handoff[k] === desired[k])) continue
    return comment.body === body ? String(comment.id) : null
  }
  return null
}

type ReviewChild = { pid: number | null; processIdentity?: string; deadline: number; executionId: string }
type ReviewLease = { token: string; pid: number; processIdentity?: string; startedAt: number; children?: ReviewChild[]; child?: ReviewChild }
/** Unknown process state is live: never duplicate a paid worker on an inconclusive probe. */
export function reviewProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 1) return false
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
}

/** Compare process creation identities so a recycled PID cannot strand a job. */
export function reviewProcessIdentity(pid: number): string | undefined {
  if (!Number.isInteger(pid) || pid < 1) return undefined
  try {
    if (process.platform === 'win32') {
      const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`], { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
      return /^\d+$/.test(output) ? output : undefined
    }
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
    }
    return execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trim() || undefined
  } catch { return undefined }
}

/** Publish an initialized exclusive lease; conservatively reconcile interrupted child ownership. */
export function acquireBabelReviewLease(path: string, isAlive = reviewProcessAlive, now = Date.now(), identity = isAlive === reviewProcessAlive ? reviewProcessIdentity : (_pid: number): string | undefined => undefined): { child: (pid: number | null, executionId: string) => void; childExited: (executionId: string) => void; release: () => void } | null {
  const sameProcess = (pid: number, expected?: string) => {
    if (!isAlive(pid)) return false
    const actual = expected ? identity(pid) : undefined
    return !actual || actual === expected
  }
  if (existsSync(path)) {
    const before = lstatSync(path)
    let prior: ReviewLease | undefined
    try { prior = JSON.parse(readFileSync(path, 'utf8')) as ReviewLease } catch { /* interrupted legacy empty lock */ }
    // `child` is the legacy single-child shape; `children` tracks the parallel
    // review children this controller may now own at once.
    const priorChildren: ReviewChild[] = prior ? [...(prior.children ?? []), ...(prior.child ? [prior.child] : [])] : []
    if (prior && (sameProcess(prior.pid, prior.processIdentity) || priorChildren.some(child => child.pid ? sameProcess(child.pid, child.processIdentity) : now < child.deadline))) return null
    if (!prior && now - lstatSync(path).mtimeMs < REVIEW_CHILD_LEASE_MS) return null
    // A stale lease is quarantined, not deleted. A later scan acquires the job;
    // recovery never starts a paid child in the same sweep as reclamation.
    const current = lstatSync(path)
    if (before.ino === current.ino && before.mtimeMs === current.mtimeMs) {
      try { renameSync(path, `${path}.interrupted-${randomUUID()}`) } catch { /* another controller reconciled it */ }
    }
    return null
  }
  const lease: ReviewLease = { token: randomUUID(), pid: process.pid, startedAt: now }
  const parentIdentity = identity(process.pid)
  if (parentIdentity) lease.processIdentity = parentIdentity
  const ready = `${path}.${lease.token}.ready`
  atomicReviewJson(ready, lease)
  try { linkSync(ready, path) } catch (error) { unlinkSync(ready); if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null; throw error }
  unlinkSync(ready)
  const owns = () => { try { return (JSON.parse(readFileSync(path, 'utf8')) as ReviewLease).token === lease.token } catch { return false } }
  const save = () => { if (!owns()) throw new Error('REVIEW_LEASE_LOST'); atomicReviewJson(path, lease) }
  return {
    child(pid, executionId) {
      const processIdentity = pid ? identity(pid) : undefined
      lease.children = [...(lease.children ?? []).filter(existing => existing.executionId !== executionId), { pid, executionId, deadline: Date.now() + REVIEW_CHILD_LEASE_MS, ...(processIdentity ? { processIdentity } : {}) }]
      delete lease.child
      save()
    },
    childExited(executionId) { lease.children = (lease.children ?? []).filter(existing => existing.executionId !== executionId); delete lease.child; save() },
    release() { if (owns() && !lease.children?.length && !lease.child) unlinkSync(path) },
  }
}

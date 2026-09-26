import type { HostReviewHandoffV3 } from './independentReviewEvidenceV3.js'
import { publicIndependentReviewHandoffV3 } from './independentReviewEvidenceV3.js'

/** Marks the PR issue comment that carries a host_review_handoff_v3 bundle. */
export const V3_REVIEW_MARKER = '<!-- babel-controller-independent-review-v3 -->'

export interface PublishIndependentReviewV3Options {
  handoff: HostReviewHandoffV3
  repository: string
  prNumber: number
  /** GitHub numeric owner id; only this user may publish. */
  ownerId: string
  /** Authenticated actor id (from `gh api user`). */
  actorId: string
  /** Lists existing PR issue comments (already fetched); used for idempotency. */
  listComments: () => Promise<Array<{ id: number; body: string; userId: string; userType: string; issueUrl: string }>>
  /** POSTs the comment body. */
  postComment: (body: string) => Promise<{ id: number }>
  /** Optional secret scan of the exact body; returns true when safe. */
  scanBody?: (body: string) => Promise<boolean>
}

/** A handoff is unauthenticated when the bundle or any contained review says so. */
function isLocalUnauthenticated(handoff: HostReviewHandoffV3): boolean {
  if (handoff.provenance === 'LOCAL_UNAUTHENTICATED') return true
  return handoff.reviews.some((review) => review.provenance === 'LOCAL_UNAUTHENTICATED')
}

/**
 * Publish a host_review_handoff_v3 bundle as an owner-authenticated PR comment.
 *
 * Pure orchestration: the caller supplies GitHub I/O, so this module never
 * touches `gh` or the network. The public body strips provenance, mirroring the
 * V2 publication rules; the trusted gate derives authority from the
 * authenticated transport instead.
 */
export async function publishIndependentReviewV3(
  options: PublishIndependentReviewV3Options,
): Promise<{ posted: boolean; commentId?: string; reason?: string }> {
  const { handoff, repository, prNumber, ownerId, actorId, listComments, postComment, scanBody } = options
  const body = `${V3_REVIEW_MARKER}\n${JSON.stringify(publicIndependentReviewHandoffV3(handoff))}`

  if (isLocalUnauthenticated(handoff)) return { posted: false, reason: 'local_unauthenticated_evidence' }
  if (actorId !== ownerId) return { posted: false, reason: 'owner_identity_required' }
  if (handoff.repository !== repository || handoff.pr_number !== prNumber) {
    return { posted: false, reason: 'handoff_candidate_mismatch' }
  }

  const comments = await listComments()
  const duplicate = comments.find(
    (comment) => comment.userId === ownerId && comment.userType === 'User' && comment.body === body,
  )
  if (duplicate) return { posted: false, commentId: String(duplicate.id), reason: 'already_published' }

  if (scanBody && !(await scanBody(body))) return { posted: false, reason: 'secret_scan_failed' }

  const posted = await postComment(body)
  return { posted: true, commentId: String(posted.id) }
}

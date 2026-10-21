import type { MissionWriteContext } from '../contracts/common.js'
import type { PassageRecord } from '../contracts/passages.js'
import type { PlanRevision } from '../contracts/plan.js'
import type { SourceRecord } from '../contracts/sources.js'
import type { SourceRevision } from '../contracts/sources.js'
import type { SourceAdapterReadResult, SourceDiscoverResult } from '../ports/sourceAdapter.js'
import type { ResearchMissionV2 } from '../contracts/mission.js'
import { assertPassageIntegrityReceiptMatchesRead } from '../integrity/passageIntegrityReceipt.js'

export class RetrievalEvidenceBindingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RetrievalEvidenceBindingError'
  }
}

export function validateRetrievalEvidenceBindings(params: {
  searchOperationId: string
  fetchOperationId: string
  discover: SourceDiscoverResult
  read: SourceAdapterReadResult
  candidate: SourceRecord
  mission: ResearchMissionV2
  plan: PlanRevision
  ctx: MissionWriteContext
}): { revision: SourceRevision; passages: PassageRecord[] } {
  if (params.discover.status !== 'ok') {
    throw new RetrievalEvidenceBindingError('discover result is not ok')
  }
  if (params.discover.operationId !== params.searchOperationId) {
    throw new RetrievalEvidenceBindingError('discover operationId does not match search operation')
  }
  if (params.read.status !== 'ok') {
    throw new RetrievalEvidenceBindingError('read result is not ok')
  }
  if (params.read.operationId !== params.fetchOperationId) {
    throw new RetrievalEvidenceBindingError('read operationId does not match fetch operation')
  }
  if (params.plan.mission_id !== params.mission.mission_id) {
    throw new RetrievalEvidenceBindingError('plan mission_id does not match mission')
  }
  if (params.plan.plan_revision_id !== params.ctx.plan_revision_id) {
    throw new RetrievalEvidenceBindingError('plan revision does not match write context')
  }
  if (params.ctx.mission_id !== params.mission.mission_id) {
    throw new RetrievalEvidenceBindingError('write context mission does not match mission')
  }
  const revision = params.read.revision
  if (revision.source_id !== params.candidate.source_id) {
    throw new RetrievalEvidenceBindingError('revision source_id does not match discovered candidate')
  }
  for (const passage of params.read.passages) {
    if (passage.source_revision_id !== revision.revision_id) {
      throw new RetrievalEvidenceBindingError('passage source_revision_id does not match revision')
    }
    try {
      assertPassageIntegrityReceiptMatchesRead({
        passage,
        candidate: params.candidate,
        revision,
        extractionVersion: params.read.extraction_version,
      })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      throw new RetrievalEvidenceBindingError(message)
    }
  }
  return { revision, passages: params.read.passages }
}

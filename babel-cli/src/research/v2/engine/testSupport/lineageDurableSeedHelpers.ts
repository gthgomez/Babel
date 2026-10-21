import { createHash } from 'node:crypto'
import { PassageRecordSchema } from '../../contracts/passages.js'
import type { PassageRecord } from '../../contracts/passages.js'
import type { SourceFetchEvidenceOwner } from '../../contracts/retrievalEvidenceOwnership.js'
import {
  stampSourceFetchEvidenceOwnerOnPassage,
  sourceFetchOwnerFromFetch,
} from '../retrievalEvidenceOwnership.js'

export function ownedInlinePassage(params: {
  missionId: string
  operationId: string
  attemptId: string
  passageId: string
  text: string
  sourceRevisionId?: string
}): PassageRecord {
  const owner: SourceFetchEvidenceOwner = sourceFetchOwnerFromFetch(
    params.missionId,
    params.operationId,
    params.attemptId,
  )
  const base = PassageRecordSchema.parse({
    passage_id: params.passageId,
    source_revision_id: params.sourceRevisionId ?? `rev-${params.passageId}`,
    locator: { kind: 'line_range', start_line: 1, end_line: 1 },
    text_ref: {
      mode: 'inline',
      text: params.text,
      text_hash: createHash('sha256').update(params.text).digest('hex'),
    },
  })
  return stampSourceFetchEvidenceOwnerOnPassage(base, owner)
}

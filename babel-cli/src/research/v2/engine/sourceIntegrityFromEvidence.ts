import { createHash } from 'node:crypto'
import type { FindingRecord } from '../contracts/findings.js'
import {
  PASSAGE_INTEGRITY_VERIFICATION_SCOPE,
  PASSAGE_INTEGRITY_VERIFIER,
  type PassageIntegrityVerification,
} from '../contracts/passageIntegrity.js'
import type { PassageRecord } from '../contracts/passages.js'
import type { SourceRecord } from '../contracts/sources.js'
import type { SourceRevision } from '../contracts/sources.js'
import type { ResearchStoreEvent } from '../ports/researchStore.js'
import { passageTextHash } from '../adapters/documents/passageInlineText.js'
import { sourceFetchEvidenceOwnerKey } from '../contracts/retrievalEvidenceOwnership.js'
import { ownerMatchesSucceededAttempt, succeededSourceFetchAttemptOwnerKeys } from './retrievalExtractionLineage.js'

function sha256Utf8(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function latestPassageRecords(events: readonly ResearchStoreEvent[]): Map<string, PassageRecord> {
  const byId = new Map<string, PassageRecord>()
  for (const event of events) {
    if (event.kind !== 'passage_recorded') continue
    const passage = (event.payload as { passage?: PassageRecord }).passage
    if (!passage) continue
    byId.set(passage.passage_id, passage)
  }
  return byId
}

function receiptMatchesPassage(
  receipt: PassageIntegrityVerification,
  passage: PassageRecord,
): boolean {
  if (receipt.passage_id !== passage.passage_id) return false
  if (receipt.source_revision_id !== passage.source_revision_id) return false
  if (JSON.stringify(receipt.locator) !== JSON.stringify(passage.locator)) return false
  if (passage.text_ref.mode !== 'inline') return false
  if (receipt.passage_text_hash !== passage.text_ref.text_hash) return false
  return true
}

function isSupportedReceipt(receipt: PassageIntegrityVerification): boolean {
  return (
    receipt.verifier === PASSAGE_INTEGRITY_VERIFIER &&
    receipt.verification_scope === PASSAGE_INTEGRITY_VERIFICATION_SCOPE
  )
}

export function deriveFindingSourceIntegrity(
  finding: FindingRecord,
  passages: readonly PassageRecord[],
  revisions: readonly SourceRevision[],
  sources: readonly SourceRecord[],
  events: readonly ResearchStoreEvent[],
): FindingRecord['source_integrity'] {
  const passageById = latestPassageRecords(events)
  for (const p of passages) {
    passageById.set(p.passage_id, p)
  }
  const revisionById = new Map(revisions.map((r) => [r.revision_id, r]))
  const sourceById = new Map(sources.map((s) => [s.source_id, s]))
  const succeededOwners = succeededSourceFetchAttemptOwnerKeys(events)

  let sawReceipt = false
  for (const passageId of finding.passage_ids) {
    const passage = passageById.get(passageId)
    if (!passage) return 'not_checked'

    const receipt = passage.integrity_verification
    if (!receipt) return 'not_checked'
    if (!isSupportedReceipt(receipt)) return 'not_checked'
    sawReceipt = true

    if (!receiptMatchesPassage(receipt, passage)) return 'invalid'

    const revision = revisionById.get(passage.source_revision_id)
    if (!revision || revision.revision_id !== receipt.source_revision_id) return 'invalid'
    if (revision.content_hash !== receipt.source_content_hash) return 'invalid'
    if (revision.source_id !== receipt.source_id) return 'invalid'

    const source = sourceById.get(receipt.source_id)
    if (!source) return 'not_checked'

    if (passage.text_ref.mode !== 'inline') return 'not_checked'
    if (sha256Utf8(passage.text_ref.text) !== passage.text_ref.text_hash) return 'invalid'
    if (passageTextHash(passage.text_ref.text) !== passage.text_ref.text_hash) return 'invalid'

    const owner = passage.source_fetch_owner
    if (!owner) return 'not_checked'
    const ownerKey = sourceFetchEvidenceOwnerKey(owner)
    if (!succeededOwners.has(ownerKey)) return 'not_checked'
    if (!ownerMatchesSucceededAttempt(owner, events)) return 'invalid'

    const receiptOwnerKey = sourceFetchEvidenceOwnerKey({
      mission_id: owner.mission_id,
      operation_id: owner.operation_id,
      attempt_id: owner.attempt_id,
    })
    if (receiptOwnerKey !== ownerKey) return 'invalid'
  }

  return sawReceipt ? 'valid' : 'not_checked'
}

export function applyFindingSourceIntegrityFromEvidence(
  findings: readonly FindingRecord[],
  passages: readonly PassageRecord[],
  revisions: readonly SourceRevision[],
  sources: readonly SourceRecord[],
  events: readonly ResearchStoreEvent[],
): FindingRecord[] {
  return findings.map((finding) => ({
    ...finding,
    source_integrity: deriveFindingSourceIntegrity(
      finding,
      passages,
      revisions,
      sources,
      events,
    ),
  }))
}

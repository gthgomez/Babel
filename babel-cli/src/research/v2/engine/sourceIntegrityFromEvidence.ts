import { createHash } from 'node:crypto'
import type { FindingRecord } from '../contracts/findings.js'
import {
  isSupportedPassageIntegrityVerifierVersion,
  PASSAGE_INTEGRITY_VERIFICATION_SCOPE,
  PASSAGE_INTEGRITY_VERIFIER,
  type PassageIntegrityVerification,
} from '../contracts/passageIntegrity.js'
import type { PassageRecord } from '../contracts/passages.js'
import type { SourceRecord } from '../contracts/sources.js'
import type { SourceRevision } from '../contracts/sources.js'
import type { ResearchStoreEvent } from '../ports/researchStore.js'
import { passageTextHash } from '../adapters/documents/passageInlineText.js'
import {
  sourceFetchEvidenceOwnerKey,
  type SourceFetchEvidenceOwner,
} from '../contracts/retrievalEvidenceOwnership.js'
import {
  ownerMatchesSucceededAttempt,
  passageIsAdmittedForExtractionLineage,
  succeededSourceFetchAttemptOwnerKeys,
} from './retrievalExtractionLineage.js'

function sha256Utf8(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function passageIdentityFingerprint(passage: PassageRecord): string {
  const ownerKey = passage.source_fetch_owner
    ? sourceFetchEvidenceOwnerKey(passage.source_fetch_owner)
    : ''
  const textHash =
    passage.text_ref.mode === 'inline' ? passage.text_ref.text_hash : passage.text_ref.text_hash
  return JSON.stringify({
    source_revision_id: passage.source_revision_id,
    locator: passage.locator,
    text_hash: textHash,
    owner_key: ownerKey,
  })
}

function indexPassagesById(
  events: readonly ResearchStoreEvent[],
  extra: readonly PassageRecord[],
): { byId: Map<string, PassageRecord>; ambiguousIds: Set<string> } {
  const byId = new Map<string, PassageRecord>()
  const ambiguousIds = new Set<string>()
  const considerEligible = (passage: PassageRecord) => {
    if (!passageIsAdmittedForExtractionLineage(passage, events)) {
      return
    }
    const existing = byId.get(passage.passage_id)
    if (!existing) {
      byId.set(passage.passage_id, passage)
      return
    }
    if (passageIdentityFingerprint(existing) !== passageIdentityFingerprint(passage)) {
      ambiguousIds.add(passage.passage_id)
    }
  }
  for (const event of events) {
    if (event.kind !== 'passage_recorded') continue
    const passage = (event.payload as { passage?: PassageRecord }).passage
    if (!passage) continue
    considerEligible(passage)
  }
  for (const passage of extra) {
    considerEligible(passage)
  }
  return { byId, ambiguousIds }
}

function allRevisionsFromEvents(events: readonly ResearchStoreEvent[]): SourceRevision[] {
  return events
    .filter((e) => e.kind === 'revision_recorded')
    .map((e) => (e.payload as { revision: SourceRevision }).revision)
}

function ownersMatch(
  a: SourceFetchEvidenceOwner | undefined,
  b: SourceFetchEvidenceOwner | undefined,
): boolean {
  if (!a || !b) return false
  return sourceFetchEvidenceOwnerKey(a) === sourceFetchEvidenceOwnerKey(b)
}

function resolveRevisionForPassage(
  passage: PassageRecord,
  revisions: readonly SourceRevision[],
): SourceRevision | undefined {
  const passageOwner = passage.source_fetch_owner
  if (!passageOwner) return undefined
  const ownerKey = sourceFetchEvidenceOwnerKey(passageOwner)
  const matches = revisions.filter(
    (r) =>
      r.revision_id === passage.source_revision_id &&
      r.source_fetch_owner &&
      sourceFetchEvidenceOwnerKey(r.source_fetch_owner) === ownerKey,
  )
  if (matches.length === 0) return undefined
  if (matches.length > 1) {
    const first = matches[0]!
    const same = matches.every(
      (r) =>
        r.content_hash === first.content_hash &&
        r.source_id === first.source_id &&
        ownersMatch(r.source_fetch_owner, first.source_fetch_owner),
    )
    if (!same) return undefined
  }
  return matches[0]
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
    receipt.verification_scope === PASSAGE_INTEGRITY_VERIFICATION_SCOPE &&
    isSupportedPassageIntegrityVerifierVersion(receipt.verifier_version)
  )
}

export function deriveFindingSourceIntegrity(
  finding: FindingRecord,
  passages: readonly PassageRecord[],
  revisions: readonly SourceRevision[],
  sources: readonly SourceRecord[],
  events: readonly ResearchStoreEvent[],
): FindingRecord['source_integrity'] {
  const { byId: passageById, ambiguousIds } = indexPassagesById(events, passages)
  const revisionCatalog = [...allRevisionsFromEvents(events), ...revisions]
  const sourceById = new Map(sources.map((s) => [s.source_id, s]))
  const succeededOwners = succeededSourceFetchAttemptOwnerKeys(events)

  let sawReceipt = false
  for (const passageId of finding.passage_ids) {
    if (ambiguousIds.has(passageId)) return 'not_checked'

    const passage = passageById.get(passageId)
    if (!passage) return 'not_checked'

    const receipt = passage.integrity_verification
    if (!receipt) return 'not_checked'
    if (!isSupportedReceipt(receipt)) return 'not_checked'
    sawReceipt = true

    if (!receiptMatchesPassage(receipt, passage)) return 'invalid'

    const passageOwner = passage.source_fetch_owner
    if (!passageOwner) return 'not_checked'
    const ownerKey = sourceFetchEvidenceOwnerKey(passageOwner)
    if (!succeededOwners.has(ownerKey)) return 'not_checked'
    if (!ownerMatchesSucceededAttempt(passageOwner, events)) return 'invalid'

    const revision = resolveRevisionForPassage(passage, revisionCatalog)
    if (!revision) {
      const ownerConflict = revisionCatalog.some(
        (r) =>
          r.revision_id === passage.source_revision_id &&
          r.source_fetch_owner &&
          sourceFetchEvidenceOwnerKey(r.source_fetch_owner) !== ownerKey,
      )
      return ownerConflict ? 'invalid' : 'not_checked'
    }
    if (!ownersMatch(revision.source_fetch_owner, passageOwner)) return 'invalid'

    if (revision.revision_id !== receipt.source_revision_id) return 'invalid'
    if (revision.content_hash !== receipt.source_content_hash) return 'invalid'
    if (revision.source_id !== receipt.source_id) return 'invalid'

    const source = sourceById.get(receipt.source_id)
    if (!source) return 'not_checked'

    if (passage.text_ref.mode !== 'inline') return 'not_checked'
    if (sha256Utf8(passage.text_ref.text) !== passage.text_ref.text_hash) return 'invalid'
    if (passageTextHash(passage.text_ref.text) !== passage.text_ref.text_hash) return 'invalid'
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

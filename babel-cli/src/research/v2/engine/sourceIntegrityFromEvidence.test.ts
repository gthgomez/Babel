import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import type { FindingRecord } from '../contracts/findings.js'
import { FindingRecordSchema } from '../contracts/findings.js'
import type { PassageRecord } from '../contracts/passages.js'
import { PassageRecordSchema } from '../contracts/passages.js'
import type { ResearchStoreEvent } from '../ports/researchStore.js'
import { PLAIN_TEXT_EXTRACTION_VERSION, passagesFromAdmittedPlainText } from '../adapters/documents/plainTextFromAdmittedBytes.js'
import { PLAIN_TEXT_MEDIA_TYPE } from '../adapters/documents/plainTextFromAdmittedBytes.js'
import { buildAdmittedContent } from '../adapters/documents/testAdmittedFixtures.js'
import { passageWithIntegrityVerification } from '../integrity/passageIntegrityReceipt.js'
import { stampSourceFetchEvidenceOwnerOnPassage } from './retrievalEvidenceOwnership.js'
import { deriveFindingSourceIntegrity } from './sourceIntegrityFromEvidence.js'
import {
  gL2OriginalDerivedPassages,
  gL2OriginalDerivedRevisions,
  gL2OriginalDerivedSources,
  gL2OriginalDerivedFindingQ3_7f3,
} from './testSupport/gL2OriginalDerivedRegression.js'
import { gL3Ba45HistoricalFindings, gL3Ba45ReviewContext } from './testSupport/gL3Ba45DerivedRegression.js'

const MISSION_ID = 'mission-integrity'

function fetchOwner(operationId: string, attemptId: string) {
  return { mission_id: MISSION_ID, operation_id: operationId, attempt_id: attemptId }
}

function fetchIntent(operationId: string, attemptId: string): ResearchStoreEvent {
  return {
    eventId: `intent-${operationId}`,
    missionId: MISSION_ID,
    kind: 'external_operation_intent',
    recordedAt: '2026-10-20T12:00:00.000Z',
    payload: {
      intent: {
        mission_id: MISSION_ID,
        operation_id: operationId,
        attempt_id: attemptId,
        operation_kind: 'source_fetch',
        dispatched_at: '2026-10-20T12:00:00.000Z',
        idempotency_key: operationId,
      },
    },
  }
}

function fetchSucceeded(operationId: string, attemptId: string): ResearchStoreEvent {
  return {
    eventId: `done-${operationId}`,
    missionId: MISSION_ID,
    kind: 'external_operation_completed',
    recordedAt: '2026-10-20T12:00:01.000Z',
    payload: {
      completion: {
        mission_id: MISSION_ID,
        operation_id: operationId,
        attempt_id: attemptId,
        completed_at: '2026-10-20T12:00:01.000Z',
        settlement: 'succeeded',
      },
    },
  }
}

function passageRecorded(passage: PassageRecord): ResearchStoreEvent {
  return {
    eventId: `passage-${passage.passage_id}`,
    missionId: MISSION_ID,
    kind: 'passage_recorded',
    recordedAt: '2026-10-20T12:00:00.500Z',
    payload: { passage },
  }
}

function verifiedPassageFixture(): {
  passage: PassageRecord
  sources: typeof gL2OriginalDerivedSources
  revisions: typeof gL2OriginalDerivedRevisions
  events: ResearchStoreEvent[]
} {
  const bytes = Buffer.from('export const X = 1\n', 'utf8')
  const admitted = buildAdmittedContent('fetch-ok', 'src-ok', 'rev-ok', bytes, PLAIN_TEXT_MEDIA_TYPE)
  const raw = passagesFromAdmittedPlainText(admitted)[0]
  assert.ok(raw)
  const owner = fetchOwner('fetch-ok', 'att-ok')
  const verified = stampSourceFetchEvidenceOwnerOnPassage(
    passageWithIntegrityVerification(raw, {
      source: { source_id: 'src-ok' },
      revision: admitted.revision,
      admitted,
      extractionVersion: PLAIN_TEXT_EXTRACTION_VERSION,
    }),
    owner,
  )
  const sources = [
    {
      source_id: 'src-ok',
      kind: 'document' as const,
      canonical_key: 'doc-ok',
      observed_urls: ['https://example.invalid/ok'],
    },
  ]
  const revisions = [admitted.revision]
  const events = [
    fetchIntent('fetch-ok', 'att-ok'),
    passageRecorded(verified),
    fetchSucceeded('fetch-ok', 'att-ok'),
  ]
  return { passage: verified, sources, revisions, events }
}

function finding(passageIds: string[]): FindingRecord {
  return FindingRecordSchema.parse({
    finding_id: 'f-integrity-1',
    question_id: 'q-1',
    assertion_text: 'observed',
    assertion_kind: 'source_observation',
    passage_ids: passageIds,
    source_integrity: 'not_checked',
    created_at: '2026-10-20T12:00:02.000Z',
  })
}

describe('deriveFindingSourceIntegrity', () => {
  it('returns valid when receipt, owner, and hashes align with succeeded fetch', () => {
    const { passage, sources, revisions, events } = verifiedPassageFixture()
    const result = deriveFindingSourceIntegrity(
      finding([passage.passage_id]),
      [passage],
      revisions,
      sources,
      events,
    )
    assert.equal(result, 'valid')
  })

  it('returns invalid when persisted text hash does not match inline text', () => {
    const { passage, sources, revisions, events } = verifiedPassageFixture()
    assert.equal(passage.text_ref.mode, 'inline')
    const tampered = PassageRecordSchema.parse({
      ...passage,
      text_ref: {
        mode: 'inline',
        text: passage.text_ref.text,
        text_hash: createHash('sha256').update('mismatch').digest('hex'),
      },
    })
    const result = deriveFindingSourceIntegrity(
      finding([tampered.passage_id]),
      [tampered],
      revisions,
      sources,
      events,
    )
    assert.equal(result, 'invalid')
  })

  it('returns invalid when receipt still binds original hash after text tamper', () => {
    const { passage, sources, revisions, events } = verifiedPassageFixture()
    const newText = 'tampered line\n'
    const tampered = PassageRecordSchema.parse({
      ...passage,
      text_ref: {
        mode: 'inline',
        text: newText,
        text_hash: createHash('sha256').update(newText, 'utf8').digest('hex'),
      },
    })
    const result = deriveFindingSourceIntegrity(
      finding([tampered.passage_id]),
      [tampered],
      revisions,
      sources,
      events,
    )
    assert.equal(result, 'invalid')
  })

  it('returns invalid when locator changes but text/hash stay consistent with receipt', () => {
    const { passage, sources, revisions, events } = verifiedPassageFixture()
    const tampered = PassageRecordSchema.parse({
      ...passage,
      locator: { kind: 'line_range', start_line: 2, end_line: 2 },
    })
    const result = deriveFindingSourceIntegrity(
      finding([tampered.passage_id]),
      [tampered],
      revisions,
      sources,
      events,
    )
    assert.equal(result, 'invalid')
  })

  it('returns not_checked when owning fetch did not succeed', () => {
    const { passage, sources, revisions } = verifiedPassageFixture()
    const events = [
      fetchIntent('fetch-ok', 'att-ok'),
      passageRecorded(passage),
      {
        ...fetchSucceeded('fetch-ok', 'att-ok'),
        payload: {
          completion: {
            mission_id: MISSION_ID,
            operation_id: 'fetch-ok',
            attempt_id: 'att-ok',
            completed_at: '2026-10-20T12:00:01.000Z',
            settlement: 'cancelled',
          },
        },
      },
    ]
    const result = deriveFindingSourceIntegrity(
      finding([passage.passage_id]),
      [passage],
      revisions,
      sources,
      events,
    )
    assert.equal(result, 'not_checked')
  })

  it('returns not_checked for legacy passages without integrity_verification', () => {
    const legacy = gL2OriginalDerivedPassages[0]!
    const result = deriveFindingSourceIntegrity(
      gL2OriginalDerivedFindingQ3_7f3,
      gL2OriginalDerivedPassages,
      gL2OriginalDerivedRevisions,
      gL2OriginalDerivedSources,
      [],
    )
    assert.equal(result, 'not_checked')
    assert.equal(legacy.integrity_verification, undefined)
  })

  it('G-L3 historical findings stay not_checked on unchanged fixture passages', () => {
    const ctx = gL3Ba45ReviewContext()
    for (const row of gL3Ba45HistoricalFindings) {
      const integrity = deriveFindingSourceIntegrity(
        row,
        ctx.passages,
        ctx.sourceRevisions,
        ctx.sources,
        [],
      )
      assert.equal(integrity, 'not_checked')
    }
  })
})

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { PassageRecordSchema } from '../contracts/passages.js'
import { PLAIN_TEXT_MEDIA_TYPE, passagesFromAdmittedPlainText } from '../adapters/documents/plainTextFromAdmittedBytes.js'
import { buildAdmittedContent } from '../adapters/documents/testAdmittedFixtures.js'
import { stampSourceFetchEvidenceOwnerOnPassage } from '../engine/retrievalEvidenceOwnership.js'
import {
  assertPassageIntegrityReceiptMatchesRead,
  buildPassageIntegrityVerification,
  passageWithIntegrityVerification,
  PassageIntegrityVerificationError,
} from './passageIntegrityReceipt.js'
import { PLAIN_TEXT_EXTRACTION_VERSION } from '../adapters/documents/plainTextFromAdmittedBytes.js'

test('passageWithIntegrityVerification: plain-text line range matches admitted bytes', () => {
  const bytes = Buffer.from('alpha\nbeta line\n', 'utf8')
  const admitted = buildAdmittedContent('op-pt', 'src-pt', 'rev-pt', bytes, PLAIN_TEXT_MEDIA_TYPE)
  const passage = passagesFromAdmittedPlainText(admitted)[0]
  assert.ok(passage)
  const verified = passageWithIntegrityVerification(passage, {
    source: { source_id: 'src-pt' },
    revision: admitted.revision,
    admitted,
    extractionVersion: PLAIN_TEXT_EXTRACTION_VERSION,
  })
  assert.ok(verified.integrity_verification)
  assert.equal(verified.integrity_verification.passage_text_hash, passage.text_ref.text_hash)
  assertPassageIntegrityReceiptMatchesRead({
    passage: verified,
    candidate: { source_id: 'src-pt', kind: 'document', canonical_key: 'k', observed_urls: ['https://example.invalid/x'] },
    revision: admitted.revision,
    extractionVersion: PLAIN_TEXT_EXTRACTION_VERSION,
  })
})

test('stampSourceFetchEvidenceOwnerOnPassage preserves integrity_verification', () => {
  const bytes = Buffer.from('only line\n', 'utf8')
  const admitted = buildAdmittedContent('op-stamp', 'src-s', 'rev-s', bytes, PLAIN_TEXT_MEDIA_TYPE)
  const passage = passagesFromAdmittedPlainText(admitted)[0]
  assert.ok(passage)
  const verified = passageWithIntegrityVerification(passage, {
    source: { source_id: 'src-s' },
    revision: admitted.revision,
    admitted,
    extractionVersion: PLAIN_TEXT_EXTRACTION_VERSION,
  })
  const stamped = stampSourceFetchEvidenceOwnerOnPassage(verified, {
    mission_id: 'm1',
    operation_id: 'fetch-1',
    attempt_id: 'att-1',
  })
  PassageRecordSchema.parse(stamped)
  assert.deepEqual(stamped.integrity_verification, verified.integrity_verification)
})

test('buildPassageIntegrityVerification: rejects locator/text mismatch', () => {
  const bytes = Buffer.from('one\ntwo\n', 'utf8')
  const admitted = buildAdmittedContent('op-bad', 'src-b', 'rev-b', bytes, PLAIN_TEXT_MEDIA_TYPE)
  const passage = passagesFromAdmittedPlainText(admitted)[0]
  assert.ok(passage)
  const tampered = PassageRecordSchema.parse({
    ...passage,
    text_ref: {
      mode: 'inline',
      text: 'wrong excerpt',
      text_hash: createHash('sha256').update('wrong excerpt', 'utf8').digest('hex'),
    },
  })
  assert.throws(
    () =>
      buildPassageIntegrityVerification({
        passage: tampered,
        source: { source_id: 'src-b' },
        revision: admitted.revision,
        admitted,
        extractionVersion: PLAIN_TEXT_EXTRACTION_VERSION,
      }),
    PassageIntegrityVerificationError,
  )
})

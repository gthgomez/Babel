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

test('buildPassageIntegrityVerification: rejects byte_offset beyond admitted length', () => {
  const bytes = Buffer.from('short', 'utf8')
  const admitted = buildAdmittedContent('op-bytes', 'src-bytes', 'rev-bytes', bytes, PLAIN_TEXT_MEDIA_TYPE)
  const textHash = createHash('sha256').update('short', 'utf8').digest('hex')
  const passage = PassageRecordSchema.parse({
    passage_id: 'p-byte-oob',
    source_revision_id: admitted.revision.revision_id,
    locator: { kind: 'byte_offset', start_offset: 0, end_offset: 99 },
    text_ref: { mode: 'inline', text: 'short', text_hash: textHash },
  })
  assert.throws(
    () =>
      buildPassageIntegrityVerification({
        passage,
        source: { source_id: 'src-bytes' },
        revision: admitted.revision,
        admitted,
        extractionVersion: PLAIN_TEXT_EXTRACTION_VERSION,
      }),
    (err: unknown) =>
      err instanceof PassageIntegrityVerificationError &&
      err.message.includes('exceeds admitted byte length'),
  )
})

test('buildPassageIntegrityVerification: rejects byte_offset slice that splits UTF-8 code unit', () => {
  const bytes = Buffer.from('aéb', 'utf8')
  const admitted = buildAdmittedContent('op-utf8', 'src-utf8', 'rev-utf8', bytes, PLAIN_TEXT_MEDIA_TYPE)
  const passage = PassageRecordSchema.parse({
    passage_id: 'p-byte-split',
    source_revision_id: admitted.revision.revision_id,
    locator: { kind: 'byte_offset', start_offset: 1, end_offset: 2 },
    text_ref: {
      mode: 'inline',
      text: '\xc3',
      text_hash: createHash('sha256').update('\xc3', 'utf8').digest('hex'),
    },
  })
  assert.throws(
    () =>
      buildPassageIntegrityVerification({
        passage,
        source: { source_id: 'src-utf8' },
        revision: admitted.revision,
        admitted,
        extractionVersion: PLAIN_TEXT_EXTRACTION_VERSION,
      }),
    (err: unknown) =>
      err instanceof PassageIntegrityVerificationError &&
      err.message.includes('not valid UTF-8'),
  )
})

test('buildPassageIntegrityVerification: rejects line_range beyond admitted lines', () => {
  const bytes = Buffer.from('only\n', 'utf8')
  const admitted = buildAdmittedContent('op-lines', 'src-l', 'rev-l', bytes, PLAIN_TEXT_MEDIA_TYPE)
  const passage = passagesFromAdmittedPlainText(admitted)[0]
  assert.ok(passage)
  const badLocator = PassageRecordSchema.parse({
    ...passage,
    locator: { kind: 'line_range', start_line: 1, end_line: 99 },
  })
  assert.throws(
    () =>
      buildPassageIntegrityVerification({
        passage: badLocator,
        source: { source_id: 'src-l' },
        revision: admitted.revision,
        admitted,
        extractionVersion: PLAIN_TEXT_EXTRACTION_VERSION,
      }),
    PassageIntegrityVerificationError,
  )
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

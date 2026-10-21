import { createHash } from 'node:crypto'
import type { AdmittedContent } from '../contracts/admittedContent.js'
import {
  PASSAGE_INTEGRITY_RECORD_VERSION,
  PASSAGE_INTEGRITY_RETENTION,
  PASSAGE_INTEGRITY_VERIFICATION_SCOPE,
  PASSAGE_INTEGRITY_VERIFIER,
  PASSAGE_INTEGRITY_VERIFIER_VERSION,
  type PassageIntegrityVerification,
  PassageIntegrityVerificationSchema,
} from '../contracts/passageIntegrity.js'
import type { PassageLocator } from '../contracts/passageLocator.js'
import type { PassageRecord } from '../contracts/passages.js'
import type { SourceRecord } from '../contracts/sources.js'
import type { SourceRevision } from '../contracts/sources.js'
import { passageTextHash } from '../adapters/documents/passageInlineText.js'
import { buildInlinePassageTextRef } from '../adapters/documents/passageInlineText.js'
import {
  decodeAdmittedInlineBytes,
  decodeAdmittedUtf8Bytes,
} from '../adapters/documents/plainTextFromAdmittedBytes.js'
import {
  excerptTextForHtmlSectionId,
  HTML_MEDIA_TYPE,
} from '../adapters/web/htmlFromAdmittedBytes.js'

export class PassageIntegrityVerificationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PassageIntegrityVerificationError'
  }
}

function sha256Buffer(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function resolveExcerptFromAdmitted(
  admitted: AdmittedContent,
  locator: PassageLocator,
): { text: string } {
  if (locator.kind === 'line_range') {
    const raw = decodeAdmittedUtf8Bytes(admitted)
    const lines = raw.toString('utf8').split(/\n/)
    const slice = lines.slice(locator.start_line - 1, locator.end_line).join('\n')
    return { text: slice }
  }
  if (locator.kind === 'section') {
    if (admitted.media_type !== HTML_MEDIA_TYPE) {
      throw new PassageIntegrityVerificationError('section locator requires html admitted representation')
    }
    const text = excerptTextForHtmlSectionId(admitted, locator.section_id)
    if (!text) {
      throw new PassageIntegrityVerificationError(
        `html section_id ${locator.section_id} not found in admitted representation`,
      )
    }
    const bounded = buildInlinePassageTextRef(text)
    return { text: bounded.text }
  }
  if (locator.kind === 'byte_offset') {
    const bytes = decodeAdmittedInlineBytes(admitted)
    const slice = bytes.subarray(locator.start_offset, locator.end_offset + 1)
    return { text: slice.toString('utf8') }
  }
  if (locator.kind === 'page') {
    throw new PassageIntegrityVerificationError(
      'page locator verification must use parser-emitted page text at extraction time',
    )
  }
  throw new PassageIntegrityVerificationError(`unsupported locator kind for receipt: ${locator.kind}`)
}

/** Verify passage excerpt against admitted representation; does not persist bytes. */
export function buildPassageIntegrityVerification(params: {
  passage: PassageRecord
  source: Pick<SourceRecord, 'source_id'>
  revision: SourceRevision
  admitted: AdmittedContent
  extractionVersion: string
  /** PDF and other paths that already normalized page text at extraction. */
  preverifiedPageText?: string
}): PassageIntegrityVerification {
  if (params.passage.text_ref.mode !== 'inline') {
    throw new PassageIntegrityVerificationError('integrity receipt requires inline passage text')
  }
  const inline = params.passage.text_ref
  if (passageTextHash(inline.text) !== inline.text_hash) {
    throw new PassageIntegrityVerificationError('passage inline text_hash does not match text')
  }
  if (params.revision.revision_id !== params.admitted.revision.revision_id) {
    throw new PassageIntegrityVerificationError('revision_id does not match admitted revision')
  }
  if (params.revision.content_hash !== params.admitted.revision.content_hash) {
    throw new PassageIntegrityVerificationError('revision content_hash does not match admitted revision')
  }
  const admittedBytes = decodeAdmittedInlineBytes(params.admitted)
  const sourceContentHash = sha256Buffer(admittedBytes)
  if (sourceContentHash !== params.admitted.revision.content_hash) {
    throw new PassageIntegrityVerificationError('admitted bytes hash does not match revision content_hash')
  }

  let expectedText: string
  if (params.preverifiedPageText !== undefined) {
    const pageLocator = params.passage.locator
    if (pageLocator.kind !== 'page') {
      throw new PassageIntegrityVerificationError('preverifiedPageText requires page locator')
    }
    expectedText = buildInlinePassageTextRef(params.preverifiedPageText).text
  } else {
    expectedText = resolveExcerptFromAdmitted(params.admitted, params.passage.locator).text
  }

  const expectedHash = passageTextHash(expectedText)
  if (expectedHash !== inline.text_hash && expectedText !== inline.text) {
    throw new PassageIntegrityVerificationError(
      'passage text does not match admitted representation at declared locator',
    )
  }

  const receipt: PassageIntegrityVerification = {
    version: PASSAGE_INTEGRITY_RECORD_VERSION,
    verifier: PASSAGE_INTEGRITY_VERIFIER,
    verifier_version: PASSAGE_INTEGRITY_VERIFIER_VERSION,
    source_id: params.source.source_id,
    source_revision_id: params.revision.revision_id,
    source_content_hash: params.revision.content_hash,
    admitted_byte_length: params.admitted.payload.byte_length,
    extraction_version: params.extractionVersion,
    passage_id: params.passage.passage_id,
    locator: params.passage.locator,
    passage_text_hash: inline.text_hash,
    verification_scope: PASSAGE_INTEGRITY_VERIFICATION_SCOPE,
    retention: PASSAGE_INTEGRITY_RETENTION,
  }
  return PassageIntegrityVerificationSchema.parse(receipt)
}

export function passageWithIntegrityVerification(
  passage: PassageRecord,
  params: Omit<Parameters<typeof buildPassageIntegrityVerification>[0], 'passage'>,
): PassageRecord {
  const integrity_verification = buildPassageIntegrityVerification({ ...params, passage })
  return { ...passage, integrity_verification }
}

export function assertPassageIntegrityReceiptMatchesRead(params: {
  passage: PassageRecord
  candidate: SourceRecord
  revision: SourceRevision
  extractionVersion: string
}): void {
  const receipt = params.passage.integrity_verification
  if (!receipt) return
  if (receipt.source_id !== params.candidate.source_id) {
    throw new PassageIntegrityVerificationError('integrity receipt source_id does not match candidate')
  }
  if (receipt.source_revision_id !== params.revision.revision_id) {
    throw new PassageIntegrityVerificationError(
      'integrity receipt source_revision_id does not match read revision',
    )
  }
  if (receipt.source_content_hash !== params.revision.content_hash) {
    throw new PassageIntegrityVerificationError(
      'integrity receipt source_content_hash does not match read revision',
    )
  }
  if (receipt.passage_id !== params.passage.passage_id) {
    throw new PassageIntegrityVerificationError('integrity receipt passage_id does not match passage')
  }
  if (receipt.extraction_version !== params.extractionVersion) {
    throw new PassageIntegrityVerificationError(
      'integrity receipt extraction_version does not match read extraction_version',
    )
  }
  if (params.passage.text_ref.mode === 'inline' && receipt.passage_text_hash !== params.passage.text_ref.text_hash) {
    throw new PassageIntegrityVerificationError(
      'integrity receipt passage_text_hash does not match passage text_ref',
    )
  }
  if (JSON.stringify(receipt.locator) !== JSON.stringify(params.passage.locator)) {
    throw new PassageIntegrityVerificationError('integrity receipt locator does not match passage locator')
  }
}

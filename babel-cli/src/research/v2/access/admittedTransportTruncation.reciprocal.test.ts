/**
 * Truncation + UTF-8 boundary reciprocals for Agent A transport (A294 class).
 * Attempt2: original wire/decompressed bytes unknown; refetch length 218_649 is replay evidence only.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { describe, it } from 'node:test'
import { GeneralWebAdapter } from '../adapters/web/generalWebAdapter.js'
import { decodeAdmittedUtf8Bytes } from '../adapters/documents/plainTextFromAdmittedBytes.js'
import { buildAdmittedContent } from '../adapters/documents/testAdmittedFixtures.js'
import type { AdmittedContent } from '../contracts/admittedContent.js'
import type { SourceRecord } from '../contracts/sources.js'
import type { SourceAccessPort } from '../ports/sourceAccessPort.js'
import {
  DEFAULT_MAX_DECODED_ADMISSION_BYTES,
  G_L1_ATTEMPT2_REFETCH_DECOMPRESSED_LENGTH,
  type ExpandGzipWireAdmission,
} from './admittedTransportContract.js'
import { loadAgentAGzipWireAdmission } from './admittedTransportRegressionTarget.js'
import {
  htmlWithMultibyteStraddlingCut,
  sha256Hex,
  syntheticHtmlWithByteLength,
  utf8SafeTruncateBytes,
} from './admittedTransportTestFixtures.js'

const expand: ExpandGzipWireAdmission | null = await loadAgentAGzipWireAdmission()
const describeDecoder = expand ? describe : describe.skip

function assertAdmittedHashConsistency(admitted: AdmittedContent): void {
  const raw = Buffer.from(admitted.payload.bytes_base64, 'base64')
  assert.equal(raw.length, admitted.payload.byte_length)
  const digest = sha256Hex(raw)
  assert.equal(digest, admitted.payload.content_hash)
  assert.equal(digest, admitted.revision.content_hash)
}

describeDecoder('Agent A decode truncation (python.org-sized refetch class)', () => {
  it('bounds decoded gzip HTML at 200_000 bytes without invalid UTF-8 (218_649 refetch class)', () => {
    const plain = syntheticHtmlWithByteLength(G_L1_ATTEMPT2_REFETCH_DECOMPRESSED_LENGTH)
    const wire = gzipSync(plain)
    const result = expand!({
      wireBytes: wire,
      contentEncodingHeader: 'gzip',
      maxDecodedBytes: DEFAULT_MAX_DECODED_ADMISSION_BYTES,
      signal: new AbortController().signal,
      responseHeaders: { 'content-encoding': 'gzip', 'content-type': 'text/html; charset=utf-8' },
    })
    assert.equal(result.status, 'ok')
    if (result.status !== 'ok') return
    assert.equal(result.truncated, true)
    assert.ok(result.body.length <= DEFAULT_MAX_DECODED_ADMISSION_BYTES)
    decodeAdmittedUtf8Bytes(
      buildAdmittedContent('op-trunc-py', 'src-web', 'rev-trunc-py', result.body, 'text/html'),
    )
    assert.notEqual(result.body.length, G_L1_ATTEMPT2_REFETCH_DECOMPRESSED_LENGTH)
  })

  it('truncates on UTF-8 code point boundary when multibyte char straddles cap', () => {
    const { full, utf8SafeAtCap } = htmlWithMultibyteStraddlingCut(DEFAULT_MAX_DECODED_ADMISSION_BYTES)
    const wire = gzipSync(full)
    const result = expand!({
      wireBytes: wire,
      contentEncodingHeader: 'gzip',
      maxDecodedBytes: DEFAULT_MAX_DECODED_ADMISSION_BYTES,
      signal: new AbortController().signal,
    })
    assert.equal(result.status, 'ok')
    if (result.status !== 'ok') return
    assert.equal(result.truncated, true)
    assert.ok(result.body.length <= DEFAULT_MAX_DECODED_ADMISSION_BYTES)
    decodeAdmittedUtf8Bytes(
      buildAdmittedContent('op-mb', 'src-web', 'rev-mb', result.body, 'text/html'),
    )
    assert.equal(result.body.compare(utf8SafeAtCap), 0)
  })
})

describe('truncated admitted HTML read path (B reciprocal; no live fetch)', () => {
  it('emits consistent hashes and section locators for UTF-8-safe truncated admission', async () => {
    const limit = DEFAULT_MAX_DECODED_ADMISSION_BYTES
    const full = syntheticHtmlWithByteLength(limit + 8_000)
    const admittedBytes = utf8SafeTruncateBytes(full, limit)
    const hash = sha256Hex(admittedBytes)
    const opId = 'fetch-read-trunc'
    const pageUrl = 'https://example.test/trunc'
    const base = buildAdmittedContent(opId, 'src-web-trunc', 'rev-read-trunc', admittedBytes, 'text/html', {
      requestedUrl: pageUrl,
      finalUrl: pageUrl,
      redirectChain: [pageUrl],
    })
    const admitted: AdmittedContent = {
      ...base,
      operation_id: opId,
      revision: {
        ...base.revision,
        completeness: 'truncated',
        truncation_reason: 'decoded_byte_limit',
        byte_length_received: admittedBytes.length,
      },
      truncation: {
        reason: 'decoded_byte_limit',
        bytes_received: full.length,
        bytes_limit: limit,
      },
    }
    admitted.revision.content_hash = hash
    admitted.payload.content_hash = hash
    assertAdmittedHashConsistency(admitted)
    decodeAdmittedUtf8Bytes(admitted)

    const source: SourceRecord = {
      source_id: 'src-web-trunc',
      kind: 'web',
      canonical_key: 'https://example.test/trunc',
      observed_urls: [pageUrl],
    }
    const port: SourceAccessPort = {
      async search() {
        return {
          operationId: 'search',
          status: 'failed',
          failureCategory: 'search_provider_unavailable',
          message: 'stub',
        }
      },
      async fetchContent(request) {
        return { operationId: request.operationId, status: 'ok', admitted }
      },
    }
    const read = await new GeneralWebAdapter().read(
      { operationId: 'fetch-read-trunc', source, signal: new AbortController().signal },
      port,
    )
    assert.equal(read.status, 'ok')
    if (read.status !== 'ok') return
    assert.equal(read.revision.completeness, 'truncated')
    assert.ok(read.passages.length >= 1)
    const passage = read.passages[0]!
    assert.equal(passage.source_revision_id, admitted.revision.revision_id)
    assert.equal(passage.locator.kind, 'section')
    if (passage.text_ref.mode === 'inline') {
      const expectedHash = createHash('sha256').update(passage.text_ref.text, 'utf8').digest('hex')
      assert.equal(passage.text_ref.text_hash, expectedHash)
    }
  })
})

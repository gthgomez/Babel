/**
 * B reciprocal gzip/truncation tests on Agent A transport @ 06c18d44.
 * Attempt2 store retained no original wire bytes; 218_649 is refetch-class evidence only.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { describe, it } from 'node:test'
import { GeneralWebAdapter } from '../adapters/web/generalWebAdapter.js'
import { decodeAdmittedUtf8Bytes } from '../adapters/documents/plainTextFromAdmittedBytes.js'
import { buildAdmittedContent } from '../adapters/documents/testAdmittedFixtures.js'
import { SourceRecordSchema } from '../contracts/sources.js'
import type { SourceAccessPort } from '../ports/sourceAccessPort.js'
import {
  AdmittedContentCodingError,
  decodeAdmittedHttpBody,
} from './admittedHttpContentCoding.js'
import { FetchSourceAccessPort } from './fetchSourceAccessPort.js'
import { utf8SafeBytePrefix } from './utf8SafeBytePrefix.js'

const HOST_CAP = 200_000
const PYTHON_HTML_DECODED_BYTES = 218_649

function dispatchGzipBody(wire: Buffer, headers?: Record<string, string>) {
  return async () => ({
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-encoding': 'gzip',
      ...headers,
    },
    body: { buffer: wire, bytesReceived: wire.byteLength, truncated: false },
  })
}

describe('FetchSourceAccessPort gzip reciprocal (A transport)', () => {
  it('admits valid gzip HTML with http_content_coding provenance', async () => {
    const html = '<!doctype html><html><body><h1>Stable</h1><p>ok</p></body></html>'
    const wire = gzipSync(Buffer.from(html, 'utf8'))
    const url = 'https://www.python.org/downloads/'
    const port = new FetchSourceAccessPort({
      maxAdmittedBytes: HOST_CAP,
      dispatchGet: dispatchGzipBody(wire),
    })
    const source = SourceRecordSchema.parse({
      source_id: 'src-valid-gzip',
      kind: 'web',
      title: 't',
      observed_urls: [url],
      canonical_key: 'web:python.org/downloads',
    })
    const result = await port.fetchContent({
      operationId: 'fetch-valid-gzip',
      source,
      signal: new AbortController().signal,
    })
    assert.equal(result.status, 'ok')
    if (result.status !== 'ok') return
    const admitted = Buffer.from(result.admitted.payload.bytes_base64, 'base64')
    assert.equal(admitted.toString('utf8'), html)
    assert.equal(result.admitted.revision.completeness, 'complete')
    assert.deepEqual(result.admitted.provenance.http_content_coding?.content_encodings, ['gzip'])
    decodeAdmittedUtf8Bytes(result.admitted)
  })

  it('truthfully truncates 218_649-byte decoded gzip at 200_000 cap (python.org class)', async () => {
    const full = Buffer.alloc(PYTHON_HTML_DECODED_BYTES, 0x61)
    const wire = gzipSync(full)
    const url = 'https://www.python.org/downloads/'
    const port = new FetchSourceAccessPort({
      maxAdmittedBytes: HOST_CAP,
      dispatchGet: dispatchGzipBody(wire),
    })
    const source = SourceRecordSchema.parse({
      source_id: 'src-python-downloads',
      kind: 'web',
      title: 'Python downloads',
      observed_urls: [url],
      canonical_key: 'web:python.org/downloads',
    })
    const result = await port.fetchContent({
      operationId: 'fetch-python-trunc',
      source,
      signal: new AbortController().signal,
    })
    assert.equal(result.status, 'ok')
    if (result.status !== 'ok') return
    assert.equal(result.admitted.revision.completeness, 'truncated')
    assert.equal(result.admitted.revision.truncation_reason, 'host_decoded_byte_limit')
    assert.equal(result.admitted.truncation?.bytes_received, PYTHON_HTML_DECODED_BYTES)
    assert.equal(result.admitted.truncation?.bytes_limit, HOST_CAP)
    assert.equal(result.admitted.provenance.http_content_coding?.decoded_byte_length, PYTHON_HTML_DECODED_BYTES)
    assert.equal(result.admitted.provenance.http_content_coding?.decoded_truncated, true)
    const payload = Buffer.from(result.admitted.payload.bytes_base64, 'base64')
    assert.ok(payload.byteLength <= HOST_CAP)
    new TextDecoder('utf-8', { fatal: true }).decode(payload)
    const digest = createHash('sha256').update(payload).digest('hex')
    assert.equal(digest, result.admitted.payload.content_hash)
    assert.equal(digest, result.admitted.revision.content_hash)
  })

  it('UTF-8-safe admitted prefix when multibyte char straddles decoded cap', async () => {
    const head = '<html><body>'
    const tail = '</body></html>'
    const innerAscii = 'a'.repeat(HOST_CAP - Buffer.byteLength(head + tail, 'utf8') - 1)
    const full = Buffer.from(`${head}${innerAscii}🐍z${tail}`, 'utf8')
    assert.ok(full.byteLength > HOST_CAP)
    const expected = utf8SafeBytePrefix(full, HOST_CAP)
    const wire = gzipSync(full)
    const url = 'https://www.python.org/downloads/'
    const port = new FetchSourceAccessPort({
      maxAdmittedBytes: HOST_CAP,
      dispatchGet: dispatchGzipBody(wire),
    })
    const source = SourceRecordSchema.parse({
      source_id: 'src-mb',
      kind: 'web',
      title: 't',
      observed_urls: [url],
      canonical_key: 'web:python.org/downloads',
    })
    const result = await port.fetchContent({
      operationId: 'fetch-mb',
      source,
      signal: new AbortController().signal,
    })
    assert.equal(result.status, 'ok')
    if (result.status !== 'ok') return
    const payload = Buffer.from(result.admitted.payload.bytes_base64, 'base64')
    assert.equal(payload.compare(expected), 0)
    new TextDecoder('utf-8', { fatal: true }).decode(payload)
  })

  it('surfaces malformed gzip as fetch failure', async () => {
    const corrupt = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xff])
    const port = new FetchSourceAccessPort({
      dispatchGet: dispatchGzipBody(corrupt),
    })
    const source = SourceRecordSchema.parse({
      source_id: 'src-bad-gzip',
      kind: 'web',
      title: 't',
      observed_urls: ['https://example.test/bad'],
      canonical_key: 'web:example.test/bad',
    })
    const result = await port.fetchContent({
      operationId: 'fetch-bad-gzip',
      source,
      signal: new AbortController().signal,
    })
    assert.equal(result.status, 'failed')
  })

  it('decodeAdmittedHttpBody rejects unsupported br encoding', async () => {
    await assert.rejects(
      () =>
        decodeAdmittedHttpBody({
          encodedBody: Buffer.from('x'),
          contentEncodingHeader: 'br',
          maxDecodedBytes: 100,
          signal: new AbortController().signal,
        }),
      (err: unknown) => {
        assert.ok(err instanceof AdmittedContentCodingError)
        assert.equal(err.code, 'unsupported_encoding')
        return true
      },
    )
  })

  it('decodeAdmittedHttpBody honours abort before decompress', async () => {
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      () =>
        decodeAdmittedHttpBody({
          encodedBody: gzipSync(Buffer.from('<html></html>', 'utf8')),
          contentEncodingHeader: 'gzip',
          maxDecodedBytes: HOST_CAP,
          signal: controller.signal,
        }),
      (err: unknown) => {
        assert.ok(err instanceof AdmittedContentCodingError)
        assert.equal(err.code, 'aborted')
        return true
      },
    )
  })
})

describe('truncated admitted HTML read path (B reciprocal; no live fetch)', () => {
  it('section locators and text_hash stay consistent after truncated admission', async () => {
    const limit = HOST_CAP
    const full = Buffer.alloc(limit + 8_000, 0x61)
    const prefix = utf8SafeBytePrefix(
      Buffer.concat([
        Buffer.from('<html><body><h1>Evidence</h1>', 'utf8'),
        full,
        Buffer.from('</body></html>', 'utf8'),
      ]),
      limit,
    )
    const opId = 'fetch-read-trunc'
    const pageUrl = 'https://example.test/trunc'
    const hash = createHash('sha256').update(prefix).digest('hex')
    const base = buildAdmittedContent(opId, 'src-web-trunc', 'rev-read-trunc', prefix, 'text/html', {
      requestedUrl: pageUrl,
      finalUrl: pageUrl,
      redirectChain: [pageUrl],
    })
    const admitted = {
      ...base,
      operation_id: opId,
      revision: {
        ...base.revision,
        completeness: 'truncated' as const,
        truncation_reason: 'host_decoded_byte_limit',
        byte_length_received: prefix.length,
        content_hash: hash,
      },
      payload: { ...base.payload, content_hash: hash },
      truncation: {
        reason: 'host_decoded_byte_limit',
        bytes_received: prefix.length + 8_000,
        bytes_limit: limit,
      },
    }
    decodeAdmittedUtf8Bytes(admitted)
    const source = SourceRecordSchema.parse({
      source_id: 'src-web-trunc',
      kind: 'web',
      title: 't',
      observed_urls: [pageUrl],
      canonical_key: 'web:example.test/trunc',
    })
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
      { operationId: opId, source, signal: new AbortController().signal },
      port,
    )
    assert.equal(read.status, 'ok')
    if (read.status !== 'ok') return
    assert.equal(read.revision.completeness, 'truncated')
    assert.ok(read.passages.length >= 1)
    const passage = read.passages[0]!
    assert.equal(passage.source_revision_id, admitted.revision.revision_id)
    if (passage.text_ref.mode === 'inline') {
      const expectedHash = createHash('sha256').update(passage.text_ref.text, 'utf8').digest('hex')
      assert.equal(passage.text_ref.text_hash, expectedHash)
    }
  })
})

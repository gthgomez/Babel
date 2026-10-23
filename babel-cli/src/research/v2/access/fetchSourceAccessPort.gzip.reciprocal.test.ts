/**
 * B ACTUAL PORT reciprocal tests @ transport e912c2f (trim only in text decode, not transport).
 * Historical: review-artifacts/a06c18d4-integration-receipt.txt (06c),
 *   review-artifacts/a3ab8ac4-integration-receipt.txt (a3, superseded for live).
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createGzip, gzipSync } from 'node:zlib'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { decodeAdmittedUtf8Bytes } from '../adapters/documents/plainTextFromAdmittedBytes.js'
import { SourceRecordSchema } from '../contracts/sources.js'
import {
  AdmittedContentCodingError,
  decodeAdmittedHttpBody,
} from './admittedHttpContentCoding.js'
import { FetchSourceAccessPort } from './fetchSourceAccessPort.js'
import { trimIncompleteUtf8SequenceSuffix } from './utf8SafeBytePrefix.js'

export const TRANSPORT_COMMIT = 'e912c2f3320de0b6e1c9ff85b95b0f74d8b5323c'

const HOST_CAP = 200_000
const PYTHON_HTML_DECODED_BYTES = 218_649
const TEN_MB_GZIP_WIRE_BYTES = 9_751

const here = fileURLToPath(new URL('.', import.meta.url))
const pdfFixture = join(here, '../adapters/documents/fixtures/two-page-sample.pdf')

function dispatchGzipBody(
  wire: Buffer,
  headers?: Record<string, string>,
  contentType = 'text/html; charset=utf-8',
) {
  return async () => ({
    status: 200,
    headers: {
      'content-type': contentType,
      'content-encoding': 'gzip',
      ...headers,
    },
    body: { buffer: wire, bytesReceived: wire.byteLength, truncated: false },
  })
}

function dispatchIdentityBody(body: Buffer, contentType: string) {
  return async () => ({
    status: 200,
    headers: { 'content-type': contentType },
    body: { buffer: body, bytesReceived: body.byteLength, truncated: false },
  })
}

async function gzipBuffer(payload: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    const gzip = createGzip()
    gzip.on('data', (c) => chunks.push(c))
    gzip.on('error', reject)
    gzip.on('end', () => resolve(Buffer.concat(chunks)))
    gzip.end(payload)
  })
}

describe(`FetchSourceAccessPort ACTUAL PORT gzip @ ${TRANSPORT_COMMIT.slice(0, 8)}`, () => {
  it('binds reciprocal proof to published transport commit', () => {
    assert.equal(TRANSPORT_COMMIT, 'e912c2f3320de0b6e1c9ff85b95b0f74d8b5323c')
  })

  it('admits valid gzip HTML with http_content_coding provenance', async () => {
    const html = '<!doctype html><html><body><h1>Stable</h1><p>ok</p></body></html>'
    const wire = gzipSync(Buffer.from(html, 'utf8'))
    const port = new FetchSourceAccessPort({
      maxAdmittedBytes: HOST_CAP,
      dispatchGet: dispatchGzipBody(wire),
    })
    const source = SourceRecordSchema.parse({
      source_id: 'src-valid-gzip',
      kind: 'web',
      title: 't',
      observed_urls: ['https://www.python.org/downloads/'],
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
    decodeAdmittedUtf8Bytes(result.admitted)
  })

  it('python.org-class 218_649 gzip truncates at 200_000 with hash/completeness and lower-bound counts', async () => {
    const full = Buffer.alloc(PYTHON_HTML_DECODED_BYTES, 0x61)
    const wire = gzipSync(full)
    const port = new FetchSourceAccessPort({
      maxAdmittedBytes: HOST_CAP,
      dispatchGet: dispatchGzipBody(wire),
    })
    const source = SourceRecordSchema.parse({
      source_id: 'src-python-downloads',
      kind: 'web',
      title: 'Python downloads',
      observed_urls: ['https://www.python.org/downloads/'],
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
    assert.equal(result.admitted.truncation?.bytes_limit, HOST_CAP)
    assert.equal(result.admitted.provenance.http_content_coding?.decoded_truncated, true)
    assert.equal(result.admitted.provenance.http_content_coding?.decoded_byte_length_is_lower_bound, true)
    assert.ok((result.admitted.truncation?.bytes_received ?? 0) >= HOST_CAP)
    assert.ok((result.admitted.provenance.http_content_coding?.decoded_byte_length ?? 0) >= HOST_CAP)
    const payload = Buffer.from(result.admitted.payload.bytes_base64, 'base64')
    assert.equal(payload.byteLength, HOST_CAP)
    assert.equal(payload.compare(full.subarray(0, HOST_CAP)), 0)
    new TextDecoder('utf-8', { fatal: true }).decode(payload)
    const digest = createHash('sha256').update(payload).digest('hex')
    assert.equal(digest, result.admitted.payload.content_hash)
    assert.equal(digest, result.admitted.revision.content_hash)
  })

  it('transport admits byte-exact cap prefix (no UTF-8 trim); text decode trims incomplete tail', async () => {
    const head = '<html><body>'
    const tail = '</body></html>'
    const emoji = '🐍'
    const innerAscii = 'a'.repeat(
      HOST_CAP - Buffer.byteLength(head + tail, 'utf8') - Buffer.byteLength(emoji, 'utf8'),
    )
    const full = Buffer.from(`${head}${innerAscii}${emoji}z${tail}`, 'utf8')
    assert.ok(full.byteLength > HOST_CAP)
    const transportExpected = full.subarray(0, HOST_CAP)
    const wire = gzipSync(full)
    const port = new FetchSourceAccessPort({
      maxAdmittedBytes: HOST_CAP,
      dispatchGet: dispatchGzipBody(wire),
    })
    const source = SourceRecordSchema.parse({
      source_id: 'src-mb',
      kind: 'web',
      title: 't',
      observed_urls: ['https://www.python.org/downloads/'],
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
    assert.equal(payload.compare(transportExpected), 0)
    const textDecoded = decodeAdmittedUtf8Bytes(result.admitted)
    assert.equal(textDecoded.compare(trimIncompleteUtf8SequenceSuffix(transportExpected)), 0)
  })

  it(`bounded inflate: ${TEN_MB_GZIP_WIRE_BYTES}-byte gzip wire, 10MB payload, cap ${HOST_CAP}`, async () => {
    const payload = Buffer.alloc(10_000_000, 0x61)
    const encoded = await gzipBuffer(payload)
    assert.equal(encoded.byteLength, TEN_MB_GZIP_WIRE_BYTES)
    const port = new FetchSourceAccessPort({
      maxAdmittedBytes: HOST_CAP,
      dispatchGet: dispatchGzipBody(encoded),
    })
    const source = SourceRecordSchema.parse({
      source_id: 'src-10mb',
      kind: 'web',
      title: 't',
      observed_urls: ['https://www.python.org/downloads/'],
      canonical_key: 'web:python.org/downloads',
    })
    const result = await port.fetchContent({
      operationId: 'fetch-10mb-cap',
      source,
      signal: new AbortController().signal,
    })
    assert.equal(result.status, 'ok')
    if (result.status !== 'ok') return
    assert.equal(result.admitted.revision.completeness, 'truncated')
    assert.equal(result.admitted.provenance.http_content_coding?.decoded_byte_length_is_lower_bound, true)
    const admitted = Buffer.from(result.admitted.payload.bytes_base64, 'base64')
    assert.equal(admitted.byteLength, HOST_CAP)
    const digest = createHash('sha256').update(admitted).digest('hex')
    assert.equal(digest, result.admitted.payload.content_hash)
  })

  it('identity and gzip application/pdf bytes are byte-exact at transport', async () => {
    const pdfBytes = readFileSync(pdfFixture)
    const identityPort = new FetchSourceAccessPort({
      maxAdmittedBytes: HOST_CAP,
      dispatchGet: dispatchIdentityBody(pdfBytes, 'application/pdf'),
    })
    const gzipPort = new FetchSourceAccessPort({
      maxAdmittedBytes: HOST_CAP,
      dispatchGet: dispatchGzipBody(gzipSync(pdfBytes), {}, 'application/pdf'),
    })
    const source = SourceRecordSchema.parse({
      source_id: 'src-pdf',
      kind: 'web',
      title: 't',
      observed_urls: ['https://www.python.org/static/two-page-sample.pdf'],
      canonical_key: 'web:python.org/pdf',
    })
    const idResult = await identityPort.fetchContent({
      operationId: 'fetch-pdf-id',
      source,
      signal: new AbortController().signal,
    })
    const gzResult = await gzipPort.fetchContent({
      operationId: 'fetch-pdf-gz',
      source,
      signal: new AbortController().signal,
    })
    assert.equal(idResult.status, 'ok')
    assert.equal(gzResult.status, 'ok')
    if (idResult.status !== 'ok' || gzResult.status !== 'ok') return
    assert.equal(Buffer.from(idResult.admitted.payload.bytes_base64, 'base64').compare(pdfBytes), 0)
    assert.equal(Buffer.from(gzResult.admitted.payload.bytes_base64, 'base64').compare(pdfBytes), 0)
  })

  it('gzip PDF over cap is truncated with byte-exact cap prefix (no transport UTF-8 trim)', async () => {
    const pdfBytes = readFileSync(pdfFixture)
    const oversized = Buffer.concat([pdfBytes, Buffer.alloc(250_000, 0)])
    const wire = gzipSync(oversized)
    const port = new FetchSourceAccessPort({
      maxAdmittedBytes: HOST_CAP,
      dispatchGet: dispatchGzipBody(wire, {}, 'application/pdf'),
    })
    const source = SourceRecordSchema.parse({
      source_id: 'src-pdf-trunc',
      kind: 'web',
      title: 't',
      observed_urls: ['https://www.python.org/static/two-page-sample.pdf'],
      canonical_key: 'web:python.org/pdf-trunc',
    })
    const result = await port.fetchContent({
      operationId: 'fetch-pdf-trunc',
      source,
      signal: new AbortController().signal,
    })
    assert.equal(result.status, 'ok')
    if (result.status !== 'ok') return
    const admitted = Buffer.from(result.admitted.payload.bytes_base64, 'base64')
    assert.equal(admitted.compare(oversized.subarray(0, HOST_CAP)), 0)
    assert.equal(result.admitted.revision.completeness, 'truncated')
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

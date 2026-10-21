import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import type { AdmittedContent } from '../frozenPorts0ccd1733.js'
import { decodeAdmittedUtf8Bytes, passagesFromAdmittedPlainText } from './plainTextFromAdmittedBytes.js'
import { resolveQuarantinedFixturePath } from './quarantinePath.js'

const devCorpusRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../profiles/general/fixtures/dev-corpus',
)

function admittedFromBytes(
  operationId: string,
  sourceId: string,
  revisionId: string,
  bytes: Buffer,
  mediaType: string,
  opts?: { corruptHash?: boolean; wrongRevisionHash?: boolean },
): AdmittedContent {
  const hash = createHash('sha256').update(bytes).digest('hex')
  const payloadHash = opts?.corruptHash ? '0'.repeat(64) : hash
  const revisionHash = opts?.wrongRevisionHash ? 'f'.repeat(64) : hash
  return {
    operation_id: operationId,
    revision: {
      revision_id: revisionId,
      source_id: sourceId,
      content_hash: revisionHash,
      retrieved_at: '2026-10-21T00:00:00.000Z',
      completeness_status: 'complete',
    },
    media_type: mediaType,
    provenance: {
      requested_url: 'file://fixture/local',
      final_url: 'file://fixture/local',
      redirect_chain: [],
    },
    payload: {
      mode: 'inline_bytes',
      bytes_base64: bytes.toString('base64'),
      byte_length: bytes.length,
      content_hash: payloadHash,
    },
  }
}

test('passagesFromAdmittedPlainText: G-DEV-03 raw bytes, hashes, line_range locators', () => {
  const rel = 'G-DEV-03/sources/official-policy.txt'
  const path = resolveQuarantinedFixturePath(devCorpusRoot, rel)
  const bytes = readFileSync(path)
  const admitted = admittedFromBytes('op-gdev3', 'src-gdev3', 'rev-gdev3', bytes, 'text/plain')
  decodeAdmittedUtf8Bytes(admitted)
  const passages = passagesFromAdmittedPlainText(admitted)
  assert.ok(passages.length >= 2)
  for (const p of passages) {
    assert.equal(p.locator.kind, 'line_range')
    assert.equal(p.locator.start_line, p.locator.end_line)
    assert.equal(p.source_id, 'src-gdev3')
    assert.equal(p.revision_id, 'rev-gdev3')
    assert.equal(p.passage_id, `op-gdev3:L${p.locator.start_line}`)
  }
  assert.match(passages[0]?.text ?? '', /retention|policy/i)
})

test('decodeAdmittedUtf8Bytes: rejects byte_length mismatch', () => {
  const bytes = Buffer.from('a\n', 'utf8')
  const admitted = admittedFromBytes('op', 's', 'r', bytes, 'text/plain')
  admitted.payload.byte_length = bytes.length + 1
  assert.throws(() => decodeAdmittedUtf8Bytes(admitted), /byte_length/)
})

test('decodeAdmittedUtf8Bytes: rejects payload content_hash mismatch', () => {
  const bytes = Buffer.from('hello', 'utf8')
  const admitted = admittedFromBytes('op', 's', 'r', bytes, 'text/plain', { corruptHash: true })
  assert.throws(() => decodeAdmittedUtf8Bytes(admitted), /payload content_hash/)
})

test('decodeAdmittedUtf8Bytes: rejects revision content_hash mismatch', () => {
  const bytes = Buffer.from('hello', 'utf8')
  const admitted = admittedFromBytes('op', 's', 'r', bytes, 'text/plain', { wrongRevisionHash: true })
  assert.throws(() => decodeAdmittedUtf8Bytes(admitted), /revision content_hash/)
})

test('decodeAdmittedUtf8Bytes: rejects invalid UTF-8', () => {
  const bytes = Buffer.from([0xc3, 0x28])
  const admitted = admittedFromBytes('op', 's', 'r', bytes, 'text/plain')
  assert.throws(() => decodeAdmittedUtf8Bytes(admitted), /UTF-8/)
})

test('passagesFromAdmittedPlainText: rejects non-text media_type', () => {
  const bytes = Buffer.from('%PDF-fake', 'utf8')
  const admitted = admittedFromBytes('op', 's', 'r', bytes, 'application/pdf')
  assert.throws(() => passagesFromAdmittedPlainText(admitted), /media_type/)
})

test('decodeAdmittedUtf8Bytes: rejects decoded length drift vs byte_length', () => {
  const bytes = Buffer.from('ok', 'utf8')
  const admitted = admittedFromBytes('op', 's', 'r', bytes, 'text/plain')
  admitted.payload.bytes_base64 = Buffer.from('longer-bytes!!', 'utf8').toString('base64')
  admitted.payload.byte_length = bytes.length
  assert.throws(() => decodeAdmittedUtf8Bytes(admitted), /byte_length|buffer length/)
})

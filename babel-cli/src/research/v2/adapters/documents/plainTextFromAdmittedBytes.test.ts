import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { PassageRecordSchema } from '../../contracts/passages.js'
import { decodeAdmittedUtf8Bytes, passagesFromAdmittedPlainText, PLAIN_TEXT_MEDIA_TYPE } from './plainTextFromAdmittedBytes.js'
import { buildAdmittedContent } from './testAdmittedFixtures.js'
import { resolveQuarantinedFixturePath } from './quarantinePath.js'

const devCorpusRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../profiles/general/fixtures/dev-corpus',
)

test('passagesFromAdmittedPlainText: G-DEV-03 raw bytes, schema-valid passages', () => {
  const rel = 'G-DEV-03/sources/official-policy.txt'
  const path = resolveQuarantinedFixturePath(devCorpusRoot, rel)
  const bytes = readFileSync(path)
  const admitted = buildAdmittedContent('op-gdev3', 'src-gdev3', 'rev-gdev3', bytes, PLAIN_TEXT_MEDIA_TYPE)
  decodeAdmittedUtf8Bytes(admitted)
  const passages = passagesFromAdmittedPlainText(admitted)
  assert.ok(passages.length >= 2)
  for (const p of passages) {
    PassageRecordSchema.parse(p)
    assert.equal(p.locator.kind, 'line_range')
    assert.equal(p.locator.start_line, p.locator.end_line)
    assert.equal(p.source_revision_id, 'rev-gdev3')
    assert.equal(p.text_ref.mode, 'inline')
  }
})

test('decodeAdmittedUtf8Bytes: rejects byte_length mismatch', () => {
  const bytes = Buffer.from('a\n', 'utf8')
  const admitted = buildAdmittedContent('op', 's', 'r', bytes, PLAIN_TEXT_MEDIA_TYPE)
  admitted.payload.byte_length = bytes.length + 1
  assert.throws(() => decodeAdmittedUtf8Bytes(admitted), /byte_length/)
})

test('decodeAdmittedUtf8Bytes: rejects payload content_hash mismatch', () => {
  const bytes = Buffer.from('hello', 'utf8')
  const admitted = buildAdmittedContent('op', 's', 'r', bytes, PLAIN_TEXT_MEDIA_TYPE, {
    corruptPayloadHash: true,
  })
  assert.throws(() => decodeAdmittedUtf8Bytes(admitted), /payload content_hash/)
})

test('decodeAdmittedUtf8Bytes: rejects revision content_hash mismatch', () => {
  const bytes = Buffer.from('hello', 'utf8')
  const admitted = buildAdmittedContent('op', 's', 'r', bytes, PLAIN_TEXT_MEDIA_TYPE, {
    corruptRevisionHash: true,
  })
  assert.throws(() => decodeAdmittedUtf8Bytes(admitted), /revision content_hash/)
})

test('decodeAdmittedUtf8Bytes: trims incomplete UTF-8 suffix for host-truncated text/plain', () => {
  const prefix = Buffer.from('abc', 'utf8')
  const raw = Buffer.concat([prefix, Buffer.from([0xe2, 0x82])])
  const admitted = buildAdmittedContent('op', 's', 'r', raw, PLAIN_TEXT_MEDIA_TYPE)
  admitted.revision.truncation_reason = 'host_decoded_byte_limit'
  admitted.revision.completeness = 'truncated'
  const decoded = decodeAdmittedUtf8Bytes(admitted)
  assert.equal(decoded.toString('utf8'), 'abc')
})

test('decodeAdmittedUtf8Bytes: does not trim incomplete suffix for truncated application/pdf', () => {
  const raw = Buffer.concat([Buffer.from('%PDF-', 'utf8'), Buffer.from([0xe2, 0x82])])
  const admitted = buildAdmittedContent('op', 's', 'r', raw, 'application/pdf')
  admitted.revision.truncation_reason = 'host_decoded_byte_limit'
  admitted.revision.completeness = 'truncated'
  assert.throws(() => decodeAdmittedUtf8Bytes(admitted), /UTF-8/)
})

test('decodeAdmittedUtf8Bytes: rejects invalid UTF-8', () => {
  const bytes = Buffer.from([0xc3, 0x28])
  const admitted = buildAdmittedContent('op', 's', 'r', bytes, PLAIN_TEXT_MEDIA_TYPE)
  assert.throws(() => decodeAdmittedUtf8Bytes(admitted), /UTF-8/)
})

test('passagesFromAdmittedPlainText: rejects text/html login markup as unsupported', () => {
  const bytes = Buffer.from('<html><form>login</form></html>', 'utf8')
  const admitted = buildAdmittedContent('op', 's', 'r', bytes, 'text/html')
  assert.throws(() => passagesFromAdmittedPlainText(admitted), /unsupported media_type/)
})

test('decodeAdmittedUtf8Bytes: rejects decoded length drift vs byte_length', () => {
  const bytes = Buffer.from('ok', 'utf8')
  const admitted = buildAdmittedContent('op', 's', 'r', bytes, PLAIN_TEXT_MEDIA_TYPE)
  admitted.payload.bytes_base64 = Buffer.from('longer-bytes!!', 'utf8').toString('base64')
  admitted.payload.byte_length = bytes.length
  assert.throws(() => decodeAdmittedUtf8Bytes(admitted), /byte_length|buffer length/)
})

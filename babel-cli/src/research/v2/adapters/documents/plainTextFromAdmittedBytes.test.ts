import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import type { AdmittedContent } from '../frozenPorts0ccd1733.js'
import { passagesFromAdmittedPlainText } from './plainTextFromAdmittedBytes.js'
import { resolveQuarantinedFixturePath } from './quarantinePath.js'

const devCorpusRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../profiles/general/fixtures/dev-corpus',
)

function admittedFromFixtureBytes(
  operationId: string,
  sourceId: string,
  revisionId: string,
  bytes: Buffer,
  mediaType: string,
): AdmittedContent {
  const hash = createHash('sha256').update(bytes).digest('hex')
  return {
    operation_id: operationId,
    revision: {
      revision_id: revisionId,
      source_id: sourceId,
      content_hash: hash,
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
      content_hash: hash,
    },
  }
}

test('passagesFromAdmittedPlainText: G-DEV-03 policy lines with line_range locators', () => {
  const rel = 'G-DEV-03/sources/official-policy.txt'
  const path = resolveQuarantinedFixturePath(devCorpusRoot, rel)
  const bytes = readFileSync(path)
  const admitted = admittedFromFixtureBytes('op-gdev3', 'src-gdev3', 'rev-gdev3', bytes, 'text/plain')
  const passages = passagesFromAdmittedPlainText(admitted)
  assert.ok(passages.length >= 2)
  assert.equal(passages[0]?.locator.kind, 'line_range')
  assert.match(passages[0]?.text ?? '', /retention|policy/i)
  assert.equal(passages.every((p) => p.extraction_version === passages[0]?.extraction_version), true)
})

test('passagesFromAdmittedPlainText: rejects byte_length mismatch', () => {
  const bytes = Buffer.from('a\n', 'utf8')
  const admitted = admittedFromFixtureBytes('op', 's', 'r', bytes, 'text/plain')
  admitted.payload.byte_length = bytes.length + 1
  assert.throws(() => passagesFromAdmittedPlainText(admitted), /byte_length/)
})

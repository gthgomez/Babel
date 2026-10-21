import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { PassageRecordSchema } from '../../contracts/passages.js'
import { SourceRevisionSchema } from '../../contracts/sources.js'
import { AdmittedContentSchema } from '../../contracts/admittedContent.js'

const contractsRoot = join(dirname(fileURLToPath(import.meta.url)), '../../contracts')
const contractsPresent = existsSync(join(contractsRoot, 'passages.ts'))

test(
  'real A contract schemas accept document adapter shapes',
  { skip: contractsPresent ? false : 'A contracts tree not present (run in 0ccd integration worktree)' },
  () => {
    const revision = SourceRevisionSchema.parse({
      revision_id: 'rev-1',
      source_id: 'src-1',
      content_hash: 'a'.repeat(64),
      retrieved_at: '2026-10-21T00:00:00.000Z',
      extraction_version: 'general-plain-text/0.1.0',
      media_type: 'text/plain',
      completeness: 'complete',
    })
    assert.equal(revision.completeness, 'complete')
    const passage = PassageRecordSchema.parse({
      passage_id: 'p1',
      source_revision_id: 'rev-1',
      locator: { kind: 'line_range', start_line: 1, end_line: 1 },
      text_ref: { mode: 'inline', text: 'hello', text_hash: 'b'.repeat(64) },
    })
    assert.equal(passage.text_ref.mode, 'inline')
    AdmittedContentSchema.parse({
      operation_id: 'op-1',
      revision,
      media_type: 'text/plain',
      provenance: {
        requested_url: 'https://example.invalid/r',
        final_url: 'https://example.invalid/f',
        redirect_chain: [],
      },
      payload: {
        mode: 'inline_bytes',
        bytes_base64: Buffer.from('hello', 'utf8').toString('base64'),
        byte_length: 5,
        content_hash: 'c'.repeat(64),
      },
    })
  },
)

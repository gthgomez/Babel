/**
 * M1.2 independent review FIX — pinning, admission validation, abort, idempotency.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import type { AdmittedContent } from '../../contracts/admittedContent.js'
import { SourceRecordSchema } from '../../contracts/sources.js'
import { FakeSourceAccessPort, type FakePortClock } from '../../fixtures/fakePorts.js'
import type { SourceAccessPort, SourceFetchRequest, SourceFetchResult } from '../../ports/sourceAccessPort.js'
import {
  technicalRepositoryCorpusBody,
  technicalRepositoryCorpusSource,
  technicalRepositoryCorpusFinalUrl,
  technicalRepositoryPinnedCommitSha,
} from '../../fixtures/technicalRepositoryCorpus.js'
import { TechnicalRepositoryFileAdapter } from './repositoryFileAdapter.js'

const adapter = new TechnicalRepositoryFileAdapter()

/** Stable timestamp for idempotency deepEqual (includes revision.retrieved_at). */
const REPEAT_READ_RETRIEVED_AT = '2026-10-20T12:00:00.000Z'

const repeatReadDeterministicClock: FakePortClock = {
  now(): string {
    return REPEAT_READ_RETRIEVED_AT
  },
}

function validAccess(): FakeSourceAccessPort {
  return new FakeSourceAccessPort([
    {
      source: technicalRepositoryCorpusSource,
      body: technicalRepositoryCorpusBody,
      mediaType: 'text/plain',
      finalUrl: technicalRepositoryCorpusFinalUrl,
    },
  ])
}

describe('technical repository_file adapter M1.2 repairs', () => {
  it('rejects repository_file without github_commit_sha before fetch', async () => {
    const unpinned = SourceRecordSchema.parse({
      ...technicalRepositoryCorpusSource,
      canonical_identifiers: { github_repo_id: 'github:gthgomez/Babel' },
    })
    let fetchCalled = false
    const access: SourceAccessPort = {
      search: async () => ({ operationId: 's', status: 'ok', hits: [] }),
      fetchContent: async (req) => {
        fetchCalled = true
        return validAccess().fetchContent(req)
      },
    }
    const result = await adapter.read(
      { operationId: 'read-unpinned', source: unpinned, signal: new AbortController().signal },
      access,
    )
    assert.equal(fetchCalled, false)
    assert.equal(result.status, 'failed')
    if (result.status === 'failed') {
      assert.equal(result.failureCategory, 'pin_binding_failed')
    }
  })

  it('rejects floating /blob/main/ observed_urls', async () => {
    const floating = SourceRecordSchema.parse({
      ...technicalRepositoryCorpusSource,
      observed_urls: [
        'https://github.com/gthgomez/Babel/blob/main/babel-cli/src/research/contracts.ts',
      ],
    })
    const result = await adapter.read(
      { operationId: 'read-main', source: floating, signal: new AbortController().signal },
      validAccess(),
    )
    assert.equal(result.status, 'failed')
  })

  it('rejects login HTML and hash-inconsistent admission', async () => {
    const loginHtml = '<html><body>Sign in to GitHub</body></html>'
    const bytes = Buffer.from(loginHtml, 'utf8')
    const wrongHash = 'f'.repeat(64)
    const admitted: AdmittedContent = {
      operation_id: 'read-html:fetch',
      revision: {
        revision_id: 'rev-html',
        source_id: technicalRepositoryCorpusSource.source_id,
        content_hash: wrongHash,
        retrieved_at: '2026-10-20T12:00:00.000Z',
        extraction_version: 'fake',
        media_type: 'text/html',
        completeness: 'complete',
        byte_length_received: bytes.length,
      },
      media_type: 'text/html',
      provenance: {
        requested_url: technicalRepositoryCorpusFinalUrl,
        final_url: technicalRepositoryCorpusFinalUrl,
        redirect_chain: [technicalRepositoryCorpusFinalUrl],
        repository_file_pin: {
          pinned_blob_url: technicalRepositoryCorpusSource.observed_urls[0]!,
        },
      },
      payload: {
        mode: 'inline_bytes',
        bytes_base64: bytes.toString('base64'),
        byte_length: bytes.length,
        content_hash: wrongHash,
      },
    }
    const access: SourceAccessPort = {
      search: async () => ({ operationId: 's', status: 'ok', hits: [] }),
      async fetchContent(request: SourceFetchRequest): Promise<SourceFetchResult> {
        return { operationId: request.operationId, status: 'ok', admitted }
      },
    }
    const htmlResult = await adapter.read(
      {
        operationId: 'read-html',
        source: technicalRepositoryCorpusSource,
        signal: new AbortController().signal,
      },
      access,
    )
    assert.equal(htmlResult.status, 'failed')
    if (htmlResult.status === 'failed') {
      assert.equal(htmlResult.failureCategory, 'admission_rejected')
    }

    const plainBytes = Buffer.from('export const X = 1\n', 'utf8')
    const goodHash = createHash('sha256').update(plainBytes).digest('hex')
    const payloadWrongHash = 'e'.repeat(64)
    const hashAdmitted: AdmittedContent = {
      operation_id: 'read-hash:fetch',
      revision: {
        revision_id: 'rev-hash',
        source_id: technicalRepositoryCorpusSource.source_id,
        content_hash: goodHash,
        retrieved_at: '2026-10-20T12:00:00.000Z',
        extraction_version: 'fake',
        media_type: 'text/plain',
        completeness: 'complete',
        byte_length_received: plainBytes.length,
      },
      media_type: 'text/plain',
      provenance: {
        requested_url: technicalRepositoryCorpusFinalUrl,
        final_url: technicalRepositoryCorpusFinalUrl,
        redirect_chain: [technicalRepositoryCorpusFinalUrl],
        repository_file_pin: {
          pinned_blob_url: technicalRepositoryCorpusSource.observed_urls[0]!,
        },
      },
      payload: {
        mode: 'inline_bytes',
        bytes_base64: plainBytes.toString('base64'),
        byte_length: plainBytes.length,
        content_hash: payloadWrongHash,
      },
    }
    const access2: SourceAccessPort = {
      search: async () => ({ operationId: 's', status: 'ok', hits: [] }),
      async fetchContent(request: SourceFetchRequest): Promise<SourceFetchResult> {
        return { operationId: request.operationId, status: 'ok', admitted: hashAdmitted }
      },
    }
    const hashResult = await adapter.read(
      {
        operationId: 'read-hash',
        source: technicalRepositoryCorpusSource,
        signal: new AbortController().signal,
      },
      access2,
    )
    assert.equal(hashResult.status, 'failed')
    if (hashResult.status === 'failed') {
      assert.equal(hashResult.failureCategory, 'admission_rejected')
      assert.match(hashResult.message, /content hash is inconsistent/i)
    }
  })

  it('returns cancelled when aborted after fetch completes', async () => {
    const controller = new AbortController()
    const access: SourceAccessPort = {
      search: async () => ({ operationId: 's', status: 'ok', hits: [] }),
      async fetchContent(request: SourceFetchRequest): Promise<SourceFetchResult> {
        const inner = await validAccess().fetchContent(request)
        controller.abort()
        return inner
      },
    }
    const result = await adapter.read(
      {
        operationId: 'read-abort',
        source: technicalRepositoryCorpusSource,
        signal: controller.signal,
      },
      access,
    )
    assert.equal(result.status, 'cancelled')
  })

  it('returns cancelled when aborted after discover search', async () => {
    const controller = new AbortController()
    const access: SourceAccessPort = {
      async search() {
        controller.abort()
        return {
          operationId: 'disc-abort:search',
          status: 'ok',
          hits: [
            {
              source: technicalRepositoryCorpusSource,
              snippet: 'x',
              completeness: 'snippet',
            },
          ],
        }
      },
      fetchContent: (req) => validAccess().fetchContent(req),
    }
    const result = await adapter.discover(
      { operationId: 'disc-abort', query: 'untrusted', signal: controller.signal },
      access,
    )
    assert.equal(result.status, 'cancelled')
  })

  it('rejects final_url repository swap with same commit and path', async () => {
    const access = new FakeSourceAccessPort([
      {
        source: technicalRepositoryCorpusSource,
        body: technicalRepositoryCorpusBody,
        mediaType: 'text/plain',
        finalUrl: `https://github.com/OTHER/OTHER/blob/${technicalRepositoryPinnedCommitSha}/babel-cli/src/research/contracts.ts`,
      },
    ])
    const result = await adapter.read(
      {
        operationId: 'read-repo-swap',
        source: technicalRepositoryCorpusSource,
        signal: new AbortController().signal,
      },
      access,
    )
    assert.equal(result.status, 'failed')
    if (result.status === 'failed') {
      assert.equal(result.failureCategory, 'pin_binding_failed')
      assert.match(result.message, /fetch hop owner does not match canonical repository/i)
    }
  })

  it('rejects admitted requested_url owner/repo drift from canonical source', async () => {
    const bytes = Buffer.from(technicalRepositoryCorpusBody, 'utf8')
    const hash = createHash('sha256').update(bytes).digest('hex')
    const driftedRequested = `https://raw.githubusercontent.com/OTHER/OTHER/${technicalRepositoryPinnedCommitSha}/babel-cli/src/research/contracts.ts`
    const admitted: AdmittedContent = {
      operation_id: 'read-req-drift:fetch',
      revision: {
        revision_id: 'rev-req',
        source_id: technicalRepositoryCorpusSource.source_id,
        content_hash: hash,
        retrieved_at: '2026-10-20T12:00:00.000Z',
        extraction_version: 'fake',
        media_type: 'text/plain',
        completeness: 'complete',
        byte_length_received: bytes.length,
      },
      media_type: 'text/plain',
      provenance: {
        requested_url: driftedRequested,
        final_url: technicalRepositoryCorpusFinalUrl,
        redirect_chain: [driftedRequested, technicalRepositoryCorpusFinalUrl],
        repository_file_pin: {
          pinned_blob_url: technicalRepositoryCorpusSource.observed_urls[0]!,
        },
      },
      payload: {
        mode: 'inline_bytes',
        bytes_base64: bytes.toString('base64'),
        byte_length: bytes.length,
        content_hash: hash,
      },
    }
    const access: SourceAccessPort = {
      search: async () => ({ operationId: 's', status: 'ok', hits: [] }),
      async fetchContent(request: SourceFetchRequest): Promise<SourceFetchResult> {
        return { operationId: request.operationId, status: 'ok', admitted }
      },
    }
    const result = await adapter.read(
      {
        operationId: 'read-req-drift',
        source: technicalRepositoryCorpusSource,
        signal: new AbortController().signal,
      },
      access,
    )
    assert.equal(result.status, 'failed')
    if (result.status === 'failed') {
      assert.equal(result.failureCategory, 'pin_binding_failed')
      assert.match(result.message, /fetch hop owner does not match/i)
    }
  })

  it('rejects fetch response operation_id drift from request', async () => {
    const access: SourceAccessPort = {
      search: async () => ({ operationId: 's', status: 'ok', hits: [] }),
      async fetchContent(request: SourceFetchRequest): Promise<SourceFetchResult> {
        const inner = await validAccess().fetchContent(request)
        if (inner.status !== 'ok') return inner
        return { operationId: 'foreign-op-id', status: 'ok', admitted: inner.admitted }
      },
    }
    const result = await adapter.read(
      {
        operationId: 'read-op-drift',
        source: technicalRepositoryCorpusSource,
        signal: new AbortController().signal,
      },
      access,
    )
    assert.equal(result.status, 'failed')
    if (result.status === 'failed') {
      assert.equal(result.failureCategory, 'pin_binding_failed')
      assert.match(result.message, /operation_id does not match request/i)
    }
  })

  it('rejects provenance commit mismatch vs pinned source', async () => {
    const wrongCommit = 'a'.repeat(40)
    const access = new FakeSourceAccessPort([
      {
        source: technicalRepositoryCorpusSource,
        body: technicalRepositoryCorpusBody,
        mediaType: 'text/plain',
        finalUrl: `https://github.com/gthgomez/Babel/blob/${wrongCommit}/babel-cli/src/research/contracts.ts`,
      },
    ])
    const result = await adapter.read(
      {
        operationId: 'read-prov',
        source: technicalRepositoryCorpusSource,
        signal: new AbortController().signal,
      },
      access,
    )
    assert.equal(result.status, 'failed')
    assert.ok(technicalRepositoryPinnedCommitSha !== wrongCommit)
  })

  it('repeat read with same operation id is byte-identical', async () => {
    const access = new FakeSourceAccessPort(
      [
        {
          source: technicalRepositoryCorpusSource,
          body: technicalRepositoryCorpusBody,
          mediaType: 'text/plain',
          finalUrl: technicalRepositoryCorpusFinalUrl,
        },
      ],
      repeatReadDeterministicClock,
    )
    const request = {
      operationId: 'read-repeat',
      source: technicalRepositoryCorpusSource,
      signal: new AbortController().signal,
    }
    const first = await adapter.read(request, access)
    const second = await adapter.read(request, access)
    assert.deepEqual(second, first)
    assert.equal(first.status, 'ok')
  })
})

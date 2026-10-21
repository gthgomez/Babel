import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { FakeSourceAccessPort } from '../../fixtures/fakePorts.js'
import type { SourceAccessPort } from '../../ports/sourceAccessPort.js'
import {
  technicalRepositoryCorpusBody,
  technicalRepositoryCorpusFinalUrl,
  technicalRepositoryCorpusSource,
} from '../../fixtures/technicalRepositoryCorpus.js'
import {
  TECHNICAL_REPOSITORY_FILE_ADAPTER_ID,
  TechnicalRepositoryFileAdapter,
} from './repositoryFileAdapter.js'
import { TECHNICAL_PLAIN_EXTRACTION_VERSION } from './plainTextFromAdmitted.js'

describe('technical repository_file adapter', () => {
  const adapter = new TechnicalRepositoryFileAdapter()

  it('discover returns search hits as candidates via SourceAccessPort only', async () => {
    const access = new FakeSourceAccessPort([
      {
        source: technicalRepositoryCorpusSource,
        body: technicalRepositoryCorpusBody,
        mediaType: 'text/plain',
        finalUrl: technicalRepositoryCorpusFinalUrl,
      },
    ])
    const result = await adapter.discover(
      {
        operationId: 'disc-1',
        query: 'untrusted data',
        signal: new AbortController().signal,
      },
      access,
    )
    assert.equal(result.status, 'ok')
    if (result.status !== 'ok') return
    assert.equal(result.candidates.length, 1)
    assert.equal(result.candidates[0]?.source_id, technicalRepositoryCorpusSource.source_id)
  })

  it('read fetches admitted bytes and emits deterministic passages', async () => {
    const access = new FakeSourceAccessPort([
      {
        source: technicalRepositoryCorpusSource,
        body: technicalRepositoryCorpusBody,
        mediaType: 'text/plain',
        finalUrl: technicalRepositoryCorpusFinalUrl,
      },
    ])
    const read = await adapter.read(
      {
        operationId: 'read-1',
        source: technicalRepositoryCorpusSource,
        signal: new AbortController().signal,
      },
      access,
    )
    assert.equal(read.status, 'ok')
    if (read.status !== 'ok') return
    assert.equal(read.extraction_version, TECHNICAL_PLAIN_EXTRACTION_VERSION)
    assert.equal(read.revision.source_id, technicalRepositoryCorpusSource.source_id)
    assert.equal(read.passages.length, 1)
    assert.match(read.passages[0]?.passage_id ?? '', /^passage-[a-f0-9]{24}$/)
    const textRef = read.passages[0]?.text_ref
    assert.equal(textRef?.mode, 'inline')
    if (textRef?.mode === 'inline') {
      assert.ok(textRef.text.includes('untrusted data'))
    }
  })

  it('rejects unsupported source kinds without fetching', async () => {
    const inner = new FakeSourceAccessPort([])
    let fetchCalled = false
    const guarded: SourceAccessPort = {
      search: (req) => inner.search(req),
      async fetchContent(req) {
        fetchCalled = true
        return inner.fetchContent(req)
      },
    }
    const webSource = { ...technicalRepositoryCorpusSource, kind: 'web' as const }
    const result = await adapter.read(
      {
        operationId: 'read-bad-kind',
        source: webSource,
        signal: new AbortController().signal,
      },
      guarded,
    )
    assert.equal(result.status, 'failed')
    assert.equal(fetchCalled, false)
    if (result.status === 'failed') {
      assert.equal(result.failureCategory, 'unsupported_source_kind')
    }
  })

  it('exposes frozen adapter id', () => {
    assert.equal(adapter.adapterId, TECHNICAL_REPOSITORY_FILE_ADAPTER_ID)
    assert.deepEqual(adapter.supportedKinds, ['repository_file'])
  })
})

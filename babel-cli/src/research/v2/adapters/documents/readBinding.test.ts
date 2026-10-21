import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SourceRecord } from '../../contracts/sources.js'
import { buildAdmittedContent } from './testAdmittedFixtures.js'
import {
  admitsRequestedUrlForSource,
  bindingFailed,
  validateAdmittedRedirectProvenance,
  validateFetchBinding,
} from './readBinding.js'

const OBSERVED = 'https://example.invalid/source'

function sampleSource(sourceId = 'src-1'): SourceRecord {
  return {
    source_id: sourceId,
    kind: 'document',
    canonical_key: `fixture:${sourceId}`,
    observed_urls: [OBSERVED],
  }
}

test('validateFetchBinding: rejects foreign operationId on failed fetch before propagating failure', () => {
  const bound = validateFetchBinding(
    'read-op',
    sampleSource(),
    {
      operationId: 'other-op',
      status: 'failed',
      failureCategory: 'network_error',
      message: 'stale failure from another operation',
    },
    AbortSignal.timeout(100),
  )
  assert.ok(bound)
  assert.equal(bound?.status, 'failed')
  if (bound?.status === 'failed') {
    assert.equal(bound.failureCategory, 'contract_violation')
    assert.match(bound.message, /operationId/)
  }
})

test('validateFetchBinding: rejects foreign operationId on cancelled fetch', () => {
  const bound = validateFetchBinding(
    'read-op',
    sampleSource(),
    { operationId: 'other-op', status: 'cancelled' },
    AbortSignal.timeout(100),
  )
  assert.ok(bound)
  assert.equal(bound?.status, 'failed')
})

test('validateFetchBinding: propagates failed fetch when operationId matches', () => {
  const bound = validateFetchBinding(
    'read-op',
    sampleSource(),
    {
      operationId: 'read-op',
      status: 'failed',
      failureCategory: 'not_found',
      message: 'missing',
    },
    AbortSignal.timeout(100),
  )
  assert.ok(bound)
  assert.equal(bound?.status, 'failed')
  if (bound?.status === 'failed') assert.equal(bound.failureCategory, 'not_found')
})

test('validateFetchBinding: rejects ok admission when requested_url is not on source', () => {
  const bytes = Buffer.from('x\n', 'utf8')
  const admitted = buildAdmittedContent('read-op', 'src-1', 'rev-1', bytes, 'text/plain', {
    requestedUrl: 'https://evil.invalid/unrelated',
    finalUrl: 'https://evil.invalid/unrelated',
    redirectChain: ['https://evil.invalid/unrelated'],
  })
  const bound = validateFetchBinding(
    'read-op',
    sampleSource('src-1'),
    { operationId: 'read-op', status: 'ok', admitted },
    AbortSignal.timeout(100),
  )
  assert.ok(bound)
  assert.equal(bound?.status, 'failed')
  if (bound?.status === 'failed') assert.match(bound.message, /observed_urls/)
})

test('validateFetchBinding: accepts legitimate redirect when chain ends at final_url', () => {
  const bytes = Buffer.from('line\n', 'utf8')
  const final = 'https://example.invalid/source/moved'
  const admitted = buildAdmittedContent('read-op', 'src-1', 'rev-1', bytes, 'text/plain', {
    requestedUrl: OBSERVED,
    finalUrl: final,
    redirectChain: [OBSERVED, final],
  })
  const bound = validateFetchBinding(
    'read-op',
    sampleSource('src-1'),
    { operationId: 'read-op', status: 'ok', admitted },
    AbortSignal.timeout(100),
  )
  assert.equal(bound, null)
})

test('validateAdmittedRedirectProvenance: rejects chain that does not end at final_url', () => {
  const err = validateAdmittedRedirectProvenance({
    requested_url: OBSERVED,
    final_url: 'https://example.invalid/final',
    redirect_chain: [OBSERVED, 'https://example.invalid/hop-only'],
  })
  assert.ok(err)
  assert.match(err, /final_url/)
})

test('admitsRequestedUrlForSource: uses observed_urls only', () => {
  const source = sampleSource()
  assert.equal(admitsRequestedUrlForSource(source, OBSERVED), true)
  assert.equal(admitsRequestedUrlForSource(source, source.canonical_key), false)
})

test('bindingFailed: uses contract_violation category', () => {
  const result = bindingFailed('op', 'test')
  assert.equal(result.failureCategory, 'contract_violation')
})

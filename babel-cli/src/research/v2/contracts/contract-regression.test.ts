/**
 * Regression tests from independent #405 contract review (consolidated repair).
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { SourceAdapter } from '../ports/sourceAdapter.js'
import {
  FakeResearchModelPort,
  FakeSourceAccessPort,
  InMemoryResearchStore,
  StoreContractError,
  extractPlainTextPassagesFromAdmitted,
} from '../fixtures/fakePorts.js'
import { SourceRecordSchema } from './sources.js'
import { AdmittedContentSchema } from './admittedContent.js'
import {
  exampleMissionWriteContext,
  examplePlanRevisionFixture,
  exampleTechnicalMissionFixture,
} from '../fixtures/exampleMission.js'
import { FindingRecordSchema } from './findings.js'

async function seedMissionWithPlan(store: InMemoryResearchStore): Promise<void> {
  await store.appendMission(exampleTechnicalMissionFixture)
  await store.appendPlanRevision(exampleMissionWriteContext, examplePlanRevisionFixture)
}

describe('research v2 contract regressions (#405 repair)', () => {
  it('ResearchStore exposes mission-scoped external operation intent/completion writes', () => {
    const store = new InMemoryResearchStore()
    assert.equal(typeof store.appendExternalOperationIntent, 'function')
    assert.equal(typeof store.appendExternalOperationCompleted, 'function')
  })

  it('listEvents(missionId) includes evidence writes for two isolated missions', async () => {
    const store = new InMemoryResearchStore()
    const missionA = { ...exampleTechnicalMissionFixture, mission_id: 'mission-a' }
    const missionB = { ...exampleTechnicalMissionFixture, mission_id: 'mission-b' }
    const handleA = await store.appendMission(missionA)
    const handleB = await store.appendMission(missionB)
    const ctxA = {
      mission_id: handleA.mission_id,
      plan_revision_id: 'plan-a',
      writer_generation: handleA.writer_generation,
    }
    const ctxB = {
      mission_id: handleB.mission_id,
      plan_revision_id: 'plan-b',
      writer_generation: handleB.writer_generation,
    }
    await store.appendPlanRevision(ctxA, {
      ...examplePlanRevisionFixture,
      mission_id: 'mission-a',
      plan_revision_id: 'plan-a',
    })
    await store.appendPlanRevision(ctxB, {
      ...examplePlanRevisionFixture,
      mission_id: 'mission-b',
      plan_revision_id: 'plan-b',
    })
    const sourceA = SourceRecordSchema.parse({
      source_id: 'src-a',
      kind: 'document',
      canonical_key: 'fixture:a',
      observed_urls: ['https://example.test/a'],
    })
    const sourceB = SourceRecordSchema.parse({
      source_id: 'src-b',
      kind: 'document',
      canonical_key: 'fixture:b',
      observed_urls: ['https://example.test/b'],
    })
    await store.appendSource(ctxA, sourceA)
    await store.appendSource(ctxB, sourceB)
    const eventsA = await store.listEvents('mission-a')
    const eventsB = await store.listEvents('mission-b')
    assert.deepEqual(eventsA.map((e) => e.kind), [
      'mission_created',
      'plan_revised',
      'source_recorded',
    ])
    assert.deepEqual(eventsB.map((e) => e.kind), [
      'mission_created',
      'plan_revised',
      'source_recorded',
    ])
  })

  it('SourceAccessPort.fetchContent yields admitted bytes without port-owned passages', async () => {
    const source = SourceRecordSchema.parse({
      source_id: 'src-html-1',
      kind: 'web',
      canonical_key: 'fixture:web:1',
      observed_urls: ['https://example.test/page'],
    })
    const access = new FakeSourceAccessPort([
      { source, body: '<html><body><p>fee</p></body></html>', mediaType: 'text/html' },
    ])
    const result = await access.fetchContent({
      operationId: 'op-raw-1',
      source,
      signal: new AbortController().signal,
    })
    assert.equal(result.status, 'ok')
    if (result.status !== 'ok') return
    assert.equal(result.admitted.payload.mode, 'inline_bytes')
    assert.ok(result.admitted.provenance.final_url)
  })

  it('SourceAdapter exposes read() in addition to discover()', () => {
    const required: Pick<SourceAdapter, 'adapterId' | 'supportedKinds' | 'discover' | 'read'> = {
      adapterId: 'web',
      supportedKinds: ['web'],
      discover: async () => ({ operationId: 'd', status: 'cancelled' }),
      read: async () => ({ operationId: 'r', status: 'cancelled' }),
    }
    assert.equal(typeof required.read, 'function')
  })

  it('store rejects duplicate completion and stale writer generation', async () => {
    const store = new InMemoryResearchStore()
    await seedMissionWithPlan(store)
    const ctx = { ...exampleMissionWriteContext }
    await store.appendExternalOperationIntent(ctx, {
      mission_id: ctx.mission_id,
      operation_id: 'op-1',
      attempt_id: 'att-1',
      operation_kind: 'source_fetch',
      dispatched_at: '2026-10-20T12:00:00.000Z',
      idempotency_key: 'k1',
    })
    await store.appendExternalOperationCompleted(ctx, {
      mission_id: ctx.mission_id,
      operation_id: 'op-1',
      attempt_id: 'att-1',
      completed_at: '2026-10-20T12:00:01.000Z',
      settlement: 'succeeded',
    })
    await assert.rejects(
      async () => {
        await store.appendExternalOperationCompleted(ctx, {
          mission_id: ctx.mission_id,
          operation_id: 'op-1',
          attempt_id: 'att-1',
          completed_at: '2026-10-20T12:00:02.000Z',
          settlement: 'failed',
        })
      },
      (err: unknown) => err instanceof StoreContractError,
    )
    store.bumpWriterGeneration(ctx.mission_id)
    const staleCtx = { ...ctx, writer_generation: ctx.writer_generation }
    await assert.rejects(
      async () => {
        await store.appendSource(staleCtx, SourceRecordSchema.parse({
          source_id: 'src-stale',
          kind: 'web',
          canonical_key: 'x',
          observed_urls: ['https://example.test/x'],
        }))
      },
      (err: unknown) => err instanceof StoreContractError,
    )
  })

  it('revision ids change when content bytes change', async () => {
    const source = SourceRecordSchema.parse({
      source_id: 'src-rev',
      kind: 'document',
      canonical_key: 'fixture:rev',
      observed_urls: ['https://example.test/doc'],
    })
    const corpus = [{ source, body: 'version-1', mediaType: 'text/plain' }]
    const access = new FakeSourceAccessPort(corpus)
    const first = await access.fetchContent({
      operationId: 'f1',
      source,
      signal: new AbortController().signal,
    })
    corpus[0]!.body = 'version-2'
    const second = await access.fetchContent({
      operationId: 'f2',
      source,
      signal: new AbortController().signal,
    })
    assert.equal(first.status, 'ok')
    assert.equal(second.status, 'ok')
    if (first.status !== 'ok' || second.status !== 'ok') return
    assert.notEqual(first.admitted.revision.revision_id, second.admitted.revision.revision_id)
  })

  it('model port returns cancelled settlement instead of throwing', async () => {
    const model = new FakeResearchModelPort()
    const controller = new AbortController()
    controller.abort()
    const result = await model.invokeStructured({
      operationId: 'm-cancel',
      attemptId: 'att-m-cancel',
      kind: 'plan_questions',
      input: {},
      signal: controller.signal,
    })
    assert.equal(result.status, 'cancelled')
    assert.equal(result.usageSettlement.cost.status, 'unknown')
  })

  it('adapter extraction uses real line ranges for multiline bodies', async () => {
    const source = SourceRecordSchema.parse({
      source_id: 'src-lines',
      kind: 'document',
      canonical_key: 'lines',
      observed_urls: ['https://example.test/lines'],
    })
    const access = new FakeSourceAccessPort([
      { source, body: 'line1\nline2\nline3', mediaType: 'text/plain' },
    ])
    const fetched = await access.fetchContent({
      operationId: 'op-lines',
      source,
      signal: new AbortController().signal,
    })
    assert.equal(fetched.status, 'ok')
    if (fetched.status !== 'ok') return
    assert.equal(fetched.admitted.payload.mode, 'inline_bytes')
    const text = Buffer.from(
      fetched.admitted.payload.mode === 'inline_bytes'
        ? fetched.admitted.payload.bytes_base64
        : '',
      'base64',
    ).toString('utf8')
    const passages = extractPlainTextPassagesFromAdmitted(fetched.admitted.revision, text)
    assert.equal(passages[0]?.locator.kind, 'line_range')
    if (passages[0]?.locator.kind === 'line_range') {
      assert.equal(passages[0].locator.end_line, 3)
    }
    const again = extractPlainTextPassagesFromAdmitted(fetched.admitted.revision, text)
    assert.equal(passages[0]?.passage_id, again[0]?.passage_id)
  })

  it('fetch rejects empty body without fabricated inline payload', async () => {
    const source = SourceRecordSchema.parse({
      source_id: 'src-empty',
      kind: 'document',
      canonical_key: 'empty',
      observed_urls: ['https://example.test/empty'],
    })
    const access = new FakeSourceAccessPort([{ source, body: '', mediaType: 'text/plain' }])
    const result = await access.fetchContent({
      operationId: 'op-empty',
      source,
      signal: new AbortController().signal,
    })
    assert.equal(result.status, 'failed')
    if (result.status === 'failed') assert.equal(result.failureCategory, 'empty_body')
  })

  it('propagates truncated admitted bytes with schema-valid envelope', async () => {
    const source = SourceRecordSchema.parse({
      source_id: 'src-trunc',
      kind: 'document',
      canonical_key: 'trunc',
      observed_urls: ['https://example.test/trunc'],
    })
    const body = 'x'.repeat(200)
    const access = new FakeSourceAccessPort(
      [{ source, body, mediaType: 'text/plain' }],
      undefined,
      64,
    )
    const result = await access.fetchContent({
      operationId: 'op-trunc',
      source,
      signal: new AbortController().signal,
    })
    assert.equal(result.status, 'ok')
    if (result.status !== 'ok') return
    AdmittedContentSchema.parse(result.admitted)
    assert.equal(result.admitted.revision.completeness, 'truncated')
    assert.ok(result.admitted.truncation)
  })

  it('long multiline excerpt uses locator within bounded text', () => {
    const revision = {
      revision_id: 'rev-long',
      source_id: 'src-long',
      content_hash: 'a'.repeat(64),
      retrieved_at: '2026-10-20T12:00:00.000Z',
      extraction_version: 't',
      media_type: 'text/plain',
      completeness: 'complete' as const,
    }
    const lines = Array.from({ length: 500 }, (_, i) => `line-${i}`)
    const text = lines.join('\n')
    const passages = extractPlainTextPassagesFromAdmitted(revision, text)
    assert.equal(passages[0]?.locator.kind, 'byte_offset')
    assert.equal(passages[0]!.text_ref.mode, 'inline')
    if (passages[0]!.text_ref.mode === 'inline') {
      assert.ok(passages[0]!.text_ref.text.length <= 4000)
    }
  })
})

describe('finding integrity vs semantic support', () => {
  it('keeps integrity state separate from semantic judgment', () => {
    const finding = FindingRecordSchema.parse({
      finding_id: 'f1',
      question_id: 'q1',
      assertion_text: 'Observed export omits bytes when incomplete.',
      assertion_kind: 'source_observation',
      passage_ids: ['p1'],
      source_integrity: 'not_checked',
      semantic_support: {
        status: 'insufficient',
        reviewer: 'fixture',
        reviewer_version: '0',
        rationale: 'not reviewed live',
        reviewed_at: '2026-10-20T12:00:00.000Z',
      },
      created_at: '2026-10-20T12:00:00.000Z',
    })
    assert.equal(finding.source_integrity, 'not_checked')
    assert.equal(finding.semantic_support?.status, 'insufficient')
  })
})

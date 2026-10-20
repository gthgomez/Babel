import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, it } from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const defaultARoot = resolve(here, '../../../..')
const aRoot = process.env.RESEARCH_V2_A_ROOT?.trim() || defaultARoot

function aPath(...segments: string[]): string {
  return join(aRoot, ...segments)
}

function assertARoot(): void {
  assert.equal(
    existsSync(aPath('contracts', 'version.ts')),
    true,
    `RESEARCH_V2_A_ROOT must point at Agent A v2 tree (missing ${aPath('contracts/version.ts')})`,
  )
}

async function importA<T>(relative: string): Promise<T> {
  assertARoot()
  const url = pathToFileURL(aPath(relative)).href
  return (await import(url)) as T
}

describe('A checkpoint 59cd561b — contract regression (expect FIX)', () => {
  it('1: store listEvents scopes all writes to mission_id', async () => {
    const { InMemoryResearchStore } = await importA<typeof import('../../../../fixtures/fakePorts.js')>(
      'fixtures/fakePorts.ts',
    )
    const { exampleTechnicalMissionFixture } = await importA<
      typeof import('../../../../fixtures/exampleMission.js')
    >('fixtures/exampleMission.ts')
    const { SourceRecordSchema } = await importA<typeof import('../../../../contracts/sources.js')>(
      'contracts/sources.ts',
    )

    const store = new InMemoryResearchStore()
    const missionA = {
      ...exampleTechnicalMissionFixture,
      mission_id: 'mission-regression-a',
    }
    const missionB = {
      ...exampleTechnicalMissionFixture,
      mission_id: 'mission-regression-b',
    }
    await store.appendMission(missionA)
    await store.appendMission(missionB)

    const source = SourceRecordSchema.parse({
      source_id: 'src-regression-1',
      kind: 'document',
      canonical_key: 'fixture:doc:1',
      observed_urls: ['https://example.invalid/doc'],
    })
    await store.appendSource(source)

    const eventsA = await store.listEvents(missionA.mission_id)
    assert.ok(
      eventsA.some((e) => e.kind === 'source_recorded'),
      'FIX: source_recorded must be listed under mission_id, not source_id',
    )
  })

  it('2: ResearchStore exposes typed external operation append APIs', async () => {
    assertARoot()
    const source = readFileSync(aPath('ports', 'researchStore.ts'), 'utf8')
    assert.match(
      source,
      /appendExternalOperation/,
      'FIX: add typed external operation intent/completion append methods',
    )
  })

  it('3: SourceAdapter defines read/extract; SourceAccessPort admits bounded acquisition', async () => {
    assertARoot()
    const adapterSrc = readFileSync(aPath('ports', 'sourceAdapter.ts'), 'utf8')
    const accessSrc = readFileSync(aPath('ports', 'sourceAccessPort.ts'), 'utf8')
    assert.match(
      adapterSrc,
      /read\s*\([^)]*SourceRead|extract\s*\(/,
      'FIX: SourceAdapter read/extract operation (not discover substring)',
    )
    assert.match(
      accessSrc,
      /Admitted|Raw|byte|truncat/i,
      'FIX: admitted bounded raw-byte/stream/reference acquisition on SourceAccessPort',
    )
    assert.match(
      accessSrc,
      /failure|cancel|zero/i,
      'FIX: search discriminates failure/cancel vs zero hits',
    )
  })

  it('4: Passage text_ref and locators reject invalid discriminated shapes', async () => {
    const { PassageRecordSchema } = await importA<typeof import('../../../../contracts/passages.js')>(
      'contracts/passages.ts',
    )
    const hash = 'a'.repeat(64)
    assert.throws(
      () =>
        PassageRecordSchema.parse({
          passage_id: 'p-bad-inline',
          source_revision_id: 'r1',
          locator: { kind: 'page', start: 1 },
          text_ref: { mode: 'inline', text_hash: hash },
        }),
      /FIX: inline mode requires text/,
    )
    assert.throws(
      () =>
        PassageRecordSchema.parse({
          passage_id: 'p-bad-page-zero',
          source_revision_id: 'r1',
          locator: { kind: 'page', start: 0 },
          text_ref: { mode: 'inline', text: 'x', text_hash: hash },
        }),
      /FIX: page locators must be positive/,
    )
  })

  it('5: ResearchModelPort rejects malformed structured output', async () => {
    const { FakeResearchModelPort } = await importA<typeof import('../../../../fixtures/fakePorts.js')>(
      'fixtures/fakePorts.ts',
    )
    const model = new FakeResearchModelPort()
    model.scriptOutput('op-malformed', { not_a_valid_plan: true })
    await assert.rejects(
      async () => {
        await model.invokeStructured({
          operationId: 'op-malformed',
          kind: 'plan_questions',
          input: {},
          signal: new AbortController().signal,
        })
      },
      /FIX: validated model output/,
    )
  })

  it('6: fake read issues new revision_id when body bytes change', async () => {
    const { FakeSourceAccessPort } = await importA<typeof import('../../../../fixtures/fakePorts.js')>(
      'fixtures/fakePorts.ts',
    )
    const { SourceRecordSchema } = await importA<typeof import('../../../../contracts/sources.js')>(
      'contracts/sources.ts',
    )
    const source = SourceRecordSchema.parse({
      source_id: 'src-rev-test',
      kind: 'document',
      canonical_key: 'fixture:rev',
      observed_urls: ['https://example.invalid/r'],
    })
    const access = new FakeSourceAccessPort([
      { source, body: 'line one\nline two', mediaType: 'text/plain' },
    ])
    const signal = new AbortController().signal
    const first = await access.read({ operationId: 'r1', source, signal })
    const access2 = new FakeSourceAccessPort([
      { source, body: 'line one\nline two changed', mediaType: 'text/plain' },
    ])
    const second = await access2.read({ operationId: 'r2', source, signal })
    assert.equal(first.status, 'ok')
    assert.equal(second.status, 'ok')
    if (first.status === 'ok' && second.status === 'ok') {
      assert.notEqual(
        first.revision.revision_id,
        second.revision.revision_id,
        'FIX: revision_id must change when content_hash changes',
      )
      const locator = first.passages[0]?.locator
      assert.ok(
        locator?.kind === 'line_range' && locator.end !== undefined && locator.end > locator.start,
        'FIX: multiline bodies need non-degenerate line_range locators',
      )
    }
  })

  it('7: usage cost_status unknown cannot carry total_cost_usd', async () => {
    const { ModelRouteReceiptSchema } = await importA<typeof import('../../../../contracts/common.js')>(
      'contracts/common.ts',
    )
    assert.throws(
      () =>
        ModelRouteReceiptSchema.parse({
          operation_id: 'op-cost',
          backend_key: 'fake',
          provider: 'fake',
          provider_model_id: 'fake/m',
          resolved_at: '2026-10-20T12:00:00.000Z',
          usage: { cost_status: 'unknown', total_cost_usd: 0 },
        }),
      /FIX: unknown cost must not include amount/,
    )
  })

  it('8: source integrity uses citation integrity enum, not semantic support', async () => {
    const findingsSrc = readFileSync(aPath('contracts', 'findings.ts'), 'utf8')
    assert.match(
      findingsSrc,
      /valid.*invalid.*not_checked|CitationIntegrity/i,
      'FIX: separate citation integrity (valid/invalid/not_checked) from semantic support',
    )
    assert.doesNotMatch(
      findingsSrc,
      /source_integrity: SourceIntegrityResultSchema/,
      'FIX: rename/replace conflated source_integrity field',
    )
  })

  it('9: G-DEV brief fixtures are not valid ResearchMissionV2 without normalization', async () => {
    const { ResearchMissionV2Schema } = await importA<
      typeof import('../../../../contracts/mission.js')
    >('contracts/mission.ts')
    const briefPath = resolve(here, '../fixtures/dev-corpus/G-DEV-01/mission.json')
    const brief = JSON.parse(readFileSync(briefPath, 'utf8')) as Record<string, unknown>
    assert.throws(() => ResearchMissionV2Schema.parse(brief))
  })
})

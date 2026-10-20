/**
 * PRE-FIX CHARACTERIZATION ONLY — not acceptance, not a B-owned schema.
 * Skipped unless RESEARCH_V2_CHARACTERIZE_PRE_FIX=1 and RESEARCH_V2_A_ROOT set.
 * Requires tsx to import A modules. Evidence: CHARACTERIZATION_EVIDENCE_59cd561b.md
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, it } from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const aRoot = process.env.RESEARCH_V2_A_ROOT?.trim() ?? ''

function aPath(...segments: string[]): string {
  return join(aRoot, ...segments)
}

function assertARoot(): void {
  assert.ok(aRoot, 'RESEARCH_V2_A_ROOT required for characterization')
  assert.equal(existsSync(aPath('contracts', 'version.ts')), true)
}

async function importAModule(relative: string): Promise<Record<string, unknown>> {
  assertARoot()
  return (await import(pathToFileURL(aPath(relative)).href)) as Record<string, unknown>
}

function readContractVersion(): string {
  const src = readFileSync(aPath('contracts', 'version.ts'), 'utf8')
  const match = src.match(/RESEARCH_V2_CONTRACT_VERSION\s*=\s*'([^']+)'/)
  assert.ok(match, 'RESEARCH_V2_CONTRACT_VERSION assignment not found in A version.ts')
  const captured = match[1]
  assert.ok(
    typeof captured === 'string' && captured.length > 0,
    'RESEARCH_V2_CONTRACT_VERSION capture group missing under noUncheckedIndexedAccess',
  )
  return captured
}

const characterize = process.env.RESEARCH_V2_CHARACTERIZE_PRE_FIX === '1' && Boolean(aRoot)
const suite = characterize ? describe : describe.skip

suite('PRE-FIX characterization: A checkpoint.1 (59cd561b) — not acceptance', () => {
  it('guards contract version is checkpoint.1 before characterization', () => {
    assertARoot()
    assert.equal(readContractVersion(), '2026.10.20-checkpoint.1')
  })

  it('1: store listEvents scopes all writes to mission_id', async () => {
    const { InMemoryResearchStore } = await importAModule('fixtures/fakePorts.ts')
    const { exampleTechnicalMissionFixture } = await importAModule('fixtures/exampleMission.ts')
    const { SourceRecordSchema } = await importAModule('contracts/sources.ts')
    const Store = InMemoryResearchStore as new () => {
      appendMission: (m: unknown) => Promise<unknown>
      appendSource: (s: unknown) => Promise<unknown>
      listEvents: (id: string) => Promise<Array<{ kind: string }>>
    }
    const parse = SourceRecordSchema as { parse: (v: unknown) => unknown }
    const mission = exampleTechnicalMissionFixture as { mission_id: string }
    const missionA = { ...mission, mission_id: 'mission-char-a' }
    const s = new Store()
    await s.appendMission(missionA)
    await s.appendSource(
      parse.parse({
        source_id: 'src-char-1',
        kind: 'document',
        canonical_key: 'fixture:doc:1',
        observed_urls: ['https://example.invalid/doc'],
      }),
    )
    const eventsA = await s.listEvents(missionA.mission_id)
    assert.ok(eventsA.some((e) => e.kind === 'source_recorded'))
  })

  it('2: ResearchStore exposes typed external operation append APIs', () => {
    assertARoot()
    assert.match(readFileSync(aPath('ports', 'researchStore.ts'), 'utf8'), /appendExternalOperation/)
  })

  it('3: SourceAdapter read/extract and SourceAccessPort admitted acquisition', () => {
    assertARoot()
    const adapterSrc = readFileSync(aPath('ports', 'sourceAdapter.ts'), 'utf8')
    const accessSrc = readFileSync(aPath('ports', 'sourceAccessPort.ts'), 'utf8')
    assert.match(adapterSrc, /read\s*\([^)]*SourceRead|extract\s*\(/)
    assert.match(accessSrc, /Admitted|Raw|byte|truncat/i)
    assert.match(accessSrc, /failure|cancel|zero/i)
  })

  it('4: Passage text_ref and locators reject invalid discriminated shapes', async () => {
    const { PassageRecordSchema } = await importAModule('contracts/passages.ts')
    const parse = PassageRecordSchema as { parse: (v: unknown) => unknown }
    const hash = 'a'.repeat(64)
    assert.throws(() =>
      parse.parse({
        passage_id: 'p-bad-inline',
        source_revision_id: 'r1',
        locator: { kind: 'page', start: 1 },
        text_ref: { mode: 'inline', text_hash: hash },
      }),
    )
  })

  it('5: ResearchModelPort rejects malformed structured output', async () => {
    const { FakeResearchModelPort } = await importAModule('fixtures/fakePorts.ts')
    const Model = FakeResearchModelPort as new () => {
      scriptOutput: (id: string, o: Record<string, unknown>) => void
      invokeStructured: (r: unknown) => Promise<unknown>
    }
    const model = new Model()
    model.scriptOutput('op-malformed', { not_a_valid_plan: true })
    await assert.rejects(() =>
      model.invokeStructured({
        operationId: 'op-malformed',
        kind: 'plan_questions',
        input: {},
        signal: new AbortController().signal,
      }),
    )
  })

  it('6: fake read issues new revision_id when body bytes change', async () => {
    const { FakeSourceAccessPort } = await importAModule('fixtures/fakePorts.ts')
    const { SourceRecordSchema } = await importAModule('contracts/sources.ts')
    const parse = SourceRecordSchema as { parse: (v: unknown) => unknown }
    const Port = FakeSourceAccessPort as new (
      c: Array<{ source: unknown; body: string; mediaType: string }>,
    ) => {
      read: (r: unknown) => Promise<{
        status: string
        revision?: { revision_id: string }
        passages?: Array<{ locator: { kind: string; start: number; end?: number } }>
      }>
    }
    const source = parse.parse({
      source_id: 'src-rev-test',
      kind: 'document',
      canonical_key: 'fixture:rev',
      observed_urls: ['https://example.invalid/r'],
    })
    const signal = new AbortController().signal
    const first = await new Port([{ source, body: 'line one\nline two', mediaType: 'text/plain' }]).read({
      operationId: 'r1',
      source,
      signal,
    })
    const second = await new Port([
      { source, body: 'line one\nline two changed', mediaType: 'text/plain' },
    ]).read({ operationId: 'r2', source, signal })
    assert.equal(first.status, 'ok')
    assert.equal(second.status, 'ok')
    assert.notEqual(first.revision?.revision_id, second.revision?.revision_id)
    const locator = first.passages?.[0]?.locator
    assert.ok(locator?.kind === 'line_range' && (locator.end ?? 0) > locator.start)
  })

  it('7: usage cost_status unknown cannot carry total_cost_usd', async () => {
    const { ModelRouteReceiptSchema } = await importAModule('contracts/common.ts')
    const parse = ModelRouteReceiptSchema as { parse: (v: unknown) => unknown }
    assert.throws(() =>
      parse.parse({
        operation_id: 'op-cost',
        backend_key: 'fake',
        provider: 'fake',
        provider_model_id: 'fake/m',
        resolved_at: '2026-10-20T12:00:00.000Z',
        usage: { cost_status: 'unknown', total_cost_usd: 0 },
      }),
    )
  })

  it('8: citation integrity enum separate from semantic support', () => {
    const findingsSrc = readFileSync(aPath('contracts', 'findings.ts'), 'utf8')
    assert.match(findingsSrc, /valid.*invalid.*not_checked|CitationIntegrity/i)
    assert.doesNotMatch(findingsSrc, /source_integrity: SourceIntegrityResultSchema/)
  })

  it('9: G-DEV brief is not a ResearchMissionV2 without normalization', async () => {
    const { ResearchMissionV2Schema } = await importAModule('contracts/mission.ts')
    const parse = ResearchMissionV2Schema as { parse: (v: unknown) => unknown }
    const brief = JSON.parse(
      readFileSync(resolve(here, '../fixtures/dev-corpus/G-DEV-01/mission.json'), 'utf8'),
    ) as Record<string, unknown>
    assert.throws(() => parse.parse(brief))
  })
})

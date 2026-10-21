import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { GENERAL_DOCUMENT_ADAPTER_ID } from '../../adapters/documents/generalDocumentAdapter.js'
import { createMissionProductionSearchProvider } from '../../access/createMissionProductionSearchProvider.js'
import { ResearchMissionV2Schema } from '../../contracts/mission.js'
import { TECHNICAL_REPOSITORY_FILE_ADAPTER_ID } from '../../profiles/technical/repositoryFileAdapter.js'
import { createCombinedResearchRegistries } from '../../registry/reviewedBAdapterIntegration.js'
import {
  resolveDiscoveryAdapterForMission,
  resolveReadAdapterForSource,
} from '../../registry/missionAdapterResolution.js'
import { planTechnicalRetrievalSlots } from '../../engine/technicalRetrievalComposition.js'
import pins from './T-L1-T-L2-PINNED-VERSIONS.json' with { type: 'json' }
import { DEFAULT_MAX_ADMITTED_BYTES } from '../../access/fetchSourceAccessPort.js'
import {
  intersectDocumentFetchByteBudgets,
  resolveMissionDocumentPolicyForFetchUrl,
} from '../../access/missionDocumentAcquisitionPolicy.js'

const campaignDir = dirname(fileURLToPath(import.meta.url))

function loadMission(name: string) {
  const path = join(campaignDir, name)
  return ResearchMissionV2Schema.parse(JSON.parse(readFileSync(path, 'utf8')))
}

describe('technical campaign production wiring (injected transport, no live model)', () => {
  it('T-L1 plans two repository pins (Babel + LangGraph)', () => {
    const mission = loadMission('T-L1-mission.json')
    const slots = planTechnicalRetrievalSlots(mission, 'persistence')
    assert.equal(slots.filter((s) => s.kind === 'repository_pin').length, 2)
  })

  it('T-L1 resolves repository-file discovery and read adapters', async () => {
    const mission = loadMission('T-L1-mission.json')
    const registries = await createCombinedResearchRegistries()
    const discovery = resolveDiscoveryAdapterForMission(mission, registries)
    assert.ok(discovery)
    assert.equal(discovery.adapterId, TECHNICAL_REPOSITORY_FILE_ADAPTER_ID)

    const search = createMissionProductionSearchProvider({
      mission,
      fetchRepositoryTree: async () => ({
        ok: true,
        status: 200,
        entries: [
          { path: 'babel-cli/src/research/v2/persistence/README.md', type: 'blob' },
          { path: 'babel-cli/src/executor/kernel.ts', type: 'blob' },
        ],
      }),
    })
    const result = await search.search(
      {
        operationId: 't-l1-search',
        query: 'research persistence README',
        sourceClasses: ['repository_file'],
        signal: new AbortController().signal,
      },
      mission,
    )
    assert.equal(result.status, 'ok')
    assert.ok((result.hits?.length ?? 0) >= 1)
    const source = result.hits![0]!.source
    assert.equal(source.kind, 'repository_file')
    const read = resolveReadAdapterForSource(source, registries)
    assert.equal(read?.adapterId, TECHNICAL_REPOSITORY_FILE_ADAPTER_ID)
  })

  it('T-L2 document search uses selected_document_refs (not fixture index)', async () => {
    const mission = loadMission('T-L2-mission.json')
    const registries = await createCombinedResearchRegistries()
    const discovery = resolveDiscoveryAdapterForMission(mission, registries)
    assert.ok(discovery)
    assert.equal(discovery.adapterId, TECHNICAL_REPOSITORY_FILE_ADAPTER_ID)

    const search = createMissionProductionSearchProvider({ mission })
    const docResult = await search.search(
      {
        operationId: 't-l2-doc-search',
        query: pins.t_l2_paper.arxiv_id,
        sourceClasses: ['document'],
        signal: new AbortController().signal,
      },
      mission,
    )
    assert.equal(docResult.status, 'ok')
    assert.equal(docResult.hits?.length, 1)
    const docSource = docResult.hits![0]!.source
    assert.equal(docSource.kind, 'document')
    assert.equal(docSource.canonical_key, pins.t_l2_paper.canonical_url)
    const docRead = resolveReadAdapterForSource(docSource, registries, {
      mediaType: 'application/pdf',
    })
    assert.equal(docRead?.adapterId, GENERAL_DOCUMENT_ADAPTER_ID)

    const paperRead = resolveReadAdapterForSource(
      { ...docSource, kind: 'paper' },
      registries,
      { mediaType: 'application/pdf' },
    )
    assert.equal(paperRead?.adapterId, GENERAL_DOCUMENT_ADAPTER_ID)

    const policy = resolveMissionDocumentPolicyForFetchUrl(
      docSource,
      mission,
      pins.t_l2_paper.canonical_url,
    )
    assert.ok(policy)
    assert.equal(policy.content_pin_kind, 'mutable_locator_content_digest')
    const budgets = intersectDocumentFetchByteBudgets(policy, DEFAULT_MAX_ADMITTED_BYTES, DEFAULT_MAX_ADMITTED_BYTES)
    assert.equal(budgets.maxWireBytes, DEFAULT_MAX_ADMITTED_BYTES)
    assert.equal(budgets.maxDecodedBytes, DEFAULT_MAX_ADMITTED_BYTES)
    const raisedHost = intersectDocumentFetchByteBudgets(policy, 10_000_000, 10_000_000)
    assert.ok(raisedHost.maxWireBytes >= pins.t_l2_paper.observed_content_length_bytes)
  })
})

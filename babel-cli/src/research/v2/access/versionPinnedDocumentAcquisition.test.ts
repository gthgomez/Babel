import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { GeneralDocumentAdapter } from '../adapters/documents/generalDocumentAdapter.js'
import { ResearchMissionV2Schema } from '../contracts/mission.js'
import { createMissionSelectedDocumentSearchProvider } from './missionSelectedDocumentSearchProvider.js'
import { createGovernedSourceAccessPort } from './governedSourceAccessPort.js'
import { DEFAULT_MAX_ADMITTED_BYTES } from './fetchSourceAccessPort.js'
import {
  findVersionPinnedDocumentPolicy,
  resolveFetchAdmittedByteLimitForSource,
  T_L2_VERSION_PINNED_PAPER_POLICY,
  verifyVersionPinnedDocumentAdmission,
} from './versionPinnedDocumentAcquisition.js'
import pins from '../fixtures/campaign/T-L1-T-L2-PINNED-VERSIONS.json' with { type: 'json' }
import paperManifest from '../fixtures/campaign/papers/1706.03762.manifest.json' with { type: 'json' }

const campaignDir = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/campaign')
const paperBytes = readFileSync(join(campaignDir, 'papers/1706.03762.pdf'))

function loadT2Mission() {
  return ResearchMissionV2Schema.parse(
    JSON.parse(readFileSync(join(campaignDir, 'T-L2-mission.json'), 'utf8')),
  )
}

async function paperSourceFromSearch(mission: ReturnType<typeof loadT2Mission>) {
  const search = createMissionSelectedDocumentSearchProvider()
  const result = await search.search(
    {
      operationId: 'paper-search',
      query: pins.t_l2_paper.arxiv_id,
      sourceClasses: ['document'],
      signal: new AbortController().signal,
    },
    mission,
  )
  assert.equal(result.status, 'ok')
  if (result.status !== 'ok') {
    throw new Error('expected document search ok')
  }
  return result.hits[0]!.source
}

describe('version-pinned document acquisition policy', () => {
  it('selects raised per-document byte limit without changing DEFAULT_MAX_ADMITTED_BYTES', async () => {
    const mission = loadT2Mission()
    const source = await paperSourceFromSearch(mission)
    const policy = findVersionPinnedDocumentPolicy(source)
    assert.equal(policy?.policy_id, T_L2_VERSION_PINNED_PAPER_POLICY.policy_id)
    const limit = resolveFetchAdmittedByteLimitForSource(source, mission)
    assert.ok(limit! > DEFAULT_MAX_ADMITTED_BYTES)
    assert.equal(limit, Math.max(policy!.wire_byte_limit, policy!.decompressed_byte_limit))
  })

  it('complete injected transport admits real paper bytes and extracts passages', async () => {
    const mission = loadT2Mission()
    const source = await paperSourceFromSearch(mission)
    const access = createGovernedSourceAccessPort({
      mission,
      searchProvider: createMissionSelectedDocumentSearchProvider(),
      admittedGet: async ({ url, maxBytes, signal }) => {
        assert.ok(maxBytes >= paperBytes.length)
        if (signal.aborted) {
          return {
            ok: false,
            status: 499,
            contentType: 'application/pdf',
            buffer: Buffer.alloc(0),
            bytesReceived: 0,
            truncated: false,
            requestedUrl: url,
            finalUrl: url,
            redirectChain: [url],
            transportCoding: null,
          }
        }
        return {
          ok: true,
          status: 200,
          contentType: 'application/pdf',
          buffer: paperBytes,
          bytesReceived: paperBytes.length,
          truncated: false,
          requestedUrl: url,
          finalUrl: url,
          redirectChain: [url],
          transportCoding: null,
        }
      },
    })
    const read = await new GeneralDocumentAdapter().read(
      { operationId: 'paper-read-complete', source, signal: new AbortController().signal },
      access,
    )
    assert.equal(read.status, 'ok')
    if (read.status !== 'ok') return
    assert.equal(read.revision.completeness, 'complete')
    assert.equal(read.revision.content_hash, paperManifest.content_sha256)
    assert.ok(read.passages.length >= 1)
  })

  it('truncated wire body fails before PDF success (not complete admission)', async () => {
    const mission = loadT2Mission()
    const source = await paperSourceFromSearch(mission)
    const access = createGovernedSourceAccessPort({
      mission,
      searchProvider: createMissionSelectedDocumentSearchProvider(),
      admittedGet: async ({ url }) => ({
        ok: true,
        status: 200,
        contentType: 'application/pdf',
        buffer: paperBytes.subarray(0, DEFAULT_MAX_ADMITTED_BYTES),
        bytesReceived: DEFAULT_MAX_ADMITTED_BYTES,
        truncated: true,
        requestedUrl: url,
        finalUrl: url,
        redirectChain: [url],
        transportCoding: null,
      }),
    })
    const read = await new GeneralDocumentAdapter().read(
      { operationId: 'paper-read-truncated', source, signal: new AbortController().signal },
      access,
    )
    assert.equal(read.status, 'failed')
    if (read.status !== 'failed') return
    assert.equal(read.failureCategory, 'truncated')
  })

  it('verifyVersionPinnedDocumentAdmission rejects digest mismatch on complete buffer', async () => {
    const mission = loadT2Mission()
    const source = await paperSourceFromSearch(mission)
    const verdict = verifyVersionPinnedDocumentAdmission(source, Buffer.from('not-the-paper'), false)
    assert.equal(verdict.ok, false)
    if (verdict.ok) return
    assert.equal(verdict.failureCategory, 'policy_denied')
  })

  it('cancelled fetch does not settle read success', async () => {
    const mission = loadT2Mission()
    const source = await paperSourceFromSearch(mission)
    const ac = new AbortController()
    ac.abort()
    const access = createGovernedSourceAccessPort({
      mission,
      searchProvider: createMissionSelectedDocumentSearchProvider(),
      admittedGet: async () => {
        throw new Error('should not dispatch after abort')
      },
    })
    const read = await new GeneralDocumentAdapter().read(
      { operationId: 'paper-read-cancel', source, signal: ac.signal },
      access,
    )
    assert.equal(read.status, 'cancelled')
  })
})

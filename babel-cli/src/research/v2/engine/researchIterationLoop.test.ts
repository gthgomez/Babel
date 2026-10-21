import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { InMemoryResearchStore } from '../fixtures/fakePorts.js'
import { examplePlanRevisionFixture, exampleTechnicalMissionFixture } from '../fixtures/exampleMission.js'
import { technicalRepositoryCorpusSource } from '../fixtures/technicalRepositoryCorpus.js'
import { FixtureResearchModelBridge } from '../model/fixtureModelBridge.js'
import { FetchSourceAccessPort } from '../access/fetchSourceAccessPort.js'
import { runAdmittedPlanningIteration, readTechnicalRepositorySource } from './researchIterationLoop.js'

describe('research iteration loop (admitted ports)', () => {
  it('runAdmittedPlanningIteration persists plan revision after model invoke', async () => {
    const store = new InMemoryResearchStore()
    const model = new FixtureResearchModelBridge()
    model.scriptOutput('plan-op-1', {
      kind: 'plan_questions',
      questions: [{ text: 'What is the API surface?', importance: 'high' }],
    })
    const access = new FetchSourceAccessPort({
      fetch: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => 'text/plain' },
        arrayBuffer: async () => Uint8Array.from(Buffer.from('x', 'utf8')).buffer,
      }),
    })
    const result = await runAdmittedPlanningIteration({
      mission: exampleTechnicalMissionFixture,
      store,
      model,
      access,
      planRevision: examplePlanRevisionFixture,
      modelOperationId: 'plan-op-1',
      modelAttemptId: 'plan-att-1',
      signal: new AbortController().signal,
    })
    assert.equal(result.plannedQuestionCount, 1)
    const events = await store.listEvents(exampleTechnicalMissionFixture.mission_id)
    assert.ok(events.some((e) => e.kind === 'plan_revised'))
    assert.ok(events.some((e) => e.kind === 'external_operation_intent'))
  })

  it('readTechnicalRepositorySource uses fetch access port', async () => {
    const body = 'export const RESEARCH_CONTRACT = 1\n'
    const access = new FetchSourceAccessPort({
      fetch: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => 'text/plain' },
        arrayBuffer: async () => Uint8Array.from(Buffer.from(body, 'utf8')).buffer,
      }),
    })
    const result = await readTechnicalRepositorySource(access, {
      operationId: 'read-loop-1',
      source: technicalRepositoryCorpusSource,
      signal: new AbortController().signal,
    })
    assert.equal(result.status, 'ok')
  })
})

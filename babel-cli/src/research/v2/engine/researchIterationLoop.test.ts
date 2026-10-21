import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { InMemoryResearchStore } from '../fixtures/fakePorts.js'
import { examplePlanRevisionFixture, exampleTechnicalMissionFixture } from '../fixtures/exampleMission.js'
import { technicalRepositoryCorpusSource } from '../fixtures/technicalRepositoryCorpus.js'
import type { LlmRunner } from '../../../runners/base.js'
import { FixtureResearchModelBridge } from '../model/fixtureModelBridge.js'
import { ProviderResearchModelBridge } from '../model/providerResearchModelBridge.js'
import { FetchSourceAccessPort } from '../access/fetchSourceAccessPort.js'
import { runAdmittedPlanningIteration, readTechnicalRepositorySource } from './researchIterationLoop.js'

const FIXED_NOW = '2026-10-20T12:05:00.000Z'

function completionSettlement(event: { payload: Record<string, unknown> } | undefined): string | undefined {
  const completion = event?.payload.completion as { settlement?: string } | undefined
  return completion?.settlement
}

async function openAdmittedSession(store: InMemoryResearchStore) {
  const handle = await store.appendMission(exampleTechnicalMissionFixture)
  return { mission: exampleTechnicalMissionFixture, handle }
}

describe('research iteration loop (admitted ports)', () => {
  it('persists generated plan, receipt, and settled completion on success', async () => {
    const store = new InMemoryResearchStore()
    const session = await openAdmittedSession(store)
    const model = new FixtureResearchModelBridge()
    model.scriptOutput('plan-op-1', {
      kind: 'plan_questions',
      questions: [{ text: 'What is the API surface?', importance: 'high' }],
    })
    const result = await runAdmittedPlanningIteration({
      session,
      store,
      model,
      modelOperationId: 'plan-op-1',
      modelAttemptId: 'plan-att-1',
      planRevisionId: 'plan-generated-001',
      revisionReason: 'model_planning',
      dispatchedAt: '2026-10-20T12:04:00.000Z',
      signal: new AbortController().signal,
      now: () => FIXED_NOW,
    })
    assert.equal(result.plannedQuestionCount, 1)
    const events = await store.listEvents(exampleTechnicalMissionFixture.mission_id)
    assert.ok(events.some((e) => e.kind === 'plan_revised'))
    assert.ok(events.some((e) => e.kind === 'external_operation_intent'))
    assert.ok(events.some((e) => e.kind === 'model_invocation_completed'))
    assert.ok(events.some((e) => e.kind === 'external_operation_completed'))
    const planEvents = events.filter((e) => e.kind === 'plan_revised')
    assert.equal(planEvents.length, 2)
    const completed = events.find((e) => e.kind === 'external_operation_completed')
    assert.equal(completionSettlement(completed), 'succeeded')
  })

  it('reopens an existing admitted session without recreating the mission', async () => {
    const store = new InMemoryResearchStore()
    const session = await openAdmittedSession(store)
    const model = new FixtureResearchModelBridge()
    model.scriptOutput('plan-op-2a', {
      kind: 'plan_questions',
      questions: [{ text: 'Replay question', importance: 'medium' }],
    })
    const first = await runAdmittedPlanningIteration({
      session,
      store,
      model,
      modelOperationId: 'plan-op-2a',
      modelAttemptId: 'plan-att-2a',
      planRevisionId: 'plan-generated-002a',
      revisionReason: 'replay-a',
      dispatchedAt: '2026-10-20T12:04:30.000Z',
      signal: new AbortController().signal,
      now: () => FIXED_NOW,
    })
    model.scriptOutput('plan-op-2b', {
      kind: 'plan_questions',
      questions: [{ text: 'Replay question b', importance: 'medium' }],
    })
    await runAdmittedPlanningIteration({
      session: {
        mission: session.mission,
        handle: first.handle,
        activePlanRevisionId: first.planRevisionId,
      },
      store,
      model,
      modelOperationId: 'plan-op-2b',
      modelAttemptId: 'plan-att-2b',
      planRevisionId: 'plan-generated-002b',
      revisionReason: 'replay-b',
      dispatchedAt: '2026-10-20T12:04:45.000Z',
      signal: new AbortController().signal,
      now: () => FIXED_NOW,
    })
    const missionEvents = (await store.listEvents(session.mission.mission_id)).filter(
      (e) => e.kind === 'mission_created',
    )
    assert.equal(missionEvents.length, 1)
  })

  it('sends mission requirements to the model port', async () => {
    const store = new InMemoryResearchStore()
    const session = await openAdmittedSession(store)
    const model = new FixtureResearchModelBridge()
    model.scriptOutput('plan-op-req', {
      kind: 'plan_questions',
      questions: [{ text: 'Q', importance: 'low' }],
    })
    const seen: Record<string, unknown>[] = []
    const original = model.fixture.invokeStructured.bind(model.fixture)
    model.fixture.invokeStructured = async (request) => {
      seen.push(request.input)
      return original(request)
    }
    await runAdmittedPlanningIteration({
      session,
      store,
      model,
      modelOperationId: 'plan-op-req',
      modelAttemptId: 'plan-att-req',
      planRevisionId: 'plan-generated-req',
      revisionReason: 'requirements',
      dispatchedAt: '2026-10-20T12:04:00.000Z',
      signal: new AbortController().signal,
      now: () => FIXED_NOW,
    })
    assert.equal(seen.length, 1)
    assert.equal(seen[0]?.mission_id, exampleTechnicalMissionFixture.mission_id)
    assert.equal(seen[0]?.primary_question, exampleTechnicalMissionFixture.primary_question)
  })

  it('works with ProviderResearchModelBridge (injected runner)', async () => {
    const runner: Pick<LlmRunner, 'execute' | 'getLastInvocationMetadata'> = {
      async execute(_prompt, schema) {
        return schema.parse({
          kind: 'plan_questions',
          questions: [{ text: 'Provider-backed question', importance: 'medium' }],
        })
      },
      getLastInvocationMetadata: () => null,
    }
    const model = new ProviderResearchModelBridge({
      runner,
      backendKey: 'research-v2-test',
      provider: 'test',
      providerModelId: 'test/model',
    })
    const store = new InMemoryResearchStore()
    const session = await openAdmittedSession(store)
    const result = await runAdmittedPlanningIteration({
      session,
      store,
      model,
      modelOperationId: 'provider-plan-op',
      modelAttemptId: 'provider-plan-att',
      planRevisionId: 'plan-provider-001',
      revisionReason: 'provider_planning',
      dispatchedAt: '2026-10-20T12:04:00.000Z',
      signal: new AbortController().signal,
      now: () => FIXED_NOW,
    })
    assert.equal(result.plannedQuestionCount, 1)
  })

  it('records uncertain completion without generated plan evidence', async () => {
    const store = new InMemoryResearchStore()
    const session = await openAdmittedSession(store)
    const model = {
      invokeStructured: async () => ({
        status: 'uncertain' as const,
        operationId: 'plan-op-uncertain',
        message: 'provider settlement unknown',
        usageSettlement: { attempt_id: 'plan-att-uncertain', cost: { status: 'unknown' as const } },
      }),
    }
    await assert.rejects(() =>
      runAdmittedPlanningIteration({
        session,
        store,
        model,
        modelOperationId: 'plan-op-uncertain',
        modelAttemptId: 'plan-att-uncertain',
        planRevisionId: 'plan-uncertain-001',
        revisionReason: 'uncertain',
        dispatchedAt: '2026-10-20T12:04:00.000Z',
        signal: new AbortController().signal,
        now: () => FIXED_NOW,
      }),
    )
    const events = await store.listEvents(session.mission.mission_id)
    assert.equal(events.filter((e) => e.kind === 'plan_revised').length, 1)
    const completed = events.find((e) => e.kind === 'external_operation_completed')
    assert.equal(completionSettlement(completed), 'uncertain')
  })

  it('records failed completion without plan evidence when model fails', async () => {
    const store = new InMemoryResearchStore()
    const session = await openAdmittedSession(store)
    const model = new FixtureResearchModelBridge()
    model.scriptOutput('plan-op-fail', {
      kind: 'plan_questions',
      questions: [{ text: '', importance: 'low' }],
    })
    await assert.rejects(() =>
      runAdmittedPlanningIteration({
        session,
        store,
        model,
        modelOperationId: 'plan-op-fail',
        modelAttemptId: 'plan-att-fail',
        planRevisionId: 'plan-fail-001',
        revisionReason: 'fail',
        dispatchedAt: '2026-10-20T12:04:00.000Z',
        signal: new AbortController().signal,
        now: () => FIXED_NOW,
      }),
    )
    const events = await store.listEvents(session.mission.mission_id)
    assert.equal(events.filter((e) => e.kind === 'plan_revised').length, 1)
    const completed = events.find((e) => e.kind === 'external_operation_completed')
    assert.equal(completionSettlement(completed), 'failed')
  })

  it('records uncertain completion when model invoke throws (no generated evidence)', async () => {
    const store = new InMemoryResearchStore()
    const session = await openAdmittedSession(store)
    const model = {
      invokeStructured: async () => {
        throw new Error('runner transport failure')
      },
    }
    await assert.rejects(
      () =>
        runAdmittedPlanningIteration({
          session,
          store,
          model,
          modelOperationId: 'plan-op-throw',
          modelAttemptId: 'plan-att-throw',
          planRevisionId: 'plan-throw-001',
          revisionReason: 'throw',
          dispatchedAt: '2026-10-20T12:04:00.000Z',
          signal: new AbortController().signal,
          now: () => FIXED_NOW,
        }),
      /runner transport failure/,
    )
    const events = await store.listEvents(session.mission.mission_id)
    assert.equal(events.filter((e) => e.kind === 'plan_revised').length, 1)
    assert.equal(events.filter((e) => e.kind === 'model_invocation_completed').length, 0)
    const completed = events.find((e) => e.kind === 'external_operation_completed')
    assert.equal(completionSettlement(completed), 'uncertain')
  })

  it('records uncertain completion when model throws during cancellation', async () => {
    const store = new InMemoryResearchStore()
    const session = await openAdmittedSession(store)
    const controller = new AbortController()
    const model = {
      invokeStructured: async () => {
        controller.abort()
        throw new Error('late reject')
      },
    }
    await assert.rejects(
      () =>
        runAdmittedPlanningIteration({
          session,
          store,
          model,
          modelOperationId: 'plan-op-throw-cancel',
          modelAttemptId: 'plan-att-throw-cancel',
          planRevisionId: 'plan-throw-cancel-001',
          revisionReason: 'throw-cancel',
          dispatchedAt: '2026-10-20T12:04:00.000Z',
          signal: controller.signal,
          now: () => FIXED_NOW,
        }),
      /model invoke rejected during cancellation/,
    )
    const events = await store.listEvents(session.mission.mission_id)
    assert.equal(events.filter((e) => e.kind === 'model_invocation_completed').length, 0)
    const completed = events.find((e) => e.kind === 'external_operation_completed')
    assert.equal(completionSettlement(completed), 'uncertain')
  })

  it('returns writeContext for the generated plan so a follow-up admitted write succeeds', async () => {
    const store = new InMemoryResearchStore()
    const session = await openAdmittedSession(store)
    const model = new FixtureResearchModelBridge()
    model.scriptOutput('plan-op-ctx', {
      kind: 'plan_questions',
      questions: [{ text: 'Context follow-up', importance: 'high' }],
    })
    const result = await runAdmittedPlanningIteration({
      session,
      store,
      model,
      modelOperationId: 'plan-op-ctx',
      modelAttemptId: 'plan-att-ctx',
      planRevisionId: 'plan-generated-ctx',
      revisionReason: 'ctx',
      dispatchedAt: '2026-10-20T12:04:00.000Z',
      signal: new AbortController().signal,
      now: () => FIXED_NOW,
    })
    assert.equal(result.writeContext.plan_revision_id, 'plan-generated-ctx')
    assert.notEqual(result.writeContext.plan_revision_id, 'plan-generated-ctx-bootstrap')
    await store.appendExternalOperationIntent(result.writeContext, {
      mission_id: result.writeContext.mission_id,
      operation_id: 'follow-up-op',
      attempt_id: 'follow-up-att',
      operation_kind: 'model_invoke',
      dispatched_at: FIXED_NOW,
      idempotency_key: 'follow-up-op',
    })
    const events = await store.listEvents(session.mission.mission_id)
    const followUp = events.find(
      (e) =>
        e.kind === 'external_operation_intent' &&
        (e.payload.intent as { operation_id?: string } | undefined)?.operation_id === 'follow-up-op',
    )
    assert.ok(followUp)
  })

  it('does not append plan or model receipt when cancelled after inference', async () => {
    const store = new InMemoryResearchStore()
    const session = await openAdmittedSession(store)
    const controller = new AbortController()
    const model = new FixtureResearchModelBridge()
    model.scriptOutput('plan-op-cancel', {
      kind: 'plan_questions',
      questions: [{ text: 'Should not persist', importance: 'low' }],
    })
    const original = model.fixture.invokeStructured.bind(model.fixture)
    model.fixture.invokeStructured = async (request) => {
      const result = await original(request)
      controller.abort()
      return result
    }
    await assert.rejects(() =>
      runAdmittedPlanningIteration({
        session,
        store,
        model,
        modelOperationId: 'plan-op-cancel',
        modelAttemptId: 'plan-att-cancel',
        planRevisionId: 'plan-cancel-001',
        revisionReason: 'cancel',
        dispatchedAt: '2026-10-20T12:04:00.000Z',
        signal: controller.signal,
        now: () => FIXED_NOW,
      }),
    )
    const events = await store.listEvents(session.mission.mission_id)
    assert.equal(events.filter((e) => e.kind === 'plan_revised').length, 1)
    assert.equal(events.filter((e) => e.kind === 'model_invocation_completed').length, 0)
    const completed = events.find((e) => e.kind === 'external_operation_completed')
    assert.equal(completionSettlement(completed), 'cancelled')
  })

  it('readTechnicalRepositorySource uses fetch access port', async () => {
    const body = 'export const RESEARCH_CONTRACT = 1\n'
    const access = new FetchSourceAccessPort({
      admittedGet: async () => ({
        ok: true,
        status: 200,
        contentType: 'text/plain',
        buffer: Buffer.from(body, 'utf8'),
        bytesReceived: body.length,
        truncated: false,
        requestedUrl: technicalRepositoryCorpusSource.observed_urls[0]!,
        finalUrl: technicalRepositoryCorpusSource.observed_urls[0]!,
        redirectChain: [technicalRepositoryCorpusSource.observed_urls[0]!],
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

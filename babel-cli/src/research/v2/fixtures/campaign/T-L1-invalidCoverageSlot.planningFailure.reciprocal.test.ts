/**
 * T-L1 live diagnostic reciprocal (A8930-class): planning returns discover-primary on repository-only mission.
 * Synthetic model envelope only — NOT C #408 fe9bf5ef captured bytes.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import type { ZodType } from 'zod'
import type { LlmRunner, RunnerCallbacks, RunnerInvocationMetadata } from '../../../../runners/base.js'
import type { GitHubTreeEntry } from '../../access/pinnedRepositoryFileSearchProvider.js'
import { runResearchV2MissionWithOwnerSession } from '../../cli/researchV2MissionRun.js'
import { fixtureModelForOfflineRun } from '../../cli/researchV2FixtureRunModel.js'
import { terminalReportFromEvents } from '../../cli/researchV2CliOperations.js'
import { openAdmittedInspectStore } from '../../control/researchStoreAdmission.js'
import { ResearchMissionV2Schema } from '../../contracts/mission.js'
import { parseValidatedModelOutput } from '../../contracts/modelOutputs.js'
import { missionCoverageSourceSlots } from '../../engine/missionCoverageSourceSlots.js'
import { missionRequirementsPayload } from '../../engine/planFromModelOutput.js'
import { ProviderResearchModelBridge } from '../../model/providerResearchModelBridge.js'
import type {
  ResearchModelInvocationRequest,
  ResearchModelPort,
} from '../../ports/researchModelPort.js'
import { ResearchEngineSession } from '../../engine/researchEngineSession.js'

const campaignDir = dirname(fileURLToPath(import.meta.url))
const missionPath = join(campaignDir, 'T-L1-mission.json')
const syntheticInvalidFixturePath = join(
  campaignDir,
  'T-L1-synthetic-invalid-discover-primary-plan-questions.json',
)
const syntheticValidFixturePath = join(
  campaignDir,
  'T-L1-synthetic-valid-repository-pin-plan-questions.json',
)

function treeFromPaths(paths: string[]): GitHubTreeEntry[] {
  return paths.map((path) => ({ path, type: 'blob' }))
}

function tL1InjectedFetchRepositoryTree(mission: ReturnType<typeof ResearchMissionV2Schema.parse>) {
  const babelPath = 'babel-cli/src/research/v2/persistence/durableResearchStore.ts'
  const langPath = 'libs/langgraph/langgraph/pregel/_checkpoint.py'
  return async ({ apiUrl }: { apiUrl: string }) => {
    if (apiUrl.includes('gthgomez/Babel')) {
      return {
        ok: true,
        status: 200,
        entries: treeFromPaths([babelPath, 'babel-cli/src/executor/kernel.ts']),
      }
    }
    if (apiUrl.includes('langchain-ai/langgraph')) {
      return {
        ok: true,
        status: 200,
        entries: treeFromPaths([langPath, 'libs/checkpoint-conformance/Makefile']),
      }
    }
    return { ok: false, status: 404, entries: [], message: `unexpected tree ${apiUrl}` }
  }
}

/** Event kinds reported from C #408 fe9bf5ef live store subset (reference only; not vendored original JSON). */
const C_408_DIAGNOSTIC_EVENT_KINDS = [
  'mission_created',
  'plan_revised',
  'external_operation_intent',
  'terminal_receipt',
] as const

function loadSyntheticFixture(fixturePath: string = syntheticInvalidFixturePath) {
  const raw = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
    _provenance: string
    request_local_usage_metadata: RunnerInvocationMetadata
    raw_model_payload: Record<string, unknown>
  }
  return raw
}

function wrapModelWithPlanQuestionsInputCapture(
  inner: ResearchModelPort,
  onPlanQuestionsInput: (input: Record<string, unknown>) => void,
): ResearchModelPort {
  return {
    async invokeStructured(request: ResearchModelInvocationRequest) {
      if (request.kind === 'plan_questions') {
        onPlanQuestionsInput(request.input as Record<string, unknown>)
      }
      return inner.invokeStructured(request)
    },
  }
}

function assertReportedUsageSettlement(
  usageSettlement: {
    input_tokens?: number
    output_tokens?: number
    cost: { status: string; amount_usd?: number }
  },
  usageMeta: RunnerInvocationMetadata,
): void {
  assert.equal(usageSettlement.input_tokens, usageMeta.prompt_tokens)
  assert.equal(usageSettlement.output_tokens, usageMeta.completion_tokens)
  assert.equal(usageSettlement.cost.status, 'reported')
  assert.equal(usageSettlement.cost.amount_usd, usageMeta.estimated_cost_usd)
}

function tL1ProductionShapedModel(fixturePath: string = syntheticInvalidFixturePath): ProviderResearchModelBridge {
  const fixture = loadSyntheticFixture(fixturePath)
  const usageMeta = fixture.request_local_usage_metadata
  const payload = { ...fixture.raw_model_payload }
  const runner: Pick<LlmRunner, 'execute'> = {
    async execute<T>(
      _prompt: string,
      _schema: ZodType<T>,
      callbacks?: RunnerCallbacks,
    ): Promise<T> {
      callbacks?.onInvocationCompleted?.({
        inference_id: 't-l1-synthetic-invalid-slot-inf',
        provider: usageMeta.provider ?? 'openrouter',
        model: usageMeta.provider_model_id ?? 'deepseek/deepseek-v4-flash-0731',
        status: 'delivered',
        usage_metadata: usageMeta,
        observed_model_id: usageMeta.observed_model_id ?? null,
      })
      return payload as T
    },
  }
  return new ProviderResearchModelBridge({
    runner,
    backendKey: 'research-v2-cli',
    provider: 'openrouter',
    providerModelId: usageMeta.provider_model_id ?? 'deepseek/deepseek-v4-flash-0731',
  })
}

function tL1ValidPlanThenFixturePhasesModel(): ResearchModelPort {
  const planningBridge = tL1ProductionShapedModel(syntheticValidFixturePath)
  const postPlan = fixtureModelForOfflineRun()
  return {
    async invokeStructured(request) {
      if (request.kind === 'plan_questions') {
        return planningBridge.invokeStructured(request)
      }
      return postPlan.invokeStructured(request)
    },
  }
}

async function runSyntheticInvalidSlotMission(
  dir: string,
  planRevisionId: string,
  model: ResearchModelPort = tL1ProductionShapedModel(),
) {
  const mission = ResearchMissionV2Schema.parse(JSON.parse(readFileSync(missionPath, 'utf8')))
  const slotError =
    /coverage obligation source_slot discover-primary is not a mission retrieval slot/
  await assert.rejects(
    () =>
      runResearchV2MissionWithOwnerSession({
        storeDirectory: dir,
        mission,
        discoverQuery: 'repository_file persistence checkpoint',
        planRevisionId,
        model,
      }),
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      assert.match(message, slotError)
      return true
    },
  )
  return mission
}

function listEventKinds(events: readonly { kind: string }[]): string[] {
  return events.map((e) => e.kind)
}

describe('historical pre-repair characterization (808d0613 / C #408 fe9bf5ef class; frozen)', () => {
  it('reference: planner payload directory defect was discover-primary fallback for repository-only missions', () => {
    const mission = ResearchMissionV2Schema.parse(JSON.parse(readFileSync(missionPath, 'utf8')))
    const canonicalSlots = missionCoverageSourceSlots(mission)
    assert.equal(canonicalSlots.includes('discover-primary'), false)
    assert.deepEqual(canonicalSlots, ['repository-pin-0', 'repository-pin-1'])
    assert.deepEqual(PRE_REPAIR_PAYLOAD_COVERAGE_SLOTS, ['discover-primary'])
    assert.notDeepEqual(PRE_REPAIR_PAYLOAD_COVERAGE_SLOTS, canonicalSlots)
  })

  it('reference: live diagnostic durable subset omitted external_operation_completed before settlement repair', () => {
    assert.deepEqual([...C_408_DIAGNOSTIC_EVENT_KINDS], [
      'mission_created',
      'plan_revised',
      'external_operation_intent',
      'terminal_receipt',
    ])
    assert.ok(PRE_REPAIR_ABSENT_EVENT_KINDS.includes('external_operation_completed'))
  })
})

/** Pre-A `missionRequirementsPayload` fallback (808d0613); not asserted against current runtime. */
const PRE_REPAIR_PAYLOAD_COVERAGE_SLOTS = ['discover-primary'] as const
const PRE_REPAIR_ABSENT_EVENT_KINDS = [
  'external_operation_completed',
  'model_invocation_completed',
] as const

describe('T-L1 invalid discover-primary planning failure reciprocal (A c27fb39c union, synthetic model)', () => {
  it('missionRequirementsPayload advertises canonical repository-pin slots on T-L1', () => {
    const mission = ResearchMissionV2Schema.parse(JSON.parse(readFileSync(missionPath, 'utf8')))
    const canonicalSlots = missionCoverageSourceSlots(mission)
    const requirements = missionRequirementsPayload(mission)
    assert.deepEqual(requirements.coverage_source_slots, canonicalSlots)
    assert.equal(requirements.coverage_source_slots.includes('discover-primary'), false)
  })

  it('synthetic envelope parses; mission slots exclude discover-primary', () => {
    const fixture = loadSyntheticFixture()
    assert.match(fixture._provenance, /Synthetic structurally valid/)
    assert.match(fixture._provenance, /NOT original/)
    const mission = ResearchMissionV2Schema.parse(JSON.parse(readFileSync(missionPath, 'utf8')))
    const slots = missionCoverageSourceSlots(mission)
    assert.equal(slots.includes('discover-primary'), false)
    assert.ok(slots.some((s) => s.startsWith('repository-pin-')))
    const payload = { ...fixture.raw_model_payload }
    const parsed = parseValidatedModelOutput('plan_questions', payload)
    assert.equal(parsed.kind, 'plan_questions')
  })

  it('production runner: strict slot rejection, settled planning failure, no retrieval evidence, cold reopen stable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'babel-t-l1-invalid-slot-'))
    const planId = 'plan-t-l1-invalid-slot-reciprocal'
    try {
      const mission = await runSyntheticInvalidSlotMission(dir, planId)
      const inspect = await openAdmittedInspectStore(dir)
      const events = await inspect.listEvents(mission.mission_id)
      const kinds = listEventKinds(events)
      assert.ok(kinds.includes('mission_created'))
      assert.ok(kinds.includes('plan_revised'))
      assert.ok(kinds.includes('external_operation_intent'))
      assert.ok(kinds.includes('external_operation_completed'))
      assert.ok(kinds.includes('terminal_receipt'))

      assert.equal(events.filter((e) => e.kind === 'external_operation_intent').length, 1)
      assert.equal(events.filter((e) => e.kind === 'external_operation_completed').length, 1)
      assert.equal(events.filter((e) => e.kind === 'model_invocation_completed').length, 0)
      assert.equal(events.filter((e) => e.kind === 'plan_revised').length, 1)

      const bootstrapPlan = (events.find((e) => e.kind === 'plan_revised')!.payload as {
        plan: { revision_reason: string; plan_revision_id: string }
      }).plan
      assert.equal(bootstrapPlan.revision_reason, 'host_bootstrap_before_model_plan')
      assert.equal(bootstrapPlan.plan_revision_id, `${planId}-bootstrap`)

      const intent = (events.find((e) => e.kind === 'external_operation_intent')!.payload as {
        intent: { operation_kind: string }
      }).intent
      assert.equal(intent.operation_kind, 'model_invoke')

      const retrievalKinds = new Set(['source_search', 'source_fetch'])
      assert.equal(
        events.some((e) => {
          if (e.kind !== 'external_operation_intent') return false
          const kind = (e.payload as { intent?: { operation_kind?: string } }).intent?.operation_kind
          return kind != null && retrievalKinds.has(kind)
        }),
        false,
        'planning slot failure must occur before repository search/fetch',
      )

      const generatedEvidence = new Set([
        'source_issued',
        'source_revision_issued',
        'passage_recorded',
        'finding_issued',
      ])
      assert.equal(events.some((e) => generatedEvidence.has(e.kind)), false)

      const report = terminalReportFromEvents(events)
      assert.ok(report)
      assert.equal(report?.terminal_state, 'failed')
      assert.match(
        report?.answer_summary ?? '',
        /discover-primary is not a mission retrieval slot/,
      )
      assert.equal(report?.plan_revision_id, `${planId}-bootstrap`)

      const reopened = await ResearchEngineSession.openInspect(dir)
      const eventsAfterReopen = await reopened.listEvents(mission.mission_id)
      assert.equal(eventsAfterReopen.length, events.length)
      assert.deepEqual(listEventKinds(eventsAfterReopen), listEventKinds(events))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('actual planner input advertises canonical repository-pin slots, not discover-primary', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'babel-t-l1-planner-input-'))
    let plannerInput: Record<string, unknown> | undefined
    const model = wrapModelWithPlanQuestionsInputCapture(tL1ProductionShapedModel(), (input) => {
      plannerInput = input
    })
    try {
      const mission = await runSyntheticInvalidSlotMission(
        dir,
        'plan-t-l1-planner-input-canonical',
        model,
      )
      assert.ok(plannerInput, 'plan_questions invoke must reach production planner input')
      const canonicalSlots = missionCoverageSourceSlots(mission)
      assert.deepEqual(
        plannerInput.coverage_source_slots,
        canonicalSlots,
        'planner input must expose mission retrieval slot directory (repository-pin/document/web), not discover-primary',
      )
      assert.equal(
        (plannerInput.coverage_source_slots as string[]).includes('discover-primary'),
        false,
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('planning slot validation failure settles model intent exactly once with preserved usage', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'babel-t-l1-invalid-slot-settlement-'))
    const fixture = loadSyntheticFixture()
    const usageMeta = fixture.request_local_usage_metadata
    try {
      const mission = await runSyntheticInvalidSlotMission(dir, 'plan-t-l1-invalid-slot-settlement')
      const events = await (await openAdmittedInspectStore(dir)).listEvents(mission.mission_id)
      const completions = events.filter((e) => e.kind === 'external_operation_completed')
      assert.equal(
        completions.length,
        1,
        'canonical gap: logical slot validation throw must still settle planning model intent exactly once (not zero, not a second mapper-phase completion)',
      )
      const completion = (completions[0]!.payload as {
        completion: {
          settlement: string
          failure_category?: string
          usage_settlement?: {
            input_tokens?: number
            output_tokens?: number
            cost: { status: string; amount_usd?: number }
          }
        }
      }).completion
      assert.ok(
        completion.settlement === 'failed' || completion.settlement === 'uncertain',
        `expected failed/uncertain settlement, got ${completion.settlement}`,
      )
      assert.ok(completion.usage_settlement)
      assertReportedUsageSettlement(completion.usage_settlement, usageMeta)
      assert.equal(events.filter((e) => e.kind === 'model_invocation_completed').length, 0)
      assert.equal(
        events.filter((e) => e.kind === 'external_operation_intent').length,
        1,
        'extract/review/synthesis invokeModelPhase paths are not reached; only planning intent',
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('valid repository-slot plan proceeds to injected repository search via owner runner', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'babel-t-l1-valid-slot-retrieval-'))
    const mission = ResearchMissionV2Schema.parse(JSON.parse(readFileSync(missionPath, 'utf8')))
    const planId = 'plan-t-l1-valid-slot-retrieval'
    try {
      await runResearchV2MissionWithOwnerSession({
        storeDirectory: dir,
        mission,
        discoverQuery: 'global-fallback-unused',
        planRevisionId: planId,
        model: tL1ValidPlanThenFixturePhasesModel(),
        fetchRepositoryTree: tL1InjectedFetchRepositoryTree(mission),
      }).catch(() => undefined)

      const events = await (await openAdmittedInspectStore(dir)).listEvents(mission.mission_id)
      const modelPlan = events
        .filter((e) => e.kind === 'plan_revised')
        .map((e) => (e.payload as { plan: { revision_reason: string; plan_revision_id: string } }).plan)
        .find((p) => p.revision_reason === 'e2e_model_planning')
      assert.ok(modelPlan, 'expected persisted model plan revision after valid slot obligations')

      const retrievalIntents = events.filter((e) => {
        if (e.kind !== 'external_operation_intent') return false
        const kind = (e.payload as { intent?: { operation_kind?: string } }).intent?.operation_kind
        return kind === 'source_search' || kind === 'source_fetch'
      })
      assert.ok(retrievalIntents.length >= 1, 'valid planning must reach injected repository retrieval')

      const reopened = await ResearchEngineSession.openInspect(dir)
      const eventsAfterReopen = await reopened.listEvents(mission.mission_id)
      assert.equal(eventsAfterReopen.length, events.length)
      assert.equal(retrievalIntents.length, eventsAfterReopen.filter((e) => {
        if (e.kind !== 'external_operation_intent') return false
        const kind = (e.payload as { intent?: { operation_kind?: string } }).intent?.operation_kind
        return kind === 'source_search' || kind === 'source_fetch'
      }).length)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

export function tL1InvalidSlotReciprocalSourceBinding(): {
  mission_json_sha256: string
  synthetic_fixture_sha256: string
  test_source_sha256: string
} {
  const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
  const testPath = fileURLToPath(import.meta.url)
  return {
    mission_json_sha256: hash(missionPath),
    synthetic_fixture_sha256: hash(syntheticInvalidFixturePath),
    test_source_sha256: hash(testPath),
  }
}

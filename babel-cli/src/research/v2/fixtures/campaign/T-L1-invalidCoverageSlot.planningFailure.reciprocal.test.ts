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
import { runResearchV2MissionWithOwnerSession } from '../../cli/researchV2MissionRun.js'
import { terminalReportFromEvents } from '../../cli/researchV2CliOperations.js'
import { openAdmittedInspectStore } from '../../control/researchStoreAdmission.js'
import { ResearchMissionV2Schema } from '../../contracts/mission.js'
import { parseValidatedModelOutput } from '../../contracts/modelOutputs.js'
import { missionCoverageSourceSlots } from '../../engine/missionCoverageSourceSlots.js'
import { ProviderResearchModelBridge } from '../../model/providerResearchModelBridge.js'
import { ResearchEngineSession } from '../../engine/researchEngineSession.js'

const campaignDir = dirname(fileURLToPath(import.meta.url))
const missionPath = join(campaignDir, 'T-L1-mission.json')
const syntheticFixturePath = join(
  campaignDir,
  'T-L1-synthetic-invalid-discover-primary-plan-questions.json',
)

/** Event kinds reported from C #408 fe9bf5ef live store subset (reference only; not vendored original JSON). */
const C_408_DIAGNOSTIC_EVENT_KINDS = [
  'mission_created',
  'plan_revised',
  'external_operation_intent',
  'terminal_receipt',
] as const

function loadSyntheticFixture() {
  const raw = JSON.parse(readFileSync(syntheticFixturePath, 'utf8')) as {
    _provenance: string
    request_local_usage_metadata: RunnerInvocationMetadata
    raw_model_payload: Record<string, unknown>
  }
  return raw
}

function tL1ProductionShapedModel(): ProviderResearchModelBridge {
  const fixture = loadSyntheticFixture()
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

async function runSyntheticInvalidSlotMission(dir: string, planRevisionId: string) {
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
        model: tL1ProductionShapedModel(),
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

describe('T-L1 invalid discover-primary planning failure reciprocal (production runner, synthetic model)', () => {
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

  it('production runner: strict slot rejection, C diagnostic durable subset, no retrieval evidence, cold reopen stable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'babel-t-l1-invalid-slot-'))
    const planId = 'plan-t-l1-invalid-slot-reciprocal'
    try {
      const mission = await runSyntheticInvalidSlotMission(dir, planId)
      const inspect = await openAdmittedInspectStore(dir)
      const events = await inspect.listEvents(mission.mission_id)
      assert.deepEqual(listEventKinds(events), [...C_408_DIAGNOSTIC_EVENT_KINDS])

      assert.equal(events.filter((e) => e.kind === 'external_operation_intent').length, 1)
      assert.equal(events.filter((e) => e.kind === 'external_operation_completed').length, 0)
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

  it('acceptance: exactly-once failed or uncertain model settlement preserves request-local usage (red until canonical repair)', async () => {
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
        'canonical gap: planning slot rejection must settle the model intent exactly once',
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
      assert.equal(completion.usage_settlement?.input_tokens, usageMeta.prompt_tokens)
      assert.equal(completion.usage_settlement?.output_tokens, usageMeta.completion_tokens)
      if (completion.usage_settlement?.cost.status === 'reported') {
        assert.equal(completion.usage_settlement.cost.amount_usd, usageMeta.estimated_cost_usd)
      }
      assert.equal(events.filter((e) => e.kind === 'model_invocation_completed').length, 0)
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
    synthetic_fixture_sha256: hash(syntheticFixturePath),
    test_source_sha256: hash(testPath),
  }
}

/**
 * B reciprocal: G-L1 planning failure on A integration runtime (deterministic; no live API).
 * Malformed payload: reconstructed from live validation trace (not raw model capture).
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import type { LlmRunner, RunnerCallbacks, RunnerInvocationMetadata } from '../../../../runners/base.js'
import { loadResearchMissionFromFile } from '../../cli/loadResearchMissionFile.js'
import { reportResearchV2Store, terminalReportFromEvents } from '../../cli/researchV2CliOperations.js'
import { runResearchV2MissionWithOwnerSession } from '../../cli/researchV2MissionRun.js'
import { openAdmittedInspectStore } from '../../control/researchStoreAdmission.js'
import { ProviderResearchModelBridge } from '../../model/providerResearchModelBridge.js'
import { parseValidatedModelOutput } from '../../contracts/modelOutputs.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', '..')
const missionFile = join(
  repoRoot,
  'codex/missions/general-g-l1-python-stable/mission.json',
)
const malformedPayloadPath = join(
  repoRoot,
  'codex/missions/general-g-l1-python-stable/g-l1-malformed-plan-questions-payload.json',
)

const G_L1_USAGE_META: RunnerInvocationMetadata = {
  provider: 'openrouter',
  provider_model_id: 'deepseek/deepseek-v4-flash-0731',
  observed_model_id: 'deepseek/deepseek-v4-flash-0731',
  latency_ms: 5955,
  prompt_tokens: 429,
  completion_tokens: 1784,
  total_tokens: 2213,
  estimated_cost_usd: 0.0002636874,
  cost_precision: 'exact',
}

function gL1MalformedPlanningRunner(): Pick<LlmRunner, 'execute'> {
  const payload = JSON.parse(readFileSync(malformedPayloadPath, 'utf8')) as Record<string, unknown>
  delete payload._provenance
  return {
    async execute(_prompt, _schema, callbacks?: RunnerCallbacks) {
      callbacks?.onInvocationCompleted?.({
        inference_id: 'g-l1-reciprocal-inf',
        provider: 'openrouter',
        model: G_L1_USAGE_META.provider_model_id ?? 'deepseek/deepseek-v4-flash-0731',
        status: 'delivered',
        usage_metadata: G_L1_USAGE_META,
        observed_model_id: G_L1_USAGE_META.observed_model_id ?? null,
      })
      return payload
    },
  }
}

function gL1ProductionShapedModel(): ProviderResearchModelBridge {
  return new ProviderResearchModelBridge({
    runner: gL1MalformedPlanningRunner(),
    backendKey: 'deepseek-v4-flash-openrouter',
    provider: 'openrouter',
    providerModelId: 'deepseek/deepseek-v4-flash-0731',
  })
}

async function runDeterministicPlanningFailureStore(dir: string, planRevisionId: string) {
  const mission = await loadResearchMissionFromFile(missionFile)
  await assert.rejects(
    () =>
      runResearchV2MissionWithOwnerSession({
        storeDirectory: dir,
        mission,
        discoverQuery: 'latest stable Python release python.org download',
        planRevisionId,
        model: gL1ProductionShapedModel(),
      }),
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      assert.match(message, /Zod validation failed|Invalid input/)
      return true
    },
  )
  return mission
}

describe('general G-L1 planning failure reciprocal (A integration runtime, deterministic)', () => {
  it('preserves failed model op + usage; no generated source/passage/finding evidence', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'babel-g-l1-planning-fail-'))
    try {
      const mission = await runDeterministicPlanningFailureStore(dir, 'plan-g-l1-reciprocal-001')
      const inspect = await openAdmittedInspectStore(dir)
      const events = await inspect.listEvents(mission.mission_id)
      assert.equal(events.filter((e) => e.kind === 'external_operation_intent').length, 1)
      assert.equal(events.filter((e) => e.kind === 'external_operation_completed').length, 1)

      const completion = (events.find((e) => e.kind === 'external_operation_completed')!.payload as {
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
      assert.equal(completion.settlement, 'failed')
      assert.equal(completion.failure_category, 'provider_invoke_failed')
      assert.equal(completion.usage_settlement?.input_tokens, 429)
      assert.equal(completion.usage_settlement?.output_tokens, 1784)
      if (completion.usage_settlement?.cost.status === 'reported') {
        assert.equal(completion.usage_settlement.cost.amount_usd, 0.0002636874)
      }

      const generatedEvidence = new Set([
        'source_issued',
        'source_revision_issued',
        'passage_issued',
        'finding_issued',
      ])
      assert.equal(
        events.some((e) => generatedEvidence.has(e.kind)),
        false,
        'planning failure must not fabricate admitted sources/passages/findings',
      )

      const inspectAfterReopen = await openAdmittedInspectStore(dir)
      assert.equal(
        (await inspectAfterReopen.listEvents(mission.mission_id)).length,
        events.length,
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('A integration acceptance: honest failed terminal_receipt and inspectable report after planning failure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'babel-g-l1-terminal-accept-'))
    try {
      const mission = await runDeterministicPlanningFailureStore(dir, 'plan-g-l1-terminal-accept')
      const events = await (await openAdmittedInspectStore(dir)).listEvents(mission.mission_id)
      const terminals = events.filter((e) => e.kind === 'terminal_receipt')
      assert.equal(
        terminals.length,
        1,
        'A failed-terminal repair: one durable terminal_receipt after provider_invoke_failed planning',
      )
      const report = terminalReportFromEvents(events)
      assert.ok(report)
      assert.equal(report?.terminal_state, 'failed')

      let reported: unknown
      await reportResearchV2Store({
        store: dir,
        missionId: mission.mission_id,
        print: (payload) => {
          reported = payload
        },
      })
      assert.ok(reported)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('malformed fixture is reconstructed from validation trace (offline envelope check)', () => {
    const payload = JSON.parse(readFileSync(malformedPayloadPath, 'utf8')) as Record<string, unknown>
    assert.match(String(payload._provenance), /Reconstructed from live G-L1/)
    assert.match(String(payload._provenance), /NOT a captured raw model response/)
    delete payload._provenance
    assert.throws(() => parseValidatedModelOutput('plan_questions', payload), /Invalid input|Unrecognized keys/)
  })
})

import {
  attributeCausalFailure,
  type CausalAttribution,
  type CausalAttributionEvidence,
} from './causalAttribution.js'

export type DeterministicCausalFixtureId =
  | 'provider_failure'
  | 'wrong_model_route'
  | 'capability_denial'
  | 'tool_never_starts'
  | 'tool_result_lost'
  | 'context_loss'
  | 'missing_executable'
  | 'model_ignores_verifier_failure'
  | 'tool_loop'
  | 'false_completion'
  | 'honest_block'

export interface DeterministicCausalFixture {
  id: DeterministicCausalFixtureId
  description: string
  evidence: CausalAttributionEvidence
  expected_family: CausalAttribution['family']
  expected_code: string
  model_blame_permitted: boolean
}

const healthy = (): CausalAttributionEvidence => ({
  information_existed: true,
  route_correct: true,
  result_delivered: true,
  context_preserved: true,
  capability_advertised: true,
  capability_authorized: true,
  capability_effective: true,
  task_feasible: true,
  evidence_complete: true,
  model_behavior: 'none',
})

function fixture(
  id: DeterministicCausalFixtureId,
  description: string,
  overrides: Partial<CausalAttributionEvidence>,
  expected_family: CausalAttribution['family'],
  expected_code: string,
  model_blame_permitted = false,
): DeterministicCausalFixture {
  return {
    id,
    description,
    evidence: { ...healthy(), ...overrides },
    expected_family,
    expected_code,
    model_blame_permitted,
  }
}

/** Provider-free causal cases covering each required attribution boundary. */
export const DETERMINISTIC_CAUSAL_FIXTURES: readonly DeterministicCausalFixture[] = [
  fixture('provider_failure', 'provider rejects before useful output', { provider_failure: 'provider_rejected' }, 'provider', 'provider_rejected'),
  fixture('wrong_model_route', 'requested model is not the observed model', { route_correct: false }, 'harness', 'wrong_model_route'),
  fixture('capability_denial', 'valid proposed effect is denied by policy', { capability_authorized: false }, 'harness', 'policy_denied_capability'),
  fixture('tool_never_starts', 'authorized dispatch fails before the tool starts', { execution_failure: 'tool_not_started' }, 'harness', 'tool_not_started'),
  fixture('tool_result_lost', 'terminal tool result is not delivered to the next inference', { result_delivered: false }, 'harness', 'result_not_delivered'),
  fixture('context_loss', 'required context is omitted after compaction', { context_preserved: false }, 'harness', 'context_evidence_lost'),
  fixture('missing_executable', 'environment cannot spawn a required executable', { capability_effective: false, environment_failure: 'missing_executable' }, 'environment', 'missing_executable'),
  fixture('model_ignores_verifier_failure', 'model ignores an explicitly delivered failed verifier', { model_behavior: 'incorrect' }, 'model', 'incorrect_action_despite_evidence', true),
  fixture('tool_loop', 'model repeats a low-value operation with usable evidence', { model_behavior: 'loop' }, 'model', 'loop_or_stall_despite_usable_capability', true),
  fixture('false_completion', 'model completes despite a delivered failed verifier receipt', { model_behavior: 'premature_completion' }, 'model', 'premature_completion_despite_evidence', true),
  fixture('honest_block', 'model reports an observed environment block honestly', { environment_failure: 'environment_block', model_behavior: 'none' }, 'environment', 'environment_block'),
]

export interface DeterministicCausalFixtureResult extends DeterministicCausalFixture {
  attribution: CausalAttribution
  passed: boolean
}

/** Run all deterministic causal fixtures without provider or filesystem access. */
export function runDeterministicCausalFixtureSuite(): DeterministicCausalFixtureResult[] {
  return DETERMINISTIC_CAUSAL_FIXTURES.map((testCase) => {
    const attribution = attributeCausalFailure(testCase.evidence)
    return {
      ...testCase,
      attribution,
      passed:
        attribution.family === testCase.expected_family &&
        attribution.code === testCase.expected_code &&
        attribution.model_blame_permitted === testCase.model_blame_permitted,
    }
  })
}

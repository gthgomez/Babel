import { ResearchMissionV2Schema } from '../contracts/mission.js'
import { PlanRevisionSchema } from '../contracts/plan.js'
import { RESEARCH_V2_CONTRACT_VERSION } from '../contracts/version.js'

/** Fixture mission for contract review — not a live OpenRouter route. */
export const exampleTechnicalMissionFixture = ResearchMissionV2Schema.parse({
  schema_version: 'research-mission-v2',
  contract_version: RESEARCH_V2_CONTRACT_VERSION,
  mission_id: 'mission-fixture-t-arch-001',
  profile_id: 'technical',
  profile_version: '0.0.0-checkpoint',
  created_at: '2026-10-20T12:00:00.000Z',
  primary_question:
    'How does Babel isolate research evidence from executable policy compared to a pinned reference implementation?',
  intended_decision: 'Choose the smaller change for Babel memory/research boundaries.',
  constraints: ['Public sources only', 'No foreign code execution'],
  exclusions: ['Private repository content', 'Paid benchmark reruns'],
  as_of: '2026-10-20',
  jurisdiction: 'unknown',
  source_policy: {
    allowed_source_classes: ['web', 'repository_file', 'paper', 'document'],
    allowed_web_domains: ['github.com', 'githubusercontent.com'],
    visibility_retention: {
      source_visibility: 'public',
      retention: 'excerpt_only',
      export_may_omit_bytes: true,
    },
  },
  effort_policy: {
    preset_name: 'normal',
    resolved_budget_label: 'host-resolved-normal',
  },
  model_route: {
    backend_key: 'fixture-model-route',
    provider: 'fixture',
    provider_model_id: 'fixture/technical-research-model',
    fixture_route: true,
  },
  pinned_target_repository: {
    provider: 'github',
    repo_id: 'github:gthgomez/Babel',
    full_name: 'gthgomez/Babel',
    commit_sha: 'd9e42b14b00b6dba25f0415ae16b084363386a01',
  },
})

export const examplePlanRevisionFixture = PlanRevisionSchema.parse({
  plan_revision_id: 'plan-fixture-001',
  mission_id: exampleTechnicalMissionFixture.mission_id,
  created_at: '2026-10-20T12:01:00.000Z',
  revision_reason: 'initial_plan',
  questions: [
    {
      question_id: 'q-mechanism',
      text: 'What mechanisms separate untrusted source text from tool policy?',
      importance: 'critical',
      evidence_requirement: 'Primary code or documentation with locators',
      status: 'open',
      next_gap: 'Read pinned Babel research contracts',
    },
    {
      question_id: 'q-tradeoff',
      text: 'What trade-offs appear versus the reference implementation?',
      importance: 'high',
      evidence_requirement: 'Comparable modules in pinned repos',
      status: 'open',
    },
  ],
})

export const exampleMissionWriteContext = {
  mission_id: exampleTechnicalMissionFixture.mission_id,
  plan_revision_id: examplePlanRevisionFixture.plan_revision_id,
  writer_generation: 1,
}

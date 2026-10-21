import { PlanRevisionSchema, type PlanRevision } from '../contracts/plan.js'
import type { ResearchMissionV2 } from '../contracts/mission.js'
import { PlanQuestionsOutputSchema } from '../contracts/modelOutputs.js'
import {
  validateQuestionCoverageObligations,
} from './missionCoverageSourceSlots.js'

/** Host-only shell so store evidence writes have an active plan before first model plan is generated. */
export function buildBootstrapPlanRevision(params: {
  mission: ResearchMissionV2
  planRevisionId: string
  createdAt: string
}): PlanRevision {
  return PlanRevisionSchema.parse({
    plan_revision_id: params.planRevisionId,
    mission_id: params.mission.mission_id,
    created_at: params.createdAt,
    revision_reason: 'host_bootstrap_before_model_plan',
    questions: [
      {
        question_id: `q-${params.planRevisionId}-bootstrap`,
        text: 'Host bootstrap plan shell (awaiting model plan_questions)',
        importance: 'low',
        evidence_requirement: 'Not used for research evidence',
        status: 'open',
      },
    ],
  })
}

export function buildPlanRevisionFromPlanQuestions(params: {
  mission: ResearchMissionV2
  planRevisionId: string
  revisionReason: string
  createdAt: string
  modelOutput: Record<string, unknown>
}): PlanRevision {
  const parsed = PlanQuestionsOutputSchema.parse(params.modelOutput)
  return PlanRevisionSchema.parse({
    plan_revision_id: params.planRevisionId,
    mission_id: params.mission.mission_id,
    created_at: params.createdAt,
    revision_reason: params.revisionReason,
    questions: parsed.questions.map((question, index) => {
      const obligations = question.coverage_obligations ?? []
      if (obligations.length > 0) {
        validateQuestionCoverageObligations(obligations, params.mission)
      }
      return {
        question_id: `q-${params.planRevisionId}-${index + 1}`,
        text: question.text,
        importance: question.importance,
        evidence_requirement: 'Host-admitted plan question; refine locators during retrieval',
        status: 'open',
        ...(obligations.length > 0 ? { coverage_obligations: obligations } : {}),
      }
    }),
  })
}

export function missionRequirementsPayload(mission: ResearchMissionV2): Record<string, unknown> {
  return {
    mission_id: mission.mission_id,
    profile_id: mission.profile_id,
    primary_question: mission.primary_question,
    intended_decision: mission.intended_decision,
    constraints: mission.constraints,
    exclusions: mission.exclusions,
    as_of: mission.as_of,
    jurisdiction: mission.jurisdiction,
    source_policy: mission.source_policy,
    effort_policy: mission.effort_policy,
    pinned_target_repository: mission.pinned_target_repository,
    coverage_source_slots: mission.source_policy.selected_web_refs?.length
      ? mission.source_policy.selected_web_refs.map((_, index) => `web-ref-${index}`)
      : ['discover-primary'],
  }
}

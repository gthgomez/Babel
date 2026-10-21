import { FixtureResearchModelBridge } from '../model/fixtureModelBridge.js'
import type { ResearchModelPort } from '../ports/researchModelPort.js'
import {
  claimedSourceReviewFieldsFromSemanticInput,
  type SemanticReviewFindingInput,
} from '../engine/testSupport/claimedSourceReviewFieldsFromSemanticInput.js'
import type { MissionSourceSlotAttribution } from '../engine/sourceAttributionContext.js'

/** Deterministic model scripts for injected offline CLI / test runs. */
export function fixtureModelForOfflineRun(): ResearchModelPort {
  const fixture = new FixtureResearchModelBridge()
  fixture.scriptOutput('cli-run-plan', {
    kind: 'plan_questions',
    questions: [{ text: 'What does the pinned contracts file export?', importance: 'high' }],
  })
  return {
    async invokeStructured(request) {
      if (
        request.kind === 'plan_questions' &&
        (request.operationId === 'cli-run-plan' || request.operationId.startsWith('cli-run-plan-'))
      ) {
        fixture.scriptOutput(request.operationId, {
          kind: 'plan_questions',
          questions: [{ text: 'What does the pinned contracts file export?', importance: 'high' }],
        })
      }
      if (request.kind === 'extract_findings') {
        const passageIds = (request.input.passage_ids as string[]) ?? []
        const planQuestions =
          (request.input.plan_questions as { question_id: string }[] | undefined) ?? []
        const questionId = planQuestions[0]?.question_id ?? 'q-cli-run-plan-1'
        fixture.scriptOutput(request.operationId, {
          kind: 'extract_findings',
          findings: [
            {
              assertion_text: 'The file exports a RESEARCH_CONTRACT constant.',
              assertion_kind: 'source_observation',
              passage_ids: passageIds,
              question_id: questionId,
            },
          ],
        })
      }
      if (request.kind === 'semantic_support_review') {
        const findings = (request.input.findings as SemanticReviewFindingInput[]) ?? []
        const missionSourceSlots = request.input.mission_source_slots as
          | readonly MissionSourceSlotAttribution[]
          | undefined
        fixture.scriptOutput(request.operationId, {
          kind: 'semantic_support_review',
          judgments: findings.map((row) => ({
            finding_id: row.finding_id,
            status: 'insufficient',
            rationale: 'Offline CLI run — insufficient for a live acceptance decision.',
            question_coverage: 'partial',
            ...claimedSourceReviewFieldsFromSemanticInput(row, missionSourceSlots),
          })),
        })
      }
      if (request.kind === 'synthesize_report') {
        fixture.scriptOutput(request.operationId, {
          kind: 'synthesize_report',
          answer_summary: 'Offline injected run produced a partial cited report.',
          stopping_reason: 'insufficient_semantic_support',
        })
      }
      return fixture.invokeStructured(request)
    },
  }
}

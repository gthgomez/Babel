import { FixtureResearchModelBridge } from '../model/fixtureModelBridge.js'
import type { ResearchModelPort } from '../ports/researchModelPort.js'

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
        const findingId = (request.input.findings as { finding_id: string }[])?.[0]?.finding_id
        fixture.scriptOutput(request.operationId, {
          kind: 'semantic_support_review',
          judgments: [
            {
              finding_id: findingId ?? 'missing',
              status: 'insufficient',
              rationale: 'Offline CLI run — insufficient for a live acceptance decision.',
              question_coverage: 'partial',
            },
          ],
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

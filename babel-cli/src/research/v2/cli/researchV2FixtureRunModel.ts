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
      if (request.kind === 'extract_findings') {
        const passageIds = (request.input.passage_ids as string[]) ?? []
        fixture.scriptOutput(request.operationId, {
          kind: 'extract_findings',
          findings: [
            {
              assertion_text: 'The file exports a RESEARCH_CONTRACT constant.',
              assertion_kind: 'source_observation',
              passage_ids: passageIds,
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

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { ExtractFindingsOutputSchema } from '../contracts/modelOutputs.js'
import { PlanRevisionSchema } from '../contracts/plan.js'
import type { PassageRecord } from '../contracts/passages.js'
import { findingsFromExtractModelOutput } from './findingsFromModelOutput.js'

const campaignDir = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/campaign')
const twoQuestionPlan = PlanRevisionSchema.parse(
  JSON.parse(readFileSync(join(campaignDir, 'G-L2-two-question-plan.fixture.json'), 'utf8')),
)

const passage: PassageRecord = {
  passage_id: 'p-legacy',
  source_revision_id: 'rev-1',
  locator: { kind: 'section', section_id: 's' },
  text_ref: { mode: 'inline', text: 't', text_hash: 'a'.repeat(64) },
}

describe('EXECUTED legacy extract binding (production A runtime until attribution ships)', () => {
  it('production ExtractFindingsOutputSchema still omits question_id (compatibility)', () => {
    const parsed = ExtractFindingsOutputSchema.parse({
      kind: 'extract_findings',
      findings: [
        {
          assertion_text: 'legacy row',
          assertion_kind: 'source_observation',
          passage_ids: ['p-legacy'],
        },
      ],
    })
    assert.ok(!('question_id' in parsed.findings[0]!))
  })

  it('production mapper binds every row to plan.questions[0] even on two-question plans', () => {
    const firstId = twoQuestionPlan.questions[0]?.question_id
    assert.ok(firstId)
    const findings = findingsFromExtractModelOutput({
      operationId: 'op-legacy-bind',
      plan: twoQuestionPlan,
      passages: [passage],
      createdAt: '2026-10-21T09:00:00.000Z',
      modelOutput: {
        kind: 'extract_findings',
        findings: [
          {
            assertion_text: 'row one',
            assertion_kind: 'source_observation',
            passage_ids: ['p-legacy'],
          },
          {
            assertion_text: 'row two',
            assertion_kind: 'source_observation',
            passage_ids: ['p-legacy'],
          },
        ],
      },
    })
    assert.equal(findings.length, 2)
    assert.ok(findings.every((f) => f.question_id === firstId))
    assert.notEqual(firstId, twoQuestionPlan.questions[1]?.question_id)
  })
})

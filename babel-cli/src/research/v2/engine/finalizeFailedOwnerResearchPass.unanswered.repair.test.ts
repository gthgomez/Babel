import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import type { MissionWriteContext } from '../contracts/common.js'
import type { PlanRevision } from '../contracts/plan.js'
import { exampleTechnicalMissionFixture } from '../fixtures/exampleMission.js'
import { DurableResearchStore } from '../persistence/durableResearchStore.js'
import { finalizeFailedOwnerResearchPass } from './finalizeFailedOwnerResearchPass.js'
import { ResearchPassFailedError } from './researchPassFailure.js'

const FIXED_NOW = '2026-10-21T15:30:00.000Z'

const twoQuestionPlan: PlanRevision = {
  plan_revision_id: 'plan-t-l1-attempt2-001',
  mission_id: exampleTechnicalMissionFixture.mission_id,
  created_at: FIXED_NOW,
  revision_reason: 'model_plan_questions',
  questions: [
    {
      question_id: 'q-plan-t-l1-attempt2-1',
      text: 'How does Babel persist research state?',
      importance: 'high',
      evidence_requirement: 'repository_file paths',
      status: 'open',
    },
    {
      question_id: 'q-plan-t-l1-attempt2-2',
      text: 'How does LangGraph persist graph state?',
      importance: 'high',
      evidence_requirement: 'repository_file paths',
      status: 'open',
    },
  ],
}

describe('failed terminal unanswered_questions from durable plan', () => {
  it('derives open plan question ids after retrieval failure with no findings (cold reopen)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'babel-failed-unanswered-'))
    try {
      const store = await DurableResearchStore.open(dir)
      const handle = await store.appendMission(exampleTechnicalMissionFixture)
      const fence = store.readMissionWriteFence(exampleTechnicalMissionFixture.mission_id)
      const ctx: MissionWriteContext = {
        mission_id: exampleTechnicalMissionFixture.mission_id,
        plan_revision_id: twoQuestionPlan.plan_revision_id,
        writer_generation: fence.writer_generation,
      }
      await store.appendPlanRevision(ctx, twoQuestionPlan)

      const appended = await finalizeFailedOwnerResearchPass({
        store,
        mission: exampleTechnicalMissionFixture,
        planRevisionId: twoQuestionPlan.plan_revision_id,
        failurePhase: 'retrieval',
        message: 'GitHub tree API HTTP 403',
        cause: new ResearchPassFailedError('repository tree listing failed', {
          stoppingReason: 'source_retrieval_failed',
          failurePhase: 'retrieval',
        }),
        now: () => FIXED_NOW,
      })
      assert.equal(appended, true)
      await store.close()

      const reopened = await DurableResearchStore.open(dir)
      const events = await reopened.listEvents(exampleTechnicalMissionFixture.mission_id)
      const terminal = events.find((e) => e.kind === 'terminal_receipt')
      const report = (terminal?.payload as { report: { unanswered_questions: string[]; terminal_state: string; answer_summary: string } })
        .report
      assert.equal(report.terminal_state, 'failed')
      assert.match(report.answer_summary, /retrieval/)
      assert.deepEqual(report.unanswered_questions, [
        'q-plan-t-l1-attempt2-1',
        'q-plan-t-l1-attempt2-2',
      ])
      await reopened.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

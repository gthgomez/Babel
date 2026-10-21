import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { FindingRecordSchema } from '../contracts/findings.js'
import {
  exampleMissionWriteContext,
  examplePlanRevisionFixture,
  exampleTechnicalMissionFixture,
} from '../fixtures/exampleMission.js'
import { listFindingsFromStoreEvents } from '../engine/listFindingsFromStoreEvents.js'
import { DurableResearchStore } from './durableResearchStore.js'

async function withTempStoreDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'babel-research-v2-qc-store-'))
}

describe('durable research store question_coverage persistence', () => {
  it('preserves question_coverage across close and reopen', async () => {
    const dir = await withTempStoreDir()
    try {
      const store1 = await DurableResearchStore.open(dir)
      const handle = await store1.appendMission(exampleTechnicalMissionFixture)
      const acquired = await store1.acquireWriterOwnership({
        mission_id: handle.mission_id,
        expected_writer_generation: handle.writer_generation,
      })
      const ctx = {
        ...exampleMissionWriteContext,
        mission_id: handle.mission_id,
        writer_generation: acquired.writer_generation,
        plan_revision_id: examplePlanRevisionFixture.plan_revision_id,
      }
      await store1.appendPlanRevision(ctx, examplePlanRevisionFixture)
      const finding = FindingRecordSchema.parse({
        finding_id: 'finding-qc-durable-001',
        question_id: examplePlanRevisionFixture.questions[0]!.question_id,
        assertion_text: 'Synthetic durable-store coverage row.',
        assertion_kind: 'source_observation',
        passage_ids: ['passage-qc-1'],
        source_integrity: 'valid',
        created_at: '2026-10-21T10:20:00.000Z',
        semantic_support: {
          status: 'supported',
          reviewer: 'research-v2-semantic-review',
          reviewer_version: '0.1.0-offline',
          rationale: 'synthetic',
          reviewed_at: '2026-10-21T10:20:01.000Z',
        },
        question_coverage: {
          status: 'tangential',
          reviewer: 'research-v2-semantic-review',
          reviewer_version: '0.1.0-question-coverage',
          rationale: 'synthetic tangential coverage for persistence',
          reviewed_at: '2026-10-21T10:20:01.000Z',
        },
      })
      await store1.appendFinding(ctx, finding)
      await store1.close()

      const store2 = await DurableResearchStore.open(dir)
      const events = await store2.listEvents(handle.mission_id)
      const reloaded = listFindingsFromStoreEvents(events)
      assert.equal(reloaded.length, 1)
      assert.equal(reloaded[0]?.question_coverage?.status, 'tangential')
      assert.equal(reloaded[0]?.semantic_support?.status, 'supported')
      await store2.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

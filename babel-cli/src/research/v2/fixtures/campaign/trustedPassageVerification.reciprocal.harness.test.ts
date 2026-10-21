/**
 * B harness for Agent A trusted passage verification port (contract + handoff only).
 * Does not implement cryptographic verification; prepares actual-runner scenarios for A wiring.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { createHash } from 'node:crypto'
import type { FindingRecord } from '../../contracts/findings.js'
import type { PassageRecord } from '../../contracts/passages.js'
import type { SourceRevision } from '../../contracts/sources.js'
import {
  TrustedPassageVerificationOutcomeSchema,
  type TrustedPassageVerificationOutcome,
} from '../../contracts/trustedPassageVerification.js'
import { ResearchEngineSession } from '../../engine/researchEngineSession.js'
import { fixtureModelForOfflineRun } from '../../cli/researchV2FixtureRunModel.js'
import { exampleTechnicalMissionFixture } from '../exampleMission.js'
import { applyTrustedPassageVerificationToFinding } from '../../engine/trustedPassageVerificationHandoff.js'
import type { TrustedPassageVerificationPort } from '../../ports/trustedPassageVerificationPort.js'

const revision: SourceRevision = {
  revision_id: 'rev-trusted-passage',
  source_id: 'src-trusted-passage',
  content_hash: createHash('sha256').update('whole-source-bytes', 'utf8').digest('hex'),
  retrieved_at: '2026-10-21T16:00:00.000Z',
  extraction_version: 'harness/1',
  media_type: 'text/plain',
  completeness: 'complete',
}

const passage: PassageRecord = {
  passage_id: 'passage-trusted-1',
  source_revision_id: revision.revision_id,
  locator: { kind: 'line_range', start_line: 1, end_line: 3 },
  text_ref: {
    mode: 'inline',
    text: 'whole-source-bytes',
    text_hash: createHash('sha256').update('whole-source-bytes', 'utf8').digest('hex'),
  },
}

const baseFinding: FindingRecord = {
  finding_id: 'finding-trusted-1',
  question_id: 'q-trusted-1',
  assertion_text: 'Harness assertion',
  assertion_kind: 'source_observation',
  passage_ids: [passage.passage_id],
  source_integrity: 'not_checked',
  created_at: '2026-10-21T16:00:00.000Z',
}

function harnessPort(
  status: TrustedPassageVerificationOutcome['status'],
): TrustedPassageVerificationPort {
  return {
    async verifyPassage(request) {
      return TrustedPassageVerificationOutcomeSchema.parse({
        status,
        passage_id: request.passage.passage_id,
        source_revision_id: request.source_revision.revision_id,
        operation_id: request.operation_id,
        attempt_id: request.attempt_id,
        ...(status === 'verified_whole_source_complete'
          ? { observed_text_hash: passage.text_ref.text_hash, expected_text_hash: passage.text_ref.text_hash }
          : {}),
        ...(status.startsWith('mismatch_') ? { detail: `harness_${status}` } : {}),
      })
    },
  }
}

describe('trusted passage verification harness (B contract; A owns verifyPassage)', () => {
  const scenarios: Array<{
    name: string
    status: TrustedPassageVerificationOutcome['status']
    expectedIntegrity: FindingRecord['source_integrity']
  }> = [
    { name: 'verified whole-source complete positive', status: 'verified_whole_source_complete', expectedIntegrity: 'valid' },
    { name: 'text mismatch', status: 'mismatch_text', expectedIntegrity: 'invalid' },
    { name: 'hash mismatch', status: 'mismatch_hash', expectedIntegrity: 'invalid' },
    { name: 'locator mismatch', status: 'mismatch_locator', expectedIntegrity: 'invalid' },
    { name: 'source mismatch', status: 'mismatch_source', expectedIntegrity: 'invalid' },
    { name: 'attempt mismatch', status: 'mismatch_attempt', expectedIntegrity: 'invalid' },
    { name: 'truncated partial', status: 'truncated_partial', expectedIntegrity: 'not_checked' },
    { name: 'legacy not_checked', status: 'legacy_not_checked', expectedIntegrity: 'not_checked' },
  ]

  for (const scenario of scenarios) {
    it(`handoff: ${scenario.name}`, async () => {
      const port = harnessPort(scenario.status)
      const outcome = await port.verifyPassage({
        operation_id: 'op-verify',
        attempt_id: 'attempt-verify',
        passage,
        source_revision: revision,
        admitted_payload: Buffer.from('whole-source-bytes', 'utf8'),
        signal: new AbortController().signal,
      })
      const applied = applyTrustedPassageVerificationToFinding(baseFinding, outcome)
      assert.equal(applied.finding.source_integrity, scenario.expectedIntegrity)
      assert.ok(applied.limitations.some((l) => l.includes(scenario.status)))
    })
  }

  it('actual-runner: cold reopen store round-trip (pending A durable verifier event wiring)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'babel-trusted-passage-reopen-'))
    try {
      const owner = await ResearchEngineSession.openOwner({
        storeDirectory: dir,
        model: fixtureModelForOfflineRun(),
      })
      await owner.appendMission(exampleTechnicalMissionFixture)
      await owner.close()

      const port = harnessPort('verified_whole_source_complete')
      const outcome = await port.verifyPassage({
        operation_id: 'op-cold-reopen',
        attempt_id: 'attempt-cold-reopen',
        passage,
        source_revision: revision,
        admitted_payload: Buffer.from('whole-source-bytes', 'utf8'),
        signal: new AbortController().signal,
      })
      const applied = applyTrustedPassageVerificationToFinding(baseFinding, outcome)
      assert.ok(applied.limitations.length >= 1)

      const reopened = await ResearchEngineSession.openInspect(dir)
      const events = await reopened.listEvents(exampleTechnicalMissionFixture.mission_id)
      assert.ok(events.some((e) => e.kind === 'mission_created'))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

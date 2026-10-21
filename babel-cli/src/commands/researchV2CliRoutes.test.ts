import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { rewriteArgv } from '../cli/argv.js'
import { exampleTechnicalMissionFixture } from '../research/v2/fixtures/exampleMission.js'
import {
  inspectResearchV2Store,
  reportResearchV2Store,
  runResearchV2CancelResumeJourney,
  runResearchV2OfflineRun,
} from '../research/v2/cli/researchV2CliOperations.js'

describe('research v2 CLI routes (offline injected)', () => {
  it('argv dispatches research without -- passthrough', () => {
    const rewritten = rewriteArgv(['node', 'babel', 'research', 'v2', 'live-status'])
    assert.equal(rewritten[2], 'research')
    assert.equal(rewritten[3], 'v2')
    assert.equal(rewritten[4], 'live-status')
  })

  it('run → inspect → report on durable store', async () => {
    const store = await mkdtemp(join(tmpdir(), 'babel-research-v2-cli-routes-'))
    const outputs: unknown[] = []
    const capture = (payload: unknown) => {
      outputs.push(payload)
    }
    try {
      await runResearchV2OfflineRun({
        store,
        json: true,
        print: (p) => capture(p),
      })
      await inspectResearchV2Store({
        store,
        missionId: exampleTechnicalMissionFixture.mission_id,
        print: (p) => capture(p),
      })
      await reportResearchV2Store({
        store,
        missionId: exampleTechnicalMissionFixture.mission_id,
        print: (p) => capture(p),
      })
      const runPayload = outputs[0] as { terminal_report_emitted?: boolean }
      assert.equal(runPayload.terminal_report_emitted, true)
      const reportPayload = outputs[2] as { report?: { terminal_state?: string } }
      assert.ok(reportPayload.report?.terminal_state)
    } finally {
      await rm(store, { recursive: true, force: true })
    }
  })

  it('cancel-resume-once records single continuation (X-L1 offline)', async () => {
    const store = await mkdtemp(join(tmpdir(), 'babel-research-v2-cli-x-l1-'))
    let payload: { continuation_resumed_count?: number } | undefined
    try {
      await runResearchV2CancelResumeJourney({
        store,
        print: (p) => {
          payload = p as { continuation_resumed_count?: number }
        },
      })
      assert.equal(payload?.continuation_resumed_count, 1)
      const withRun = payload as { continuation_run?: { terminal_report_emitted?: boolean } }
      assert.equal(withRun.continuation_run?.terminal_report_emitted, true)
    } finally {
      await rm(store, { recursive: true, force: true })
    }
  })
})

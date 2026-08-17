import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { codingCorpusInventory, listCodingCorpusTasks } from './tasks.js'
import { detectObservationBlindness, scoreCorpus, scoreTrajectory } from './scorer.js'
import { runCodingCorpusOffline } from './runner.js'
import { HARDENED_REPLAY_TRAJECTORIES, PLANTED_BLINDNESS_TRAJECTORIES } from './fixtures/trajectories.js'

describe('coding corpus v0', () => {
  test('inventory is 36-40 human-validated pinned tasks', () => {
    const tasks = listCodingCorpusTasks()
    const inv = codingCorpusInventory()
    assert.ok(inv.count >= 36 && inv.count <= 40, `count=${inv.count}`)
    assert.equal(tasks.length, inv.count)
    for (const t of tasks) {
      assert.ok(t.repository.length > 0)
      assert.ok(t.starting_commit.length > 0)
      assert.ok(t.task_prompt.length > 10)
      assert.ok(t.task_class)
      assert.ok(t.risk)
      assert.ok(t.visible_checks.length > 0)
      assert.ok(t.hidden_acceptance.length > 0)
      assert.ok(Array.isArray(t.known_baseline_failures))
      assert.ok(t.max_cost_usd > 0)
      assert.ok(t.max_turns > 0)
      assert.ok(t.max_wall_s > 0)
      assert.ok(t.expected_files.length > 0)
      assert.ok(Array.isArray(t.forbidden_changes))
      assert.ok(t.validated_by.length > 0)
      assert.ok(t.validation_note.length > 0)
    }
    assert.ok((inv.byClass['single_file_bug'] ?? 0) >= 6)
    assert.ok(tasks.some((t) => t.windows_relevant === true))
    assert.ok(tasks.some((t) => t.id.startsWith('df-')))
  })

  test('planted blindness events are counted', () => {
    const card = scoreCorpus(PLANTED_BLINDNESS_TRAJECTORIES)
    assert.ok(card.observationBlindnessEvents >= 4)
    const kinds = new Set(card.scores.flatMap((s) => s.observationBlindness))
    assert.ok(kinds.has('dropped_stderr'))
    assert.ok(kinds.has('head_only_hidden_failure'))
    assert.ok(kinds.has('skipped_requested_range'))
    assert.ok(kinds.has('inaccessible_overflow'))
  })

  test('hardened Wave-0 replay has zero observation-blindness events', () => {
    const card = scoreCorpus(HARDENED_REPLAY_TRAJECTORIES)
    assert.equal(card.observationBlindnessEvents, 0)
    const repair = scoreTrajectory(HARDENED_REPLAY_TRAJECTORIES[0]!)
    assert.equal(repair.repairEvidenceBeforeSecondMutation, true)
    assert.equal(repair.hiddenSuccess, true)
    assert.equal(repair.falseCompletion, false)
  })

  test('offline runner scores inventory + fixtures', () => {
    const result = runCodingCorpusOffline()
    assert.ok(result.inventory.count >= 36)
    assert.ok(result.plantedBlindness.observationBlindnessEvents > 0)
    assert.equal(result.hardenedReplay.observationBlindnessEvents, 0)
  })

  test('detectObservationBlindness is the shipped detector used by the scorer', () => {
    const kinds = detectObservationBlindness(PLANTED_BLINDNESS_TRAJECTORIES[0]!.events)
    assert.ok(kinds.includes('dropped_stderr'))
  })
})

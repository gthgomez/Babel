import test from 'node:test'
import assert from 'node:assert/strict'
import { balanceUnitInventory } from '../../babel-cli/scripts/run_ci_unit_shard.mjs'
import { updateUnitDurations } from '../../babel-cli/scripts/update_ci_unit_durations.mjs'

test('duration scheduling is deterministic, exhaustive, disjoint and nonempty', () => {
  const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
  const hints = { a: 9000, c: 8000, e: 7000, g: 6000 }
  const plan = balanceUnitInventory(files, 4, hints)
  assert.deepEqual(plan, balanceUnitInventory([...files].reverse(), 4, hints))
  assert.deepEqual(plan.flatMap(shard => shard.files).sort(), files)
  assert.ok(plan.every(shard => shard.files.length > 0))
  assert.equal(Math.max(...plan.map(shard => shard.estimatedMs)), 9000)
  assert.equal(balanceUnitInventory(files, 4, { a: Infinity })[0].estimatedMs, 2000)
  assert.throws(() => balanceUnitInventory(['a', 'a'], 1), /Invalid/)
})

test('timing hints require complete execution, matching content, and a bounded duration', () => {
  const observation = { complete: true, platform: 'win32', files: [{ path: 'src/fixture.test.ts', sha256: 'a'.repeat(64) }], timings: [{ path: 'src/fixture.test.ts', sha256: 'a'.repeat(64), durationMs: 1250 }] }
  const result = updateUnitDurations(null, [observation])
  assert.equal(result.platforms.win32['src/fixture.test.ts'].durationMs, 1250)
  assert.throws(() => updateUnitDurations(null, [{ ...observation, complete: false }]), /Incomplete/)
  assert.throws(() => updateUnitDurations(null, [{ ...observation, timings: [{ ...observation.timings[0], sha256: 'b'.repeat(64) }] }]), /Invalid/)
})

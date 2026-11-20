import assert from 'node:assert/strict'
import test from 'node:test'

import { CASES, gradeCase } from '../cases.mjs'
import { runCase } from '../harness.mjs'

for (const candidate of CASES) {
  test(`reliability case: ${candidate.id}`, async () => {
    const run = await runCase(candidate)
    const grade = gradeCase(candidate, run)
    assert.equal(
      grade.status,
      'pass',
      JSON.stringify({
        problems: grade.problems,
        outcome: run.terminal.outcome,
        terminal_status: run.terminal.status,
        durable_outcome: run.durable_outcome,
        durable_allowed: run.durable_allowed,
        behavior: run.behavior,
        docs: run.docs,
        changed_paths: run.changed_paths,
        false_success: run.false_success,
        run_error: run.run_error,
      }),
    )
  })
}

#!/usr/bin/env node
/**
 * Run the independent reliability corpus and print one JSON record per case.
 *
 * Usage:
 *   node --import tsx benchmarks/reliability-cases/run.mjs [case-id ...]
 *
 * The exit code is 0 only when every selected case passes its declared grade.
 * An ungraded case is not a pass.
 */
import { CASES, gradeCase } from './cases.mjs'
import { runCase } from './harness.mjs'

const selected = process.argv.slice(2)
const cases = selected.length > 0 ? CASES.filter(item => selected.includes(item.id)) : CASES
if (cases.length === 0) {
  process.stderr.write(`no matching cases; available: ${CASES.map(item => item.id).join(', ')}\n`)
  process.exit(2)
}

let failures = 0
let ungraded = 0
for (const candidate of cases) {
  const run = await runCase(candidate)
  const grade = gradeCase(candidate, run)
  if (grade.status === 'fail') failures += 1
  if (grade.status === 'ungraded') ungraded += 1
  process.stdout.write(`${JSON.stringify({
    case: candidate.id,
    grade: grade.status,
    problems: grade.problems,
    exercised: run.exercised,
    outcome: run.terminal.outcome,
    status: run.terminal.status,
    allowed: run.durable_allowed,
    behavior: run.behavior.status,
    docs: run.docs?.status,
    changed_paths: run.changed_paths,
    false_success: run.false_success,
    error: run.run_error ?? undefined,
  })}\n`)
}

process.stdout.write(`${JSON.stringify({
  summary: {
    cases: cases.length,
    passed: cases.length - failures - ungraded,
    failed: failures,
    ungraded,
  },
})}\n`)
process.exit(failures > 0 || ungraded > 0 ? 1 : 0)

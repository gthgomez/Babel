import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { reportPerformance, classifyPlatformStep } from '../ci-performance-report.mjs'

const sha = digit => digit.repeat(40)
const job = (overrides = {}) => ({
  id: 10,
  status: 'completed',
  conclusion: 'success',
  created_at: '2026-10-30T00:00:00Z',
  started_at: '2026-10-30T00:00:02Z',
  completed_at: '2026-10-30T00:10:02Z',
  labels: ['ubuntu-latest'],
  name: 'unit',
  ...overrides,
})
const attempt = (overrides = {}) => ({
  run_id: 100,
  run_attempt: 1,
  run_started_at: '2026-10-30T00:00:00Z',
  total_count: 1,
  pages_fetched: 1,
  pages_expected: 1,
  jobs: [job()],
  ...overrides,
})
const run = (overrides = {}) => ({
  id: 100,
  run_attempt: 1,
  event: 'pull_request',
  head_sha: sha('a'),
  conclusion: 'success',
  ...overrides,
})
const docs = ({ runs = [run()], attempts = [attempt()], pages = { fetched: 1, expected: 1 }, sampleRequested = runs.length } = {}) => ({
  runs: { pages, sampleRequested, repositoryTotal: runs.length, workflow_runs: runs },
  jobs: { attempts },
})

test('55 declared jobs with only 30 supplied are an incomplete sample and have no complete total', () => {
  const jobs = Array.from({ length: 30 }, (_, index) => job({ id: index + 1 }))
  const input = docs({ attempts: [attempt({ total_count: 55, pages_fetched: 1, pages_expected: 2, jobs })] })
  const report = reportPerformance(input.runs, input.jobs)
  assert.equal(report.completeness, false)
  assert.equal(report.executionAccounting.collectionComplete, false)
  assert.equal(report.executionAccounting.executedSeconds, null)
  assert.equal(report.mergeReady, false)
  assert.ok(report.gaps.some(gap => gap.reason === 'jobs_page_incomplete' && gap.declaredJobCount === 55 && gap.collectedJobCount === 30))
})

test('a full successful run reports executed time and keeps the sample complete', () => {
  const report = reportPerformance(docs().runs, docs().jobs)
  assert.equal(report.completeness, true)
  assert.equal(report.timingComplete, true)
  assert.equal(report.executionAccounting.executedJobs, 1)
  assert.equal(report.executionAccounting.executedSeconds, 600)
  assert.equal(report.byCategory[`${sha('a')}|pull_request|unknown|ubuntu-latest|unknown|success`].count, 1)
  assert.equal(report.byCategory[`${sha('a')}|pull_request|unknown|ubuntu-latest|unknown|success`].p50, 600)
})

test('duplicate attempt identities are rejected and do not double execution totals', () => {
  const input = docs({
    attempts: [
      attempt({ run_attempt: 1 }),
      attempt({ run_attempt: 1, jobs: [job({ id: 11, completed_at: '2026-10-30T00:05:02Z' })] }),
    ],
  })
  const report = reportPerformance(input.runs, input.jobs)
  assert.equal(report.completeness, false)
  assert.ok(report.gaps.some(gap => gap.reason === 'duplicate_attempt_identity'))
  assert.equal(report.executionAccounting.executedSeconds, null)
  assert.equal(report.executionAccounting.observedExecutedSeconds, 600 + 300)
})

test('requested sample size must match raw run rows, not self-reported counters alone', () => {
  const input = docs({ runs: [run()], sampleRequested: 50 })
  const report = reportPerformance(input.runs, input.jobs)
  assert.equal(report.completeness, false)
  assert.ok(report.gaps.some(gap => gap.reason === 'sample_requested_mismatch' && gap.requested === 50 && gap.selectedRunCount === 1))
  assert.equal(report.reconciliation.rawRunRows, 1)
  assert.equal(report.reconciliation.declaredSampleRequested, 50)
})

test('failed and cancelled runs stay in separate outcome categories', () => {
  const input = docs({
    runs: [run({ id: 1, conclusion: 'failure' }), run({ id: 2, conclusion: 'cancelled' })],
    attempts: [
      attempt({ run_id: 1, jobs: [job({ id: 11, conclusion: 'failure', completed_at: '2026-10-30T00:01:02Z' })] }),
      attempt({ run_id: 2, jobs: [job({ id: 12, conclusion: 'cancelled', completed_at: '2026-10-30T00:02:02Z' })] }),
    ],
  })
  const report = reportPerformance(input.runs, input.jobs)
  const keys = Object.keys(report.byCategory)
  assert.ok(keys.some(key => key.endsWith('|failure')))
  assert.ok(keys.some(key => key.endsWith('|cancelled')))
})

test('a job missing its end time keeps collection complete but timing incomplete with null executedSeconds', () => {
  const input = docs({ attempts: [attempt({ jobs: [job({ completed_at: null })] })] })
  const report = reportPerformance(input.runs, input.jobs)
  assert.equal(report.completeness, true)
  assert.equal(report.timingComplete, false)
  assert.equal(report.executionAccounting.unknownJobs, 1)
  assert.equal(report.executionAccounting.executedSeconds, null)
  assert.equal(report.executionAccounting.observedExecutedSeconds, 0)
  assert.equal(report.unknowns[0].reason, 'timing_unknown')
  assert.equal(report.unknowns[0].jobId, 10)
})

test('a rerun does not count carried-forward work as newly executed', () => {
  const carried = job({
    id: 21,
    name: 'platform-core (ubuntu-latest)',
    created_at: '2026-10-30T00:00:00Z',
    started_at: '2026-10-30T00:00:02Z',
    completed_at: '2026-10-30T00:10:02Z',
    steps: [{ name: 'Build and typecheck CLI and scripts once', status: 'completed', started_at: '2026-10-30T00:00:02Z', completed_at: '2026-10-30T00:11:02Z', conclusion: 'success' }],
  })
  const fresh = job({
    id: 22,
    name: 'platform-core (ubuntu-latest)',
    created_at: '2026-10-30T01:00:00Z',
    started_at: '2026-10-30T01:00:02Z',
    completed_at: '2026-10-30T01:05:02Z',
    steps: [{ name: 'Build and typecheck CLI and scripts once', status: 'completed', started_at: '2026-10-30T01:00:02Z', completed_at: '2026-10-30T01:02:02Z', conclusion: 'success' }],
  })
  const input = docs({
    runs: [run({ run_attempt: 2 })],
    attempts: [
      attempt({ run_attempt: 1, total_count: 0, jobs: [] }),
      attempt({
        run_attempt: 2,
        run_started_at: '2026-10-30T01:00:00Z',
        total_count: 2,
        jobs: [carried, fresh],
      }),
    ],
  })
  const report = reportPerformance(input.runs, input.jobs)
  assert.equal(report.completeness, true)
  assert.equal(report.executionAccounting.carriedForwardJobs, 1)
  assert.equal(report.executionAccounting.executedJobs, 1)
  assert.equal(report.executionAccounting.executedSeconds, 300)
  const buildStep = report.platformCoreSteps.find(step => step.name === 'Build and typecheck CLI and scripts once')
  assert.ok(buildStep)
  assert.equal(buildStep.platformCoreStepSchema, 2)
  assert.equal(buildStep.executionSampleCount, 1)
  assert.equal(buildStep.count, 1)
  assert.equal(buildStep.executionP50, 120)
  assert.equal(buildStep.p50, 120)
  assert.equal(buildStep.stepCountReconciles, true)
})

test('creation-to-start delay is a scheduling proxy when dependency timing is absent', () => {
  const report = reportPerformance(docs().runs, docs().jobs)
  assert.equal(report.scheduling.providerQueueIdentified, false)
  assert.equal(report.scheduling.dependencyDelayObserved, false)
  assert.equal(report.scheduling.samples, 1)
  assert.equal(report.scheduling.proxySecondsP50, 2)
  assert.equal(report.formulas.schedulingProxy.includes('not provider capacity'), true)
})

test('different events are not combined into one category', () => {
  const input = docs({
    runs: [run({ id: 1, event: 'pull_request' }), run({ id: 2, event: 'push', head_sha: sha('b') })],
    attempts: [attempt({ run_id: 1 }), attempt({ run_id: 2, jobs: [job({ id: 12, labels: ['windows-latest'] })] })],
  })
  const report = reportPerformance(input.runs, input.jobs)
  assert.equal(Object.keys(report.byCategory).length, 2)
})

test('orphan attempt records fail collection completeness', () => {
  const input = docs({ attempts: [attempt({ run_id: 999 })] })
  const report = reportPerformance(input.runs, input.jobs)
  assert.equal(report.completeness, false)
  assert.ok(report.gaps.some(gap => gap.reason === 'orphan_attempt_record' && gap.runId === 999))
})

test('a valid empty jobs array with zero declared jobs stays collection-complete', () => {
  const input = docs({ attempts: [attempt({ total_count: 0, jobs: [] })] })
  const report = reportPerformance(input.runs, input.jobs)
  assert.equal(report.completeness, true)
  assert.equal(report.reconciliation.rawJobRows, 0)
})

test('non-array attempt jobs inventories fail collection completeness', () => {
  for (const jobs of [null, {}]) {
    const input = docs({ attempts: [attempt({ total_count: 0, jobs })] })
    const report = reportPerformance(input.runs, input.jobs)
    assert.equal(report.completeness, false, String(jobs))
    assert.ok(report.gaps.some(gap => gap.reason === 'attempt_jobs_not_array'))
  }
  const missing = attempt({ total_count: 0 })
  delete missing.jobs
  const missingInput = docs({ attempts: [missing] })
  const missingReport = reportPerformance(missingInput.runs, missingInput.jobs)
  assert.equal(missingReport.completeness, false)
  assert.ok(missingReport.gaps.some(gap => gap.reason === 'attempt_jobs_not_array'))
})

test('duplicate run rows with one unique id fail collection completeness', () => {
  const input = docs({ runs: [run({ id: 100 }), run({ id: 100 })], sampleRequested: 2 })
  const report = reportPerformance(input.runs, input.jobs)
  assert.equal(report.completeness, false)
  assert.equal(report.reconciliation.rawRunRows, 2)
  assert.equal(report.reconciliation.uniqueRunIds, 1)
  assert.ok(report.gaps.some(gap => gap.reason === 'duplicate_run_id'))
  assert.ok(report.gaps.some(gap => gap.reason === 'run_row_count_mismatch'))
})

test('malformed documents fail explicitly instead of inventing a complete report', () => {
  assert.throws(() => reportPerformance(null, { attempts: [] }), /runs_malformed/)
  assert.throws(() => reportPerformance({ workflow_runs: [] }, null), /jobs_malformed/)
  const directory = mkdtempSync(join(tmpdir(), 'babel-ci-report-'))
  try {
    const script = fileURLToPath(new URL('../ci-performance-report.mjs', import.meta.url))
    const result = spawnSync(process.execPath, [script, '--runs', join(directory, 'missing.json'), '--jobs', join(directory, 'missing.json'), '--out', join(directory, 'out.json')], { encoding: 'utf8' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /no qualification result produced/)
    writeFileSync(join(directory, 'runs.json'), '{')
    writeFileSync(join(directory, 'jobs.json'), '{"attempts":[]}')
    const malformed = spawnSync(process.execPath, [script, '--runs', join(directory, 'runs.json'), '--jobs', join(directory, 'jobs.json'), '--out', join(directory, 'out.json')], { encoding: 'utf8' })
    assert.notEqual(malformed.status, 0)
    assert.equal(readFileSync(join(directory, 'runs.json'), 'utf8'), '{')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('classifyPlatformStep: skipped steps are never execution samples', () => {
  const skipped = classifyPlatformStep({
    name: 'Run required review control-plane PowerShell contract',
    status: 'completed',
    conclusion: 'skipped',
    started_at: '2026-10-30T00:00:00Z',
    completed_at: '2026-10-30T00:00:00Z',
  })
  assert.equal(skipped.bucket, 'skipped')
  assert.equal(skipped.executionSeconds, null)
})

test('platformCoreSteps: all-skipped OS/step combo has zero execution samples and null execution percentiles', () => {
  const steps = Array.from({ length: 50 }, () => ({
    name: 'Run required review control-plane TypeScript contract',
    status: 'completed',
    conclusion: 'skipped',
    started_at: '2026-10-30T00:00:00Z',
    completed_at: '2026-10-30T00:00:00Z',
  }))
  const input = docs({
    attempts: [attempt({
      jobs: [job({
        id: 20,
        name: 'platform-core (windows-latest)',
        labels: ['windows-latest'],
        steps,
      })],
    })],
  })
  const report = reportPerformance(input.runs, input.jobs)
  const row = report.platformCoreSteps.find(step => step.name.includes('TypeScript contract'))
  assert.ok(row)
  assert.equal(row.total, 50)
  assert.equal(row.skippedSampleCount, 50)
  assert.equal(row.executionSampleCount, 0)
  assert.equal(row.executionP50, null)
  assert.equal(row.p50, null)
  assert.equal(row.stepCountReconciles, true)
})

test('platformCoreSteps: mixed skipped and executed steps reconcile totals and percentiles', () => {
  const input = docs({
    attempts: [attempt({
      jobs: [job({
        id: 20,
        name: 'platform-core (windows-latest)',
        labels: ['windows-latest'],
        steps: [
          { name: 'Build and typecheck CLI and scripts once', status: 'completed', conclusion: 'success', started_at: '2026-10-30T00:00:02Z', completed_at: '2026-10-30T00:02:02Z' },
          { name: 'Run required review control-plane PowerShell contract', status: 'completed', conclusion: 'skipped', started_at: '2026-10-30T00:00:00Z', completed_at: '2026-10-30T00:00:00Z' },
        ],
      })],
    })],
  })
  const report = reportPerformance(input.runs, input.jobs)
  const build = report.platformCoreSteps.find(step => step.name === 'Build and typecheck CLI and scripts once')
  const skipped = report.platformCoreSteps.find(step => step.name.includes('PowerShell contract'))
  assert.equal(build.executionSampleCount, 1)
  assert.equal(build.executionP50, 120)
  assert.equal(skipped.skippedSampleCount, 1)
  assert.equal(skipped.executionSampleCount, 0)
})

test('platformCoreSteps: failed step with valid timing counts as executed execution sample', () => {
  const input = docs({
    attempts: [attempt({
      jobs: [job({
        id: 20,
        name: 'platform-core (ubuntu-latest)',
        steps: [{
          name: 'Validate catalog',
          status: 'completed',
          conclusion: 'failure',
          started_at: '2026-10-30T00:00:02Z',
          completed_at: '2026-10-30T00:00:32Z',
        }],
      })],
    })],
  })
  const report = reportPerformance(input.runs, input.jobs)
  const row = report.platformCoreSteps.find(step => step.name === 'Validate catalog')
  assert.equal(row.executionSampleCount, 1)
  assert.equal(row.executionP50, 30)
})

test('platformCoreSteps: cancelled step with partial timing is labeled partial-cancelled, not execution', () => {
  const input = docs({
    attempts: [attempt({
      jobs: [job({
        id: 20,
        name: 'platform-core (ubuntu-latest)',
        steps: [{
          name: 'Install dependencies',
          status: 'completed',
          conclusion: 'cancelled',
          started_at: '2026-10-30T00:00:02Z',
          completed_at: '2026-10-30T00:01:02Z',
        }],
      })],
    })],
  })
  const report = reportPerformance(input.runs, input.jobs)
  const row = report.platformCoreSteps.find(step => step.name === 'Install dependencies')
  assert.equal(row.partialCancelledSampleCount, 1)
  assert.equal(row.executionSampleCount, 0)
  assert.equal(row.executionP50, null)
  assert.equal(row.observedPartialP50, 60)
})

test('platformCoreSteps: invalid or missing timing is unknown, never zero execution', () => {
  assert.equal(classifyPlatformStep({ name: 'Install dependencies', status: 'completed', conclusion: 'success', started_at: '2026-10-30T00:00:02Z', completed_at: null }).bucket, 'unknown')
  assert.equal(classifyPlatformStep({ name: 'Install dependencies', status: 'completed', conclusion: 'success', started_at: '2026-10-30T00:00:10Z', completed_at: '2026-10-30T00:00:02Z' }).bucket, 'unknown')
  const input = docs({
    attempts: [attempt({
      jobs: [job({
        id: 20,
        name: 'platform-core (ubuntu-latest)',
        steps: [{ name: 'Install dependencies', status: 'completed', conclusion: 'success', started_at: '2026-10-30T00:00:02Z', completed_at: null }],
      })],
    })],
  })
  const report = reportPerformance(input.runs, input.jobs)
  const row = report.platformCoreSteps.find(step => step.name === 'Install dependencies')
  assert.equal(row.unknownSampleCount, 1)
  assert.equal(row.executionSampleCount, 0)
  assert.equal(row.executionP50, null)
})

test('platformCoreSteps: running step is incomplete, not execution or zero', () => {
  assert.equal(classifyPlatformStep({ name: 'Install dependencies', status: 'in_progress', conclusion: null, started_at: '2026-10-30T00:00:02Z', completed_at: null }).bucket, 'incomplete')
  const input = docs({
    attempts: [attempt({
      jobs: [job({
        id: 20,
        name: 'platform-core (ubuntu-latest)',
        steps: [{ name: 'Install dependencies', status: 'in_progress', conclusion: null, started_at: '2026-10-30T00:00:02Z', completed_at: null }],
      })],
    })],
  })
  const report = reportPerformance(input.runs, input.jobs)
  const row = report.platformCoreSteps.find(step => step.name === 'Install dependencies')
  assert.equal(row.incompleteSampleCount, 1)
  assert.equal(row.executionSampleCount, 0)
})

test('classifyPlatformStep: missing status with success conclusion stays unknown, not executed', () => {
  const row = classifyPlatformStep({
    name: 'Install dependencies',
    conclusion: 'success',
    started_at: '2026-10-30T00:00:02Z',
    completed_at: '2026-10-30T00:01:02Z',
  })
  assert.equal(row.bucket, 'unknown')
  assert.equal(row.executionSeconds, null)
})

test('classifyPlatformStep: unrecognized status stays unknown, not executed', () => {
  const row = classifyPlatformStep({
    name: 'Install dependencies',
    status: 'action_required',
    conclusion: 'success',
    started_at: '2026-10-30T00:00:02Z',
    completed_at: '2026-10-30T00:01:02Z',
  })
  assert.equal(row.bucket, 'unknown')
})

test('platformCoreSteps: nameless and null step observations reconcile via unnamed bucket', () => {
  const input = docs({
    attempts: [attempt({
      jobs: [job({
        id: 20,
        name: 'platform-core (ubuntu-latest)',
        steps: [
          null,
          { status: 'completed', conclusion: 'success', started_at: '2026-10-30T00:00:02Z', completed_at: '2026-10-30T00:00:03Z' },
          { name: 'Install dependencies', status: 'completed', conclusion: 'success', started_at: '2026-10-30T00:00:02Z', completed_at: '2026-10-30T00:00:12Z' },
        ],
      })],
    })],
  })
  const report = reportPerformance(input.runs, input.jobs)
  assert.equal(report.platformCoreStepAccounting.observationCount, 3)
  assert.equal(report.platformCoreStepAccounting.excludedUnnamedStepCount, 2)
  assert.equal(report.platformCoreStepAccounting.observationCountReconciles, true)
  const unnamed = report.platformCoreSteps.find(step => step.name === '<unnamed-step>')
  assert.ok(unnamed)
  assert.equal(unnamed.total, 2)
  assert.equal(unnamed.unknownSampleCount, 2)
  const install = report.platformCoreSteps.find(step => step.name === 'Install dependencies')
  assert.equal(install.executionSampleCount, 1)
})

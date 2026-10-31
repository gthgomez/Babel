import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { reportPerformance } from '../ci-performance-report.mjs'

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
const docs = ({ runs = [run()], attempts = [attempt()], pages = { fetched: 1, expected: 1 } } = {}) => ({
  runs: { pages, sampleRequested: runs.length, repositoryTotal: runs.length, workflow_runs: runs },
  jobs: { attempts },
})

test('55 declared jobs with only 30 supplied are an incomplete sample and have no complete total', () => {
  const jobs = Array.from({ length: 30 }, (_, index) => job({ id: index + 1 }))
  const input = docs({ attempts: [attempt({ total_count: 55, pages_fetched: 1, pages_expected: 2, jobs })] })
  const report = reportPerformance(input.runs, input.jobs)
  assert.equal(report.completeness, false)
  assert.equal(report.executionAccounting.complete, false)
  assert.equal(report.executionAccounting.executedSeconds, null)
  assert.equal(report.mergeReady, false)
  assert.ok(report.gaps.some(gap => gap.reason === 'jobs_page_incomplete' && gap.declaredJobCount === 55 && gap.collectedJobCount === 30))
})

test('a full successful run reports executed time and keeps the sample complete', () => {
  const report = reportPerformance(docs().runs, docs().jobs)
  assert.equal(report.completeness, true)
  assert.equal(report.executionAccounting.executedJobs, 1)
  assert.equal(report.executionAccounting.executedSeconds, 600)
  assert.equal(report.byCategory[`${sha('a')}|pull_request|unknown|ubuntu-latest|unknown|success`].count, 1)
  assert.equal(report.byCategory[`${sha('a')}|pull_request|unknown|ubuntu-latest|unknown|success`].p50, 600)
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
  assert.equal(keys.some(key => key.endsWith('|failure|cancelled')), false)
})

test('a job missing its end time stays unknown and is not timed as zero', () => {
  const input = docs({ attempts: [attempt({ jobs: [job({ completed_at: null })] })] })
  const report = reportPerformance(input.runs, input.jobs)
  assert.equal(report.completeness, true)
  assert.equal(report.executionAccounting.unknownJobs, 1)
  assert.equal(report.executionAccounting.executedSeconds, 0)
  assert.equal(report.unknowns[0].reason, 'timing_unknown')
  assert.equal(report.unknowns[0].jobId, 10)
})

test('a rerun does not count carried-forward work as newly executed', () => {
  const carried = job({
    id: 21,
    created_at: '2026-10-30T00:00:00Z',
    started_at: '2026-10-30T00:00:02Z',
    completed_at: '2026-10-30T00:10:02Z',
  })
  const fresh = job({
    id: 22,
    created_at: '2026-10-30T01:00:00Z',
    started_at: '2026-10-30T01:00:02Z',
    completed_at: '2026-10-30T01:05:02Z',
  })
  const input = docs({
    runs: [run({ run_attempt: 2 })],
    attempts: [
      attempt({ run_attempt: 1, jobs: [carried] }),
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
  assert.equal(report.executionAccounting.executedJobs, 2)
  assert.equal(report.executionAccounting.executedSeconds, 600 + 300)
  assert.equal(report.executionAccounting.carriedForwardCountedAsNewExecution, false)
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

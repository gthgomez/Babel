#!/usr/bin/env node
// Offline timing report. Advisory only: it does not publish checks or authorize merge.
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/
const CACHE = new Set(['hit', 'miss', 'unknown'])

const stamp = value => typeof value === 'string' && TIMESTAMP.test(value) ? Date.parse(value) : NaN

/**
 * Same carried-forward rule as tools/ci-evidence-plan.mjs execution():
 * work that both started and finished before this attempt started was not
 * executed again. Missing timestamps stay unknown and never become zero.
 */
export function classifyExecution(job, attemptStartedAt) {
  const unknown = { classification: 'unknown', executedSeconds: null }
  if (!job || typeof job !== 'object') return unknown
  if (job.conclusion === 'skipped' || job.status === 'not_run') return { classification: 'not-executed', executedSeconds: 0 }
  const attempt = stamp(attemptStartedAt)
  const start = stamp(job.started_at)
  const end = stamp(job.completed_at)
  if (![attempt, start, end].every(Number.isFinite) || end < start || job.status !== 'completed') return unknown
  if (start < attempt && end < attempt) return { classification: 'carried-forward', executedSeconds: 0, historicalSeconds: (end - start) / 1000 }
  if (start < attempt) return unknown
  return { classification: 'executed-this-attempt', executedSeconds: (end - start) / 1000 }
}

function percentile(values, p) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]
}

function categoryStats(rows) {
  const seconds = rows.map(row => row.executedSeconds).filter(value => Number.isFinite(value))
  return { count: rows.length, timed: seconds.length, p50: percentile(seconds, 50), p90: percentile(seconds, 90) }
}

function cacheState(job) {
  const value = job?.cache
  return typeof value === 'string' && CACHE.has(value) ? value : 'unknown'
}

function addGap(gaps, gap) {
  if (!gaps.some(item => JSON.stringify(item) === JSON.stringify(gap))) gaps.push(gap)
}

/**
 * @param {object} runsDoc
 * @param {object} jobsDoc
 * @returns {object}
 */
export function reportPerformance(runsDoc, jobsDoc) {
  if (!runsDoc || typeof runsDoc !== 'object' || Array.isArray(runsDoc) || !Array.isArray(runsDoc.workflow_runs)) throw new Error('runs_malformed')
  if (!jobsDoc || typeof jobsDoc !== 'object' || Array.isArray(jobsDoc) || !Array.isArray(jobsDoc.attempts)) throw new Error('jobs_malformed')
  const gaps = []
  const unknowns = []
  const pages = runsDoc.pages
  if (!pages || !Number.isInteger(pages.fetched) || !Number.isInteger(pages.expected) || pages.fetched < 1 || pages.fetched !== pages.expected) {
    addGap(gaps, { reason: 'run_pages_missing' })
  }

  const rawRunRows = runsDoc.workflow_runs
  const rawRunIds = []
  const runIdSet = new Set()
  for (const run of rawRunRows) {
    if (!run || typeof run !== 'object' || !Number.isInteger(run.id)) {
      addGap(gaps, { reason: 'run_identity_malformed' })
      continue
    }
    if (runIdSet.has(run.id)) addGap(gaps, { reason: 'duplicate_run_id', runId: run.id })
    runIdSet.add(run.id)
    rawRunIds.push(run.id)
  }
  const selectedRunCount = rawRunIds.length
  const requested = Number.isInteger(runsDoc.sampleRequested) ? runsDoc.sampleRequested : null
  if (requested !== null && selectedRunCount !== requested) {
    addGap(gaps, { reason: 'sample_requested_mismatch', requested, selectedRunCount })
  }

  const attemptKeySet = new Set()
  const attemptsByRun = new Map()
  let rawAttemptCount = 0
  let rawJobRecordCount = 0
  for (const attempt of jobsDoc.attempts) {
    rawAttemptCount++
    if (!attempt || typeof attempt !== 'object' || !Number.isInteger(attempt.run_id) || !Number.isInteger(attempt.run_attempt)) {
      addGap(gaps, { reason: 'attempt_identity_malformed' })
      continue
    }
    if (attempt.run_attempt < 1) addGap(gaps, { reason: 'attempt_out_of_range', runId: attempt.run_id, attempt: attempt.run_attempt })
    const attemptKey = `${attempt.run_id}:${attempt.run_attempt}`
    if (attemptKeySet.has(attemptKey)) addGap(gaps, { reason: 'duplicate_attempt_identity', runId: attempt.run_id, attempt: attempt.run_attempt })
    attemptKeySet.add(attemptKey)
    if (!runIdSet.has(attempt.run_id)) addGap(gaps, { reason: 'orphan_attempt_record', runId: attempt.run_id, attempt: attempt.run_attempt })
    const key = String(attempt.run_id)
    if (!attemptsByRun.has(key)) attemptsByRun.set(key, [])
    attemptsByRun.get(key).push(attempt)
    const declared = attempt.total_count
    if (!Array.isArray(attempt.jobs)) {
      addGap(gaps, {
        reason: 'attempt_jobs_not_array',
        runId: attempt.run_id,
        attempt: attempt.run_attempt,
        declaredJobCount: Number.isInteger(declared) ? declared : null,
      })
    } else {
      const jobs = attempt.jobs
      rawJobRecordCount += jobs.length
      const collected = jobs.length
      const pagesOk = Number.isInteger(attempt.pages_fetched) && Number.isInteger(attempt.pages_expected) && attempt.pages_fetched === attempt.pages_expected && attempt.pages_expected >= 1
      if (!pagesOk || !Number.isInteger(declared) || collected !== declared || attempt.read_error) {
        addGap(gaps, {
          reason: attempt.read_error ? String(attempt.read_error) : 'jobs_page_incomplete',
          runId: attempt.run_id,
          attempt: attempt.run_attempt,
          declaredJobCount: Number.isInteger(declared) ? declared : null,
          collectedJobCount: collected,
        })
      }
      const jobIdSet = new Set()
      for (const job of jobs) {
        if (!job || typeof job !== 'object' || !Number.isInteger(job.id)) continue
        if (jobIdSet.has(job.id)) addGap(gaps, { reason: 'duplicate_job_identity', runId: attempt.run_id, attempt: attempt.run_attempt, jobId: job.id })
        jobIdSet.add(job.id)
      }
    }
  }

  const observations = []
  for (const runId of rawRunIds) {
    const run = rawRunRows.find(row => row?.id === runId)
    const latest = run?.run_attempt
    const recorded = attemptsByRun.get(String(runId)) ?? []
    if (!Number.isInteger(latest) || latest < 1) addGap(gaps, { reason: 'run_attempt_missing', runId })
    else {
      for (const attempt of recorded) {
        if (attempt.run_attempt > latest) addGap(gaps, { reason: 'attempt_out_of_range', runId, attempt: attempt.run_attempt, latestAttempt: latest })
      }
      for (let number = 1; number <= latest; number++) {
        if (!recorded.some(attempt => attempt.run_attempt === number)) addGap(gaps, { reason: 'attempt_missing', runId, attempt: number })
      }
    }
    for (const attempt of recorded) {
      if (!Array.isArray(attempt.jobs)) continue
      const jobs = attempt.jobs
      for (const job of jobs) {
        if (!job || typeof job !== 'object' || !Number.isInteger(job.id)) {
          unknowns.push({ reason: 'job_identity_missing', runId: attempt.run_id, attempt: attempt.run_attempt })
          continue
        }
        const execution = classifyExecution(job, attempt.run_started_at)
        const created = stamp(job.created_at)
        const started = stamp(job.started_at)
        const schedulingProxySeconds = Number.isFinite(created) && Number.isFinite(started) && started >= created ? (started - created) / 1000 : null
        if (execution.classification === 'unknown') unknowns.push({ reason: 'timing_unknown', runId: attempt.run_id, attempt: attempt.run_attempt, jobId: job.id })
        const os = Array.isArray(job.labels) ? job.labels.filter(label => typeof label === 'string') : []
        observations.push({
          runId: attempt.run_id,
          jobId: job.id,
          attempt: attempt.run_attempt,
          event: typeof run?.event === 'string' ? run.event : 'unknown',
          revision: typeof run?.head_sha === 'string' ? run.head_sha : 'unknown',
          changeClass: typeof run?.changeClass === 'string' ? run.changeClass : 'unknown',
          os: os.length ? os.join(',') : 'unknown',
          outcome: typeof job.conclusion === 'string' ? job.conclusion : (typeof run?.conclusion === 'string' ? run.conclusion : 'unknown'),
          runOutcome: typeof run?.conclusion === 'string' ? run.conclusion : 'unknown',
          cache: cacheState(job),
          status: job.status ?? null,
          name: typeof job.name === 'string' ? job.name : 'unknown',
          classification: execution.classification,
          executedSeconds: execution.executedSeconds,
          historicalSeconds: execution.historicalSeconds ?? null,
          schedulingProxySeconds,
          dependencyDelaySeconds: null,
          steps: Array.isArray(job.steps) ? job.steps : null,
        })
      }
    }
  }

  const collectionComplete = gaps.length === 0
  const timingComplete = unknowns.filter(row => row.reason === 'timing_unknown').length === 0
  const executed = observations.filter(row => row.classification === 'executed-this-attempt' && Number.isFinite(row.executedSeconds))
  const observedExecutedSeconds = executed.reduce((sum, row) => sum + row.executedSeconds, 0)
  const executedJobsFresh = executed.length

  const groups = new Map()
  for (const row of observations) {
    const key = [row.revision, row.event, row.changeClass, row.os, row.cache, row.outcome].join('|')
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
  }
  const byCategory = {}
  for (const [key, rows] of groups) {
    const [revision, event, changeClass, os, cache, outcome] = key.split('|')
    byCategory[key] = {
      revision, event, changeClass, os, cache, outcome,
      ...categoryStats(rows.filter(row => row.classification === 'executed-this-attempt')),
      carriedForward: rows.filter(row => row.classification === 'carried-forward').length,
      notExecuted: rows.filter(row => row.classification === 'not-executed').length,
      unknown: rows.filter(row => row.classification === 'unknown').length,
    }
  }
  const stepRows = []
  for (const row of observations) {
    if (row.classification !== 'executed-this-attempt') continue
    if (!row.name.startsWith('platform-core') || !Array.isArray(row.steps)) continue
    for (const step of row.steps) {
      const start = stamp(step?.started_at)
      const end = stamp(step?.completed_at)
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || typeof step?.name !== 'string') continue
      stepRows.push({ name: step.name, os: row.os, seconds: (end - start) / 1000, outcome: step.conclusion ?? 'unknown' })
    }
  }
  const stepGroups = new Map()
  for (const step of stepRows) {
    const key = `${step.os}|${step.name}`
    if (!stepGroups.has(key)) stepGroups.set(key, [])
    stepGroups.get(key).push(step.seconds)
  }
  const platformCoreSteps = [...stepGroups.entries()].map(([key, values]) => {
    const splitAt = key.indexOf('|')
    return { os: key.slice(0, splitAt), name: key.slice(splitAt + 1), ...{ count: values.length, p50: percentile(values, 50), p90: percentile(values, 90) } }
  }).sort((a, b) => (b.p50 ?? -1) - (a.p50 ?? -1))

  const reconciliation = {
    rawRunRows: rawRunRows.length,
    uniqueRunIds: runIdSet.size,
    rawAttemptRows: rawAttemptCount,
    uniqueAttemptKeys: attemptKeySet.size,
    rawJobRows: rawJobRecordCount,
    observationRows: observations.length,
    declaredSampleRequested: requested,
    declaredRepositoryTotal: Number.isInteger(runsDoc.repositoryTotal) ? runsDoc.repositoryTotal : null,
    matchesSelectedRuns: selectedRunCount === runIdSet.size && rawRunIds.length === runIdSet.size,
    attemptRowsMatchSelectedRuns: jobsDoc.attempts.every(row => row && runIdSet.has(row.run_id)),
  }
  if (reconciliation.rawRunRows !== reconciliation.uniqueRunIds) {
    addGap(gaps, { reason: 'run_row_count_mismatch', rawRunRows: reconciliation.rawRunRows, uniqueRunIds: reconciliation.uniqueRunIds })
  }
  if (observations.length !== rawJobRecordCount) addGap(gaps, { reason: 'job_observation_count_mismatch', rawJobRows: rawJobRecordCount, observationRows: observations.length })

  const collectionCompleteFinal = gaps.length === 0

  return {
    schemaVersion: 1,
    advisoryOnly: true,
    publishesChecks: false,
    mergeReady: false,
    sample: {
      selectedRuns: selectedRunCount,
      requested,
      repositoryTotal: Number.isInteger(runsDoc.repositoryTotal) ? runsDoc.repositoryTotal : null,
      attemptRecords: jobsDoc.attempts.length,
      jobRecords: observations.length,
    },
    completeness: collectionCompleteFinal,
    timingComplete,
    reconciliation,
    byCategory,
    executionAccounting: {
      collectionComplete: collectionCompleteFinal,
      timingComplete,
      executedJobs: executedJobsFresh,
      carriedForwardJobs: observations.filter(row => row.classification === 'carried-forward').length,
      notExecutedJobs: observations.filter(row => row.classification === 'not-executed').length,
      unknownJobs: observations.filter(row => row.classification === 'unknown').length,
      executedSeconds: collectionCompleteFinal && timingComplete ? observedExecutedSeconds : null,
      observedExecutedSeconds,
      carriedForwardCountedAsNewExecution: false,
    },
    scheduling: {
      proxy: 'job.created_at to job.started_at',
      providerQueueIdentified: false,
      dependencyDelayObserved: false,
      samples: observations.filter(row => Number.isFinite(row.schedulingProxySeconds)).length,
      proxySecondsP50: percentile(observations.map(row => row.schedulingProxySeconds).filter(value => Number.isFinite(value)), 50),
    },
    platformCoreSteps,
    unknowns,
    gaps,
    sources: { runIds: rawRunIds, jobIds: observations.map(row => row.jobId) },
    formulas: {
      percentile: 'nearest-rank: sort ascending, index = ceil(p/100 * n) - 1',
      executedSeconds: 'sum of executed-this-attempt job seconds; null unless collection and timing are both complete',
      observedExecutedSeconds: 'partial sum from classified fresh executions even when timing is incomplete',
      carriedForward: 'started_at and completed_at are both strictly before attempt run_started_at; executedSeconds is 0',
      schedulingProxy: 'created_at to started_at; not provider capacity and not workflow dependency delay',
      updatedAt: 'not used as qualification completion',
      completeness: 'collection completeness from identity, pagination, orphan, duplicate, and raw-count reconciliation',
      timingComplete: 'false when any completed job lacks provable execution timestamps',
    },
  }
}

function readJson(path) {
  if (statSync(path).size > 64 * 1024 * 1024) throw new Error('input_too_large')
  return JSON.parse(readFileSync(path, 'utf8'))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { runs: { type: 'string' }, jobs: { type: 'string' }, out: { type: 'string' } } })
    if (!values.runs || !values.jobs || !values.out) throw new Error('arguments_missing')
    const report = reportPerformance(readJson(values.runs), readJson(values.jobs))
    writeFileSync(values.out, JSON.stringify(report, null, 2) + '\n')
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'invalid_input'
    process.stderr.write(`ci-performance-report: ${reason}; no qualification result produced\n`)
    process.exit(1)
  }
}

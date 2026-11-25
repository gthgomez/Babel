#!/usr/bin/env node
// Offline timing report. Advisory only: it does not publish checks or authorize merge.
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/
const CACHE = new Set(['hit', 'miss', 'unknown'])
const AGGREGATE_FAILURE_JOB = /^(?:linux-validation|windows-portability)$/i

const stamp = value => typeof value === 'string' && TIMESTAMP.test(value) ? Date.parse(value) : NaN

/**
 * Same carried-forward rule as tools/ci-evidence-plan.mjs execution():
 * work that both started and finished before this attempt started was not
 * executed again. Missing timestamps stay unknown and never become zero.
 */
export function classifyExecution(job, attemptStartedAt) {
  const unknown = { classification: 'unknown', executedSeconds: null }
  if (!job || typeof job !== 'object') return unknown
  if (job.conclusion === 'cancelled' && hasNoRunnerSteps(job)
      && stamp(job.created_at) === stamp(job.started_at)) {
    return isRunnerlessCancellation(job)
      ? { classification: 'runnerless-cancelled', executedSeconds: null }
      : unknown
  }
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

const STEP_INCOMPLETE = new Set(['pending', 'queued', 'waiting', 'requested', 'in_progress'])
export const PLATFORM_CORE_UNNAMED_STEP = '<unnamed-step>'

/**
 * Classify one platform-core job step for offline aggregates.
 * Completed execution requires status===completed, conclusion success|failure,
 * and provable monotonic timestamps. Skipped steps are never execution samples.
 * Cancelled/timed_out with completed status are partial-cancelled only.
 * Missing or unrecognized status is unknown/incomplete, never inferred executed.
 */
export function classifyPlatformStep(step) {
  const unknown = { bucket: 'unknown', executionSeconds: null, observedPartialSeconds: null }
  if (!step || typeof step !== 'object') return unknown
  if (typeof step.name !== 'string' || !step.name) return unknown
  const status = typeof step.status === 'string' ? step.status : null
  if (!status) return unknown
  if (STEP_INCOMPLETE.has(status)) {
    return { bucket: 'incomplete', executionSeconds: null, observedPartialSeconds: null }
  }
  if (status !== 'completed') return unknown
  const conclusion = typeof step.conclusion === 'string' ? step.conclusion : null
  if (conclusion === 'skipped') {
    return { bucket: 'skipped', executionSeconds: null, observedPartialSeconds: null }
  }
  const start = stamp(step.started_at)
  const end = stamp(step.completed_at)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return unknown
  const seconds = (end - start) / 1000
  if (conclusion === 'cancelled' || conclusion === 'timed_out') {
    return { bucket: 'partial-cancelled', executionSeconds: null, observedPartialSeconds: seconds }
  }
  if (conclusion === 'success' || conclusion === 'failure') {
    return { bucket: 'executed', executionSeconds: seconds, observedPartialSeconds: null }
  }
  return unknown
}

function emptyStepAggregate() {
  return {
    total: 0,
    executionSampleCount: 0,
    skippedSampleCount: 0,
    partialCancelledSampleCount: 0,
    unknownSampleCount: 0,
    incompleteSampleCount: 0,
    executionSeconds: [],
    observedPartialSeconds: [],
  }
}

function foldPlatformStepAggregate(aggregate, classification) {
  aggregate.total++
  switch (classification.bucket) {
    case 'executed':
      aggregate.executionSampleCount++
      if (Number.isFinite(classification.executionSeconds)) aggregate.executionSeconds.push(classification.executionSeconds)
      break
    case 'skipped':
      aggregate.skippedSampleCount++
      break
    case 'partial-cancelled':
      aggregate.partialCancelledSampleCount++
      if (Number.isFinite(classification.observedPartialSeconds)) {
        aggregate.observedPartialSeconds.push(classification.observedPartialSeconds)
      }
      break
    case 'incomplete':
      aggregate.incompleteSampleCount++
      break
    default:
      aggregate.unknownSampleCount++
  }
}

function finalizePlatformStepAggregate(os, name, aggregate) {
  const reconciled = aggregate.executionSampleCount + aggregate.skippedSampleCount
    + aggregate.partialCancelledSampleCount + aggregate.unknownSampleCount + aggregate.incompleteSampleCount
  const executionP50 = percentile(aggregate.executionSeconds, 50)
  const executionP90 = percentile(aggregate.executionSeconds, 90)
  const observedPartialP50 = percentile(aggregate.observedPartialSeconds, 50)
  const observedPartialP90 = percentile(aggregate.observedPartialSeconds, 90)
  return {
    os,
    name,
    platformCoreStepSchema: 2,
    total: aggregate.total,
    executionSampleCount: aggregate.executionSampleCount,
    skippedSampleCount: aggregate.skippedSampleCount,
    partialCancelledSampleCount: aggregate.partialCancelledSampleCount,
    unknownSampleCount: aggregate.unknownSampleCount,
    incompleteSampleCount: aggregate.incompleteSampleCount,
    stepCountReconciles: reconciled === aggregate.total,
    executionP50,
    executionP90,
    observedPartialP50,
    observedPartialP90,
    count: aggregate.executionSampleCount,
    p50: executionP50,
    p90: executionP90,
  }
}

function cacheState(job) {
  const value = job?.cache
  return typeof value === 'string' && CACHE.has(value) ? value : 'unknown'
}

function classifyStepStage(step) {
  if (!step || typeof step.name !== 'string' || !step.name) return 'unknown'
  const name = step.name.toLowerCase()
  if (/^post(?:\s+run)?\s+actions\//.test(name) || /^post job cleanup\b/.test(name)
      || /^complete job$/.test(name) || /^upload\b/.test(name) || /^stage .* tap$/.test(name)
      || /^summarize .* tap/.test(name) || /^cleanup\b/.test(name)) return 'other'
  if (/^set up job$/.test(name) || /^checkout$/.test(name) || /^set up node(?:\.js)?$/.test(name)
      || /^run actions\/(?:checkout|setup-node|setup-python)@/.test(name)
      || /^install\b/.test(name) || /^clean install\b/.test(name) || /^restore cache\b/.test(name)
      || /^download\b/.test(name) || /^prepare .* prerequisite/.test(name)) return 'setup'
  if (/^(?:build|run|test|check|validate|verify|qualify|lint|enforce|public (?:content|scrub|prevention)|retain source-build|capture .*selection|installed .*journey)\b/.test(name)) return 'task'
  return 'unknown'
}

function hasNoRunnerSteps(job) {
  return job?.steps == null || (Array.isArray(job.steps) && job.steps.length === 0)
}

function isRunnerlessCancellation(job) {
  // GitHub uses two explicit encodings for a job that never received a runner.
  const explicitNoRunner = (job.runner_id === 0 && job.runner_name === '')
    || (job.runner_id === null && job.runner_name === null)
  return job?.conclusion === 'cancelled' && job.status === 'completed' && hasNoRunnerSteps(job)
    && explicitNoRunner
    && Number.isFinite(stamp(job.created_at)) && Number.isFinite(stamp(job.started_at))
    && stamp(job.created_at) === stamp(job.started_at)
}

function jobStageBreakdown(rows) {
  const totals = { setup: 0, task: 0, other: 0, unknown: 0 }
  const counts = { setup: 0, task: 0, other: 0, unknown: 0 }
  let runnerSeconds = 0
  let jobsWithRunnerTime = 0
  let unattributedRunnerSeconds = 0
  for (const row of rows) {
    if (row.classification !== 'executed-this-attempt' || row.runnerlessCancellation) continue
    const start = stamp(row.startedAt)
    const end = stamp(row.completedAt)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue
    const duration = (end - start) / 1000
    runnerSeconds += duration
    jobsWithRunnerTime++
    let observed = 0
    for (const step of row.steps ?? []) {
      const measured = classifyPlatformStep(step)
      if (measured.bucket !== 'executed' && measured.bucket !== 'partial-cancelled') continue
      const seconds = measured.executionSeconds ?? measured.observedPartialSeconds
      if (!Number.isFinite(seconds)) continue
      const stage = classifyStepStage(step)
      totals[stage] += seconds
      counts[stage]++
      observed += seconds
    }
    // Timing gaps, overlaps, and missing steps are not assigned to a stage.
    unattributedRunnerSeconds += Math.max(0, duration - observed)
  }
  return { jobsWithRunnerTime, runnerSeconds, stages: Object.fromEntries(Object.keys(totals).map(stage => [stage, { observedSeconds: totals[stage], timedSteps: counts[stage] }])), unattributedRunnerSeconds }
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
        const schedulingProxySeconds = !isRunnerlessCancellation(job)
          && Number.isFinite(created) && Number.isFinite(started) && started >= created ? (started - created) / 1000 : null
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
          jobOutcome: typeof job.conclusion === 'string' ? job.conclusion : 'unknown',
          runOutcome: typeof run?.conclusion === 'string' ? run.conclusion : 'unknown',
          cache: cacheState(job),
          status: job.status ?? null,
          name: typeof job.name === 'string' ? job.name : 'unknown',
          createdAt: job.created_at ?? null,
          startedAt: job.started_at ?? null,
          completedAt: job.completed_at ?? null,
          classification: execution.classification,
          executedSeconds: execution.executedSeconds,
          historicalSeconds: execution.historicalSeconds ?? null,
          schedulingProxySeconds,
          dependencyDelaySeconds: null,
          steps: Array.isArray(job.steps) ? job.steps : null,
          runnerlessCancellation: isRunnerlessCancellation(job),
        })
      }
    }
  }

  const collectionComplete = gaps.length === 0
  const timingComplete = unknowns.filter(row => row.reason === 'timing_unknown').length === 0
  const executed = observations.filter(row => row.classification === 'executed-this-attempt' && Number.isFinite(row.executedSeconds))
  const observedExecutedSeconds = executed.reduce((sum, row) => sum + row.executedSeconds, 0)
  const executedJobsFresh = executed.length
  const freshQueueProxySeconds = executed.map(row => row.schedulingProxySeconds).filter(Number.isFinite)
  const stageBreakdown = jobStageBreakdown(observations)
  const runnerlessCancelled = observations.filter(row => row.runnerlessCancellation)
  const runnerlessUnstartedSeconds = runnerlessCancelled.map(row => {
    const created = stamp(row.createdAt)
    const completed = stamp(row.completedAt)
    return Number.isFinite(created) && Number.isFinite(completed) && completed >= created
      ? (completed - created) / 1000 : null
  }).filter(Number.isFinite)

  const runRows = rawRunRows.filter(row => row && Number.isInteger(row.id))
  const runSummaries = runRows.map(current => {
    const created = stamp(current.created_at)
    const updated = stamp(current.updated_at)
    const finished = current.status === 'completed' && Number.isFinite(created) && Number.isFinite(updated) && updated >= created
    const currentBranch = current.head_branch ?? current.headBranch
    const currentWorkflow = current.workflow_id ?? current.name
    const candidates = runRows.filter(other => typeof currentBranch === 'string' && currentBranch.length > 0
      && currentWorkflow !== undefined && currentWorkflow !== null
      && other.id !== current.id
      && other.event === current.event && (other.workflow_id ?? other.name) === (current.workflow_id ?? current.name)
      && (other.head_branch ?? other.headBranch) === currentBranch
      && Number.isFinite(stamp(other.created_at)) && Number.isFinite(created) && stamp(other.created_at) > created)
    const laterDifferentHead = candidates.filter(other => typeof other.head_sha === 'string' && typeof current.head_sha === 'string' && other.head_sha !== current.head_sha)
    const requiredCheckAt = stamp(current.required_check_completed_at ?? current.requiredCheckCompletedAt)
    const requiredCheckCompleted = Number.isFinite(created) && Number.isFinite(requiredCheckAt) && requiredCheckAt >= created
    return {
      runId: current.id,
      outcome: current.conclusion ?? 'unknown',
      endToEndSeconds: finished ? (updated - created) / 1000 : null,
      endToEndTimingStatus: finished ? 'observed' : 'unknown',
      requiredCheckCompletionSeconds: requiredCheckCompleted ? (requiredCheckAt - created) / 1000 : null,
      requiredCheckCompletionStatus: requiredCheckCompleted ? 'observed' : 'unknown',
      potentiallySupersededByRunIds: current.conclusion === 'cancelled' ? laterDifferentHead.map(other => other.id) : [],
      supersessionCausality: 'unknown',
    }
  })
  const failedJobRows = observations.filter(row => row.jobOutcome === 'failure')
  const failureByIdentity = new Map(failedJobRows.map(row => [`${row.runId}:${row.attempt}:${row.jobId}`, row]))
  const uniqueFailedJobs = [...failureByIdentity.values()]
  const rootFailureCandidates = uniqueFailedJobs.filter(row => !AGGREGATE_FAILURE_JOB.test(row.name.split(' (')[0]))
  const aggregateFailureRows = uniqueFailedJobs.filter(row => AGGREGATE_FAILURE_JOB.test(row.name.split(' (')[0]))

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
  const stepGroups = new Map()
  let platformCoreStepObservations = 0
  let excludedUnnamedStepCount = 0
  for (const row of observations) {
    if (row.classification !== 'executed-this-attempt') continue
    if (!row.name.startsWith('platform-core') || !Array.isArray(row.steps)) continue
    for (const step of row.steps) {
      platformCoreStepObservations++
      const nameless = !step || typeof step !== 'object' || typeof step.name !== 'string' || !step.name
      if (nameless) excludedUnnamedStepCount++
      const stepName = nameless ? PLATFORM_CORE_UNNAMED_STEP : step.name
      const key = `${row.os}|${stepName}`
      if (!stepGroups.has(key)) stepGroups.set(key, emptyStepAggregate())
      foldPlatformStepAggregate(stepGroups.get(key), classifyPlatformStep(step))
    }
  }
  const platformCoreSteps = [...stepGroups.entries()].map(([key, aggregate]) => {
    const splitAt = key.indexOf('|')
    return finalizePlatformStepAggregate(key.slice(0, splitAt), key.slice(splitAt + 1), aggregate)
  }).sort((a, b) => (b.executionP50 ?? -1) - (a.executionP50 ?? -1))
  const platformCoreStepTotalFromGroups = platformCoreSteps.reduce((sum, row) => sum + row.total, 0)
  const platformCoreStepAccounting = {
    observationCount: platformCoreStepObservations,
    excludedUnnamedStepCount,
    unnamedStepLabel: PLATFORM_CORE_UNNAMED_STEP,
    groupTotalObservations: platformCoreStepTotalFromGroups,
    observationCountReconciles: platformCoreStepObservations === platformCoreStepTotalFromGroups,
  }

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
    schemaVersion: 2,
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
      runnerlessCancelledJobs: runnerlessCancelled.length,
      runnerlessUnstartedLifetimeSeconds: runnerlessUnstartedSeconds.length === runnerlessCancelled.length
        ? runnerlessUnstartedSeconds.reduce((sum, value) => sum + value, 0) : null,
      runnerlessLifetimeMeasurementStatus: runnerlessUnstartedSeconds.length === runnerlessCancelled.length ? 'observed' : 'unknown',
    },
    stageBreakdown: {
      ...stageBreakdown,
      billingSeconds: null,
      billingStatus: 'unknown',
      cacheEvidence: 'unknown unless directly supplied per job',
    },
    workload: {
      jobRows: observations.length,
      failedJobRows: failedJobRows.length,
      rootFailureCandidates: rootFailureCandidates.length,
      aggregateFailureRowsExcluded: aggregateFailureRows.length,
      duplicateFailedJobRowsExcluded: failedJobRows.length - uniqueFailedJobs.length,
      rootFailureIdentity: 'unknown without dependency/failure-cause evidence; candidates are failed non-aggregate jobs, not proven roots',
      duplicateWorkloadDeduplicated: false,
    },
    runSummaries,
    scheduling: {
      proxy: 'job.created_at to job.started_at',
      providerQueueIdentified: false,
      dependencyDelayObserved: false,
      samples: observations.filter(row => Number.isFinite(row.schedulingProxySeconds)).length,
      proxySecondsP50: percentile(observations.map(row => row.schedulingProxySeconds).filter(value => Number.isFinite(value)), 50),
      proxySecondsP95: percentile(observations.map(row => row.schedulingProxySeconds).filter(value => Number.isFinite(value)), 95),
      observedProxySeconds: observations.filter(row => Number.isFinite(row.schedulingProxySeconds)).reduce((sum, row) => sum + row.schedulingProxySeconds, 0),
      freshExecution: {
        jobs: executed.length,
        queueProxySamples: freshQueueProxySeconds.length,
        queueProxyP50Seconds: percentile(freshQueueProxySeconds, 50),
        queueProxyP95Seconds: percentile(freshQueueProxySeconds, 95),
        runnerExecutionSamples: executedJobsFresh,
        runnerExecutionSeconds: executedJobsFresh ? observedExecutedSeconds : null,
      },
      waitInterpretation: 'pre-start timestamp proxy only; not proven provider queue or prerequisite completion',
    },
    platformCoreSteps,
    platformCoreStepAccounting,
    unknowns,
    gaps,
    sources: { runIds: rawRunIds, jobIds: observations.map(row => row.jobId) },
    formulas: {
      percentile: 'nearest-rank: sort ascending, index = ceil(p/100 * n) - 1',
      executedSeconds: 'sum of executed-this-attempt job seconds; null unless collection and timing are both complete',
      observedExecutedSeconds: 'partial sum from classified fresh executions even when timing is incomplete',
      carriedForward: 'started_at and completed_at are both strictly before attempt run_started_at; executedSeconds is 0',
      runnerlessCancellation: 'cancelled completed job with no steps and created_at equal to started_at; requires runner_id 0 with empty runner_name, or both runner fields null',
      schedulingProxy: 'created_at to started_at; not provider capacity and not workflow dependency delay',
      freshSchedulingVsExecution: 'freshExecution includes only executed-this-attempt jobs; queue proxy is created_at to started_at, runner execution is started_at to completed_at; carried-forward, skipped, unknown and runnerless cancellations are excluded',
      updatedAt: 'not used as qualification completion',
      stageBreakdown: 'observed step seconds classified by explicit step-name hints; unknown and unassigned runner seconds remain unattributed; not billing time',
      rootFailureCandidates: 'failed non-aggregate job rows; dependency/root-cause identity is unknown without dependency evidence',
      requiredCheckCompletion: 'unknown unless required_check_completed_at or requiredCheckCompletedAt is supplied in the run input',
      potentialSupersession: 'later same-event/workflow/branch run with a different head; cancellation causality remains unknown',
      completeness: 'collection completeness from identity, pagination, orphan, duplicate, and raw-count reconciliation',
      timingComplete: 'false when any completed job lacks provable execution timestamps',
      platformCoreSteps:
        'schema 2: per (os, step) totals reconcile execution+skipped+partial-cancelled+unknown+incomplete; '
        + 'completed execution requires status completed plus conclusion success|failure plus valid timestamps; '
        + 'missing or unrecognized status is unknown/incomplete, never inferred executed; '
        + 'nameless step observations roll into <unnamed-step> and excludedUnnamedStepCount; '
        + 'p50/p90 and count are execution-only; skipped never execution; '
        + 'partial-cancelled/timed_out observed durations are labeled separately and excluded from execution percentiles',
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

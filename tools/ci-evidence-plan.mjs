#!/usr/bin/env node
// Offline advice only. Never execute candidate code or publish check results.
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const digest = value => sha256(JSON.stringify(value))
const isSha = (value, length) => typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value)
const same = (a, b) => a !== undefined && a === b
const list = value => Array.isArray(value) ? value : []
const nameOk = name => typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9 ()_,.:/-]{0,159}$/.test(name)
const pathOk = path => typeof path === 'string' && /^src\/[A-Za-z0-9_./-]+\.test\.ts$/.test(path) && !path.split('/').includes('..')
const INPUTS = ['headSha', 'treeSha', 'workflowSha', 'policySha', 'commandDigest', 'lockDigest', 'environmentDigest', 'selectionDigest', 'compiledDigest', 'packageDigest']
const PORTABILITY_CONTROLS = ['wrong-path-delivery', 'missing-glob-metadata']

function execution(job) {
  const unknown = { classification: 'unknown', executedSeconds: 0 }
  if (job.conclusion === 'skipped' || job.status === 'not_run') return { classification: 'not-executed', executedSeconds: 0 }
  const timestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) ? Date.parse(value) : NaN
  const attempt = timestamp(job.attemptStartedAt), start = timestamp(job.startedAt), end = timestamp(job.completedAt)
  if (![attempt, start, end].every(Number.isFinite) || end < start || job.status !== 'completed') return unknown
  if (start < attempt && end < attempt) return { classification: 'carried-forward', executedSeconds: 0, historicalSeconds: (end - start) / 1000 }
  if (start < attempt) return unknown
  return { classification: 'executed-this-attempt', executedSeconds: (end - start) / 1000 }
}

function recognizedPathRepair(file) {
  if (!pathOk(file?.path) || typeof file.before !== 'string' || typeof file.after !== 'string') return false
  let matches = 0
  let expected = file.before.replace(/^(\s*assert\.deepEqual\([^\r\n]+, )\['([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+)'\](\)\r?)$/gm, (line, prefix, path, suffix) => {
    const parts = path.split('/')
    if (parts.some(part => part === '.' || part === '..')) return line
    matches++
    return `${prefix}[join(${parts.map(part => `'${part}'`).join(', ')})]${suffix}`
  })
  if (!matches) return false
  if (!/^import \{ join, resolve \} from 'node:path'\r?$/m.test(expected)) {
    expected = expected.replace(/^import \{ resolve \} from 'node:path'(\r?)$/m, "import { join, resolve } from 'node:path'$1")
  }
  return /^import \{ join, resolve \} from 'node:path'\r?$/m.test(expected) && expected === file.after
}

function changeReasons(evidence, context) {
  const change = evidence.change
  if (!change || !['unchanged', 'native-path-portability'].includes(change.kind)) return ['unsupported_change']
  const reasons = []
  for (const key of ['dynamicDependencies', 'compiledOutput', 'packageOutput', 'skips']) {
    if (change[key] !== 'unchanged') reasons.push(`unproven_or_changed:${key}`)
  }
  if (!Array.isArray(change.files)) reasons.push('change_files_missing')
  if (change.kind === 'unchanged' && list(change.files).length) reasons.push('unchanged_claim_has_diff')
  if (change.kind === 'unchanged') {
    for (const key of ['headSha', 'treeSha']) {
      if (!same(evidence.baseline?.[key], context.candidate?.[key]) || !same(context.baseline?.[key], context.candidate?.[key])) reasons.push(`unchanged_baseline_mismatch:${key}`)
    }
  }
  if (change.kind === 'native-path-portability') {
    if (!list(change.files).length || !list(change.files).every(recognizedPathRepair)) reasons.push('unsupported_portability_edit')
    for (const key of ['headSha', 'treeSha']) {
      if (!isSha(context.baseline?.[key], 40) || !same(evidence.baseline?.[key], context.baseline[key])) reasons.push(`baseline_mismatch:${key}`)
    }
    const ids = list(context.controls).map(control => control?.id)
    if (ids.length !== PORTABILITY_CONTROLS.length || new Set(ids).size !== ids.length || PORTABILITY_CONTROLS.some(id => !ids.includes(id))) reasons.push('frozen_negative_controls_missing_or_duplicate')
    for (const expected of list(context.controls)) {
      const id = nameOk(expected?.id) ? expected.id : 'invalid-control'
      const records = list(evidence.controls).filter(control => control?.id === id)
      const control = records[0]
      const binding = ['assertionCode', 'testDigest', 'mutationDigest', 'environmentDigest']
      const valid = id !== 'invalid-control' && nameOk(expected.assertionCode) &&
        ['testDigest', 'mutationDigest', 'environmentDigest'].every(key => isSha(expected[key], 64)) &&
        records.length === 1 && binding.every(key => same(control?.[key], expected[key])) &&
        same(control?.headSha, context.candidate?.headSha) && same(control?.treeSha, context.candidate?.treeSha) &&
        control.goodExitCode === 0 && Number.isInteger(control.mutantExitCode) && control.mutantExitCode > 0 && control.mutantExitCode <= 255 && control.mutantOutcome === 'assertion-failure'
      if (!valid) reasons.push(`negative_control_not_detected:${id}`)
    }
  }
  return reasons
}

/**
 * Inspect supplied immutable exports against separately pinned operator context.
 * A matching pin proves byte identity, not GitHub authenticity or input closure.
 */
export function planEvidence(evidence, contextPin = {}) {
  let context = {}, globalReasons = []
  const bytes = contextPin.bytes
  if (typeof bytes !== 'string' || !isSha(contextPin.expectedSha256, 64) || sha256(bytes) !== contextPin.expectedSha256) globalReasons.push('context_pin_mismatch')
  try { context = JSON.parse(bytes) } catch { globalReasons.push('context_malformed') }
  if (!context || typeof context !== 'object' || Array.isArray(context)) context = {}
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) evidence = {}
  if (context.schemaVersion !== 1 || evidence.schemaVersion !== 1) globalReasons.push('unsupported_schema')
  if (!isSha(context.evidenceDigest, 64) || context.evidenceDigest !== digest(evidence)) globalReasons.push('evidence_digest_mismatch')
  if (typeof context.candidate?.repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(context.candidate.repository)) globalReasons.push('repository_missing')
  for (const key of ['repository', 'headSha', 'treeSha']) {
    if (!same(evidence.candidate?.[key], context.candidate?.[key]) || key.endsWith('Sha') && !isSha(context.candidate?.[key], 40)) globalReasons.push(`candidate_mismatch:${key}`)
  }
  if (!list(context.jobs).length || list(context.jobs).some(job => !nameOk(job?.name)) || list(evidence.jobs).some(job => !nameOk(job?.name))) globalReasons.push('job_inventory_invalid')
  const expectedNames = list(context.jobs).map(job => job?.name)
  const actualNames = list(evidence.jobs).map(job => job?.name)
  if (new Set(expectedNames).size !== expectedNames.length || new Set(actualNames).size !== actualNames.length || actualNames.some(name => !expectedNames.includes(name))) globalReasons.push('job_inventory_ambiguous')
  const changed = changeReasons(evidence, context)
  const accounting = { executedJobs: 0, carriedForwardJobs: 0, skippedJobs: 0, unknownJobs: 0, executedSeconds: 0 }
  const jobs = (list(context.jobs).length ? context.jobs : [{ name: 'evidence' }]).map(expected => {
    const found = list(evidence.jobs).filter(job => job?.name === expected?.name)
    const job = found[0] ?? {}, reasons = [...globalReasons], missingEvidence = []
    if (found.length !== 1) reasons.push('job_observation_missing_or_duplicate')
    for (const key of INPUTS) {
      const length = key.endsWith('Sha') ? 40 : 64
      if (!isSha(job.identity?.[key], length) || !isSha(expected?.identity?.[key], length)) missingEvidence.push(`identity.${key}`)
      else if (job.identity[key] !== expected.identity[key]) reasons.push(key === 'headSha' ? 'stale_head' : key === 'treeSha' ? 'stale_tree' : `input_identity_mismatch:${key}`)
    }
    for (const key of ['headSha', 'treeSha']) {
      if (job.identity?.[key] !== context.candidate?.[key] && !reasons.includes(`stale_${key === 'headSha' ? 'head' : 'tree'}`)) reasons.push(`stale_${key === 'headSha' ? 'head' : 'tree'}`)
    }
    const producer = context.producer
    if (!producer || producer.repository !== context.candidate?.repository || producer.event !== 'pull_request' ||
      !['repository', 'event', 'workflow', 'appId'].every(key => same(job.source?.[key], producer[key])) ||
      !Number.isInteger(producer.appId) || producer.appId <= 0 || !nameOk(producer.workflow)) reasons.push('producer_mismatch')
    if (!/^[1-9][0-9]*$/.test(String(job.source?.runId)) || !/^[1-9][0-9]*$/.test(String(job.source?.jobId)) || !Number.isInteger(job.source?.attempt) || job.source.attempt < 1) missingEvidence.push('source.run_job_attempt')
    reasons.push(...changed)
    if (evidence.change?.kind === 'native-path-portability' && expected?.kind === 'unit' &&
      !list(context.controls).every(control => control?.environmentDigest === expected.identity?.environmentDigest)) reasons.push('negative_control_environment_mismatch')
    const observedExecution = execution(job)
    if (observedExecution.classification === 'unknown') reasons.push('execution_timestamps_unproven')
    if (globalReasons.length === 0) {
      const counter = { 'executed-this-attempt': 'executedJobs', 'carried-forward': 'carriedForwardJobs', 'not-executed': 'skippedJobs', unknown: 'unknownJobs' }[observedExecution.classification]
      accounting[counter]++; accounting.executedSeconds += observedExecution.executedSeconds
    }
    let recommendation = 'ESCALATE'
    if (reasons.length === 0 && missingEvidence.length === 0) {
      if (evidence.change.kind === 'native-path-portability') {
        const paths = list(expected.selectedPaths)
        if (expected.kind === 'unit' && paths.every(pathOk) && digest(paths) === expected.identity.selectionDigest && evidence.change.files.some(file => paths.includes(file.path))) {
          recommendation = 'RERUN'; reasons.push('recognized_edit_shape_requires_fresh_unit_qualification')
        } else reasons.push('cross_head_dependency_closure_not_supported')
      } else if (job.status === 'completed' && job.conclusion === 'success') {
        recommendation = 'REUSE'; reasons.push('same_candidate_exact_recorded_inputs_success')
      } else if (job.conclusion === 'failure' && (
        job.failure?.phase === 'artifact-upload' && /Failed to CreateArtifact:.*Request timeout/.test(job.failure.log ?? '') ||
        job.failure?.phase === 'npm-install' && /ETIMEDOUT/.test(job.failure.log ?? '') && /installArtifact/.test(job.failure.log ?? '')
      )) {
        recommendation = 'RERUN'; reasons.push('observed_infrastructure_failure_requires_retry')
      } else reasons.push('qualification_missing_failed_or_skipped')
    }
    return {
      name: nameOk(expected?.name) ? expected.name : 'invalid-job', recommendation,
      reasons: [...new Set(reasons)], missingEvidence,
      provenance: {
        contextSha256: typeof bytes === 'string' ? sha256(bytes) : null,
        evidenceDigest: digest(evidence),
        headSha: isSha(job.identity?.headSha, 40) ? job.identity.headSha : null,
        treeSha: isSha(job.identity?.treeSha, 40) ? job.identity.treeSha : null,
        runId: /^[1-9][0-9]*$/.test(String(job.source?.runId)) ? String(job.source.runId) : null,
        jobId: /^[1-9][0-9]*$/.test(String(job.source?.jobId)) ? String(job.source.jobId) : null,
        attempt: Number.isInteger(job.source?.attempt) ? job.source.attempt : null,
        inputIdentity: Object.fromEntries(INPUTS.map(key => [key, isSha(job.identity?.[key], key.endsWith('Sha') ? 40 : 64) ? job.identity[key] : null])),
      },
      execution: observedExecution,
    }
  })
  return {
    schemaVersion: 1, advisoryOnly: true, githubAuthenticated: false, jobs, accounting,
    limitations: [
      'Operator-selected context pins bytes; this offline tool does not authenticate their origin or completeness.',
      'REUSE means retain recorded same-head evidence, never manufacture a new passing check.',
      'No general dependency closure or cross-head evidence reuse is supported.',
      'Portability recognition checks an enumerated text edit, not program semantics.',
      'Execution seconds are observed job work, not wall-clock lead time or measured savings.',
      'Existing full CI, independent review and trusted merge gates remain authoritative.',
    ],
  }
}

function readJson(path) {
  if (statSync(path).size > 16 * 1024 * 1024) throw new Error('input_too_large')
  return readFileSync(path, 'utf8')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { evidence: { type: 'string' }, context: { type: 'string' }, 'context-sha256': { type: 'string' } } })
    if (!values.evidence || !values.context || !values['context-sha256']) throw new Error('arguments_missing')
    const report = planEvidence(JSON.parse(readJson(values.evidence)), { bytes: readJson(values.context), expectedSha256: values['context-sha256'] })
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  } catch {
    process.stderr.write('ci-evidence-plan: invalid arguments or unreadable/malformed input; no qualification result produced\n')
    process.exitCode = 2
  }
}

import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { scoreAttempt } from './runner.mjs'

// Admission gate for a supplied real-run evidence bundle.
// This module does not start a provider client, container, or server, and it
// never records a live trial of its own.

export const REAL_RUN_CONTRACT_ID = 'babel-curated-real-run-v1'
export const LIVE_TRIAL_EXECUTED = false
export const ISOLATION_CANARY_FILE = '.babel-grader-canary'

const SHA256 = /^sha256:[a-f0-9]{64}$/
const PLACEHOLDER_MODEL = new Set(['unknown', 'unset', 'null', 'none', 'undefined'])
const PLACEHOLDER_ENV = new Set([...PLACEHOLDER_MODEL, 'host', 'local', 'localhost'])
const MAX_CANDIDATE_FILES = 10000
const MAX_SCAN_BYTES = 1_000_000
const MIN_CANARY_TOKEN = 16

function isWithin(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate))
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function token(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function accessDenied(message) {
  return Object.assign(new Error(message), { code: 'EACCES' })
}

function baseResult(extra) {
  return {
    schema_version: 1,
    contract_id: REAL_RUN_CONTRACT_ID,
    live_trial_executed: false,
    provider_requests: 0,
    model_performance_claim: false,
    numeric_score: null,
    admitted: false,
    refused: true,
    outcome: 'unknown',
    real_run_score: null,
    patch_correct: null,
    session_completed: null,
    false_complete: false,
    transcript_captured: false,
    transcript_digest: null,
    grading_root_inaccessible: null,
    grading_inputs_candidate_writable: null,
    isolation_canary: 'missing',
    binding: {
      executable_path: null,
      model_id: null,
      environment_identity: null,
      missing: ['executable_path', 'model_id', 'environment_identity'],
    },
    reasons: ['contract_error'],
    ...extra,
  }
}

/** Read a candidate-relative path. Absolute paths and root escapes are refused. */
export async function candidateScopedRead(candidateRoot, relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0 || path.isAbsolute(relativePath)) {
    throw accessDenied('candidate read refused')
  }
  const root = await realpath(candidateRoot)
  const target = path.resolve(root, relativePath)
  let resolved
  try {
    resolved = await realpath(target)
  } catch {
    throw accessDenied('candidate read refused')
  }
  if (!isWithin(root, resolved)) throw accessDenied('candidate read refused')
  return readFile(resolved)
}

/** Write a candidate-relative path. Escapes and absolute paths are refused and not created. */
export async function candidateScopedWrite(candidateRoot, relativePath, contents) {
  if (typeof relativePath !== 'string' || relativePath.length === 0 || path.isAbsolute(relativePath)) {
    throw accessDenied('candidate write refused')
  }
  const root = await realpath(candidateRoot)
  const target = path.resolve(root, relativePath)
  let parent
  try {
    parent = await realpath(path.dirname(target))
  } catch {
    throw accessDenied('candidate write refused')
  }
  if (!isWithin(root, parent) || !isWithin(root, target)) throw accessDenied('candidate write refused')
  let existing = null
  try {
    existing = await realpath(target)
  } catch {
    existing = null
  }
  if (existing && !isWithin(root, existing)) throw accessDenied('candidate write refused')
  await writeFile(target, contents)
  return target
}

function classifyBinding(binding = {}) {
  const executable = token(binding.executable_path)
  const model = token(binding.model_id)
  const environment = token(binding.environment_identity)
  const missing = []
  const unbound = []
  if (!executable) missing.push('executable_path')
  else if (!path.isAbsolute(executable)) unbound.push('executable_path')
  if (!model) missing.push('model_id')
  else if (PLACEHOLDER_MODEL.has(model.toLowerCase())) unbound.push('model_id')
  if (!environment) missing.push('environment_identity')
  else if (PLACEHOLDER_ENV.has(environment.toLowerCase())) unbound.push('environment_identity')
  return {
    executable_path: executable,
    model_id: model && !unbound.includes('model_id') ? model : null,
    environment_identity: environment && !unbound.includes('environment_identity') ? environment : null,
    missing,
    unbound,
  }
}

async function confirmExecutable(binding) {
  if (!binding.executable_path || binding.unbound.includes('executable_path') || binding.missing.includes('executable_path')) {
    return binding
  }
  try {
    const stats = await lstat(binding.executable_path)
    if (!stats.isFile()) binding.unbound.push('executable_path')
  } catch {
    binding.unbound.push('executable_path')
  }
  if (binding.unbound.includes('executable_path')) binding.executable_path = token(binding.executable_path)
  return binding
}

async function inspectTranscript(transcriptPath, candidateRoot, gradingRoot, claimedDigest) {
  if (!transcriptPath) return { captured: false, digest: null, reason: 'transcript_missing' }
  let resolved
  try {
    const stats = await lstat(transcriptPath)
    if (!stats.isFile()) return { captured: false, digest: null, reason: 'transcript_unreadable' }
    resolved = await realpath(transcriptPath)
  } catch {
    return { captured: false, digest: null, reason: 'transcript_unreadable' }
  }
  if (candidateRoot && isWithin(candidateRoot, resolved)) {
    return { captured: false, digest: null, reason: 'transcript_inside_candidate' }
  }
  if (gradingRoot && isWithin(gradingRoot, resolved)) {
    return { captured: false, digest: null, reason: 'transcript_inside_grading_root' }
  }
  let bytes
  try {
    bytes = await readFile(resolved)
  } catch {
    return { captured: false, digest: null, reason: 'transcript_unreadable' }
  }
  if (bytes.length === 0) return { captured: false, digest: null, reason: 'transcript_empty' }
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
  if (claimedDigest !== undefined && claimedDigest !== null) {
    if (typeof claimedDigest !== 'string' || !SHA256.test(claimedDigest) || claimedDigest !== digest) {
      return { captured: false, digest, reason: 'transcript_digest_mismatch' }
    }
  }
  return { captured: true, digest, reason: null }
}

async function walkCandidate(candidateRoot, gradingRoot) {
  const files = []
  const links = []
  let count = 0
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      count += 1
      if (count > MAX_CANDIDATE_FILES) return 'unbounded'
      const full = path.join(directory, entry.name)
      const stats = await lstat(full)
      if (stats.isSymbolicLink()) {
        try {
          const target = await realpath(full)
          if (gradingRoot && (isWithin(gradingRoot, target) || isWithin(target, gradingRoot))) links.push(full)
        } catch {
          // A dangling link does not prove the grader is reachable.
        }
        continue
      }
      if (stats.isDirectory()) {
        if (gradingRoot && isWithin(gradingRoot, full)) links.push(full)
        const nested = await walk(full)
        if (nested === 'unbounded') return nested
      } else if (stats.isFile()) {
        files.push({ path: full, dev: stats.dev, ino: stats.ino, size: stats.size })
      }
    }
    return null
  }
  const unbounded = await walk(candidateRoot)
  return { files, links, unbounded: unbounded === 'unbounded' }
}

async function gradingInodes(gradingRoot) {
  const inodes = new Set()
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(directory, entry.name)
      const stats = await lstat(full)
      if (stats.isSymbolicLink()) continue
      if (stats.isDirectory()) await walk(full)
      else if (stats.isFile()) inodes.add(`${stats.dev}:${stats.ino}`)
    }
  }
  await walk(gradingRoot)
  return inodes
}

async function tokenVisible(files, canaryToken, canaryPath) {
  const canaryReal = await realpath(canaryPath).catch(() => null)
  for (const file of files) {
    if (canaryReal && path.resolve(file.path) === canaryReal) return true
    if (file.size === 0 || file.size > MAX_SCAN_BYTES) continue
    let text
    try {
      text = await readFile(file.path, 'utf8')
    } catch {
      continue
    }
    if (text.includes(canaryToken)) return true
  }
  return false
}

async function inspectIsolation(candidateRoot, gradingRoot) {
  if (!candidateRoot) {
    return { status: 'missing', inaccessible: null, writable: null, reasons: ['candidate_root_missing'] }
  }
  if (!gradingRoot) {
    return { status: 'missing', inaccessible: null, writable: null, reasons: ['grading_root_missing'] }
  }
  let candidateReal
  let gradingReal
  try {
    candidateReal = await realpath(candidateRoot)
    const candidateStat = await lstat(candidateReal)
    if (!candidateStat.isDirectory()) throw new Error('not a directory')
  } catch {
    return { status: 'missing', inaccessible: null, writable: null, reasons: ['candidate_root_missing'] }
  }
  try {
    gradingReal = await realpath(gradingRoot)
    const gradingStat = await lstat(gradingReal)
    if (!gradingStat.isDirectory()) throw new Error('not a directory')
  } catch {
    return { status: 'missing', inaccessible: null, writable: null, reasons: ['grading_root_missing'] }
  }
  if (isWithin(candidateReal, gradingReal) || isWithin(gradingReal, candidateReal)) {
    return {
      status: 'failed',
      inaccessible: false,
      writable: true,
      reasons: ['grading_root_not_inaccessible', 'isolation_canary_altered'],
    }
  }
  const walked = await walkCandidate(candidateReal, gradingReal)
  if (walked.unbounded) {
    return { status: 'missing', inaccessible: null, writable: null, reasons: ['candidate_tree_unbounded'] }
  }
  if (walked.links.length > 0) {
    return {
      status: 'failed',
      inaccessible: false,
      writable: true,
      reasons: ['isolation_symlink', 'isolation_canary_altered'],
    }
  }
  const shared = await gradingInodes(gradingReal)
  if (walked.files.some((file) => shared.has(`${file.dev}:${file.ino}`))) {
    return {
      status: 'failed',
      inaccessible: false,
      writable: true,
      reasons: ['isolation_hardlink', 'isolation_canary_altered'],
    }
  }
  const canaryPath = path.join(gradingReal, ISOLATION_CANARY_FILE)
  let canaryToken
  try {
    const stats = await lstat(canaryPath)
    if (!stats.isFile()) throw new Error('canary is not a file')
    canaryToken = (await readFile(canaryPath, 'utf8')).trim()
  } catch {
    return { status: 'missing', inaccessible: null, writable: null, reasons: ['isolation_canary_missing'] }
  }
  if (canaryToken.length < MIN_CANARY_TOKEN) {
    return { status: 'missing', inaccessible: null, writable: null, reasons: ['isolation_canary_missing'] }
  }
  if (await tokenVisible(walked.files, canaryToken, canaryPath)) {
    return {
      status: 'failed',
      inaccessible: false,
      writable: false,
      reasons: ['isolation_canary_seen'],
    }
  }
  const escape = path.relative(candidateReal, canaryPath)
  try {
    const leaked = await candidateScopedRead(candidateReal, escape)
    if (leaked.includes(canaryToken)) {
      return { status: 'failed', inaccessible: false, writable: true, reasons: ['isolation_canary_seen', 'isolation_canary_altered'] }
    }
  } catch (error) {
    if (error.code !== 'EACCES') {
      return { status: 'missing', inaccessible: null, writable: null, reasons: ['isolation_canary_missing'] }
    }
  }
  let written = null
  try {
    written = await candidateScopedWrite(candidateReal, escape, 'probe')
  } catch (error) {
    if (error.code !== 'EACCES') {
      return { status: 'missing', inaccessible: null, writable: null, reasons: ['isolation_canary_missing'] }
    }
  }
  if (written) {
    await rm(written, { force: true })
    return { status: 'failed', inaccessible: false, writable: true, reasons: ['isolation_canary_altered'] }
  }
  return { status: 'passed', inaccessible: true, writable: false, reasons: [] }
}

function engineView(task, attempt) {
  if (!task?.change_policy || !attempt) return null
  return scoreAttempt(task, attempt)
}

/**
 * Decide whether a supplied bundle may carry a real-run score.
 * Missing transcript capture or any of executable path, model id, and
 * environment identity stays unknown. A candidate who can see or alter the
 * grader fails the run. Self-graded and scripted bundles are refused.
 * No numeric score is emitted.
 */
export async function assessRealRunContract(input = {}) {
  try {
    const binding = await confirmExecutable(classifyBinding(input.binding))
    const isolation = await inspectIsolation(input.candidate_root, input.grading_root)
    let candidateReal = null
    let gradingReal = null
    try { candidateReal = input.candidate_root ? await realpath(input.candidate_root) : null } catch { candidateReal = null }
    try { gradingReal = input.grading_root ? await realpath(input.grading_root) : null } catch { gradingReal = null }
    const transcript = await inspectTranscript(input.transcript_path, candidateReal, gradingReal, input.transcript_digest)
    const reasons = []
    for (const field of binding.missing) reasons.push(`binding_missing:${field}`)
    for (const field of binding.unbound) reasons.push(`binding_unbound:${field}`)
    if (candidateReal && binding.executable_path && binding.missing.length === 0 && !binding.unbound.includes('executable_path')) {
      try {
        const executableReal = await realpath(binding.executable_path)
        if (isWithin(candidateReal, executableReal)) {
          reasons.push('binding_unbound:executable_path')
          binding.unbound.push('executable_path')
        }
      } catch {
        reasons.push('binding_unbound:executable_path')
        binding.unbound.push('executable_path')
      }
    }
    if (!transcript.captured) reasons.push(transcript.reason)
    reasons.push(...isolation.reasons)
    const provenance = input.grading_provenance
    const gradeInsideCandidate = input.grade_path && candidateReal
      ? await realpath(input.grade_path).then((resolved) => isWithin(candidateReal, resolved), () => false)
      : false
    const selfGraded = input.self_graded === true || provenance !== 'isolated_harness' || gradeInsideCandidate || input.attempt?.verifier?.source === 'candidate'
    if (selfGraded) reasons.push('self_graded')
    if (input.attempt?.scripted_provider === true || input.scripted_provider === true) reasons.push('scripted_provider')
    if (input.model_performance_claim === true || input.attempt?.model_performance_claim === true) reasons.push('model_performance_claim_refused')
    if (!input.task) reasons.push('task_missing')
    if (!input.attempt) reasons.push('attempt_missing')
    const scored = engineView(input.task, input.attempt)
    const integrityBreach = isolation.status === 'failed' || transcript.reason === 'transcript_digest_mismatch'
    const bindingGaps = binding.missing.length > 0 || binding.unbound.length > 0
    const evidenceGaps = !transcript.captured || isolation.status !== 'passed' || bindingGaps || !input.task || !input.attempt
    const refusedClaim = selfGraded || reasons.includes('scripted_provider') || reasons.includes('model_performance_claim_refused')
    let outcome = 'unknown'
    let admitted = false
    if (integrityBreach) outcome = 'integrity_failure'
    else if (!evidenceGaps && !refusedClaim && scored) {
      const blockedSuccess = scored.outcome === 'valid_success' && (scored.session_completed !== true || scored.patch_correct !== true)
      if (blockedSuccess) reasons.push('success_without_session')
      else {
        admitted = true
        outcome = scored.outcome
      }
    }
    const uniqueReasons = [...new Set(reasons)]
    return {
      schema_version: 1,
      contract_id: REAL_RUN_CONTRACT_ID,
      live_trial_executed: false,
      provider_requests: 0,
      model_performance_claim: false,
      numeric_score: null,
      admitted,
      refused: !admitted,
      outcome,
      real_run_score: admitted ? outcome : null,
      patch_correct: admitted ? scored.patch_correct : null,
      session_completed: scored ? scored.session_completed : null,
      false_complete: scored ? scored.false_complete : false,
      transcript_captured: transcript.captured,
      transcript_digest: transcript.digest,
      grading_root_inaccessible: isolation.inaccessible,
      grading_inputs_candidate_writable: isolation.writable,
      isolation_canary: isolation.status,
      binding: {
        executable_path: binding.unbound.includes('executable_path') ? null : binding.executable_path,
        model_id: binding.model_id,
        environment_identity: binding.environment_identity,
        missing: [...new Set([...binding.missing, ...binding.unbound])],
      },
      reasons: admitted ? [] : uniqueReasons,
    }
  } catch {
    return baseResult()
  }
}

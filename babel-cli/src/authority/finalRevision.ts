import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { isCredentialTargetPath } from '../agent/autonomyEnforcement.js'
import { isAuthoritativeVerifierCommand } from '../agent/completionGatePolicy.js'
import { decodeCommand } from './commandDecoder.js'
import { satisfiesVerifierRequirement } from '../services/verifierIdentity.js'

/**
 * Shared final-revision verification contract (`final-revision-v1`).
 *
 * Chat and Deep completion both consume this module. The contract answers one
 * question: does the proof the turn relies on describe the bytes that are on
 * disk at completion time? A later write, an external editor save, a canceled
 * check or an unsettled command invalidates the proof instead of preserving a
 * stale success.
 */

/** Version of the persisted final-revision witness contract. */
export const FINAL_REVISION_CONTRACT_VERSION = 'final-revision-v1' as const

const MAX_WITNESS_PATHS = 256
const MAX_WITNESS_FILE_BYTES = 16 * 1024 * 1024

/** One path whose bytes the host observed. `deleted` records a confirmed absence. */
export interface FinalRevisionFileV1 {
  path: string
  sha256: string
}

/** Bytes the completion claim is allowed to speak about. */
export interface FinalRevisionCandidateV1 {
  schema_version: 1
  contract: typeof FINAL_REVISION_CONTRACT_VERSION
  scope: { kind: 'files'; paths: string[] } | { kind: 'repository' }
  git_commit_hash: string | null
  composite_tree_hash: string
  captured_at: number
  snapshot_complete: boolean
}

/** Truthful state of the final-revision proof. Never promotes stale to current. */
export type FinalRevisionStatus = 'verified' | 'unverified' | 'stale' | 'unavailable'

/** Completion-facing proof that the verifier evidence still covers the final tree. */
export interface FinalRevisionWitnessV1 {
  schema_version: 1
  contract: typeof FINAL_REVISION_CONTRACT_VERSION
  status: FinalRevisionStatus
  candidate: FinalRevisionCandidateV1 | null
  /** Which host observation established currency. */
  verified_against: 'required_verifier' | 'inspection_reads' | 'verifier_bound_revision' | null
  /** Paths changed after the accepted proof. User-owned bytes; never deleted here. */
  stale_paths: string[]
  /** Paths mutated with no accepted verifier result covering them. */
  unverified_paths: string[]
  reason: string | null
}

/** Minimal structural view of a tool-log entry; GateToolLogEntry/ToolCallLog satisfy it. */
export interface FinalRevisionToolEntry {
  tool: string
  target: string
  error?: string | undefined
  exit_code?: number | undefined
  stale?: boolean | undefined
  preDispatchNoEffect?: true | undefined
  mutation_paths?: string[] | undefined
  effect_status?: string | undefined
  read_revision_hash?: string | undefined
}

const MUTATION_TOOLS = new Set([
  'write_file',
  'file_write',
  'str_replace',
  'apply_patch',
  'edit_file',
])

const READ_TOOLS = new Set(['read_file', 'read_range', 'file_read'])

function normalizeProjectPath(projectRoot: string, value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null
  const slash = value.replaceAll('\\', '/')
  if (/^(?:[A-Za-z]:|\/)/.test(slash)) return null
  const normalized = slash.replace(/^\.\//, '')
  const root = resolve(projectRoot)
  const target = resolve(root, normalized)
  const rel = relative(root, target)
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return null
  const posix = rel.split(sep).join('/')
  if (isCredentialTargetPath(posix)) return null
  return posix
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.keys(value as Record<string, unknown>).sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
    .join(',')}}`
}

/** Deterministic digest of a file set and its observed bytes. */
export function finalRevisionCompositeHash(files: readonly FinalRevisionFileV1[]): string {
  return createHash('sha256')
    .update(canonicalJson({ contract: FINAL_REVISION_CONTRACT_VERSION, files }))
    .digest('hex')
}

/** Hash one project-relative file at completion time; null when absent or unsafe. */
export function hashFinalRevisionFile(projectRoot: string, value: string): string | null {
  const safe = normalizeProjectPath(projectRoot, value)
  if (!safe) return null
  try {
    const root = realpathSync.native(projectRoot)
    const target = resolve(root, safe)
    const rel = relative(root, target)
    if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return null
    const stats = statSync(target)
    if (!stats.isFile() || stats.size > MAX_WITNESS_FILE_BYTES) return null
    const bytes = readFileSync(target)
    if (bytes.byteLength > MAX_WITNESS_FILE_BYTES) return null
    return createHash('sha256').update(bytes).digest('hex')
  } catch {
    return null
  }
}

function readGitHead(projectRoot: string): string | null {
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
      windowsHide: true,
    }).trim()
    return /^[0-9a-f]{40}$/i.test(head) ? head : null
  } catch {
    return null
  }
}

function uniqueSafePaths(projectRoot: string, paths: readonly string[]): string[] | null {
  const unique = new Set<string>()
  for (const path of paths) {
    const safe = normalizeProjectPath(projectRoot, path)
    if (!safe) return null
    unique.add(safe)
    if (unique.size > MAX_WITNESS_PATHS) return null
  }
  return [...unique].sort()
}

/**
 * Capture the exact bytes of the candidate file set right now.
 * Missing files are recorded as `deleted`; an unsafe path makes capture unavailable.
 */
export function captureFinalRevisionCandidate(
  projectRoot: string,
  paths: readonly string[],
): FinalRevisionCandidateV1 | null {
  const safe = uniqueSafePaths(projectRoot, paths)
  if (!safe) return null
  if (safe.length === 0) {
    return {
      schema_version: 1,
      contract: FINAL_REVISION_CONTRACT_VERSION,
      scope: { kind: 'repository' },
      git_commit_hash: readGitHead(projectRoot),
      composite_tree_hash: finalRevisionCompositeHash([]),
      captured_at: Date.now(),
      snapshot_complete: false,
    }
  }
  const files: FinalRevisionFileV1[] = []
  let complete = true
  for (const path of safe) {
    const hash = hashFinalRevisionFile(projectRoot, path)
    if (hash === null) {
      complete = false
      files.push({ path, sha256: 'deleted' })
    } else {
      files.push({ path, sha256: hash })
    }
  }
  return {
    schema_version: 1,
    contract: FINAL_REVISION_CONTRACT_VERSION,
    scope: { kind: 'files', paths: safe },
    git_commit_hash: readGitHead(projectRoot),
    composite_tree_hash: finalRevisionCompositeHash(files),
    captured_at: Date.now(),
    snapshot_complete: complete,
  }
}

function isSuccessful(entry: FinalRevisionToolEntry): boolean {
  if (entry.preDispatchNoEffect === true || entry.error) return false
  // A process without a settled exit status is not evidence. Reads may omit it.
  if (['shell_exec', 'run_command', 'test_run'].includes(entry.tool)) return entry.exit_code === 0
  return entry.exit_code === undefined || entry.exit_code === 0
}

function isVerifierEntry(entry: FinalRevisionToolEntry): boolean {
  return ['test_run', 'run_command', 'shell_exec'].includes(entry.tool) &&
    isAuthoritativeVerifierCommand(entry.target)
}

function isMutationEntry(entry: FinalRevisionToolEntry): boolean {
  if (!isSuccessful(entry) || entry.stale === true) return false
  // A host-proven no-op changed no bytes and cannot invalidate proof.
  if (entry.effect_status === 'confirmed_no_change') return false
  if (MUTATION_TOOLS.has(entry.tool)) return true
  if (!['shell_exec', 'run_command', 'test_run'].includes(entry.tool) || isVerifierEntry(entry)) return false
  // Proven read-only or test-only commands leave worktree bytes untouched.
  try {
    const semantic = decodeCommand(entry.target).semantic
    if (semantic === 'read_local' || semantic === 'test_local' || semantic === 'network_read' ||
        semantic === 'git_commit') return false
  } catch {
    // Undecoded commands remain conservative mutations.
  }
  return true
}

function mutationPaths(entry: FinalRevisionToolEntry): string[] {
  if (entry.mutation_paths?.length) return [...entry.mutation_paths]
  return MUTATION_TOOLS.has(entry.tool) ? [entry.target] : []
}

function identityCommands(commands: readonly string[]): string[] {
  return commands.map(command => command.trim()).filter(Boolean)
}

/** Tool-log paths changed after the last passing authoritative verifier. */
export function untestedPathsAfterLastGreenVerifier(
  toolCallLog: readonly FinalRevisionToolEntry[],
): string[] {
  let lastGreen = -1
  for (const [index, entry] of toolCallLog.entries()) {
    if (isVerifierEntry(entry) && isSuccessful(entry)) lastGreen = index
  }
  if (lastGreen < 0) return []
  const paths = new Set<string>()
  for (const entry of toolCallLog.slice(lastGreen + 1)) {
    if (!isMutationEntry(entry)) continue
    for (const path of mutationPaths(entry)) paths.add(path)
  }
  return [...paths].sort()
}

function inspectionReads(toolCallLog: readonly FinalRevisionToolEntry[]): { path: string; sha256: string }[] {
  const reads = new Map<string, string>()
  for (const entry of toolCallLog) {
    if (!READ_TOOLS.has(entry.tool) || !isSuccessful(entry) || !entry.read_revision_hash) continue
    reads.set(entry.target, entry.read_revision_hash)
  }
  return [...reads.entries()].map(([path, sha256]) => ({ path, sha256 })).sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * Evaluate whether the turn's proof still describes the bytes on disk.
 *
 * Rules are intentionally conservative:
 * - A required verifier that never passed is `unverified`, never `verified`.
 * - A mutation after the last accepted green verifier is `stale`.
 * - Read-only no-change needs per-path inspection witnesses; a later external
 *   save invalidates it.
 * - Without a verifier or inspection witness the state is `unverified`.
 */
export function evaluateFinalRevisionWitness(input: {
  projectRoot: string
  toolCallLog: readonly FinalRevisionToolEntry[]
  requiredVerifierCommands?: readonly string[]
  /** Host-bound revision the verifier ran against, when available. */
  verifierBoundRevision?: FinalRevisionCandidateV1 | null
}): FinalRevisionWitnessV1 {
  const required = identityCommands(input.requiredVerifierCommands ?? [])
  const log = input.toolCallLog
  const mutations = log.filter(isMutationEntry)
  const mutatedPaths = [...new Set(mutations.flatMap(mutationPaths))]
  const changedForWitness = mutatedPaths.length > 0 ? mutatedPaths : inspectionReads(log).map(read => read.path)

  const base = (status: FinalRevisionStatus, reason: string | null, verifiedAgainst: FinalRevisionWitnessV1['verified_against'], stalePaths: string[] = [], unverifiedPaths: string[] = []): FinalRevisionWitnessV1 => ({
    schema_version: 1,
    contract: FINAL_REVISION_CONTRACT_VERSION,
    status,
    candidate: captureFinalRevisionCandidate(input.projectRoot, changedForWitness),
    verified_against: verifiedAgainst,
    stale_paths: stalePaths,
    unverified_paths: unverifiedPaths,
    reason,
  })

  if (input.verifierBoundRevision) {
    const expected = input.verifierBoundRevision
    if (expected.scope.kind === 'files') {
      const current = captureFinalRevisionCandidate(input.projectRoot, expected.scope.paths)
      if (!current) return base('unavailable', 'final_revision_capture_unavailable', null)
      if (current.composite_tree_hash === expected.composite_tree_hash) {
        return base('verified', null, 'verifier_bound_revision')
      }
      return base('stale', 'final_revision_changed_after_verifier', null, expected.scope.paths)
    }
    const head = readGitHead(input.projectRoot)
    if (expected.git_commit_hash === null || head === null) {
      return base('unavailable', 'repository_revision_unavailable', null)
    }
    return head === expected.git_commit_hash
      ? base('verified', null, 'verifier_bound_revision')
      : base('stale', 'git_head_changed_after_verifier', null)
  }

  if (required.length === 0) {
    if (mutations.length === 0) {
      const reads = inspectionReads(log)
      if (reads.length === 0) return base('unverified', 'no_inspection_witness', null)
      const stale: string[] = []
      for (const read of reads) {
        const current = hashFinalRevisionFile(input.projectRoot, read.path)
        if (current !== read.sha256) stale.push(read.path)
      }
      return stale.length > 0
        ? base('stale', 'inspected_bytes_changed_before_publication', null, stale)
        : base('verified', null, 'inspection_reads')
    }
    return base('unverified', 'no_required_verifier_contract', null, [], mutatedPaths)
  }

  const lastGreenByRequirement: number[] = []
  for (const requirement of required) {
    let last = -1
    for (const [index, entry] of log.entries()) {
      if (isVerifierEntry(entry) && isSuccessful(entry) && satisfiesVerifierRequirement(requirement, entry.target)) {
        last = index
      }
    }
    if (last < 0) return base('unverified', 'required_verifier_missing', null, [], mutatedPaths)
    lastGreenByRequirement.push(last)
  }
  const verifiedIndex = Math.min(...lastGreenByRequirement)
  const after = log.slice(verifiedIndex + 1).filter(isMutationEntry)
  if (after.length > 0) {
    const stale = [...new Set(after.flatMap(mutationPaths))].sort()
    return base('stale', 'mutation_after_required_verifier', null, stale, stale)
  }
  return base('verified', null, 'required_verifier')
}

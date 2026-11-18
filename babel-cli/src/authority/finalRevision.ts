import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { isCredentialTargetPath } from '../agent/autonomyEnforcement.js'
import { isAuthoritativeVerifierCommand } from '../agent/completionGatePolicy.js'
import { decodeCommand, splitChains, tokenize } from './commandDecoder.js'
import { satisfiesVerifierRequirement } from '../services/verifierIdentity.js'

/**
 * Shared final-revision verification contract (`final-revision-v1`).
 *
 * What this contract proves, exactly:
 * - A required verifier's last green invocation is not followed by any logged
 *   local effect that may have changed worktree bytes. Logged effects include
 *   direct mutation tools, confirmation-bearing child/await effects, and shell
 *   commands that are not provably read-only.
 * - A read-only no-change conclusion is still current only when every inspected
 *   path was re-hashed from its raw bytes at publication.
 * - A host-supplied `verifierBoundRevision` still matches the current bytes of
 *   its own file scope.
 *
 * What it does not prove: an external process that wrote to a file Babel never
 * observed. Shell classification is conservative (unknown write shapes are
 * effects); read-only shapes are an explicit allowlist, not a decoder guess.
 */

/** Version of the persisted final-revision witness contract. */
export const FINAL_REVISION_CONTRACT_VERSION = 'final-revision-v1' as const

const MAX_WITNESS_PATHS = 256
const MAX_INSPECTION_WITNESSES = 64
const MAX_INSPECTION_PROOF_BYTES = 64 * 1024 * 1024
const MAX_SHELL_WITNESS_PATHS = 32
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
  verifierExecuted?: boolean | undefined
  processExecuted?: boolean | undefined
  processCompleted?: boolean | undefined
  simulated?: boolean | undefined
}

const MUTATION_TOOLS = new Set([
  'write_file',
  'file_write',
  'str_replace',
  'apply_patch',
  'edit_file',
  'file_delete',
])

const READ_TOOLS = new Set(['read_file', 'read_range', 'file_read'])
const SHELL_TOOLS = new Set(['shell_exec', 'run_command', 'test_run'])

/**
 * Commands whose ordinary invocation only reads bytes or prints those bytes.
 * Anything not listed is treated as a possible worktree write.
 */
const READ_ONLY_BASES = new Set([
  'cat', 'ls', 'dir', 'pwd', 'rg', 'grep', 'egrep', 'fgrep', 'head', 'tail',
  'wc', 'stat', 'file', 'du', 'df', 'tree', 'which', 'where', 'type',
  'basename', 'dirname', 'realpath', 'readlink', 'md5sum', 'sha256sum',
  'shasum', 'cmp', 'diff', 'comm', 'cut', 'find', 'sort', 'uniq', 'echo',
  'printf', 'test', 'true', 'false', 'sleep', 'date', 'whoami', 'id',
  'uname', 'hostname', 'printenv', 'ls-files', 'less', 'more', 'sed',
])


function normalizeExecutionBase(value: string | undefined): string {
  return String(value ?? '').replace(/^.*[\\/]/, '').replace(/\.(?:exe|cmd|bat)$/i, '').toLowerCase()
}

function normalizeProjectPath(projectRoot: string, value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null
  const root = resolve(projectRoot)
  const target = isAbsolute(value) ? resolve(value) : resolve(root, value)
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

function safeRealTarget(projectRoot: string, value: string): { realRoot: string; realTarget: string } | null {
  const safe = normalizeProjectPath(projectRoot, value)
  if (!safe) return null
  try {
    const realRoot = realpathSync.native(projectRoot)
    const realTarget = realpathSync.native(resolve(realRoot, safe))
    const rel = relative(realRoot, realTarget)
    if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return null
    const posix = rel.split(sep).join('/')
    if (isCredentialTargetPath(posix)) return null
    return { realRoot, realTarget }
  } catch {
    return null
  }
}

/** Stat one in-root regular file for the bounded inspection proof. */
function finalRevisionFileSize(projectRoot: string, value: string):
  | { kind: 'ok'; size: number }
  | { kind: 'missing' }
  | { kind: 'unsupported' } {
  const target = safeRealTarget(projectRoot, value)
  if (!target) return { kind: 'unsupported' }
  try {
    const stats = statSync(target.realTarget)
    return stats.isFile() && stats.size <= MAX_WITNESS_FILE_BYTES
      ? { kind: 'ok', size: stats.size }
      : { kind: 'unsupported' }
  } catch (error) {
    return error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
      ? { kind: 'missing' }
      : { kind: 'unsupported' }
  }
}

/**
 * Hash one in-root file from its raw bytes at completion time.
 * Returns null when absent, outside the real project root, credential-shaped,
 * a non-regular file, or over the 16 MB witness cap. Callers treat null as
 * unproven, never as unchanged.
 */
export function hashFinalRevisionFile(projectRoot: string, value: string): string | null {
  const target = safeRealTarget(projectRoot, value)
  if (!target) return null
  try {
    const stats = statSync(target.realTarget)
    if (!stats.isFile() || stats.size > MAX_WITNESS_FILE_BYTES) return null
    const bytes = readFileSync(target.realTarget)
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
    }
  }
  const files: FinalRevisionFileV1[] = []
  for (const path of safe) {
    const hash = hashFinalRevisionFile(projectRoot, path)
    files.push({ path, sha256: hash ?? 'deleted' })
  }
  return {
    schema_version: 1,
    contract: FINAL_REVISION_CONTRACT_VERSION,
    scope: { kind: 'files', paths: safe },
    git_commit_hash: readGitHead(projectRoot),
    composite_tree_hash: finalRevisionCompositeHash(files),
    captured_at: Date.now(),
  }
}

function shellHasFileRedirect(segment: string): boolean {
  let quote: "'" | '"' | null = null
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index]!
    if (quote !== null) {
      if (char === '\\' && quote === '"') { index += 1; continue }
      if (char === quote) quote = null
      continue
    }
    if (char === "'" || char === '"') { quote = char; continue }
    if (char === '\\') { index += 1; continue }
    if (char !== '>') continue
    // `2>&1` duplicates a descriptor; it does not open a worktree file.
    if (segment[index + 1] === '&') continue
    let cursor = index + 1
    while (segment[cursor] === ' ') cursor += 1
    let target = ''
    let targetQuote: "'" | '"' | null = null
    for (; cursor < segment.length; cursor += 1) {
      const value = segment[cursor]!
      if (targetQuote !== null) {
        if (value === targetQuote) { targetQuote = null; continue }
        target += value
        continue
      }
      if (value === "'" || value === '"') { targetQuote = value; continue }
      if (/\s|[;|&]/.test(value)) break
      target += value
    }
    const normalized = target.toLowerCase()
    if (normalized === '/dev/null' || normalized === 'nul') continue
    return true
  }
  return false
}

function splitPipes(segment: string): string[] {
  const parts: string[] = []
  let current = ''
  let quote: "'" | '"' | null = null
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index]!
    if (quote !== null) {
      current += char
      if (char === '\\' && quote === '"') { current += segment[++index] ?? ''; continue }
      if (char === quote) quote = null
      continue
    }
    if (char === "'" || char === '"') { quote = char; current += char; continue }
    if (char === '\\') { current += char; current += segment[++index] ?? ''; continue }
    if (char === '|') {
      if (segment[index + 1] === '|') { current += '||'; index += 1; continue }
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  parts.push(current)
  return parts
}

/** True when a shell string executes or separates in a way we cannot prove read-only. */
function hasExecutingOrUnsafeShellSyntax(command: string): boolean {
  let quote: "'" | '"' | null = null
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!
    if (quote === "'") {
      if (char === "'") quote = null
      continue
    }
    if (quote === '"') {
      if (char === '\\') { index += 1; continue }
      if (char === '"') { quote = null; continue }
      if (char === '`') return true
      if (char === '$' && command[index + 1] === '(') return true
      continue
    }
    if (char === "'" || char === '"') { quote = char; continue }
    if (char === '\\') { index += 1; continue }
    if (char === '\n' || char === '\r') return true
    if (char === '`') return true
    if (char === '$' && command[index + 1] === '(') return true
    if ((char === '<' || char === '>') && command[index + 1] === '(') return true
    if (char === '&') {
      const previous = command[index - 1] ?? ''
      const next = command[index + 1] ?? ''
      if (next === '&' || next === '>' || previous === '>' || previous === '<') continue
      return true
    }
  }
  return false
}

/**
 * Proof-safety table: only a known-safe flag set keeps a command read-only.
 * Unknown options fail to the mutation path. This is intentionally stricter
 * than the capability decoder: proof safety, not authorization.
 */
const gitFlagSet = (...values: string[]): ReadonlySet<string> => new Set(values)

interface GitProofSpec {
  flags: ReadonlySet<string>
  valueFlags?: ReadonlySet<string>
  attachedValueFlags?: readonly string[]
  positionals: 'none' | 'any' | 'max1'
  verbs?: ReadonlySet<string>
  requiresListForPositionals?: boolean
  allowNumericShorthand?: boolean
  denied?: ReadonlySet<string>
}

/** Options that execute external programs or write files under git. */
export const GIT_EXEC_WRITE_DENIALS: readonly RegExp[] = [
  /^-O/,
  /^--open-files-in-pager(?:=|$)/,
  /^--textconv(?:=|$)/,
  /^--filters(?:=|$)/,
  /^--ext-diff(?:=|$)/,
  /^--output(?:=|$)/,
  /^--show-signature(?:=|$)/,
  /^--paginate(?:=|$)/,
  /^--exec-path(?:=|$)/,
]

const LOG_SAFE_FLAGS = gitFlagSet(
  '--oneline', '--graph', '--stat', '--numstat', '--shortstat', '--name-only',
  '--name-status', '--pretty', '--format', '--abbrev-commit', '--no-abbrev-commit',
  '--decorate', '--no-decorate', '--date', '--max-count', '-n', '--skip', '-S', '-G',
  '-p', '-u', '--patch', '--no-patch', '-s', '--first-parent', '--merges', '--no-merges',
  '--since', '--until', '--after', '--before', '--author', '--committer', '--grep',
  '--all', '--branches', '--tags', '--remotes', '--reverse', '--follow', '--no-renames',
  '--diff-filter', '--binary', '--color', '--no-color', '--notes', '--no-notes',
  '--show-notes', '--no-show-notes', '--mailmap', '--use-mailmap', '--topo-order',
  '--date-order', '--left-right', '--cherry-pick', '--cherry-mark', '--raw',
  '--simplify-by-decoration', '--full-history', '--dense', '--sparse', '--remove-empty',
  '--source', '--relative-date', '--abbrev', '--no-abbrev', '--parents', '--children',
  '--boundary', '--walk-reflogs', '--grep-reflog', '-L', '--no-renames', '--submodule', '--no-ext-diff', '--no-textconv', '-U', '--unified', '-w', '--ignore-all-space',
)
const LOG_VALUE_FLAGS = gitFlagSet(
  '--pretty', '--format', '--date', '--max-count', '-n', '--skip', '-S', '-G', '--since',
  '--until', '--after', '--before', '--author', '--committer', '--grep', '--diff-filter',
  '--abbrev', '--grep-reflog', '-L', '--unified', '-U',
)

const DIFF_SAFE_FLAGS = gitFlagSet(
  '--stat', '--numstat', '--shortstat', '--name-only', '--name-status', '--oneline',
  '--graph', '--patch', '-p', '-u', '--no-patch', '-s', '--cached', '--staged',
  '--merge-base', '--quiet', '--exit-code', '--no-ext-diff', '--no-textconv', '--binary',
  '--full-index', '--abbrev', '--color', '--no-color', '--find-renames', '-M',
  '--find-copies', '-C', '--find-copies-harder', '--diff-filter', '--ignore-space-at-eol',
  '--ignore-cr-at-eol', '--ignore-all-space', '-w', '--ignore-blank-lines',
  '--function-context', '-W', '--src-prefix', '--dst-prefix', '--word-diff',
  '--word-diff-regex', '--color-words', '--color-moved', '--no-color-moved', '--raw',
  '--patch-with-raw', '--patch-with-stat', '--submodule', '--no-submodule',
  '--ita-invisible-in-index', '--relative', '--no-relative', '--unified', '-U', '--no-renames', '--text', '-S', '--patience', '--histogram', '--summary', '--minimal', '--ignore-submodules', '--compact-summary', '--dirstat',
)

const TABULAR_FLAGS = gitFlagSet('--stat', '--numstat', '--shortstat', '--name-only', '--name-status', '--patch', '-p', '--no-patch', '--oneline', '--graph', '--color', '--no-color')

const GIT_PROOF_SPECS: Readonly<Record<string, GitProofSpec>> = {
  status: { flags: gitFlagSet('--short', '-s', '--porcelain', '--long', '--branch', '-b', '--verbose', '-v', '--untracked-files', '-u', '--ignored', '--show-stash', '--ahead-behind', '--no-ahead-behind', '--renames', '--no-renames', '--find-renames', '--column', '--no-column', '--null', '-z', '--no-optional-locks'), valueFlags: gitFlagSet('--untracked-files', '-u', '--find-renames', '--column'), attachedValueFlags: ['-u'], positionals: 'none' },
  diff: { flags: DIFF_SAFE_FLAGS, valueFlags: gitFlagSet('--diff-filter', '--find-renames', '--find-copies', '--unified', '-U', '--src-prefix', '--dst-prefix', '--word-diff-regex', '--color-words', '--abbrev', '--inter-hunk-context', '-S', '--ignore-submodules', '--dirstat'), attachedValueFlags: ['-U', '-M', '-C', '-S'], positionals: 'any', denied: gitFlagSet('--no-index') },
  log: { flags: LOG_SAFE_FLAGS, valueFlags: LOG_VALUE_FLAGS, attachedValueFlags: ['-n', '-S', '-G', '-L', '-U'], positionals: 'any', allowNumericShorthand: true },
  show: { flags: LOG_SAFE_FLAGS, valueFlags: LOG_VALUE_FLAGS, attachedValueFlags: ['-n', '-S', '-G', '-L', '-U'], positionals: 'any', allowNumericShorthand: true },
  blame: { flags: gitFlagSet('-L', '--line-porcelain', '--porcelain', '-p', '--incremental', '--root', '--show-name', '--show-number', '-n', '--date', '--abbrev', '--encoding', '--ignore-rev', '--ignore-revs-file', '--reverse', '--first-parent', '--since', '--progress', '--score-debug', '--show-stats', '-s', '-w', '--ignore-all-space', '--no-textconv', '-M', '--find-renames', '-C', '--find-copies', '-e', '--show-email', '-f'), valueFlags: gitFlagSet('-L', '--date', '--abbrev', '--encoding', '--ignore-rev', '--ignore-revs-file', '--since'), attachedValueFlags: ['-L'], positionals: 'any' },
  grep: { flags: gitFlagSet('-n', '--line-number', '-i', '--ignore-case', '-w', '--word-regexp', '-v', '--invert-match', '-l', '--files-with-matches', '-L', '--files-without-match', '-c', '--count', '--column', '--color', '--no-color', '--heading', '--no-heading', '--break', '--full-name', '--no-full-name', '--null', '-z', '--cached', '--untracked', '--no-index', '--recursive', '-r', '--no-recursive', '-E', '--extended-regexp', '-G', '--basic-regexp', '-F', '--fixed-strings', '-P', '--perl-regexp', '-e', '-f', '--and', '--or', '--not', '--all-match', '--max-depth', '--threads', '-p', '--show-function', '--function-context', '-W', '-I', '--text', '-A', '-B', '-C', '-m', '-q', '--quiet', '-o', '--only-matching', '-h', '--no-filename'), valueFlags: gitFlagSet('-e', '-f', '--max-depth', '--threads', '-A', '-B', '-C', '-m'), attachedValueFlags: ['-e', '-f', '-A', '-B', '-C', '-m'], positionals: 'any' },
  'cat-file': { flags: gitFlagSet('-t', '-s', '-e', '-p', '--batch', '--batch-check', '--batch-all-objects', '--buffer', '--follow-symlinks', '--unordered', '--allow-unknown-type'), positionals: 'any' },
  'rev-parse': { flags: gitFlagSet('--verify', '--short', '--abbrev-ref', '--symbolic', '--symbolic-full-name', '--all', '--branches', '--tags', '--remotes', '--default', '--sq', '--local-env-vars', '--show-toplevel', '--git-dir', '--absolute-git-dir', '--is-inside-work-tree', '--is-inside-git-dir', '--is-bare-repository', '--is-shallow-repository', '--show-cdup', '--show-prefix', '--show-superproject-working-tree', '--shared-index-path', '--resolve-git-dir', '--path-format', '--disambiguate', '--end-of-options', '--revs-only', '--no-revs', '--flags', '--no-flags', '--not'), valueFlags: gitFlagSet('--default', '--path-format', '--resolve-git-dir'), positionals: 'any' },
  'rev-list': { flags: gitFlagSet('--count', '--max-count', '-n', '--skip', '--since', '--until', '--after', '--before', '--all', '--branches', '--tags', '--remotes', '--objects', '--object-names', '--no-object-names', '--parents', '--children', '--reverse', '--first-parent', '--merges', '--no-merges', '--topo-order', '--date-order', '--author', '--grep', '--left-right'), valueFlags: gitFlagSet('--max-count', '-n', '--skip', '--since', '--until', '--after', '--before', '--author', '--grep'), attachedValueFlags: ['-n'], positionals: 'any', allowNumericShorthand: true },
  'ls-files': { flags: gitFlagSet('-t', '-s', '-u', '-z', '--stage', '--unmerged', '--debug', '--eol', '--cached', '-c', '--deleted', '-d', '--modified', '-m', '--others', '-o', '--ignored', '-i', '--exclude-standard', '--error-unmatch', '--full-name', '--abbrev', '--format', '--deduplicate', '--sparse', '--no-empty-directory'), valueFlags: gitFlagSet('--abbrev', '--format'), positionals: 'any' },
  'ls-tree': { flags: gitFlagSet('-r', '-t', '-d', '-l', '-z', '--name-only', '--name-status', '--full-name', '--full-tree', '--abbrev', '--format', '--long'), valueFlags: gitFlagSet('--abbrev', '--format'), positionals: 'any' },
  shortlog: { flags: gitFlagSet('-s', '-n', '-e', '--email', '--format', '--group', '--summary', '--numbered', '--no-merges', '--merges'), valueFlags: gitFlagSet('--format', '--group'), attachedValueFlags: ['-n'], positionals: 'any', allowNumericShorthand: true },
  reflog: { flags: gitFlagSet('--all', '--date', '--format', '--no-abbrev', '--abbrev', '--oneline', '-n'), valueFlags: gitFlagSet('--date', '--format', '--abbrev', '-n'), attachedValueFlags: ['-n'], positionals: 'any', verbs: gitFlagSet('show', 'list') },
  whatchanged: { flags: LOG_SAFE_FLAGS, valueFlags: LOG_VALUE_FLAGS, attachedValueFlags: ['-n', '-S', '-G', '-L', '-U'], positionals: 'any', allowNumericShorthand: true },
  describe: { flags: gitFlagSet('--tags', '--all', '--long', '--abbrev', '--always', '--dirty', '--broken', '--match', '--exclude', '--contains', '--first-parent', '--debug', '--candidates', '--exact-match'), valueFlags: gitFlagSet('--abbrev', '--match', '--exclude', '--contains', '--candidates'), positionals: 'max1' },
  'merge-base': { flags: gitFlagSet('--all', '--octopus', '--independent', '--is-ancestor', '--fork-point'), positionals: 'any' },
  'name-rev': { flags: gitFlagSet('--name-only', '--tags', '--refs', '--exclude', '--always', '--undefined'), valueFlags: gitFlagSet('--refs', '--exclude'), positionals: 'any' },
  'check-ignore': { flags: gitFlagSet('-v', '--verbose', '-n', '--non-matching', '-q', '--quiet', '--stdin', '-z'), positionals: 'any' },
  'check-attr': { flags: gitFlagSet('-a', '--all', '-l', '--stdin', '-z'), positionals: 'any' },
  var: { flags: gitFlagSet('-l', '--list'), positionals: 'max1' },
  'show-ref': { flags: gitFlagSet('--head', '--heads', '--tags', '--dereference', '-d', '--verify', '--hash', '-s', '--abbrev', '--quiet', '-q'), valueFlags: gitFlagSet('--abbrev'), positionals: 'any' },
  'for-each-ref': { flags: gitFlagSet('--format', '--sort', '--count', '--shell', '--python', '--perl', '--tcl', '--points-at', '--merged', '--no-merged', '--contains', '--no-contains'), valueFlags: gitFlagSet('--format', '--sort', '--count', '--points-at', '--merged', '--no-merged', '--contains', '--no-contains'), positionals: 'any' },
  'count-objects': { flags: gitFlagSet('-v', '--verbose', '-H', '--human-readable'), positionals: 'none' },
  fsck: { flags: gitFlagSet('--unreachable', '--dangling', '--no-dangling', '--root', '--tags', '--cache', '--no-reflogs', '--connectivity-only', '--strict', '--verbose'), positionals: 'any' },
  version: { flags: gitFlagSet('--build-options'), positionals: 'none' },
  cherry: { flags: gitFlagSet('-v', '--verbose'), positionals: 'any' },
  'range-diff': { flags: gitFlagSet('--stat', '--no-dual-color', '--creation-factor', '--notes', '--no-notes', '--no-ext-diff', '--no-textconv'), valueFlags: gitFlagSet('--creation-factor'), positionals: 'any' },
  branch: { flags: gitFlagSet('--show-current', '--list', '-l', '-a', '--all', '-r', '--remotes', '-v', '-vv', '--verbose', '--contains', '--no-contains', '--points-at', '--merged', '--no-merged', '--sort', '--format', '--column', '--no-column', '--no-color', '--color', '--abbrev', '--no-abbrev', '-i', '--ignore-case'), valueFlags: gitFlagSet('--contains', '--no-contains', '--points-at', '--merged', '--no-merged', '--sort', '--format', '--abbrev'), positionals: 'any', requiresListForPositionals: true, denied: gitFlagSet('-d', '-D', '--delete', '-m', '-M', '--move', '-c', '-C', '--copy', '-f', '--force', '-u', '--set-upstream-to', '--unset-upstream', '--edit-description') },
  tag: { flags: gitFlagSet('-l', '--list', '-n', '--contains', '--no-contains', '--points-at', '--merged', '--no-merged', '--sort', '--format', '--column', '--no-column', '-i', '--ignore-case'), valueFlags: gitFlagSet('--contains', '--no-contains', '--points-at', '--merged', '--no-merged', '--sort', '--format'), attachedValueFlags: ['-n'], positionals: 'any', requiresListForPositionals: true, denied: gitFlagSet('-d', '--delete', '-a', '--annotate', '-s', '--sign', '-u', '--local-user', '-f', '--force', '-m', '-F', '--file', '-e', '--edit') },
  stash: { flags: gitFlagSet('--oneline', '--stat', '--patch', '-p', '-n', '--name-only', '--format'), valueFlags: gitFlagSet('--format', '-n'), attachedValueFlags: ['-n'], positionals: 'any', verbs: gitFlagSet('list', 'show') },
  worktree: { flags: gitFlagSet('--porcelain', '-z'), positionals: 'any', verbs: gitFlagSet('list') },
  remote: { flags: gitFlagSet('-v', '--verbose', '--all', '--push', '--no-push'), positionals: 'any', verbs: gitFlagSet('-v', '--verbose', 'get-url') },
  submodule: { flags: gitFlagSet('--cached', '--recursive', '--quiet'), positionals: 'any', verbs: gitFlagSet('status', 'summary') },
  config: { flags: gitFlagSet('--get', '--get-all', '--get-regexp', '--list', '-l', '--show-origin', '--show-scope', '--name-only', '--null', '-z', '--type', '--bool', '--int', '--path', '--global', '--local', '--system', '--file', '-f'), valueFlags: gitFlagSet('--type', '--file', '-f'), positionals: 'max1' },
  notes: { flags: gitFlagSet('--ref', '--format'), valueFlags: gitFlagSet('--ref', '--format'), positionals: 'any', verbs: gitFlagSet('list', 'show') },
}

/** Exported for the adversarial corpus that pins every subcommand/denial pair. */
export const GIT_READ_ONLY_SUBCOMMANDS: readonly string[] = Object.keys(GIT_PROOF_SPECS)

/** Concrete probes, one per exported denial regex; the corpus validates coverage. */
export const GIT_EXEC_WRITE_DENIAL_PROBES: readonly string[] = [
  '-O./pager.sh',
  '--open-files-in-pager=./pager.sh',
  '--textconv',
  '--filters',
  '--ext-diff',
  '--output=out.txt',
  '--show-signature',
  '--paginate',
  '--exec-path=/tmp',
]

/**
 * Config-capability table. These subcommands can execute repo-configured
 * programs (diff.external, textconv, fsmonitor, pager, gpg) even with a plain
 * argv, so a post-verifier invocation is effect-unproven unless hardened.
 * Everything else in the proof table is mechanical for worktree bytes.
 */
export const GIT_CONFIG_CAPABLE_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'status', 'diff', 'log', 'show', 'grep', 'whatchanged', 'range-diff', 'blame', 'reflog',
  'branch', 'tag', 'shortlog',
])

export type GitConfigCapability = 'mechanical' | 'config_capable'

/** Subcommand-local flags a hardening recipe requires, for spec ⊆ predicate checks. */
export function gitHardeningFlags(subcommand: string): readonly string[] {
  const sub = subcommand.toLowerCase()
  if (sub === 'blame') return ['--no-textconv']
  if (['diff', 'log', 'show', 'whatchanged'].includes(sub)) {
    return ['--no-ext-diff', '--no-textconv']
  }
  return []
}

/** Whether a proof-table subcommand admits every supplied flag. */
export function gitSubcommandAllowsFlags(subcommand: string, flags: readonly string[]): boolean {
  const spec = GIT_PROOF_SPECS[subcommand.toLowerCase()]
  return spec !== undefined && flags.every(flag => spec.flags.has(flag))
}

/**
 * Mechanism requirement for a capable subcommand. `gpg` means "forbid %G
 * format atoms"; `unproven` means no sound argv recipe exists (range-diff).
 */
export type GitHardeningMechanism =
  | 'pager+fsmonitor+gpg'
  | 'pager+fsmonitor'
  | 'pager+gpg'
  | 'fsmonitor'
  | 'pager'
  | 'none'
  | 'unproven'

const GIT_HARDENING_MECHANISMS: Readonly<Record<string, GitHardeningMechanism>> = {
  diff: 'pager+fsmonitor+gpg',
  log: 'pager+fsmonitor+gpg',
  show: 'pager+fsmonitor+gpg',
  whatchanged: 'pager+fsmonitor+gpg',
  blame: 'pager+fsmonitor',
  reflog: 'pager+gpg',
  grep: 'pager+fsmonitor',
  status: 'fsmonitor',
  branch: 'pager',
  tag: 'pager',
  shortlog: 'pager',
  'range-diff': 'unproven',
}

/** Exported mechanism requirement; null means the census is missing a recipe. */
export function gitHardeningMechanisms(subcommand: string): GitHardeningMechanism | null {
  return GIT_HARDENING_MECHANISMS[subcommand.toLowerCase()] ?? null
}

/** Capability for one proof-table subcommand. */
export function gitConfigCapability(subcommand: string): GitConfigCapability {
  return GIT_CONFIG_CAPABLE_SUBCOMMANDS.has(subcommand.toLowerCase())
    ? 'config_capable'
    : 'mechanical'
}

interface ParsedGitRead {
  sub: string
  args: string[]
  noPager: boolean
  config: ReadonlySet<string>
}

const SAFE_GIT_CONFIG = new Set(['core.fsmonitor=false', 'core.pager=cat'])

function parseGitRead(tokens: readonly string[]): ParsedGitRead | null {
  if (tokens[1] === '--version' || tokens[1] === '-v') {
    return { sub: 'version', args: [], noPager: true, config: new Set() }
  }
  let noPager = false
  const config = new Set<string>()
  let index = 1
  while (index < tokens.length) {
    const token = tokens[index]!
    if (token === '-C') {
      index += 2
      if (index > tokens.length) return null
      continue
    }
    if (token === '-c') {
      const value = tokens[index + 1]
      if (!value || !SAFE_GIT_CONFIG.has(value)) return null
      config.add(value)
      index += 2
      continue
    }
    if (token === '--no-pager') { noPager = true; index += 1; continue }
    if (token === '--exec-path' || token.startsWith('--exec-path=') ||
        token === '--paginate' || token === '-p' || token === '--git-dir' ||
        token.startsWith('--git-dir=') || token === '--work-tree' ||
        token.startsWith('--work-tree=') || token === '--namespace' ||
        token === '--bare') return null
    if (token === '--no-optional-locks' || token === '--literal-pathspecs') { index += 1; continue }
    if (token.startsWith('-')) return null
    break
  }
  const sub = tokens[index]?.toLowerCase()
  if (!sub) return null
  const spec = GIT_PROOF_SPECS[sub]
  if (!spec) return null
  const args = tokens.slice(index + 1)
  if (!gitArgsProofSafe(args, spec)) return null
  return { sub, args, noPager, config }
}

/** True when a git invocation is a proof-table read (argv shape only). */
export function gitCommandProofReadOnly(command: string): boolean {
  const tokens = tokenize(command)
  return normalizeExecutionBase(tokens[0]) === 'git' && parseGitRead(tokens) !== null
}

function gitFormatValues(args: readonly string[]): string[] {
  const values: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!
    if (token === '--format' || token === '--pretty') {
      const next = args[index + 1]
      if (next !== undefined) { values.push(next); index += 1 }
      continue
    }
    if (token.startsWith('--format=')) values.push(token.slice('--format='.length))
    if (token.startsWith('--pretty=')) values.push(token.slice('--pretty='.length))
  }
  return values
}

function gitHardeningSatisfied(parsed: ParsedGitRead): boolean {
  const mechanism = gitHardeningMechanisms(parsed.sub)
  // Fail closed: a capable subcommand with no mechanism entry is unproven.
  if (mechanism === null || mechanism === 'unproven') return false
  const has = (flag: string) => parsed.args.includes(flag)
  const fsmonitor = parsed.config.has('core.fsmonitor=false')
  const pager = parsed.noPager || parsed.config.has('core.pager=cat')
  const gpgFormat = gitFormatValues(parsed.args).some(value => value.includes('%G'))
  const localFlagsSatisfied = gitHardeningFlags(parsed.sub).every(flag => has(flag))
  if (mechanism.includes('pager') && !pager) return false
  if (mechanism.includes('fsmonitor') && !fsmonitor) return false
  if (mechanism.includes('gpg') && gpgFormat) return false
  return localFlagsSatisfied
}

/** True when a config-capable read cannot attest no post-verifier effect. */
export function gitConfigEffectUnproven(command: string): boolean {
  const tokens = tokenize(command)
  if (normalizeExecutionBase(tokens[0]) !== 'git') return false
  const parsed = parseGitRead(tokens)
  if (!parsed) return false
  if (gitConfigCapability(parsed.sub) !== 'config_capable') return false
  return !gitHardeningSatisfied(parsed)
}

function gitArgsProofSafe(args: readonly string[], spec: GitProofSpec): boolean {
  let positionals = 0
  let listFlag = false
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!
    if (GIT_EXEC_WRITE_DENIALS.some(pattern => pattern.test(token))) return false
    if (spec.denied?.has(token)) return false
    if (token === '--') {
      positionals += args.length - index - 1
      break
    }
    if (token.startsWith('-') && token !== '-') {
      if (token === '-l' || token === '--list') listFlag = true
      if (spec.allowNumericShorthand === true && /^-\d+$/.test(token)) continue
      if (spec.attachedValueFlags?.some(prefix => token.startsWith(prefix) && token.length > prefix.length)) continue
      const equals = token.indexOf('=')
      const flag = equals >= 0 ? token.slice(0, equals) : token
      if (!spec.flags.has(flag)) {
        // Combined short flags (`-sb`, `-vv`) are safe only if every letter is.
        if (/^-[A-Za-z]{2,}$/.test(token) &&
            [...token.slice(1)].every(letter => spec.flags.has(`-${letter}`))) continue
        return false
      }
      if (spec.valueFlags?.has(flag) && equals < 0) {
        const next = args[index + 1]
        if (next !== undefined && !next.startsWith('-')) index += 1
      }
      continue
    }
    positionals += 1
    if (spec.positionals === 'none') return false
    if (spec.positionals === 'max1' && positionals > 1) return false
    if (spec.verbs && positionals === 1 && !spec.verbs.has(token)) return false
  }
  if (spec.requiresListForPositionals === true && positionals > 0 && !listFlag) return false
  return true
}

function gitSegmentReadOnly(tokens: readonly string[]): boolean {
  return parseGitRead(tokens) !== null
}
function xargsCommandTokens(tokens: readonly string[]): string[] | null {
  const command: string[] = []
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]!
    if (token === '--') { command.push(...tokens.slice(index + 1)); break }
    if (token === '-n' || token === '-I' || token === '-P' || token === '-s' ||
        token === '-d' || token === '-E' || token === '-L') { index += 1; continue }
    if (/^-(?:n|I|P|s|d|E|L).+/.test(token) || /^--(?:max-args|replace|max-procs|max-chars|delimiter|eof|max-lines)=/.test(token) ||
        token === '-0' || token === '--null' || token === '-r' || token === '--no-run-if-empty' ||
        token === '-t' || token === '--verbose' || token === '-x' || token === '--exit') continue
    command.push(token)
  }
  return command.length > 0 ? command : null
}

function splitSedScript(script: string): string[] {
  const parts: string[] = []
  let current = ''
  let escaped = false
  for (const char of script) {
    if (escaped) { current += char; escaped = false; continue }
    if (char === '\\') { current += char; escaped = true; continue }
    if (char === ';' || char === '\n') { parts.push(current); current = ''; continue }
    current += char
  }
  parts.push(current)
  return parts
}

/** Strict sed subset: print/delete/quit and plain substitutions without w/W/e/r. */
function sedScriptProofSafe(script: string): boolean {
  for (const raw of splitSedScript(script)) {
    let command = raw.trim()
    if (!command) continue
    const address = /^(?:(?:\d+|\$|\/(?:\\.|[^/])*\/)(?:,(?:\d+|\$|\/(?:\\.|[^/])*\/))?)\s*/.exec(command)
    if (address) command = command.slice(address[0].length)
    if (!command) return false
    const verb = command[0]
    if (verb === 'p' || verb === 'd' || verb === 'q' || verb === '=') {
      if (command.slice(1).trim().length > 0) return false
      continue
    }
    // `a`/`i`/`c` append/insert/replace in the output stream only.
    if (verb === 'a' || verb === 'i' || verb === 'c') continue
    if (verb === 's' || verb === 'y') {
      const delimiter = command[1]
      if (!delimiter || /[A-Za-z0-9\\\s]/.test(delimiter)) return false
      let index = 2
      let delimiters = 0
      while (index < command.length && delimiters < 2) {
        if (command[index] === '\\') { index += 2; continue }
        if (command[index] === delimiter) { delimiters += 1; index += 1; continue }
        index += 1
      }
      if (delimiters < 2) return false
      const flags = command.slice(index).trim()
      if (verb === 'y' ? flags.length > 0 : !/^[gpiImM0-9]*$/.test(flags)) return false
      continue
    }
    return false
  }
  return true
}

function sedArgsProofSafe(rest: readonly string[]): boolean {
  const scripts: string[] = []
  let expressionSeen = false
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!
    if (token === '-e' || token === '--expression') {
      const script = rest[index + 1]
      if (script === undefined) return false
      scripts.push(script)
      expressionSeen = true
      index += 1
      continue
    }
    if (token.startsWith('--expression=')) {
      scripts.push(token.slice('--expression='.length))
      expressionSeen = true
      continue
    }
    if (token === '-f' || token === '--file' || token.startsWith('--file=') ||
        /^-[a-zA-Z]*f/.test(token) || token === '-i' || token.startsWith('--in-place') ||
        /^-[a-zA-Z]*i/.test(token)) return false
    if (token === '-l' || token === '--line-length') { index += 1; continue }
    if (token.startsWith('-')) {
      if (/^-[nErusuz]+$/.test(token) || token === '--quiet' || token === '--silent' ||
          token === '--unbuffered' || token === '--posix' || token === '--null-data' ||
          token === '--separate' || token === '--debug' || token === '--sandbox') continue
      return false
    }
    if (!expressionSeen && scripts.length === 0) scripts.push(token)
  }
  return scripts.length > 0 && scripts.every(sedScriptProofSafe)
}

function segmentIsReadOnly(segment: string): boolean {
  const trimmed = segment.trim()
  if (!trimmed || hasExecutingOrUnsafeShellSyntax(trimmed) || shellHasFileRedirect(trimmed)) return false
  const tokens = tokenize(trimmed)
  if (tokens.length === 0) return false
  const base = normalizeExecutionBase(tokens[0])
  if (base === 'git') return gitSegmentReadOnly(tokens)
  if (base === 'gh') {
    try { return decodeCommand(trimmed).semantic === 'read_local' } catch { return false }
  }
  if (base === 'xargs') {
    const command = xargsCommandTokens(tokens)
    return command !== null && segmentIsReadOnly(command.join(' '))
  }
  if (base === 'node' || base === 'nodejs' || base === 'npm' || base === 'pnpm' || base === 'yarn') {
    const rest = tokens.slice(1)
    return rest.length === 1 && ['--version', '-v', '--help', '-h'].includes(rest[0]!)
  }
  if (!READ_ONLY_BASES.has(base)) return false
  const rest = tokens.slice(1)
  if (base === 'find') {
    const writeFlags = new Set([
      '-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0',
      '-fprintf', '-fls',
    ])
    if (rest.some(token => writeFlags.has(token))) return false
  }
  if (base === 'sort' && rest.some(token => token === '-o' || token.startsWith('-o') || /^--output(?:=|$)/.test(token))) return false
  if (base === 'tree' && rest.some(token => token === '-o' || /^-o.+/.test(token) || /^--output(?:=|$)/.test(token))) return false
  if (base === 'file' && rest.some(token => token === '-C' || /^--compile(?:=|$)/.test(token))) return false
  if (base === 'rg' && rest.some(token => token === '--pre' || /^--pre(?:=|$)/.test(token))) return false
  if (base === 'sed') return sedArgsProofSafe(rest)
  if (base === 'uniq') {
    const valueFlags = new Set(['-f', '--skip-fields', '-s', '--skip-chars', '-w', '--check-chars'])
    let operands = 0
    for (let index = 0; index < rest.length; index += 1) {
      const token = rest[index]!
      if (valueFlags.has(token)) { index += 1; continue }
      if (token.startsWith('-')) continue
      operands += 1
    }
    if (operands > 1) return false
  }
  return true
}

/** True only when every chained/pipe segment is a provable read-only shape. */
function shellIsReadOnly(command: string): boolean {
  if (hasExecutingOrUnsafeShellSyntax(command)) return false
  const segments = splitChains(command)
  if (segments.length === 0) return false
  return segments.every(segment => splitPipes(segment).every(part => segmentIsReadOnly(part)))
}

/** Best-effort paths named by a shell write, for disclosure only. */
function shellWitnessPaths(command: string): string[] {
  const paths = new Set<string>()
  const tokens = tokenize(command)
  const base = normalizeExecutionBase(tokens[0])
  if (base === 'tee' || base === 'rm' || base === 'rmdir' || base === 'touch' ||
      base === 'mkdir' || base === 'truncate' || base === 'unlink') {
    for (const token of tokens.slice(1)) {
      if (!token.startsWith('-')) paths.add(token)
    }
  }
  if (base === 'cp' || base === 'mv' || base === 'install') {
    const operands = tokens.slice(1).filter(token => !token.startsWith('-'))
    if (operands.length >= 2) paths.add(operands.at(-1)!)
  }
  // Redirection targets are the most common late-write shape.
  let quote: "'" | '"' | null = null
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!
    if (quote !== null) {
      if (char === '\\' && quote === '"') { index += 1; continue }
      if (char === quote) quote = null
      continue
    }
    if (char === "'" || char === '"') { quote = char; continue }
    if (char === '\\') { index += 1; continue }
    if (char !== '>' || command[index + 1] === '&') continue
    let cursor = index + 1
    while (command[cursor] === ' ') cursor += 1
    let target = ''
    while (cursor < command.length && !/[\s;|&]/.test(command[cursor]!)) {
      target += command[cursor]!
      cursor += 1
    }
    if (target && target.toLowerCase() !== '/dev/null' && target.toLowerCase() !== 'nul') paths.add(target)
  }
  return [...paths].slice(0, MAX_SHELL_WITNESS_PATHS)
}

function isVerifierEntry(entry: FinalRevisionToolEntry, requirements?: readonly string[]): boolean {
  if (!SHELL_TOOLS.has(entry.tool)) return false
  if (entry.verifierExecuted === true) return true
  // Same requirement-satisfaction predicate the plan gate uses, so
  // `gradle test` and `./gradlew test` recognize each other.
  if (requirements?.some(required => satisfiesVerifierRequirement(required, entry.target))) return true
  return isAuthoritativeVerifierCommand(entry.target, requirements)
}

function isGreenVerifierEntry(entry: FinalRevisionToolEntry, requirements?: readonly string[]): boolean {
  return isVerifierEntry(entry, requirements) && entry.exit_code === 0 &&
    !entry.error && entry.preDispatchNoEffect !== true && entry.stale !== true &&
    entry.simulated !== true && entry.processExecuted !== false && entry.processCompleted !== false
}

function isMutationEntry(entry: FinalRevisionToolEntry, requirements?: readonly string[]): boolean {
  // Policy/approval denials never dispatched: they cannot have changed bytes.
  if (entry.preDispatchNoEffect === true || entry.error === 'blocked') return false
  const paths = entry.mutation_paths ?? []
  // A host-proven byte-identical effect changed nothing.
  if (entry.effect_status === 'confirmed_no_change' && paths.length === 0) return false
  // Paths on a failed, timed-out or unsettled call are a possible partial write.
  if (paths.length > 0) return true
  if (MUTATION_TOOLS.has(entry.tool)) return true
  if (entry.tool === 'sub_agent') {
    // Errored or unsettled children are conservative even without paths.
    return entry.effect_status === 'confirmed_change' || Boolean(entry.error) ||
      entry.effect_status === 'indeterminate'
  }
  if (entry.tool === 'await_command') return true
  if (!SHELL_TOOLS.has(entry.tool)) return false
  if (isVerifierEntry(entry, requirements)) return false
  return !shellIsReadOnly(entry.target)
}

function mutationPaths(entry: FinalRevisionToolEntry): string[] {
  if (entry.mutation_paths?.length) return [...entry.mutation_paths]
  if (MUTATION_TOOLS.has(entry.tool)) return [entry.target]
  if (SHELL_TOOLS.has(entry.tool) || entry.tool === 'await_command') return shellWitnessPaths(entry.target)
  return []
}

function identityCommands(commands: readonly string[]): string[] {
  return commands.map(command => command.trim()).filter(Boolean)
}

/** Tool-log paths changed after the last passing authoritative verifier. */
export function untestedPathsAfterLastGreenVerifier(
  toolCallLog: readonly FinalRevisionToolEntry[],
  boundCommands?: readonly string[],
): string[] {
  let lastGreen = -1
  for (const [index, entry] of toolCallLog.entries()) {
    if (isGreenVerifierEntry(entry, boundCommands)) lastGreen = index
  }
  if (lastGreen < 0) return []
  const paths = new Set<string>()
  for (const entry of toolCallLog.slice(lastGreen + 1)) {
    if (!isMutationEntry(entry, boundCommands)) continue
    for (const path of mutationPaths(entry)) paths.add(path)
  }
  return [...paths].sort()
}

function inspectionReads(toolCallLog: readonly FinalRevisionToolEntry[]): { path: string; sha256: string }[] {
  const reads = new Map<string, string>()
  for (const entry of toolCallLog) {
    if (!READ_TOOLS.has(entry.tool) || entry.preDispatchNoEffect === true ||
        entry.error || !entry.read_revision_hash) continue
    if (entry.exit_code !== undefined && entry.exit_code !== 0) continue
    reads.delete(entry.target)
    reads.set(entry.target, entry.read_revision_hash)
  }
  // Completion re-hashing is bounded: only the most recent inspection witnesses.
  return [...reads.entries()].slice(-MAX_INSPECTION_WITNESSES)
    .map(([path, sha256]) => ({ path, sha256 }))
    .sort((a, b) => a.path.localeCompare(b.path))
}

/** Explicit unproven witness for a project-scoped completion. */
export function unavailableFinalRevisionWitness(reason: string): FinalRevisionWitnessV1 {
  return {
    schema_version: 1,
    contract: FINAL_REVISION_CONTRACT_VERSION,
    status: 'unavailable',
    candidate: null,
    verified_against: null,
    stale_paths: [],
    unverified_paths: [],
    reason,
  }
}

/**
 * Whether a Chat no-change conclusion must carry a current byte witness.
 * Only ambient read-only chat (`BABEL_READ_ONLY`) is exempt: it makes no
 * worktree claim. A project-scoped READ_ONLY task still requires proof.
 */
export function chatFinalRevisionRequired(input: {
  ambientReadOnly: boolean
  hasProjectRoot: boolean
}): boolean {
  return input.hasProjectRoot && !input.ambientReadOnly
}

function hasEffectUnprovenGit(entries: readonly FinalRevisionToolEntry[]): boolean {
  return entries.some(entry => SHELL_TOOLS.has(entry.tool) && gitConfigEffectUnproven(entry.target))
}

/**
 * Evaluate whether the turn's proof still describes the bytes on disk.
 *
 * Conservative rules:
 * - A required verifier must have a green, settled, non-simulated invocation.
 * - Any logged mutation-capable effect after that invocation is `stale`.
 * - Read-only no-change needs per-path inspection witnesses; a later external
 *   save invalidates it. No witness means `unverified`, never `verified`.
 * - A host-bound revision mismatch is `stale`.
 */
export function evaluateFinalRevisionWitness(input: {
  projectRoot: string
  toolCallLog: readonly FinalRevisionToolEntry[]
  requiredVerifierCommands?: readonly string[]
  /**
   * Host-supplied revision the verifier ran against. This is an optional
   * integration hook; the current pipeline has no production caller, and the
   * required-verifier path proves only logged-effect ordering. Consumers that
   * bind a verifier revision can pass it here to reject changed bytes.
   */
  verifierBoundRevision?: FinalRevisionCandidateV1 | null
}): FinalRevisionWitnessV1 {
  const required = identityCommands(input.requiredVerifierCommands ?? [])
  const log = input.toolCallLog
  const mutations = log.filter(entry => isMutationEntry(entry, required))
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
      let remainingBytes = MAX_INSPECTION_PROOF_BYTES
      for (const read of reads) {
        const state = finalRevisionFileSize(input.projectRoot, read.path)
        if (state.kind === 'unsupported') {
          return base('unavailable', 'inspected_bytes_unproven', null)
        }
        if (state.kind === 'missing') {
          stale.push(read.path)
          continue
        }
        remainingBytes -= state.size
        if (remainingBytes < 0) return base('unavailable', 'final_revision_proof_budget_exceeded', null)
        const current = hashFinalRevisionFile(input.projectRoot, read.path)
        if (current !== read.sha256) stale.push(read.path)
      }
      if (stale.length > 0) {
        return base('stale', 'inspected_bytes_changed_before_publication', null, stale)
      }
      let lastRead = -1
      for (const [index, entry] of log.entries()) {
        if (READ_TOOLS.has(entry.tool) && entry.read_revision_hash) lastRead = index
      }
      if (hasEffectUnprovenGit(log.slice(lastRead + 1))) {
        return base('unverified', 'effect_unproven:config_capable_git', null)
      }
      return base('verified', null, 'inspection_reads')
    }
    return base('unverified', 'no_required_verifier_contract', null, [], mutatedPaths)
  }

  const lastGreenByRequirement: number[] = []
  for (const requirement of required) {
    let last = -1
    let lastAttempt = -1
    for (const [index, entry] of log.entries()) {
      if (!isVerifierEntry(entry, required) || entry.simulated === true) continue
      if (!satisfiesVerifierRequirement(requirement, entry.target)) continue
      lastAttempt = index
      if (isGreenVerifierEntry(entry, required)) last = index
    }
    if (last < 0) {
      const attempt = lastAttempt >= 0 ? log[lastAttempt] : undefined
      const settledRed = attempt !== undefined && attempt.exit_code !== undefined && attempt.exit_code !== 0 &&
        attempt.error !== 'blocked' && attempt.preDispatchNoEffect !== true
      return base('unverified', settledRed ? 'required_verifier_red' : 'required_verifier_missing', null, [], mutatedPaths)
    }
    if (lastAttempt > last) {
      const attempt = log[lastAttempt]
      const settledRed = attempt !== undefined && attempt.exit_code !== undefined && attempt.exit_code !== 0
      return base('unverified', settledRed ? 'required_verifier_red_after_green' : 'required_verifier_unsettled',
        null, [], mutatedPaths)
    }
    lastGreenByRequirement.push(last)
  }
  const verifiedIndex = Math.min(...lastGreenByRequirement)
  const after = log.slice(verifiedIndex + 1).filter(entry => isMutationEntry(entry, required))
  if (after.length > 0) {
    const stale = [...new Set(after.flatMap(mutationPaths))].sort()
    return base('stale', 'mutation_after_required_verifier', null, stale, stale)
  }
  if (hasEffectUnprovenGit(log.slice(verifiedIndex + 1))) {
    return base('unverified', 'effect_unproven:config_capable_git', null)
  }
  return base('verified', null, 'required_verifier')
}

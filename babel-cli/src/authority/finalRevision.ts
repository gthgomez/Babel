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

const GIT_READ_ONLY_SUBCOMMANDS = new Set([
  'status', 'diff', 'log', 'show', 'blame', 'grep', 'describe', 'rev-parse',
  'rev-list', 'ls-files', 'ls-tree', 'cat-file', 'shortlog', 'reflog',
  'whatchanged', 'merge-base', 'name-rev', 'check-ignore', 'check-attr',
  'var', 'show-ref', 'for-each-ref', 'count-objects', 'fsck', 'version',
  'help', 'cherry', 'range-diff',
])
const GIT_WRITE_FLAGS = /^(?:--output(?:=|$)|--ext-diff$|--no-index$)/

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

function stripGitGlobalOptions(tokens: readonly string[]): string[] {
  let index = 1
  while (index < tokens.length) {
    const token = tokens[index]!
    if (token === '-C' || token === '-c' || token === '--git-dir' || token === '--work-tree' ||
        token === '--exec-path' || token === '--namespace') {
      index += 2
      continue
    }
    if (token.startsWith('--git-dir=') || token.startsWith('--work-tree=') ||
        token.startsWith('--exec-path=') || token.startsWith('-c=') ||
        token === '--no-pager' || token === '--paginate' || token === '-p' ||
        token === '--bare' || token === '--no-optional-locks' || token === '--literal-pathspecs') {
      index += 1
      continue
    }
    break
  }
  return tokens.slice(index)
}

function gitSegmentReadOnly(tokens: readonly string[]): boolean {
  const rest = stripGitGlobalOptions(tokens)
  const sub = rest[0]?.toLowerCase()
  if (!sub) return false
  const args = rest.slice(1)
  if (args.some(arg => GIT_WRITE_FLAGS.test(arg))) return false
  if (GIT_READ_ONLY_SUBCOMMANDS.has(sub)) return true
  if (sub === 'branch') {
    if (args.some(arg => /^(?:-d|-D|--delete|-m|-M|--move|-c|-C|--copy|-f|--force|-u|--set-upstream-to|--unset-upstream|--edit-description)$/.test(arg))) return false
    const valueFlags = new Set(['--contains', '--no-contains', '--points-at', '--merged', '--no-merged', '--sort', '--format'])
    let operands = 0
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index]!
      if (arg.startsWith('-')) {
        if (valueFlags.has(arg)) index += 1
        continue
      }
      operands += 1
    }
    return operands === 0
  }
  if (sub === 'tag') {
    if (args.some(arg => /^(?:-d|--delete|-a|--annotate|-s|--sign|-u|--local-user|-f|--force|-m|-F|--file)$/.test(arg))) return false
    if (args.some(arg => arg === '-l' || arg === '--list')) return true
    return args.length === 0
  }
  if (sub === 'stash') return args[0]?.toLowerCase() === 'list' || args[0]?.toLowerCase() === 'show'
  if (sub === 'worktree') return args[0]?.toLowerCase() === 'list'
  if (sub === 'remote') {
    const verb = args[0]?.toLowerCase()
    if (!verb || verb === '-v' || verb === '--verbose' || verb === 'show' || verb === 'get-url') return true
    return false
  }
  if (sub === 'submodule') return args[0]?.toLowerCase() === 'status' || args[0]?.toLowerCase() === 'summary'
  if (sub === 'config') {
    if (args.some(arg => /^(?:--set|--unset|--unset-all|--add|--replace-all|--rename-section|--remove-section|-e|--edit)$/.test(arg))) return false
    if (args.some(arg => /^(?:--get|--get-all|--get-regexp|--list|-l|--show-origin|--show-scope|--name-only)$/.test(arg))) return true
    const operands = args.filter(arg => !arg.startsWith('-'))
    return operands.length <= 1
  }
  if (sub === 'notes') return args[0]?.toLowerCase() === 'list' || args[0]?.toLowerCase() === 'show'
  return false
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
  if (base === 'sed') {
    if (rest.some(token => token === '-i' || /^-i.+/.test(token) || /^--in-place(?:=|$)/.test(token))) return false
    const script = rest.find(token => !token.startsWith('-')) ?? ''
    if (/(?:^|[;\n])\s*[wW](?:\s|$)/.test(script) ||
        /\/[a-zA-Z0-9]*[wWe][a-zA-Z0-9]*\s*(?:;|$)/.test(script)) return false
  }
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
      return stale.length > 0
        ? base('stale', 'inspected_bytes_changed_before_publication', null, stale)
        : base('verified', null, 'inspection_reads')
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
  return base('verified', null, 'required_verifier')
}

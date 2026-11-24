/**
 * File-change / diff summary from existing Git workspace truth.
 * Not a second mutation engine - read-only git status/diff.
 *
 * Execution uses a fixed trusted Git installation and a private Git directory
 * built from a copied index and resolved HEAD. The approved checkout is
 * validated as a canonical repository scope first: no symlink/reparse aliases,
 * no external object alternates, no ambiguous .git indirection, no split
 * index, and no submodule state. The isolated config contains no filters,
 * hooks, includes, worktree layers or helper programs. The original config is
 * inspected only through a bounded snapshot and is never used for execution.
 */

import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  accessSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export interface WorkspaceFileChange {
  path: string
  status: string
}

export interface WorkspaceChangeSnapshot {
  available: boolean
  files: WorkspaceFileChange[]
  diff: string
  reason?: string
}

const MAX_FILES = 200
const MAX_UNTRACKED_FILES = 200
const MAX_OUTPUT_BYTES = 1_000_000
const MAX_TOTAL_TIME_MS = 15_000
const MAX_CONFIG_BYTES = 256 * 1024
const MAX_METADATA_BYTES = 1024 * 1024
const MAX_INDEX_BYTES = 64 * 1024 * 1024
const MAX_POINTER_BYTES = 4096

/** Global-config key that proves the sanitized Git configuration boundary is active. */
export const WORKSPACE_CHANGE_CONFIG_SENTINEL_KEY = 'babelWorkspaceInspection.configBoundarySentinel'

/** Private-repository config key that proves execution uses the isolated metadata. */
export const WORKSPACE_CHANGE_ISOLATED_SENTINEL_KEY = 'babelWorkspaceInspection.isolatedRepositoryConfig'

const REPOSITORY_FILTER_KEY = /^filter\..+\.(clean|process|smudge)$/i
const REPOSITORY_INCLUDE_KEY = /^(include\.path|includeif\..+\.path)$/i
const ALLOWED_EXTENSIONS = new Set(['worktreeconfig', 'objectformat', 'preciousobjects', 'refstorage', 'sparseindex'])

export function buildReadOnlyGitEnvironment(
  source: NodeJS.ProcessEnv,
  globalConfig: string,
  systemConfig?: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  const allowed = new Set([
    'PATH',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'PATHEXT',
    'TEMP',
    'TMP',
    'TMPDIR',
  ])
  for (const [name, value] of Object.entries(source)) {
    const normalized = name.toUpperCase()
    if (value !== undefined && (allowed.has(normalized) || normalized === 'LANG' || normalized.startsWith('LC_'))) {
      env[name] = value
    }
  }
  return {
    ...env,
    GIT_CONFIG_GLOBAL: globalConfig,
    ...(systemConfig !== undefined ? { GIT_CONFIG_SYSTEM: systemConfig } : {}),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    GIT_OPTIONAL_LOCKS: '0',
  }
}

export function buildReadOnlyGitArgs(args: string[]): string[] {
  return [
    '--no-pager',
    '-c',
    'core.fsmonitor=false',
    '-c',
    'diff.external=',
    '-c',
    'core.pager=cat',
    '-c',
    'pager.diff=false',
    ...args,
  ]
}

/**
 * Fixed host-owned installation roots. Caller PATH (absolute or not) is never
 * consulted for the executable; a missing binding fails before any Git process.
 */
function resolveTrustedGitExecutable(): string | null {
  const candidates =
    process.platform === 'win32'
      ? [
          'C:\\Program Files\\Git\\cmd\\git.exe',
          'C:\\Program Files\\Git\\bin\\git.exe',
          'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
        ]
      : ['/usr/bin/git', '/bin/git']
  for (const candidate of candidates) {
    try {
      if (!statSync(candidate).isFile()) continue
      if (process.platform !== 'win32') accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Try the next trusted installation root.
    }
  }
  return null
}

interface GitResult {
  ok: boolean
  stdout: string
  outputLimit: boolean
  timedOut: boolean
}

function runGit(
  gitExecutable: string,
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  deadline: number,
  acceptedExitCodes: number[] = [],
): GitResult {
  const remaining = deadline - Date.now()
  if (remaining <= 0) {
    return {
      ok: false,
      stdout: '',
      outputLimit: false,
      timedOut: true,
    }
  }
  const result = spawnSync(gitExecutable, buildReadOnlyGitArgs(args), {
    cwd,
    env,
    encoding: 'utf8',
    timeout: remaining,
    maxBuffer: MAX_OUTPUT_BYTES,
    windowsHide: true,
  })
  const stdout = typeof result.stdout === 'string' ? result.stdout : ''
  const outputLimit = (result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOBUFS'
  const timedOut =
    (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT' ||
    result.signal === 'SIGTERM' ||
    result.signal === 'SIGKILL'
  if (result.error || (result.status !== 0 && !acceptedExitCodes.includes(result.status ?? Number.NaN))) {
    return {
      ok: false,
      stdout,
      outputLimit,
      timedOut,
    }
  }
  return { ok: true, stdout, outputLimit: false, timedOut: false }
}

function unavailable(reason: string): WorkspaceChangeSnapshot {
  return { available: false, files: [], diff: '', reason }
}

function singleLine(value: string): string | null {
  const line = value.replace(/\r?\n$/, '')
  return line.length > 0 && !/[\r\n]/.test(line) ? line : null
}

class ScopeError extends Error {
  readonly reason: string

  constructor(reason: string) {
    super(reason)
    this.name = 'ScopeError'
    this.reason = reason
  }
}

function assertNoLinkAncestors(path: string): void {
  const chain: string[] = []
  for (let cursor = dirname(resolve(path)); dirname(cursor) !== cursor; cursor = dirname(cursor)) {
    chain.push(cursor)
  }
  for (const ancestor of chain.reverse()) {
    const stat = lstatSync(ancestor)
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new ScopeError('repository scope could not be validated')
    }
  }
}

function metadataExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw new ScopeError('repository scope could not be validated')
  }
}

function assertRegularFile(path: string, maxBytes?: number): number {
  assertNoLinkAncestors(path)
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || (maxBytes !== undefined && stat.size > maxBytes)) {
    throw new ScopeError('repository scope could not be validated')
  }
  return stat.size
}

function assertDirectory(path: string): void {
  assertNoLinkAncestors(path)
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new ScopeError('repository scope could not be validated')
  }
}

function canonicalDirectory(path: string): string {
  assertDirectory(path)
  return realpathSync.native(path)
}

function sameCanonicalPath(left: string, right: string): boolean {
  const a = realpathSync.native(left)
  const b = realpathSync.native(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function readBoundedFile(path: string, maxBytes: number): Buffer {
  assertNoLinkAncestors(path)
  const leaf = lstatSync(path)
  if (!leaf.isFile() || leaf.isSymbolicLink()) {
    throw new ScopeError('repository scope could not be validated')
  }
  const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW
  const descriptor = openSync(path, constants.O_RDONLY | noFollow)
  try {
    const stat = fstatSync(descriptor)
    if (!stat.isFile() || stat.size > maxBytes) {
      throw new ScopeError('repository scope could not be validated')
    }
    const buffer = Buffer.allocUnsafe(stat.size)
    let offset = 0
    while (offset < stat.size) {
      const read = readSync(descriptor, buffer, offset, stat.size - offset, offset)
      if (read <= 0) throw new ScopeError('repository scope could not be validated')
      offset += read
    }
    const extra = Buffer.allocUnsafe(1)
    if (readSync(descriptor, extra, 0, 1, stat.size) > 0) {
      throw new ScopeError('repository scope could not be validated')
    }
    return buffer
  } finally {
    closeSync(descriptor)
  }
}

function copyBoundedFile(source: string, destination: string, maxBytes: number): void {
  writeFileSync(destination, readBoundedFile(source, maxBytes))
}

function assertOptionalDirectory(path: string): void {
  if (metadataExists(path)) assertDirectory(path)
}

function assertOptionalRegular(path: string, maxBytes?: number): void {
  if (metadataExists(path)) assertRegularFile(path, maxBytes)
}

interface RepositoryScope {
  worktree: string
  gitDir: string
  commonDir: string
  config: string
  index: string
  objects: string
  refs: string
  head: string
  infoExclude: string
  infoAttributes: string
  linked: boolean
}

type ScopeResult = { ok: true; scope: RepositoryScope } | { ok: false; reason: string }

function assertNoExternalAlternates(objects: string): void {
  const info = join(objects, 'info')
  if (!metadataExists(info)) return
  assertDirectory(info)
  for (const name of ['alternates', 'http-alternates']) {
    const path = join(info, name)
    if (!metadataExists(path)) continue
    assertRegularFile(path, MAX_METADATA_BYTES)
    const text = readBoundedFile(path, MAX_METADATA_BYTES).toString('utf8')
    const meaningful = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
    if (meaningful.length > 0) {
      throw new ScopeError('repository object alternates are unsupported')
    }
  }
}

function assertObjectStore(objects: string): void {
  assertDirectory(objects)
  let names: string[]
  try {
    names = readdirSync(objects)
  } catch {
    throw new ScopeError('repository scope could not be validated')
  }
  for (const name of names) {
    if (name === 'info' || name === 'pack' || /^[0-9a-f]{2}$/.test(name)) {
      assertDirectory(join(objects, name))
    }
  }
  assertNoExternalAlternates(objects)
}

function assertNoSubmoduleState(worktree: string): void {
  if (metadataExists(join(worktree, '.gitmodules'))) {
    throw new ScopeError('repository submodule state is unsupported')
  }
}

function validateGitDirectories(scope: RepositoryScope): void {
  assertDirectory(scope.gitDir)
  assertDirectory(scope.commonDir)
  assertRegularFile(scope.config, MAX_CONFIG_BYTES)
  assertRegularFile(scope.head)
  assertRegularFile(join(scope.commonDir, 'HEAD'))
  assertObjectStore(scope.objects)
  assertDirectory(scope.refs)
  assertOptionalRegular(scope.index, MAX_INDEX_BYTES)
  assertOptionalDirectory(join(scope.commonDir, 'info'))
  assertOptionalDirectory(join(scope.gitDir, 'info'))
  assertOptionalDirectory(join(scope.gitDir, 'refs'))
  for (const directory of new Set([scope.gitDir, scope.commonDir])) {
    assertOptionalRegular(join(directory, 'packed-refs'))
    if (metadataExists(join(directory, 'config.worktree'))) {
      throw new ScopeError('worktree-specific repository configuration is unsupported')
    }
    let names: string[]
    try {
      names = readdirSync(directory)
    } catch {
      throw new ScopeError('repository scope could not be validated')
    }
    if (names.some((name) => name.startsWith('sharedindex.'))) {
      throw new ScopeError('repository split index is unsupported')
    }
  }
  if (scope.linked) {
    assertRegularFile(join(scope.gitDir, 'commondir'), MAX_POINTER_BYTES)
    assertRegularFile(join(scope.gitDir, 'gitdir'), MAX_POINTER_BYTES)
    if (metadataExists(join(scope.gitDir, 'config'))) {
      throw new ScopeError('repository scope could not be validated')
    }
  } else {
    for (const name of ['commondir', 'gitdir']) {
      if (metadataExists(join(scope.gitDir, name))) {
        throw new ScopeError('repository scope could not be validated')
      }
    }
  }
  for (const name of ['commondir', 'gitdir']) {
    if (metadataExists(join(scope.commonDir, name))) {
      throw new ScopeError('repository scope could not be validated')
    }
  }
}

function validateRepositoryScope(cwd: string): ScopeResult {
  try {
    const requested = resolve(cwd)
    const pointer = join(requested, '.git')
    assertNoLinkAncestors(pointer)
    if (!metadataExists(pointer)) {
      throw new ScopeError('approved checkout must be the repository worktree root')
    }
    const pointerStat = lstatSync(pointer)
    if (pointerStat.isSymbolicLink()) {
      throw new ScopeError('repository scope could not be validated')
    }
    if (pointerStat.isDirectory()) {
      const worktree = canonicalDirectory(requested)
      const gitDir = canonicalDirectory(pointer)
      const scope: RepositoryScope = {
        worktree,
        gitDir,
        commonDir: gitDir,
        config: join(gitDir, 'config'),
        index: join(gitDir, 'index'),
        objects: join(gitDir, 'objects'),
        refs: join(gitDir, 'refs'),
        head: join(gitDir, 'HEAD'),
        infoExclude: join(gitDir, 'info', 'exclude'),
        infoAttributes: join(gitDir, 'info', 'attributes'),
        linked: false,
      }
      validateGitDirectories(scope)
      assertNoSubmoduleState(worktree)
      return { ok: true, scope }
    }
    if (!pointerStat.isFile()) {
      throw new ScopeError('repository scope could not be validated')
    }
    const pointerText = readBoundedFile(pointer, MAX_POINTER_BYTES).toString('utf8')
    const match = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(pointerText)
    if (!match) throw new ScopeError('repository scope could not be validated')
    const admin = canonicalDirectory(resolve(requested, match[1]!))
    const commonLine = singleLine(readBoundedFile(join(admin, 'commondir'), MAX_POINTER_BYTES).toString('utf8'))
    if (commonLine === null) throw new ScopeError('repository scope could not be validated')
    const commonDir = canonicalDirectory(resolve(admin, commonLine))
    const worktreesDir = join(commonDir, 'worktrees')
    assertDirectory(worktreesDir)
    if (!sameCanonicalPath(dirname(admin), worktreesDir)) {
      throw new ScopeError('repository scope could not be validated')
    }
    const backlink = singleLine(readBoundedFile(join(admin, 'gitdir'), MAX_POINTER_BYTES).toString('utf8'))
    if (backlink === null || !sameCanonicalPath(resolve(admin, backlink), pointer)) {
      throw new ScopeError('repository scope could not be validated')
    }
    const worktree = canonicalDirectory(requested)
    const scope: RepositoryScope = {
      worktree,
      gitDir: admin,
      commonDir,
      config: join(commonDir, 'config'),
      index: join(admin, 'index'),
      objects: join(commonDir, 'objects'),
      refs: join(commonDir, 'refs'),
      head: join(admin, 'HEAD'),
      infoExclude: join(commonDir, 'info', 'exclude'),
      infoAttributes: join(commonDir, 'info', 'attributes'),
      linked: true,
    }
    validateGitDirectories(scope)
    assertNoSubmoduleState(worktree)
    return { ok: true, scope }
  } catch (error) {
    if (error instanceof ScopeError) return { ok: false, reason: error.reason }
    return { ok: false, reason: 'repository scope could not be validated' }
  }
}

type ConfigEntries = Map<string, string[]>

function configValue(entries: ConfigEntries, key: string): string | undefined {
  return entries.get(key.toLowerCase())?.at(-1)
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined
  switch (value.trim().toLowerCase()) {
    case 'true':
    case 'yes':
    case 'on':
    case '1':
      return true
    case 'false':
    case 'no':
    case 'off':
    case '0':
    case '':
      return false
    default:
      return undefined
  }
}

type RepositoryConfigResult = { ok: true; entries: ConfigEntries } | { ok: false; reason: string }

function readRepositoryConfig(
  gitExecutable: string,
  cwd: string,
  snapshotPath: string,
  env: NodeJS.ProcessEnv,
  deadline: number,
): RepositoryConfigResult {
  const result = runGit(
    gitExecutable,
    cwd,
    ['config', '--file', snapshotPath, '--no-includes', '--null', '--list'],
    env,
    deadline,
  )
  if (!result.ok) {
    return {
      ok: false,
      reason: result.timedOut ? 'workspace inspection timed out' : 'repository configuration could not be inspected',
    }
  }
  const entries: ConfigEntries = new Map()
  for (const record of result.stdout.split('\0')) {
    if (record.length === 0) continue
    const separator = record.indexOf('\n')
    const key = (separator === -1 ? record : record.slice(0, separator)).toLowerCase()
    const value = separator === -1 ? '' : record.slice(separator + 1)
    const values = entries.get(key)
    if (values) values.push(value)
    else entries.set(key, [value])
  }
  return { ok: true, entries }
}

type ConfigGateResult = { ok: true } | { ok: false; reason: string }

function inspectRepositoryConfig(entries: ConfigEntries): ConfigGateResult {
  for (const key of entries.keys()) {
    if (REPOSITORY_INCLUDE_KEY.test(key)) {
      return { ok: false, reason: 'repository include configuration is unsupported' }
    }
    if (REPOSITORY_FILTER_KEY.test(key)) {
      return { ok: false, reason: 'repository filter configuration is unsupported' }
    }
  }
  const sparse =
    parseBoolean(configValue(entries, 'core.sparsecheckout')) === true ||
    parseBoolean(configValue(entries, 'extensions.sparseindex')) === true
  if (sparse) {
    return { ok: false, reason: 'repository sparse-checkout configuration is unsupported' }
  }
  const refStorage = configValue(entries, 'extensions.refstorage')
  if (refStorage !== undefined && refStorage.trim().toLowerCase() !== 'files') {
    return { ok: false, reason: 'repository ref storage is unsupported' }
  }
  if (configValue(entries, 'extensions.compatobjectformat') !== undefined) {
    return { ok: false, reason: 'repository compatibility object format is unsupported' }
  }
  if (configValue(entries, 'extensions.partialclone') !== undefined) {
    return { ok: false, reason: 'repository partial-clone configuration is unsupported' }
  }
  for (const key of entries.keys()) {
    if (!key.startsWith('extensions.')) continue
    if (!ALLOWED_EXTENSIONS.has(key.slice('extensions.'.length))) {
      return { ok: false, reason: 'repository extensions are unsupported' }
    }
  }
  const objectFormat = configValue(entries, 'extensions.objectformat')?.trim().toLowerCase()
  if (objectFormat !== undefined && objectFormat !== 'sha1') {
    return { ok: false, reason: 'repository object format is unsupported' }
  }
  const formatVersion = configValue(entries, 'core.repositoryformatversion')?.trim()
  if (formatVersion !== undefined && formatVersion !== '' && formatVersion !== '0' && formatVersion !== '1') {
    return { ok: false, reason: 'repository format version is unsupported' }
  }
  return { ok: true }
}

type HeadResult = { ok: true; head: string } | { ok: false; reason: string }

function resolveHead(
  gitExecutable: string,
  scope: RepositoryScope,
  env: NodeJS.ProcessEnv,
  deadline: number,
): HeadResult {
  const prefix = ['--git-dir', scope.gitDir, '--work-tree', scope.worktree]
  const head = runGit(
    gitExecutable,
    scope.worktree,
    [...prefix, 'rev-parse', '--verify', '--quiet', 'HEAD'],
    env,
    deadline,
    [1],
  )
  if (!head.ok) {
    return {
      ok: false,
      reason: head.timedOut ? 'workspace inspection timed out' : 'repository HEAD could not be inspected',
    }
  }
  const commit = singleLine(head.stdout)
  if (commit !== null) {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(commit)) {
      return { ok: false, reason: 'repository HEAD could not be inspected' }
    }
    return { ok: true, head: `${commit}\n` }
  }
  const symbolic = runGit(gitExecutable, scope.worktree, [...prefix, 'symbolic-ref', 'HEAD'], env, deadline, [1])
  if (!symbolic.ok) {
    return {
      ok: false,
      reason: symbolic.timedOut ? 'workspace inspection timed out' : 'repository HEAD could not be inspected',
    }
  }
  const ref = singleLine(symbolic.stdout)
  if (ref === null || !ref.startsWith('refs/') || /\s/.test(ref)) {
    return { ok: false, reason: 'repository HEAD could not be inspected' }
  }
  return { ok: true, head: `ref: ${ref}\n` }
}

function normalizeAutocrlf(value: string | undefined): 'true' | 'input' | 'false' | undefined {
  if (value === undefined) return undefined
  if (value.trim().toLowerCase() === 'input') return 'input'
  const parsed = parseBoolean(value)
  if (parsed === undefined) return undefined
  return parsed ? 'true' : 'false'
}

function normalizeEol(value: string | undefined): 'lf' | 'crlf' | 'native' | undefined {
  const normalized = value?.trim().toLowerCase()
  return normalized === 'lf' || normalized === 'crlf' || normalized === 'native' ? normalized : undefined
}

function normalizeSafecrlf(value: string | undefined): 'true' | 'false' | 'warn' | undefined {
  if (value?.trim().toLowerCase() === 'warn') return 'warn'
  const parsed = parseBoolean(value)
  if (parsed === undefined) return undefined
  return parsed ? 'true' : 'false'
}

function quoteConfigPath(value: string): string {
  return `"${value.replace(/\\/g, '/').replace(/"/g, '\\"')}"`
}

interface IsolatedRepository {
  gitDir: string
  worktree: string
  objects: string
  indexFile: string
  localSentinel: string
}

type IsolatedRepositoryResult = { ok: true; repository: IsolatedRepository } | { ok: false; reason: string }

function buildIsolatedConfig(
  entries: ConfigEntries,
  tempRoot: string,
  formatVersion: number,
  localSentinel: string,
): string {
  const attributesFile = join(tempRoot, 'empty.attributes')
  const excludesFile = join(tempRoot, 'empty.excludes')
  writeFileSync(attributesFile, '')
  writeFileSync(excludesFile, '')

  const ignorecase =
    process.platform === 'win32' || process.platform === 'darwin'
      ? true
      : (parseBoolean(configValue(entries, 'core.ignorecase')) ?? false)
  const lines = [
    '[core]',
    `\trepositoryformatversion = ${formatVersion}`,
    '\tbare = false',
    `\tfilemode = ${process.platform !== 'win32'}`,
    `\tignorecase = ${ignorecase}`,
    `\tsymlinks = ${process.platform !== 'win32'}`,
    `\tprecomposeunicode = ${process.platform === 'darwin'}`,
    '\tprotectntfs = true',
    '\tprotecthfs = true',
    '\tquotepath = true',
    '\tfsmonitor = false',
    '\tuntrackedcache = false',
    `\tattributesfile = ${quoteConfigPath(attributesFile)}`,
    `\texcludesfile = ${quoteConfigPath(excludesFile)}`,
  ]
  const autocrlf = normalizeAutocrlf(configValue(entries, 'core.autocrlf'))
  if (autocrlf !== undefined) lines.push(`\tautocrlf = ${autocrlf}`)
  const eol = normalizeEol(configValue(entries, 'core.eol'))
  if (eol !== undefined) lines.push(`\teol = ${eol}`)
  const safecrlf = normalizeSafecrlf(configValue(entries, 'core.safecrlf'))
  if (safecrlf !== undefined) lines.push(`\tsafecrlf = ${safecrlf}`)
  lines.push('[babelWorkspaceInspection]', `\tisolatedRepositoryConfig = ${localSentinel}`)
  return `${lines.join('\n')}\n`
}

function createIsolatedRepository(
  tempRoot: string,
  scope: RepositoryScope,
  entries: ConfigEntries,
  head: string,
): IsolatedRepositoryResult {
  const formatVersion = configValue(entries, 'core.repositoryformatversion')?.trim() === '1' ? 1 : 0
  const gitDir = join(tempRoot, 'repository.git')
  const indexFile = join(gitDir, 'index')
  const localSentinel = randomBytes(16).toString('hex')
  try {
    mkdirSync(join(gitDir, 'info'), { recursive: true })
    mkdirSync(join(gitDir, 'objects'), { recursive: true })
    mkdirSync(join(gitDir, 'refs', 'heads'), { recursive: true })
    writeFileSync(join(gitDir, 'HEAD'), head)
    writeFileSync(join(gitDir, 'config'), buildIsolatedConfig(entries, tempRoot, formatVersion, localSentinel))
    if (metadataExists(scope.index)) {
      copyBoundedFile(scope.index, indexFile, MAX_INDEX_BYTES)
    }
    for (const [source, name] of [
      [scope.infoExclude, 'exclude'],
      [scope.infoAttributes, 'attributes'],
    ] as const) {
      if (metadataExists(source)) copyBoundedFile(source, join(gitDir, 'info', name), MAX_METADATA_BYTES)
    }
  } catch {
    return { ok: false, reason: 'repository metadata could not be isolated' }
  }
  return {
    ok: true,
    repository: {
      gitDir,
      worktree: scope.worktree,
      objects: scope.objects,
      indexFile,
      localSentinel,
    },
  }
}

function buildIsolatedGitEnvironment(base: NodeJS.ProcessEnv, repository: IsolatedRepository): NodeJS.ProcessEnv {
  return {
    ...base,
    GIT_DIR: repository.gitDir,
    GIT_WORK_TREE: repository.worktree,
    GIT_OBJECT_DIRECTORY: repository.objects,
    GIT_INDEX_FILE: repository.indexFile,
    GIT_ATTR_NOSYSTEM: '1',
  }
}

interface ParsedStatus {
  files: WorkspaceFileChange[]
  untracked: string[]
}

function parseStatusOutput(output: string): ParsedStatus {
  const records = output.split('\0')
  const files: WorkspaceFileChange[] = []
  const untracked: string[] = []
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (!record || record.length < 3) continue
    const status = record.slice(0, 2)
    const path = record.slice(3)
    if (path.length === 0) continue
    files.push({ status: status.trim() || 'M', path })
    if (status === '??') untracked.push(path)
    if (status.includes('R') || status.includes('C')) index += 1
  }
  return { files, untracked }
}

type UntrackedSnapshotResult = { ok: true; label: string; snapshotPath: string } | { ok: false; reason: string }

function untrackedPathFailure(): UntrackedSnapshotResult {
  return { ok: false, reason: 'untracked path is not a regular in-scope file' }
}

function validateUntrackedPath(
  worktree: string,
  untrackedPath: string,
  snapshotDirectory: string,
  sequence: number,
): UntrackedSnapshotResult {
  if (
    untrackedPath.length === 0 ||
    untrackedPath.endsWith('/') ||
    untrackedPath.startsWith('/') ||
    (process.platform === 'win32' && (untrackedPath.includes('\\') || /^[A-Za-z]:/.test(untrackedPath)))
  ) {
    return untrackedPathFailure()
  }
  const components = untrackedPath.split('/')
  if (
    components.some(
      (component) =>
        component.length === 0 || component === '.' || component === '..' || component.toLowerCase() === '.git',
    )
  ) {
    return untrackedPathFailure()
  }
  const candidate = resolve(worktree, ...components)
  const relativePath = relative(worktree, candidate)
  if (
    relativePath.length === 0 ||
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    return untrackedPathFailure()
  }
  try {
    assertNoLinkAncestors(candidate)
  } catch {
    return untrackedPathFailure()
  }
  try {
    let current = worktree
    for (const component of components.slice(0, -1)) {
      current = join(current, component)
      if (
        metadataExists(join(current, '.git')) ||
        (metadataExists(join(current, 'HEAD')) &&
          metadataExists(join(current, 'objects')) &&
          metadataExists(join(current, 'refs')))
      ) {
        return { ok: false, reason: 'embedded repositories are unsupported' }
      }
    }
  } catch {
    return untrackedPathFailure()
  }
  let stat
  try {
    stat = lstatSync(candidate)
  } catch {
    return untrackedPathFailure()
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return untrackedPathFailure()
  if (stat.nlink > 1) {
    return { ok: false, reason: 'hardlinked untracked paths are unsupported' }
  }
  if (stat.size > MAX_OUTPUT_BYTES) {
    return { ok: false, reason: 'workspace diff output limit exceeded' }
  }
  const snapshotPath = join(snapshotDirectory, String(sequence))
  try {
    copyBoundedFile(candidate, snapshotPath, MAX_OUTPUT_BYTES)
    const after = lstatSync(candidate)
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      after.nlink > 1 ||
      after.nlink !== stat.nlink ||
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      (stat.ino !== 0 && after.ino !== 0 && stat.ino !== after.ino)
    ) {
      return untrackedPathFailure()
    }
  } catch {
    return untrackedPathFailure()
  }
  return { ok: true, label: untrackedPath, snapshotPath }
}

function encodeDiffPath(path: string): string {
  return JSON.stringify(path)
}

/** Testable pure sanitizer for reconstructed no-index diff headers. */
export function sanitizeNoIndexDiff(raw: string, path: string): string {
  if (raw.length === 0) return ''
  const encodedLabel = encodeDiffPath(path)
  const lines = raw.split(/\r?\n/)
  const headerEnd = lines.findIndex(
    (line) =>
      line.startsWith('@@') ||
      line.startsWith('GIT binary patch') ||
      line.startsWith('Binary files ') ||
      line.startsWith('Files '),
  )
  const limit = headerEnd === -1 ? lines.length : headerEnd
  for (let index = 0; index < limit; index += 1) {
    const line = lines[index]!
    if (line.startsWith('diff --git ')) {
      lines[index] = `diff --git a/${encodedLabel} b/${encodedLabel}`
    } else if (line.startsWith('--- ')) {
      lines[index] = '--- /dev/null'
    } else if (line.startsWith('+++ ')) {
      lines[index] = `+++ b/${encodedLabel}`
    }
  }
  if (headerEnd !== -1) {
    const line = lines[headerEnd]!
    if (line.startsWith('Binary files ') || line.startsWith('Files ')) {
      lines[headerEnd] = `Binary files /dev/null and ${encodedLabel} differ`
    }
  }
  return lines.join('\n')
}

export function collectWorkspaceChanges(
  cwd: string,
  options: { env?: NodeJS.ProcessEnv } = {},
): WorkspaceChangeSnapshot {
  const created = (() => {
    try {
      return mkdtempSync(join(tmpdir(), 'babel-safe-git-'))
    } catch {
      return null
    }
  })()
  if (created === null) return unavailable('workspace inspection unavailable')
  const tempRoot = created
  const deadline = Date.now() + MAX_TOTAL_TIME_MS
  try {
    const gitExecutable = resolveTrustedGitExecutable()
    if (gitExecutable === null) {
      return unavailable('trusted Git installation could not be resolved')
    }

    const scopeResult = validateRepositoryScope(cwd)
    if (!scopeResult.ok) return unavailable(scopeResult.reason)
    const scope = scopeResult.scope

    const globalConfig = join(tempRoot, 'global.gitconfig')
    const systemConfig = join(tempRoot, 'system.gitconfig')
    const sentinel = randomBytes(16).toString('hex')
    writeFileSync(globalConfig, `[babelWorkspaceInspection]\n\tconfigBoundarySentinel = ${sentinel}\n`)
    writeFileSync(systemConfig, '')
    const env = buildReadOnlyGitEnvironment(options.env ?? process.env, globalConfig, systemConfig)

    const configSnapshot = join(tempRoot, 'repository.config')
    try {
      copyBoundedFile(scope.config, configSnapshot, MAX_CONFIG_BYTES)
    } catch {
      return unavailable('repository configuration could not be isolated')
    }
    const repositoryConfig = readRepositoryConfig(gitExecutable, scope.worktree, configSnapshot, env, deadline)
    if (!repositoryConfig.ok) return unavailable(repositoryConfig.reason)
    const configGate = inspectRepositoryConfig(repositoryConfig.entries)
    if (!configGate.ok) return unavailable(configGate.reason)

    const head = resolveHead(gitExecutable, scope, env, deadline)
    if (!head.ok) return unavailable(head.reason)

    const isolated = createIsolatedRepository(tempRoot, scope, repositoryConfig.entries, head.head)
    if (!isolated.ok) return unavailable(isolated.reason)
    const repository = isolated.repository
    const isolatedEnv = buildIsolatedGitEnvironment(env, repository)

    // The execution boundary must be the private config, not the repository's.
    const globalBoundary = runGit(
      gitExecutable,
      scope.worktree,
      ['config', '--get', WORKSPACE_CHANGE_CONFIG_SENTINEL_KEY],
      isolatedEnv,
      deadline,
      [1],
    )
    const localBoundary = runGit(
      gitExecutable,
      scope.worktree,
      ['config', '--get', WORKSPACE_CHANGE_ISOLATED_SENTINEL_KEY],
      isolatedEnv,
      deadline,
      [1],
    )
    if (!globalBoundary.ok || globalBoundary.stdout.trim() !== sentinel) {
      return unavailable(
        globalBoundary.timedOut ? 'workspace inspection timed out' : 'Git configuration boundary could not be verified',
      )
    }
    if (!localBoundary.ok || localBoundary.stdout.trim() !== repository.localSentinel) {
      return unavailable(
        localBoundary.timedOut ? 'workspace inspection timed out' : 'Git configuration boundary could not be verified',
      )
    }

    const stagedEntries = runGit(gitExecutable, scope.worktree, ['ls-files', '--stage', '-z'], isolatedEnv, deadline)
    if (!stagedEntries.ok) {
      return unavailable(
        stagedEntries.timedOut
          ? 'workspace inspection timed out'
          : stagedEntries.outputLimit
            ? 'repository index output limit exceeded'
            : 'repository index could not be inspected',
      )
    }
    if (stagedEntries.stdout.split('\0').some((record) => record.startsWith('160000 '))) {
      return unavailable('repository submodule state is unsupported')
    }

    const status = runGit(
      gitExecutable,
      scope.worktree,
      ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all'],
      isolatedEnv,
      deadline,
    )
    if (!status.ok) {
      return unavailable(
        status.timedOut
          ? 'workspace inspection timed out'
          : status.outputLimit
            ? 'workspace status output limit exceeded'
            : 'git status unavailable',
      )
    }

    const parsed = parseStatusOutput(status.stdout)
    if (parsed.files.length > MAX_FILES) return unavailable('workspace file limit exceeded')
    if (parsed.untracked.length > MAX_UNTRACKED_FILES) {
      return unavailable('untracked file limit exceeded')
    }

    const parts: string[] = []
    const reasons: string[] = []
    let totalDiffBytes = 0
    const appendDiff = (diff: string): boolean => {
      const addition = Buffer.byteLength(diff, 'utf8') + (parts.length > 0 ? 2 : 0)
      if (totalDiffBytes + addition > MAX_OUTPUT_BYTES) return false
      parts.push(diff)
      totalDiffBytes += addition
      return true
    }
    const diffArgs = ['--no-ext-diff', '--no-textconv', '--no-color', '--ignore-submodules=all']
    const unstaged = runGit(gitExecutable, scope.worktree, ['diff', ...diffArgs, '--', '.'], isolatedEnv, deadline)
    if (unstaged.ok && unstaged.stdout.trim()) {
      if (!appendDiff(unstaged.stdout.trim())) {
        return unavailable('workspace diff output limit exceeded')
      }
    } else if (!unstaged.ok) {
      if (unstaged.timedOut) return unavailable('workspace inspection timed out')
      if (unstaged.outputLimit) return unavailable('workspace diff output limit exceeded')
      reasons.push('unstaged diff unavailable')
    }
    const staged = runGit(
      gitExecutable,
      scope.worktree,
      ['diff', '--cached', ...diffArgs, '--', '.'],
      isolatedEnv,
      deadline,
    )
    if (staged.ok && staged.stdout.trim()) {
      if (!appendDiff(staged.stdout.trim())) return unavailable('workspace diff output limit exceeded')
    } else if (!staged.ok) {
      if (staged.timedOut) return unavailable('workspace inspection timed out')
      if (staged.outputLimit) return unavailable('workspace diff output limit exceeded')
      reasons.push('staged diff unavailable')
    }

    const snapshotDirectory = join(tempRoot, 'untracked')
    mkdirSync(snapshotDirectory, { recursive: true })
    let untrackedSequence = 0
    for (const path of parsed.untracked) {
      const validated = validateUntrackedPath(scope.worktree, path, snapshotDirectory, untrackedSequence)
      untrackedSequence += 1
      if (!validated.ok) return unavailable(validated.reason)
      const fileDiff = runGit(
        gitExecutable,
        scope.worktree,
        [
          'diff',
          '--no-index',
          '--no-ext-diff',
          '--no-textconv',
          '--no-color',
          '--',
          '/dev/null',
          validated.snapshotPath,
        ],
        isolatedEnv,
        deadline,
        [1],
      )
      if (fileDiff.ok) {
        const body = sanitizeNoIndexDiff(fileDiff.stdout.trim(), validated.label)
        if (!appendDiff(`# Untracked file: ${encodeDiffPath(validated.label)}\n${body}`)) {
          return unavailable('workspace diff output limit exceeded')
        }
      } else {
        return unavailable(
          fileDiff.timedOut
            ? 'workspace inspection timed out'
            : fileDiff.outputLimit
              ? 'workspace diff output limit exceeded'
              : 'untracked diff unavailable',
        )
      }
    }

    if (parsed.files.length > 0 && parts.length === 0) {
      return unavailable('workspace diff unavailable')
    }

    const reason = reasons.length > 0 ? `${reasons.join('; ')}; showing the diff that is available` : undefined
    return {
      available: true,
      files: parsed.files,
      diff: parts.join('\n\n'),
      ...(reason !== undefined ? { reason } : {}),
    }
  } catch {
    return unavailable('workspace inspection unavailable')
  } finally {
    try {
      rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch {
      // Cleanup failure must not leak a temporary path into the remote error.
    }
  }
}

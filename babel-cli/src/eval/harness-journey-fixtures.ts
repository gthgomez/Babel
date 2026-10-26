/** Disposable fixture preparation; protected baselines never enter candidate roots. */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { JourneySpecSchema, type JourneySpec } from './harness-journey-contract.js'
import { isCredentialTargetPath } from '../authority/protectedPath.js'

const FileMap = z.record(z.string(), z.string())
export const JourneyFixtureSchema = z.object({
  git: z.boolean(), files: FileMap, dirtyFiles: FileMap, untrackedFiles: FileMap,
  siblings: z.record(z.string(), FileMap), rootName: z.string().optional(), binaryFiles: FileMap.optional(),
  history: z.array(FileMap).optional(), siblingHistories: z.record(z.string(), z.array(FileMap)).optional(), workspaceLayout: z.boolean().optional(),
}).strict()
export type JourneyFixture = z.infer<typeof JourneyFixtureSchema>
const CorpusSchema = z.object({
  schemaVersion: z.literal(1),
  journeys: z.array(JourneySpecSchema),
  fixtures: z.record(z.string(), JourneyFixtureSchema),
  controls: z.array(z.object({ id: z.string(), name: z.string(), oracle: z.string(), ownerTasks: z.array(z.string()) }).strict()),
}).strict()
export type JourneyCorpus = z.infer<typeof CorpusSchema>
export interface PreparedJourneyFixture {
  id: string
  candidateRoot: string
  workingDirectory: string
  protectedRoot: string
  files: { path: string; sha256: string }[]
  gitHead: string | null
  gitBaselineHead: string | null
  gitStatus: string | null
  gitMetadataDigest: string | null
  siblingRepositories: Record<string, { root: string; head: string; baselineHead: string; metadataDigest: string }>
}

function safePath(path: string): void {
  if (!path || isAbsolute(path) || /[:\\\x00-\x1f]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error('Expected safe relative fixture path')
  }
}

function validateFixture(fixture: JourneyFixture): void {
  safePath(fixture.rootName ?? 'candidate')
  if ((fixture.rootName ?? 'candidate').includes('/') || ['protected', 'adjacent'].includes((fixture.rootName ?? '').toLowerCase())) throw new Error('Expected safe relative fixture path')
  const history = fixture.history ?? []
  if (history.length && !fixture.git) throw new Error('Fixture history requires Git')
  for (const name of Object.keys(fixture.siblingHistories ?? {})) if (!Object.hasOwn(fixture.siblings, name)) throw new Error('Sibling history requires an existing fixture sibling')
  for (const files of [fixture.files, fixture.dirtyFiles, fixture.untrackedFiles, fixture.binaryFiles ?? {}, ...Object.values(fixture.siblings), ...history, ...Object.values(fixture.siblingHistories ?? {}).flat()]) {
    for (const path of Object.keys(files)) safePath(path)
  }
  for (const sibling of Object.keys(fixture.siblings)) {
    safePath(sibling)
    if (sibling.includes('/')) throw new Error('Expected safe relative fixture path')
  }
  const siblingNames = Object.keys(fixture.siblings).map(name => name.normalize('NFC').toLowerCase())
  if (new Set(siblingNames).size !== siblingNames.length) throw new Error('Fixture sibling name collision')
  if (fixture.workspaceLayout && siblingNames.includes((fixture.rootName ?? 'candidate').toLowerCase())) throw new Error('Fixture sibling name collision')
  for (const path of Object.keys(fixture.dirtyFiles)) if (!(path in fixture.files)) throw new Error('Dirty fixture path must be tracked at baseline')
  for (const path of Object.keys(fixture.untrackedFiles)) if (path in fixture.files || path in fixture.dirtyFiles) throw new Error('Untracked fixture path overlaps tracked file')
  for (const [path, contents] of Object.entries(fixture.binaryFiles ?? {})) {
    if (path in fixture.files || path in fixture.dirtyFiles || path in fixture.untrackedFiles) throw new Error('Binary fixture path overlaps text file')
    if (Buffer.from(contents, 'base64').toString('base64') !== contents) throw new Error('Invalid fixture base64')
  }
  for (const paths of [
    [...new Set([...Object.keys(fixture.files), ...history.flatMap(change => Object.keys(change)), ...Object.keys(fixture.untrackedFiles), ...Object.keys(fixture.binaryFiles ?? {})])],
    ...Object.entries(fixture.siblings).map(([name, files]) => [...new Set([...Object.keys(files), ...(fixture.siblingHistories?.[name] ?? []).flatMap(change => Object.keys(change))])]),
  ]) {
    const folded = paths.map(path => path.normalize('NFC').toLowerCase())
    if (new Set(folded).size !== folded.length || folded.some(path => folded.some(other => other.startsWith(`${path}/`)))) throw new Error('Fixture path collision')
  }
  for (const change of history) for (const path of Object.keys(change)) if (path in (fixture.binaryFiles ?? {})) throw new Error('Binary fixture path overlaps history')
}

/** Read generic public data only; no implicit credential or private corpus loading. */
export async function readJourneyCorpus(path: string): Promise<JourneyCorpus> {
  const corpus = CorpusSchema.parse(JSON.parse(await readFile(path, 'utf8')))
  if (new Set(corpus.journeys.map(row => row.id)).size !== corpus.journeys.length || new Set(corpus.controls.map(row => row.id)).size !== corpus.controls.length) throw new Error('Duplicate corpus id')
  if (new Set(corpus.journeys.map(row => row.id.toLowerCase())).size !== corpus.journeys.length) throw new Error('Portable journey id collision')
  for (const fixture of Object.values(corpus.fixtures)) validateFixture(fixture)
  for (const spec of corpus.journeys) if (!corpus.fixtures[spec.fixtureId]) throw new Error('Missing journey fixture')
  return corpus
}

async function materialize(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, contents, 'utf8')
  }
}

// Fixture-only Git commands run in newly created disposable repos. Check every
// exit code, disable hooks/config/prompting, and never mutate a user repository.
function git(root: string, args: string[]): string {
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=/dev/null', '-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', '-c', 'user.name=Journey Fixture', '-c', 'user.email=fixture@example.invalid', ...args], {
    cwd: root, encoding: 'utf8', timeout: 10_000, windowsHide: true,
    env: { PATH: process.env['PATH'], SystemRoot: process.env['SystemRoot'], TEMP: process.env['TEMP'], TMP: process.env['TMP'], GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_ATTR_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
  })
  if (result.error || result.status !== 0) throw new Error(`Fixture git ${args[0]} failed (exit ${result.status ?? 'unknown'})`)
  return result.stdout
}

async function fixtureMetadataDigest(root: string): Promise<string> {
  const metadataRoot = join(root, '.git')
  const directory = await lstat(metadataRoot)
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Expected owned fixture Git directory')
  const entries: [string, string][] = []
  let byteCount = 0
  async function collect(relative: string): Promise<void> {
    for (const entry of (await readdir(join(root, '.git', relative), { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const path = relative ? `${relative}/${entry.name}` : entry.name
      if (entries.length >= 2048 || entry.isSymbolicLink() || isCredentialTargetPath(path)) throw new Error('Unsafe fixture Git metadata')
      if (entry.isDirectory()) { entries.push([`${path}/`, 'directory']); await collect(path) }
      else if (entry.isFile()) {
        const info = await lstat(join(metadataRoot, path))
        if (!info.isFile() || info.nlink > 1 || info.size + byteCount > 16_777_216) throw new Error('Unsafe fixture Git metadata file')
        const bytes = await readFile(join(root, '.git', path))
        byteCount += bytes.length
        if (byteCount > 16_777_216 || entries.length >= 2048) throw new Error('Fixture Git metadata exceeds capture limit')
        entries.push([path, createHash('sha256').update(bytes).digest('hex')])
      } else throw new Error('Unsupported fixture Git metadata')
    }
  }
  await collect('')
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex')
}

/** Stop all writers first. Protected digest must come from fresh fixture preparation. */
export async function captureJourneyGitState(root: string, expectedMetadataDigest: string): Promise<{ head: string; porcelainStatus: string; metadataDigest: string }> {
  if (!/^[a-f0-9]{64}$/.test(expectedMetadataDigest)) throw new Error('Protected fixture metadata digest is required')
  const metadataDigest = await fixtureMetadataDigest(root)
  // Never ask host Git to interpret a changed config/include/filter. Equality
  // binds to our generated baseline, whose config has no external execution.
  if (metadataDigest !== expectedMetadataDigest) return { head: '', porcelainStatus: 'not_observed:metadata_changed', metadataDigest }
  const metadataRoot = join(root, '.git')
  const selection = [`--git-dir=${metadataRoot}`, `--work-tree=${root}`]
  const head = git(root, [...selection, 'rev-parse', 'HEAD']).trim()
  const porcelainStatus = git(root, [...selection, 'status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=all'])
  return { head, porcelainStatus, metadataDigest }
}

async function history(root: string, changes: readonly Record<string, string>[]): Promise<{ baselineHead: string; head: string }> {
  git(root, ['init', '--initial-branch=main'])
  git(root, ['add', '--all'])
  git(root, ['commit', '--allow-empty', '-m', 'Synthetic baseline'])
  const baselineHead = git(root, ['rev-parse', 'HEAD']).trim()
  git(root, ['tag', 'supplied-baseline'])
  for (const change of changes) {
    await materialize(root, change)
    git(root, ['add', '--all'])
    git(root, ['commit', '--allow-empty', '-m', 'Synthetic history change'])
  }
  return { baselineHead, head: git(root, ['rev-parse', 'HEAD']).trim() }
}

/** Create a new fixture root only; existing evidence is never overwritten. */
export async function prepareJourneyFixture(spec: JourneySpec, input: JourneyFixture, root: string): Promise<PreparedJourneyFixture> {
  JourneySpecSchema.parse(spec)
  const fixture = JourneyFixtureSchema.parse(input)
  validateFixture(fixture)
  await mkdir(root)
  const workspaceRoot = fixture.workspaceLayout ? join(root, 'workspace') : root
  const candidateRoot = join(workspaceRoot, fixture.rootName ?? 'candidate')
  const protectedRoot = join(root, 'protected')
  await mkdir(candidateRoot, { recursive: true })
  await mkdir(protectedRoot)
  await materialize(candidateRoot, fixture.files)
  for (const [path, contents] of Object.entries(fixture.binaryFiles ?? {})) {
    await mkdir(dirname(join(candidateRoot, path)), { recursive: true })
    await writeFile(join(candidateRoot, path), Buffer.from(contents, 'base64'))
  }
  let gitHead: string | null = null
  let gitBaselineHead: string | null = null
  if (fixture.git) {
    const repository = await history(candidateRoot, fixture.history ?? [])
    gitHead = repository.head
    gitBaselineHead = repository.baselineHead
  }
  await materialize(candidateRoot, fixture.dirtyFiles)
  await materialize(candidateRoot, fixture.untrackedFiles)
  const siblingRepositories: PreparedJourneyFixture['siblingRepositories'] = {}
  for (const [name, files] of Object.entries(fixture.siblings)) {
    const siblingRoot = fixture.workspaceLayout ? join(workspaceRoot, name) : join(root, 'adjacent', name)
    await materialize(siblingRoot, files)
    const changes = fixture.siblingHistories?.[name]
    if (changes) {
      const repository = await history(siblingRoot, changes)
      siblingRepositories[name] = { root: siblingRoot, ...repository, metadataDigest: await fixtureMetadataDigest(siblingRoot) }
    }
  }
  const currentFiles = Object.assign({}, fixture.files, ...(fixture.history ?? []), fixture.dirtyFiles, fixture.untrackedFiles) as Record<string, string>
  const files = Object.entries(currentFiles).map(([path, contents]) => ({ path, sha256: createHash('sha256').update(contents).digest('hex') }))
  for (const [path, contents] of Object.entries(fixture.binaryFiles ?? {})) files.push({ path, sha256: createHash('sha256').update(Buffer.from(contents, 'base64')).digest('hex') })
  const gitStatus = fixture.git ? git(candidateRoot, ['status', '--porcelain=v1', '--untracked-files=all']) : null
  const gitMetadataDigest = fixture.git ? await fixtureMetadataDigest(candidateRoot) : null
  const prepared = { id: spec.id, candidateRoot, workingDirectory: fixture.workspaceLayout ? workspaceRoot : candidateRoot, protectedRoot, files, gitHead, gitBaselineHead, gitStatus, gitMetadataDigest, siblingRepositories }
  await writeFile(join(protectedRoot, 'baseline.json'), JSON.stringify(prepared, null, 2), { flag: 'wx' })
  return prepared
}

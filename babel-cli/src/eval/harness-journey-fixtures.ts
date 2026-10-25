/** Disposable fixture preparation; protected baselines never enter candidate roots. */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { JourneySpecSchema, type JourneySpec } from './harness-journey-contract.js'

const FileMap = z.record(z.string(), z.string())
export const JourneyFixtureSchema = z.object({
  git: z.boolean(), files: FileMap, dirtyFiles: FileMap, untrackedFiles: FileMap,
  siblings: z.record(z.string(), FileMap), rootName: z.string().optional(), binaryFiles: FileMap.optional(),
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
  protectedRoot: string
  files: { path: string; sha256: string }[]
  gitHead: string | null
  gitStatus: string | null
}

function safePath(path: string): void {
  if (!path || isAbsolute(path) || /[:\\\x00-\x1f]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error('Expected safe relative fixture path')
  }
}

function validateFixture(fixture: JourneyFixture): void {
  safePath(fixture.rootName ?? 'candidate')
  if ((fixture.rootName ?? 'candidate').includes('/') || ['protected', 'adjacent'].includes((fixture.rootName ?? '').toLowerCase())) throw new Error('Expected safe relative fixture path')
  for (const files of [fixture.files, fixture.dirtyFiles, fixture.untrackedFiles, fixture.binaryFiles ?? {}, ...Object.values(fixture.siblings)]) {
    for (const path of Object.keys(files)) safePath(path)
  }
  for (const sibling of Object.keys(fixture.siblings)) {
    safePath(sibling)
    if (sibling.includes('/')) throw new Error('Expected safe relative fixture path')
  }
  const siblingNames = Object.keys(fixture.siblings).map(name => name.normalize('NFC').toLowerCase())
  if (new Set(siblingNames).size !== siblingNames.length) throw new Error('Fixture sibling name collision')
  for (const path of Object.keys(fixture.dirtyFiles)) if (!(path in fixture.files)) throw new Error('Dirty fixture path must be tracked at baseline')
  for (const path of Object.keys(fixture.untrackedFiles)) if (path in fixture.files || path in fixture.dirtyFiles) throw new Error('Untracked fixture path overlaps tracked file')
  for (const [path, contents] of Object.entries(fixture.binaryFiles ?? {})) {
    if (path in fixture.files || path in fixture.dirtyFiles || path in fixture.untrackedFiles) throw new Error('Binary fixture path overlaps text file')
    if (Buffer.from(contents, 'base64').toString('base64') !== contents) throw new Error('Invalid fixture base64')
  }
  for (const paths of [
    [...Object.keys(fixture.files), ...Object.keys(fixture.untrackedFiles), ...Object.keys(fixture.binaryFiles ?? {})],
    ...Object.values(fixture.siblings).map(files => Object.keys(files)),
  ]) {
    const folded = paths.map(path => path.normalize('NFC').toLowerCase())
    if (new Set(folded).size !== folded.length || folded.some(path => folded.some(other => other.startsWith(`${path}/`)))) throw new Error('Fixture path collision')
  }
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
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', '-c', 'user.name=Journey Fixture', '-c', 'user.email=fixture@example.invalid', ...args], {
    cwd: root, encoding: 'utf8', timeout: 10_000, windowsHide: true,
    env: { PATH: process.env['PATH'], SystemRoot: process.env['SystemRoot'], TEMP: process.env['TEMP'], TMP: process.env['TMP'], GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0' },
  })
  if (result.error || result.status !== 0) throw new Error(`Fixture git ${args[0]} failed (exit ${result.status ?? 'unknown'})`)
  return result.stdout
}

/** Create a new fixture root only; existing evidence is never overwritten. */
export async function prepareJourneyFixture(spec: JourneySpec, input: JourneyFixture, root: string): Promise<PreparedJourneyFixture> {
  JourneySpecSchema.parse(spec)
  const fixture = JourneyFixtureSchema.parse(input)
  validateFixture(fixture)
  await mkdir(root)
  const candidateRoot = join(root, fixture.rootName ?? 'candidate')
  const protectedRoot = join(root, 'protected')
  await mkdir(candidateRoot)
  await mkdir(protectedRoot)
  await materialize(candidateRoot, fixture.files)
  for (const [path, contents] of Object.entries(fixture.binaryFiles ?? {})) {
    await mkdir(dirname(join(candidateRoot, path)), { recursive: true })
    await writeFile(join(candidateRoot, path), Buffer.from(contents, 'base64'))
  }
  let gitHead: string | null = null
  if (fixture.git) {
    git(candidateRoot, ['init', '--initial-branch=main'])
    git(candidateRoot, ['add', '--all'])
    git(candidateRoot, ['commit', '--allow-empty', '-m', 'Synthetic baseline'])
    gitHead = git(candidateRoot, ['rev-parse', 'HEAD']).trim()
  }
  await materialize(candidateRoot, fixture.dirtyFiles)
  await materialize(candidateRoot, fixture.untrackedFiles)
  for (const [name, files] of Object.entries(fixture.siblings)) await materialize(join(root, 'adjacent', name), files)
  const files = Object.entries({ ...fixture.files, ...fixture.dirtyFiles, ...fixture.untrackedFiles }).map(([path, contents]) => ({ path, sha256: createHash('sha256').update(contents).digest('hex') }))
  for (const [path, contents] of Object.entries(fixture.binaryFiles ?? {})) files.push({ path, sha256: createHash('sha256').update(Buffer.from(contents, 'base64')).digest('hex') })
  const gitStatus = fixture.git ? git(candidateRoot, ['status', '--porcelain=v1', '--untracked-files=all']) : null
  const prepared = { id: spec.id, candidateRoot, protectedRoot, files, gitHead, gitStatus }
  await writeFile(join(protectedRoot, 'baseline.json'), JSON.stringify(prepared, null, 2), { flag: 'wx' })
  return prepared
}

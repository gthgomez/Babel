// License: Apache-2.0 — offline diagnostic; not part of CI.
import { createHash } from 'node:crypto'
import { lstat, mkdtemp, readdir, readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const cliRoot = join(repoRoot, 'babel-cli')

async function metadataEntries(root) {
  const entries = []
  async function collect(relative) {
    for (const entry of (await readdir(join(root, '.git', relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) throw new Error(`symlink ${path}`)
      if (entry.isDirectory()) {
        entries.push([`${path}/`, 'directory'])
        await collect(path)
      } else if (entry.isFile()) {
        const bytes = await readFile(join(root, '.git', path))
        entries.push([path, createHash('sha256').update(bytes).digest('hex')])
      }
    }
  }
  const meta = join(root, '.git')
  const dir = await lstat(meta)
  if (!dir.isDirectory() || dir.isSymbolicLink()) throw new Error('missing .git')
  await collect('')
  return entries
}

function diffEntries(before, after) {
  const b = new Map(before)
  const a = new Map(after)
  return [...new Set([...b.keys(), ...a.keys()])].sort()
    .filter(path => b.get(path) !== a.get(path))
    .map(path => ({ path, before: b.get(path) ?? null, after: a.get(path) ?? null }))
}

const root = await mkdtemp(join(tmpdir(), 'babel-calibration-git-diag-'))
const home = join(root, 'home')
const reportRoot = join(root, 'report')
await import('node:fs/promises').then(fs => fs.mkdir(home))
const run = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/run_native_chat_tasks.mjs', '--mode', 'calibration', '--out', reportRoot], {
  cwd: cliRoot,
  encoding: 'utf8',
  env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home },
})
if (run.status !== 0) {
  console.error(run.stderr)
  process.exit(run.status ?? 1)
}

const { readJourneyCorpus, prepareJourneyFixture } = await import('../src/eval/harness-journey-fixtures.ts')
const manifest = JSON.parse(await readFile(join(repoRoot, 'benchmarks/harness-journeys/native-chat-tasks.json'), 'utf8'))
const corpus = await readJourneyCorpus(join(repoRoot, 'benchmarks/harness-journeys/development.json'))

const report = JSON.parse(await readFile(join(reportRoot, 'report.json'), 'utf8'))
for (const task of report.tasks) {
  const spec = manifest.tasks.find(row => row.id === task.id)
  if (!spec) continue
  const journey = corpus.journeys.find(row => row.id === spec.journeyId)
  if (!journey) continue
  const cellRoot = join(reportRoot, task.id)
  const candidate = join(cellRoot, 'candidate')
  const baseline = JSON.parse(await readFile(join(cellRoot, 'protected', 'baseline.json'), 'utf8'))
  const { randomUUID } = await import('node:crypto')
  const freshRoot = join(tmpdir(), `babel-calibration-fresh-${randomUUID()}`)
  const fresh = await prepareJourneyFixture(journey, corpus.fixtures[journey.fixtureId], freshRoot)
  const prepEntries = await metadataEntries(fresh.candidateRoot)
  const postEntries = await metadataEntries(candidate)
  const deltas = diffEntries(prepEntries, postEntries)
  console.log(JSON.stringify({
    taskId: task.id,
    outcome: task.outcome,
    diagnostics: task.diagnostics,
    expectedDigest: baseline.gitMetadataDigest,
    postDigest: createHash('sha256').update(JSON.stringify(postEntries)).digest('hex'),
    deltaCount: deltas.length,
    deltas,
  }, null, 2))
}

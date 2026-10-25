/** Offline preparation only. Candidate execution uses runJourney via a host adapter. */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { prepareJourneyFixture, readJourneyCorpus } from '../src/eval/harness-journey-fixtures.js'
import { journeyScenario } from '../src/eval/harness-journey-resources.js'

const root = fileURLToPath(new URL('../../', import.meta.url))
const { values } = parseArgs({ options: { out: { type: 'string' }, corpus: { type: 'string' }, rubrics: { type: 'string' } }, strict: true, allowPositionals: false })
if (!values.out) throw new Error('Usage: npm run eval:harness-journeys -- --out <new-evidence-directory> [--corpus <corpus.json>]')
const out = resolve(values.out)
const corpusPath = values.corpus ? resolve(values.corpus) : join(root, 'benchmarks/harness-journeys/development.json')
const corpus = await readJourneyCorpus(corpusPath)
function gitFact(args: string[]): string {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10_000 })
  if (result.error || result.status !== 0) throw new Error('Evaluator source revision is unavailable')
  return result.stdout.trim()
}
const evaluatorRevision = gitFact(['rev-parse', 'HEAD'])
const evaluatorWorkingTreeClean = gitFact(['status', '--porcelain=v1', '--untracked-files=all']) === ''
const rubricPath = values.rubrics ? resolve(values.rubrics) : join(root, 'benchmarks/harness-journeys/oracle-rubrics.json')
const rubrics = z.object({ schemaVersion: z.literal(1), rubrics: z.record(z.string(), z.object({ journeyId: z.string(), requirements: z.string().min(1) }).strict()) }).strict().parse(JSON.parse(await readFile(rubricPath, 'utf8')))
for (const spec of corpus.journeys) if (rubrics.rubrics[spec.oracleId]?.journeyId !== spec.id) throw new Error('Missing or mismatched frozen oracle rubric')
// Zero-spend preparation is distinct from model-backed product qualification.
if (corpus.journeys.some(spec => spec.limits.maxCostUsd !== 0)) throw new Error('Offline preparation requires zero model budget')
await mkdir(out)
const cells = []
for (const spec of corpus.journeys) {
  const fixture = corpus.fixtures[spec.fixtureId]
  if (!fixture) throw new Error('Missing fixture')
  const cell = await prepareJourneyFixture(spec, fixture, join(out, spec.id))
  await writeFile(join(cell.protectedRoot, 'scenario.json'), JSON.stringify({ schemaVersion: 1, stage: 'not_executed', steps: journeyScenario(spec) }, null, 2), { flag: 'wx' })
  cells.push(cell)
}
const files = [
  corpusPath, rubricPath,
  join(root, 'babel-cli/src/eval/harness-journey-contract.ts'),
  join(root, 'babel-cli/src/eval/harness-journey-fixtures.ts'), fileURLToPath(import.meta.url),
  ...['checks', 'code-oracle', 'oracle', 'html', 'service', 'resources', 'blind'].map(name => join(root, `babel-cli/src/eval/harness-journey-${name}.ts`)),
  ...['cleanRoomGrade.ts', '../config/benchmarkContainer.ts', '../config/dockerIsolationArgs.ts', '../authority/protectedPath.ts'].map(path => join(root, 'babel-cli/src/eval', path)),
]
const hashes = []
for (const path of files) hashes.push({ path, sha256: createHash('sha256').update(await readFile(path)).digest('hex') })
const record = {
  schemaVersion: 1, stage: 'prepared_not_executed', nodeVersion: process.version, evaluatorRevision, evaluatorWorkingTreeClean,
  evaluatorFiles: hashes, cells, controls: corpus.controls.map(control => control.id),
  limits: { providerSpendUsd: 0 },
  pending: ['independent blind assessment of actual candidate output', 'backend steering activation and execution', 'actual candidate execution', 'held-out corpus'],
}
await writeFile(join(out, 'frozen-evaluator.json'), JSON.stringify(record, null, 2), { flag: 'wx' })
console.log(JSON.stringify({ stage: record.stage, journeys: cells.length, controls: corpus.controls.length, providerSpendUsd: 0 }))

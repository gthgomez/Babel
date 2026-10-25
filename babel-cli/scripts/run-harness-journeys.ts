/** Offline preparation only. Candidate execution uses runJourney via a host adapter. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { prepareJourneyFixture, readJourneyCorpus } from '../src/eval/harness-journey-fixtures.js'

const root = fileURLToPath(new URL('../../', import.meta.url))
const { values } = parseArgs({ options: { out: { type: 'string' }, corpus: { type: 'string' }, rubrics: { type: 'string' } }, strict: true, allowPositionals: false })
if (!values.out) throw new Error('Usage: npm run eval:harness-journeys -- --out <new-evidence-directory> [--corpus <corpus.json>]')
const out = resolve(values.out)
const corpusPath = values.corpus ? resolve(values.corpus) : join(root, 'benchmarks/harness-journeys/development.json')
const corpus = await readJourneyCorpus(corpusPath)
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
  cells.push(await prepareJourneyFixture(spec, fixture, join(out, spec.id)))
}
const files = [
  corpusPath, rubricPath,
  join(root, 'babel-cli/src/eval/harness-journey-contract.ts'),
  join(root, 'babel-cli/src/eval/harness-journey-fixtures.ts'), fileURLToPath(import.meta.url),
]
const hashes = []
for (const path of files) hashes.push({ path, sha256: createHash('sha256').update(await readFile(path)).digest('hex') })
const record = {
  schemaVersion: 1, stage: 'prepared_not_executed', nodeVersion: process.version,
  evaluatorFiles: hashes, cells, controls: corpus.controls.map(control => control.id),
  limits: { providerSpendUsd: 0 },
  pending: ['task-specific executable graders and blind rubric adjudication', 'service/fault/steering activation by host adapters', 'actual candidate execution', 'held-out corpus'],
}
await writeFile(join(out, 'frozen-evaluator.json'), JSON.stringify(record, null, 2), { flag: 'wx' })
console.log(JSON.stringify({ stage: record.stage, journeys: cells.length, controls: corpus.controls.length, providerSpendUsd: 0 }))

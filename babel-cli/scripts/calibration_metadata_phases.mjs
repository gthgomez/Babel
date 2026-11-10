/** Same-fixture phased .git metadata snapshots for native Chat calibration (local only). */
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const fixtures = await import('../src/eval/harness-journey-fixtures.js')
const tasks = await import('../src/eval/native-chat-tasks.js')
const { createCalibrationRunner, calibrationPolicy } = await import('../src/eval/native-chat-calibration.js')

async function entriesDigest(entries) {
  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex')
}

function diffEntries(before, after) {
  const b = new Map(before)
  const a = new Map(after)
  const paths = [...new Set([...b.keys(), ...a.keys()])].sort()
  const changed = []
  for (const path of paths) {
    const bv = b.get(path)
    const av = a.get(path)
    if (bv === av) continue
    changed.push({ path, before: bv ?? null, after: av ?? null })
  }
  return changed
}

const corpus = await fixtures.readJourneyCorpus(join(root, 'benchmarks/harness-journeys/development.json'))
const manifest = JSON.parse(await readFile(join(root, 'benchmarks/harness-journeys/native-chat-tasks.json'), 'utf8'))

const taskId = process.argv[2] ?? 'invoice-feature'
const task = manifest.tasks.find(t => t.id === taskId)
const spec = corpus.journeys.find(j => j.id === task.journeyId)
const out = await mkdtemp(join(tmpdir(), 'babel-cal-meta-'))
const cell = await fixtures.prepareJourneyFixture({ ...spec, id: task.id }, corpus.fixtures[spec.fixtureId], join(out, task.id))

const phases = []
let priorEntries = null
const snap = async (label) => {
  const entries = await fixtures.fixtureMetadataEntries(cell.candidateRoot)
  const changed = priorEntries ? diffEntries(priorEntries, entries) : []
  priorEntries = entries
  phases.push({ label, digest: await entriesDigest(entries), changed })
}

await snap('after_prepare')
await tasks.captureNativeTaskFiles(cell.candidateRoot, new Map())
await snap('after_baseline_capture')

process.env.BABEL_TESTS_ALLOW_INFERENCE = '0'
process.env.BABEL_BENCHMARK_MODE = '1'
process.env.BABEL_BENCHMARK_AUTO_APPROVE = '1'
process.env.BABEL_DRY_RUN = '0'
process.env.BABEL_DRY_RUN_SOURCE = 'session'
process.env.BABEL_COMPACTION = 'off'

const { ChatEngine } = await import('../src/agent/chatEngine.js')
const engine = new ChatEngine({
  task: spec.prompt,
  projectRoot: cell.candidateRoot,
  runId: `native-eval-${randomUUID()}`,
  ...(task.kind === 'read_only' ? { operation: 'READ_ONLY' } : {}),
  providerRunner: createCalibrationRunner(task.journeyId, task.kind === 'negative_control'),
  providerPolicy: calibrationPolicy,
  model: 'synthetic-calibration',
  maxTurns: 4,
})

await snap('pre_engine')
await engine.submitMessage(spec.prompt, {
  onAnswerChunk() {},
  onToolStart(tool, target) {},
  onToolComplete() {},
})
await snap('post_engine')
await tasks.captureNativeTaskFiles(cell.candidateRoot, new Map())
await snap('post_snapshot_capture')

const report = {
  taskId,
  prepDigest: cell.gitMetadataDigest,
  phases: phases.map(({ label, digest, changed }) => ({
    label,
    digest,
    driftFromPrep: digest !== cell.gitMetadataDigest,
    changedCount: changed.length,
    changed: changed.slice(0, 40),
  })),
}
await mkdir(join(out, 'diag'), { recursive: true })
await writeFile(join(out, 'diag', `${taskId}.json`), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))

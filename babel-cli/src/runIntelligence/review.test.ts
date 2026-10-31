import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, symlinkSync, linkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { extractRunDirectory } from './adapter.js'
import { RunIntelligenceCatalog } from './catalog.js'
import { opaqueId } from './contracts.js'
import { DatabaseSync } from 'node:sqlite'
import { reviewCatalog, formatRunReview } from './review.js'

function guardNetwork(root: string): { networkGuard: string; networkMarker: string } {
  const networkMarker = join(root, 'network-attempt')
  const networkGuard = join(root, 'deny-network.mjs')
  writeFileSync(networkGuard, `import { writeFileSync } from 'node:fs';
import net from 'node:net'; import http from 'node:http'; import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
const deny = () => { writeFileSync(${JSON.stringify(networkMarker)}, new Error('network attempt').stack); throw new Error('NETWORK_FORBIDDEN'); };
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args) {
  const target=Array.isArray(args[0]) ? args[0][0] : args[0];
  if ((typeof target==='object' && target?.path) || (typeof target==='string' && target.startsWith('/'))) return originalConnect.apply(this,args);
  return deny();
};
globalThis.fetch=deny;
http.request=deny; http.get=deny; https.request=deny; https.get=deny; syncBuiltinESMExports();`)
  return { networkGuard: pathToFileURL(networkGuard).href, networkMarker }
}

const end = '2026-10-27T16:00:00.000Z'
test('ordinary review deduplicates tasks, preserves corrections and minimizes evidence without writes or inference', () => {
  const root = mkdtempSync(join(tmpdir(), 'bri-review-'))
  const path = join(root, 'catalog.sqlite')
  const catalog = new RunIntelligenceCatalog(path)
  const originals: Array<[string, string]> = []
  for (const [name, taskId, verdict] of [
    ['failure', 'task-one', 'FAIL'], ['retry', 'task-one', 'FAIL'],
    ['success', 'task-two', 'PASS'], ['unknown', null, null], ['corrected', 'task-three', 'FAIL'],
  ] as const) {
    const dir = join(root, name)
    mkdirSync(dir)
    const events = [
      { kind: 'user_submitted', task_id: taskId, task_preview: 'PRIVATE CONTENT', session_id: name },
      { kind: 'provider_retry_scheduled', attempt: 1 },
      ...(name === 'failure' ? [{ kind: 'completion_decision', allowed: false }] : []),
      ...(verdict === 'FAIL' ? [{ kind: 'tool_failed', tool_name: 'write_file', ts: '2026-10-27T12:00:00Z', secret: 'SENSITIVE CANARY' }] : []),
    ]
    for (const [file, value] of [
      ['01_manifest.json', JSON.stringify({ schema_version: 1, created_at: '2026-10-27T12:00:00Z' })],
      ['session-events.jsonl', events.map(e => JSON.stringify(e)).join('\n')],
    ]) {
      const filePath = join(dir, file!)
      writeFileSync(filePath, value!)
      originals.push([filePath, value!])
    }
    // Independent fixture evaluator checks the user's actual CSV artifact.
    const output = join(dir, name === 'corrected' ? 'résultats' : 'output')
    mkdirSync(output)
    if (verdict === 'PASS' || name === 'corrected') writeFileSync(join(output, 'result.csv'), 'name,total\nAda,7\n')
    const actualPass = existsSync(join(output, 'result.csv')) && readFileSync(join(output, 'result.csv'), 'utf8') === 'name,total\nAda,7\n'
    assert.equal(actualPass, verdict === 'PASS' || name === 'corrected')
    // v1 evaluator deliberately misses the Unicode subdirectory, as a correction control.
    const assessedVerdict = name === 'corrected' ? 'FAIL' : actualPass ? 'PASS' : 'FAIL'
    const run = extractRunDirectory(dir)
    if (verdict) run.outcomes.push({ dimension: 'TASK_CORRECTNESS', value: assessedVerdict,
      observer: 'controlled-independent-evaluator-v1', evidenceRef: 'private/evaluation.json',
      validity: 'VALID', availability: 'PRESENT', observedAt: '2026-10-27T12:00:00Z',
      authority: 'INDEPENDENT_VERIFICATION', revision: 'BOUND', revisionToken: 'controlled-revision' })
    catalog.ingest(run)
  }
  const initial = catalog.review({ until: end, lastHours: 24 })
  assert.equal(initial.summary.distinctTasks, 3)
  assert.equal(initial.summary.unattributedRuns, 1)
  assert.equal(initial.findings[0]?.distinctTasks, 2)
  assert.equal(initial.findings[0]?.occurrences, 3)
  const corrected = initial.runs.find(r => r.taskToken === opaqueId('task', 'babel.local', 'task-three'))!
  for (const [evaluationVersion, verdict] of [['v2', 'PASS'], ['v3', 'UNKNOWN']] as const)
    catalog.recordAssessmentCorrection({ trialId: corrected.trialId, evaluationVersion,
      verdict, correctionKind: 'EVALUATOR_ERROR', evidenceRef: 'private/unicode-selector-review.json' })
  catalog.reviewFailureCluster({ signatureId: initial.findings[0]!.signatureId,
    suspectedCause: 'PRIVATE CONTENT', candidateFix: 'SENSITIVE CANARY', validatedFix: 'private-proof' })
  catalog.addLineageEdge({ fromId: initial.findings[0]!.clusterId, toId: 'private-proof', relation: 'validated_fix' })
  catalog.close()
  const before = readFileSync(path)
  const filesBeforeReview = readdirSync(root).filter(name => name.startsWith('catalog.sqlite'))
  const { networkGuard, networkMarker } = guardNetwork(root)
  const cli = spawnSync(process.execPath, ['--import', networkGuard, '--import', 'tsx', 'src/index.ts', 'runs', 'review', '--catalog', path, '--until', end, '--last-hours', '24', '--json'], {
    cwd: process.cwd(), encoding: 'utf8', env: { PATH: process.env['PATH'], BABEL_TELEMETRY_ENABLED: 'false', NODE_OPTIONS: '--no-warnings' }, timeout: 30000,
  })
  assert.equal(cli.status, 0, cli.stderr.slice(0, 500))
  assert.equal(existsSync(networkMarker), false)
  const report = JSON.parse(cli.stdout)
  writeFileSync(join(root, 'report.json'), cli.stdout)
  writeFileSync(join(tmpdir(), 'bri-review-acceptance.json'), cli.stdout)
  const readable = formatRunReview(report)
  writeFileSync(join(tmpdir(), 'bri-review-acceptance.txt'), readable)
  assert.ok(readable.includes('PASS:EVALUATOR_ERROR:REVIEW_ONLY'))
  for (const ref of [report.runs[0].sourceRef, report.findings[0].clusterId]) {
    const shown = spawnSync(process.execPath, ['--import', networkGuard, '--import', 'tsx', 'src/index.ts', 'runs', 'show', ref, '--catalog', path, '--json'], {
      cwd: process.cwd(), encoding: 'utf8', env: { PATH: process.env['PATH'], NODE_OPTIONS: '--no-warnings' }, timeout: 30000,
    })
    assert.equal(shown.status, 0, shown.stderr.slice(0, 300))
    assert.ok(JSON.parse(shown.stdout).entityType)
    assert.ok(!shown.stdout.includes('PRIVATE CONTENT') && !shown.stdout.includes('private-proof'))
  }
  const blankUntil = spawnSync(process.execPath, ['--import', networkGuard, '--import', 'tsx', 'src/index.ts', 'runs', 'review', '--catalog', path, '--until', '', '--json'], {
    cwd: process.cwd(), encoding: 'utf8', env: { PATH: process.env['PATH'], NODE_OPTIONS: '--no-warnings' }, timeout: 30000,
  })
  assert.notEqual(blankUntil.status, 0)
  assert.equal(JSON.parse(blankUntil.stdout).status, 'error')
  assert.match(JSON.parse(blankUntil.stdout).message, /valid --until/)
  assert.ok(report.runs.every((r: { friction: { providerRetriesScheduled: number } }) => r.friction.providerRetriesScheduled === 1))
  assert.ok(report.runs.some((r: { friction: { completionBlocks: number } }) => r.friction.completionBlocks === 1))
  assert.equal(report.summary.runs, 5)
  assert.equal(report.summary.distinctTasks, 3)
  assert.equal(report.summary.unknownOutcomeRuns, 1)
  assert.equal(report.summary.missingCostRuns, 5)
  assert.equal(report.findings[0].status, 'VALIDATION_RECORDED_UNVERIFIED')
  assert.equal(report.findings[0].resolution, 'NOT_ESTABLISHED')
  assert.equal(report.findings[0].lineage[0].relation, 'validated_fix')
  assert.equal(report.findings[0].failedDistinctTasks, 1)
  assert.equal(report.runs.find((r: { corrections: unknown[] }) => r.corrections.length).corrections.length, 2)
  assert.equal(report.runs.find((r: { corrections: unknown[] }) => r.corrections.length).assessment, 'ESTABLISHED_FAIL')
  for (const secret of ['PRIVATE CONTENT', 'SENSITIVE CANARY', 'private/', 'task-one', 'unicode-selector']) assert.ok(!cli.stdout.includes(secret) && !readable.includes(secret))
  assert.equal(existsSync(networkMarker), false)
  assert.deepEqual(readFileSync(path), before)
  assert.deepEqual(readdirSync(root).filter(name => name.startsWith('catalog.sqlite')), filesBeforeReview)
  for (const [file, value] of originals) assert.equal(readFileSync(file, 'utf8'), value)
})

test('nearby records keep multiple tasks unattributed, rank deterministically and enforce the window', () => {
  const root = mkdtempSync(join(tmpdir(), 'bri-review-nearby-'))
  const catalog = new RunIntelligenceCatalog(join(root, 'catalog.sqlite'))
  for (const [name, date, tasks, category] of [
    ['old', '2026-10-26T15:59:59Z', ['old'], 'TIMEOUT'],
    ['edge', '2026-10-26T16:00:00Z', ['one'], 'RATE_LIMIT'],
    ['retry', '2026-10-27T12:00:00Z', ['one'], 'RATE_LIMIT'],
    ['variation', '2026-10-27T12:01:00Z', ['two'], 'TIMEOUT'],
    ['mixed', '2026-10-27T12:02:00Z', ['three', 'four'], 'TIMEOUT'],
    ['end', end, ['future'], 'TIMEOUT'],
  ] as const) {
    const dir = join(root, name)
    mkdirSync(dir)
    writeFileSync(join(dir, '01_manifest.json'), JSON.stringify({ schema_version: 1, created_at: date }))
    writeFileSync(join(dir, 'session-events.jsonl'), tasks.map(task_id => JSON.stringify({ kind: 'user_submitted', task_id })).join('\n') + '\n' + JSON.stringify({ kind: 'provider_failure_receipt', receipt: { failure_class: category }, ts: date }))
    const extracted = extractRunDirectory(dir)
    if (name === 'variation') extracted.outcomes.push({ dimension: 'TASK_CORRECTNESS', value: 'FAIL',
      observer: 'controlled-independent-evaluator', evidenceRef: 'held-out-evaluation', validity: 'VALID',
      availability: 'PRESENT', observedAt: date, authority: 'INDEPENDENT_VERIFICATION', revision: 'BOUND', revisionToken: 'held-out-revision' })
    catalog.ingest(extracted)
  }
  const review = catalog.review({ until: end })
  assert.equal(review.summary.runs, 4)
  assert.equal(review.summary.distinctTasks, 2)
  assert.equal(review.summary.unattributedRuns, 1)
  assert.equal(review.findings.find(f => f.category === 'RATE_LIMIT')!.distinctTasks, 1)
  assert.equal(review.findings.find(f => f.category === 'TIMEOUT')!.distinctTasks, 1)
  assert.equal(review.findings[0]!.category, 'TIMEOUT')
  assert.equal(review.findings[0]!.failedDistinctTasks, 1)
  assert.equal(review.findings[1]!.failedDistinctTasks, 0)
  assert.deepEqual(catalog.review({ until: end }), review)
  assert.throws(() => catalog.review({ lastHours: -1 }), /Review requires/)
  assert.throws(() => catalog.review({ until: 'invalid' }), /Review requires/)
  const trial = review.runs[0]!.trialId
  catalog.recordAssessmentCorrection({ trialId: trial, evaluationVersion: 'v1', verdict: 'UNKNOWN', correctionKind: 'EVIDENCE_UPDATE', evidenceRef: 'evidence' })
  assert.throws(() => catalog.recordAssessmentCorrection({ trialId: trial, evaluationVersion: 'v1', verdict: 'PASS', correctionKind: 'EVIDENCE_UPDATE', evidenceRef: 'evidence' }), /immutable/)
  catalog.close()
})

test('review rejects impossible calendar dates and pending WAL rather than silently changing its evidence window', () => {
  const root = mkdtempSync(join(tmpdir(), 'bri review-é-input-'))
  const path = join(root, 'catalog.sqlite')
  const catalog = new RunIntelligenceCatalog(path)
  catalog.close()
  for (const until of ['2026-02-30T16:00:00Z', '2026-04-31T16:00:00Z', '2025-02-29T16:00:00Z', '2026-01-01T24:00:00Z'])
    assert.throws(() => reviewCatalog(path, { until }), /valid --until/)
  assert.equal(reviewCatalog(path, { until: '2024-02-29T23:59:59+01:00' }).summary.runs, 0)
  const writer = new DatabaseSync(path)
  writer.exec("PRAGMA journal_mode=WAL; INSERT INTO annotations VALUES ('control', 'none', 'control', '{}', 'now')")
  const filesBefore = readdirSync(root)
  assert.throws(() => reviewCatalog(path, { until: end }), /checkpointed catalog/)
  assert.deepEqual(readdirSync(root), filesBefore)
  writer.close()
})

test('all correction history affects ranking while emitted history remains bounded and references resolve locally', () => {
  const root = mkdtempSync(join(tmpdir(), 'bri-review-history-'))
  const dir = join(root, 'source')
  mkdirSync(dir)
  writeFileSync(join(dir, '01_manifest.json'), JSON.stringify({ schema_version: 1, created_at: '2026-10-27T12:00:00Z' }))
  writeFileSync(join(dir, 'session-events.jsonl'), [
    { kind: 'user_submitted', task_id: 'held-out-task' },
    { kind: 'tool_failed', tool_name: 'write_file', ts: '2026-10-27T12:00:00Z' },
  ].map(event => JSON.stringify(event)).join('\n'))
  const catalog = new RunIntelligenceCatalog(join(root, 'catalog.sqlite'))
  const run = extractRunDirectory(dir)
  run.outcomes.push({ dimension: 'TASK_CORRECTNESS', value: 'FAIL', observer: 'held-out-evaluator-v1',
    evidenceRef: 'private/verdict', validity: 'VALID', availability: 'PRESENT', observedAt: '2026-10-27T12:00:00Z',
    authority: 'INDEPENDENT_VERIFICATION', revision: 'BOUND', revisionToken: 'held-out-revision' })
  catalog.ingest(run)
  const original = catalog.review({ until: end })
  const trialId = original.runs[0]!.trialId
  for (let i = 1; i <= 50; i++) catalog.recordAssessmentCorrection({ trialId, evaluationVersion: String(i), verdict: 'FAIL', correctionKind: 'EVIDENCE_UPDATE', evidenceRef: 'private/updates' })
  catalog.recordAssessmentCorrection({ trialId, evaluationVersion: '51', verdict: 'PASS', correctionKind: 'EVALUATOR_ERROR', evidenceRef: 'private/evaluator-repair' })
  catalog.reviewFailureCluster({ signatureId: original.findings[0]!.signatureId, candidateFix: 'PRIVATE CANDIDATE', validatedFix: 'PRIVATE VALIDATION' })
  const edge = catalog.addLineageEdge({ fromId: original.findings[0]!.clusterId, toId: trialId, relation: 'validated_fix' })
  const report = catalog.review({ until: end })
  assert.equal(report.runs[0]!.assessment, 'ESTABLISHED_FAIL')
  assert.equal(report.runs[0]!.corrections.length, 50)
  assert.equal(report.runs[0]!.correctionsTruncated, true)
  assert.equal(report.findings[0]!.failedDistinctTasks, 0)
  for (const ref of [report.runs[0]!.sourceRef, report.runs[0]!.runId, trialId, ...report.runs[0]!.evidenceRefs,
    report.findings[0]!.clusterId, report.findings[0]!.reviewedFixRef!, edge, report.runs[0]!.corrections[0]!.correctionId])
    assert.ok(catalog.show(ref), 'Every emitted catalog entity reference must resolve')
  assert.ok(!JSON.stringify(report).includes('PRIVATE'))
  catalog.close()
})

test('ordinary CLI refuses real and symbolic active-WAL catalogs and reports complete evidence only after checkpoint', t => {
  const root = mkdtempSync(join(tmpdir(), 'bri-review-alias-'))
  const path = join(root, 'catalog.sqlite')
  const alias = join(root, 'alias.sqlite')
  const seed = (name: string) => {
    const dir = join(root, name)
    mkdirSync(dir)
    writeFileSync(join(dir, '01_manifest.json'), JSON.stringify({ schema_version: 1, created_at: '2026-10-27T12:00:00Z' }))
    return extractRunDirectory(dir)
  }
  const catalog = new RunIntelligenceCatalog(path)
  catalog.ingest(seed('one'))
  catalog.close()
  try { symlinkSync(path, alias, 'file') } catch (error) {
    if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
      t.skip('Windows host does not permit this symbolic-link control')
      return
    }
    throw error
  }
  const { networkGuard, networkMarker } = guardNetwork(root)
  const invoke = (selectedPath: string) => spawnSync(process.execPath,
    ['--import', networkGuard, '--import', 'tsx', 'src/index.ts', 'runs', 'review', '--catalog', selectedPath, '--until', end, '--json'], {
      cwd: process.cwd(), encoding: 'utf8', env: { PATH: process.env['PATH'], NODE_OPTIONS: '--no-warnings' }, timeout: 30000,
    })
  const writer = new RunIntelligenceCatalog(path)
  let refused = 0
  try {
    writer.ingest(seed('two'))
    assert.equal(writer.review({ until: end }).summary.runs, 2)
    const before = readdirSync(root)
    const dbBefore = readFileSync(path)
    const walBefore = readFileSync(`${path}-wal`)
    for (const selectedPath of [path, alias]) {
      const active = invoke(selectedPath)
      assert.notEqual(active.status, 0)
      const failure = JSON.parse(active.stdout)
      assert.deepEqual(Object.keys(failure).sort(), ['message', 'status'])
      assert.equal(failure.status, 'error')
      assert.match(failure.message, /checkpointed catalog/)
      refused++
    }
    assert.deepEqual(readdirSync(root), before)
    assert.deepEqual(readFileSync(path), dbBefore)
    assert.deepEqual(readFileSync(`${path}-wal`), walBefore)
  } finally { writer.close() }
  const afterCheckpoint = readdirSync(root)
  const checkpointedBytes = readFileSync(path)
  const complete = invoke(alias)
  assert.equal(complete.status, 0, complete.stderr.slice(0, 300))
  assert.equal(JSON.parse(complete.stdout).summary.runs, 2)
  assert.deepEqual(readdirSync(root), afterCheckpoint)
  assert.deepEqual(readFileSync(path), checkpointedBytes)
  assert.equal(existsSync(networkMarker), false)
  for (const name of ['one', 'two']) assert.equal(JSON.parse(readFileSync(join(root, name, '01_manifest.json'), 'utf8')).created_at, '2026-10-27T12:00:00Z')
  writeFileSync(join(tmpdir(), 'bri-cli-wal-outcomes.json'), JSON.stringify({ activeDatabaseRefusals: refused, refusedReportsEmitted: 0, checkpointedExit: complete.status, checkpointedRuns: JSON.parse(complete.stdout).summary.runs, sourceAndCatalogUnchangedByReaders: true, networkAttempts: false }, null, 2))
})

test('hardlinked database files are refused rather than treating an alias as an independent checkpoint', () => {
  const root = mkdtempSync(join(tmpdir(), 'bri-review-hardlink-'))
  const path = join(root, 'catalog.sqlite')
  const alias = join(root, 'hardlink.sqlite')
  const catalog = new RunIntelligenceCatalog(path)
  catalog.close()
  linkSync(path, alias)
  assert.throws(() => reviewCatalog(alias, { until: end }), /hardlink aliases/)
})

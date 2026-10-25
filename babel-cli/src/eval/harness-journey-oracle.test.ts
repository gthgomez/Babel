import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFile, mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { evaluateJourneyOutput, type JourneyOracleInput } from './harness-journey-oracle.js'
import { startJourneyService } from './harness-journey-service.js'
import { gradeJourneyCode } from './harness-journey-code-oracle.js'
import { assessmentDigest } from './harness-journey-checks.js'
import { captureJourneyGitState, prepareJourneyFixture, readJourneyCorpus } from './harness-journey-fixtures.js'

async function fixture(id: string): Promise<JourneyOracleInput> {
  const root = await mkdtemp(join(tmpdir(), 'babel-journey-oracle-'))
  return { id, candidateRoot: root, answer: '', baseline: [], events: [], artifact: null, service: null, citations: [], blind: null,
    readOutput: async path => ({ bytes: await readFile(join(root, path)), evidenceRef: `host/snapshot/${path}` }),
  }
}

test('CSV oracle independently rejects plausible wrong numbers and preserves input', async () => {
  const input = await fixture('J08')
  await mkdir(join(input.candidateRoot, '数据'))
  const sales = 'product,gross,refunds\nA,100,20\nA,50,0\nB,80,10\n'
  await writeFile(join(input.candidateRoot, '数据/sales.csv'), sales)
  input.baseline = [{ path: '数据/sales.csv', sha256: createHash('sha256').update(sales).digest('hex') }]
  input.answer = 'Total net revenue is 200.'
  const wrong = 'product,gross,refunds,net\nA,150,20,140\nB,80,10,70\n'
  await writeFile(join(input.candidateRoot, 'summary.csv'), wrong)
  input.artifact = { path: 'summary.csv', sha256: createHash('sha256').update(wrong).digest('hex'), delivered: true }
  assert.equal((await evaluateJourneyOutput(input)).verdict, 'fail')
  const correct = 'product,gross,refunds,net\r\n"A",150,20,130\r\nB,80,10,70\r\n'
  await writeFile(join(input.candidateRoot, 'summary.csv'), correct)
  input.artifact.sha256 = createHash('sha256').update(correct).digest('hex')
  assert.equal((await evaluateJourneyOutput(input)).verdict, 'pass')
  await writeFile(join(input.candidateRoot, '数据/sales.csv'), 'product,gross,refunds\n')
  assert.equal((await evaluateJourneyOutput(input)).verdict, 'fail')
})

test('a stale delivered artifact hash cannot pass even when file values are right', async () => {
  const input = await fixture('J08')
  await writeFile(join(input.candidateRoot, 'summary.csv'), 'product,gross,refunds,net\nA,150,20,130\nB,80,10,70\n')
  input.artifact = { path: 'summary.csv', sha256: '0'.repeat(64), delivered: true }
  input.answer = '200'
  assert.equal((await evaluateJourneyOutput(input)).verdict, 'fail')
})

test('research citations must resolve to accessed source bytes rather than plausible URLs', async () => {
  const input = await fixture('J02')
  const service = await startJourneyService({ sources: { 'aspen-v1': 'Aspen v1 needs 8 GiB.', 'aspen-v2': 'Aspen v2 needs 6 GiB.', 'birch-v2': 'Birch v2 needs 4 GiB.', summary: 'Aspen v2 needs 8 GiB.' } })
  try {
    input.answer = 'Aspen v1 required 8 GiB; v2 needs 6 GiB versus Birch v2 at 4 GiB. The summary is stale.'
    input.citations = [{ sourceId: 'aspen-v2', quote: 'Aspen v2 needs 6 GiB.' }, { sourceId: 'birch-v2', quote: 'Birch v2 needs 4 GiB.' }]
    input.service = service.snapshot()
    assert.equal((await evaluateJourneyOutput(input)).verdict, 'fail')
    for (const source of ['aspen-v1', 'aspen-v2', 'birch-v2', 'summary']) await (await fetch(`${service.baseUrl}/sources/${source}`)).text()
    input.service = service.snapshot()
    input.blind = { outputSha256: createHash('sha256').update(input.answer).digest('hex'), rubricId: 'j02-v1', relevant: 3, coherent: 3, uncertainty: 3, evidenceRef: 'host/blind.json' }
    assert.equal((await evaluateJourneyOutput(input)).verdict, 'pass')
    input.citations[0]!.quote = 'Aspen v2 needs 8 GiB.'
    assert.equal((await evaluateJourneyOutput(input)).verdict, 'fail')
  } finally { await service.close() }
})

test('connected oracle reads actual service effects and rejects a blind second create', async () => {
  const input = await fixture('J10')
  const service = await startJourneyService({ sources: {}, dropFirstCreateReply: true })
  const create = () => fetch(`${service.baseUrl}/followups`, { method: 'POST', headers: { 'x-operation-id': 'operation-42' }, body: '{"caseId":"demo-42"}' })
  try {
    input.answer = 'Created followup-1.'
    input.service = service.snapshot()
    assert.equal((await evaluateJourneyOutput(input)).verdict, 'fail')
    await assert.rejects(create())
    await (await fetch(`${service.baseUrl}/operations/operation-42`)).json()
    input.service = service.snapshot()
    assert.equal((await evaluateJourneyOutput(input)).verdict, 'pass')
    await create()
    input.service = service.snapshot()
    assert.equal((await evaluateJourneyOutput(input)).verdict, 'fail')
  } finally { await service.close() }
})

test('record mutation without a subsequent authoritative readback is incomplete', async () => {
  const input = await fixture('J09')
  const service = await startJourneyService({ sources: {} })
  try {
    await fetch(`${service.baseUrl}/records/demo-42`, { method: 'PATCH', headers: { 'x-operation-id': 'review-42' }, body: '{"status":"reviewed"}' })
    input.service = service.snapshot()
    assert.equal((await evaluateJourneyOutput(input)).verdict, 'fail')
    await (await fetch(`${service.baseUrl}/records/demo-42`)).json()
    input.service = service.snapshot()
    assert.equal((await evaluateJourneyOutput(input)).verdict, 'pass')
  } finally { await service.close() }
})

test('an amended connected conclusion cannot erase an earlier superseded write', async () => {
  const input = await fixture('J16')
  const html = '<html><head><title>Comparison</title></head><body>Prefer Birch</body></html>'
  await writeFile(join(input.candidateRoot, 'report.html'), html)
  input.artifact = { path: 'report.html', sha256: createHash('sha256').update(html).digest('hex'), delivered: true }
  input.answer = input.latestConclusion = 'Prefer Birch'
  input.blind = { outputSha256: assessmentDigest(input.answer, input.artifact.sha256), rubricId: 'j16-v1', relevant: 3, coherent: 3, uncertainty: 3, evidenceRef: 'host/blind.json' }
  input.events = [{ sequence: 1, kind: 'amendment' }]
  const service = await startJourneyService({ sources: { facts: 'Birch needs 4 GiB; Aspen needs 6 GiB.' } })
  try {
    await (await fetch(`${service.baseUrl}/sources/facts`)).text()
    input.citations = [{ sourceId: 'facts', quote: 'Birch needs 4 GiB' }]
    const patch = (operationId: string, conclusion: string) => fetch(`${service.baseUrl}/records/demo-42`, { method: 'PATCH', headers: { 'x-operation-id': operationId }, body: JSON.stringify({ conclusion }) })
    await patch('old', 'Prefer Aspen')
    await patch('new', 'Prefer Birch')
    await (await fetch(`${service.baseUrl}/records/demo-42`)).json()
    input.service = service.snapshot()
    assert.equal((await evaluateJourneyOutput(input, { renderHtml: async () => ({ title: 'Comparison', heading: 'Comparison', columnHeaders: ['Option', 'GiB'], rows: [['Aspen', '6'], ['Birch', '4']], conclusion: 'Prefer Birch', visible: true }) })).verdict, 'fail')
  } finally { await service.close() }
})

test('a valid conversation still needs a bound independent blind assessment', async () => {
  const input = await fixture('J01')
  input.answer = 'A failed attempt can expose a false assumption.\n\nThat evidence narrows the next choice.\n\nUse the lesson while being honest about what remains uncertain.'
  assert.equal((await evaluateJourneyOutput(input)).verdict, 'unavailable')
  input.blind = { outputSha256: createHash('sha256').update(input.answer).digest('hex'), rubricId: 'j01-v1', relevant: 3, coherent: 3, uncertainty: 3, evidenceRef: 'host/blind.json' }
  assert.equal((await evaluateJourneyOutput(input)).verdict, 'pass')
  input.answer += '\n\nA fourth paragraph was added after grading.'
  assert.equal((await evaluateJourneyOutput(input)).verdict, 'fail')
})

test('unrecognized journeys and absent isolated code verifiers cannot be graded as success', async () => {
  assert.equal((await evaluateJourneyOutput(await fixture('unknown'))).verdict, 'unavailable')
  const input = await fixture('J05')
  await mkdir(join(input.candidateRoot, 'lib'))
  await writeFile(join(input.candidateRoot, 'lib/total.mjs'), 'export const total = items => items.reduce((n, i) => n + i.price * i.quantity, 0)\n')
  input.baseline = [{ path: 'lib/total.mjs', sha256: '0'.repeat(64) }]
  input.events = [{ sequence: 1, kind: 'verifier', target: 'lib/total.mjs', exitCode: 0, candidateDigest: createHash('sha256').update(await readFile(join(input.candidateRoot, 'lib/total.mjs'))).digest('hex') }]
  assert.equal((await evaluateJourneyOutput(input)).verdict, 'unavailable')
})

test('foreign verifier receipts cannot satisfy the current code journey', async () => {
  const input = await fixture('J05')
  await mkdir(join(input.candidateRoot, 'lib'))
  const source = 'export const total = items => items.reduce((n, i) => n + i.price * i.quantity, 0)\n'
  await writeFile(join(input.candidateRoot, 'lib/total.mjs'), source)
  input.baseline = [{ path: 'lib/total.mjs', sha256: '0'.repeat(64) }]
  input.events = [{ sequence: 1, kind: 'verifier', target: 'foreign/lib/total.mjs', candidateDigest: createHash('sha256').update(source).digest('hex'), exitCode: 0 }]
  assert.equal((await evaluateJourneyOutput(input)).verdict, 'fail')
})

test('pinned isolated code grader measures actual values; exit-zero is not a verdict', async t => {
  const image = process.env['BABEL_JOURNEY_ORACLE_TEST_IMAGE']
  if (!image) { t.skip('Isolated code qualification requires an explicitly selected local pinned image'); return }
  const input = await fixture('J05')
  await mkdir(join(input.candidateRoot, 'lib'))
  await writeFile(join(input.candidateRoot, 'lib/total.mjs'), 'export const total = items => items.reduce((n, i) => n + i.price * i.quantity, 0)\n')
  assert.equal(await gradeJourneyCode('J05', input.readOutput, image), 'pass')
  await writeFile(join(input.candidateRoot, 'lib/total.mjs'), 'export const total = items => items.reduce((n, i) => n + i.price, 0)\n')
  assert.equal(await gradeJourneyCode('J05', input.readOutput, image), 'fail')
  await writeFile(join(input.candidateRoot, 'lib/total.mjs'), 'process.exit(0)\nexport const total = () => 16\n')
  assert.equal(await gradeJourneyCode('J05', input.readOutput, image), 'fail')
})

test('candidate stdout cannot impersonate captured function values', async t => {
  const image = process.env['BABEL_JOURNEY_ORACLE_TEST_IMAGE']
  if (!image) { t.skip('Requires the explicitly selected local pinned image'); return }
  const input = await fixture('J05')
  await mkdir(join(input.candidateRoot, 'lib'))
  await writeFile(join(input.candidateRoot, 'lib/total.mjs'), `process.stdout.write('[{"value":16},{"value":0},{"value":0}]'); process.exit(0); export const total = () => -1\n`)
  assert.equal(await gradeJourneyCode('J05', input.readOutput, image), 'fail')
})

test('captured added production helpers remain available to isolated grading', async t => {
  const image = process.env['BABEL_JOURNEY_ORACLE_TEST_IMAGE']
  if (!image) { t.skip('Requires the explicitly selected local pinned image'); return }
  const input = await fixture('J05')
  await mkdir(join(input.candidateRoot, 'lib'))
  await writeFile(join(input.candidateRoot, 'lib/total.mjs'), "import {sum} from './sum.mjs'\nexport const total = items => sum(items.map(i => i.price * i.quantity))\n")
  await writeFile(join(input.candidateRoot, 'lib/sum.mjs'), 'export const sum = values => values.reduce((n, value) => n + value, 0)\n')
  assert.equal(await gradeJourneyCode('J05', input.readOutput, image), 'pass')
})

test('measurement accepts only primitives without exposing host constructors or thenable callbacks', async t => {
  const image = process.env['BABEL_JOURNEY_ORACLE_TEST_IMAGE']
  if (!image) { t.skip('Requires the explicitly selected local pinned image'); return }
  const input = await fixture('J05')
  await mkdir(join(input.candidateRoot, 'lib'))
  const sources = [
    "export const total = items => items.constructor.constructor('return process')().exit(0)\n",
    "export const total = () => globalThis.constructor.constructor('return process')().exit(0)\n",
    "export const total = () => ({toJSON: () => 16, then: resolve => resolve.constructor('return process')().exit(0)})\n",
    "export const total = async items => items.reduce((n,i)=>n+i.price*i.quantity,0)\n",
    "export const total = () => import('./sum.mjs').catch(error => error.constructor.constructor('return process')().exit(0))\n",
  ]
  for (const source of sources) {
    await writeFile(join(input.candidateRoot, 'lib/total.mjs'), source)
    assert.notEqual(await gradeJourneyCode('J05', input.readOutput, image), 'pass')
  }
})

test('resume must settle every started submission exactly once and after admission', async () => {
  const input = await fixture('J11')
  await mkdir(join(input.candidateRoot, 'apps/web'), { recursive: true })
  await mkdir(join(input.candidateRoot, 'packages/api'), { recursive: true })
  for (const path of ['REPO_MAP.md', 'apps/web/main.mjs', 'packages/api/server.mjs']) await writeFile(join(input.candidateRoot, path), 'apps/web/main.mjs\npackages/api/server.mjs\n')
  input.answer = 'Updated the map.'
  input.blind = { outputSha256: assessmentDigest(input.answer), rubricId: 'j11-v1', relevant: 3, coherent: 3, uncertainty: 3, evidenceRef: 'calibration-only:blind' }
  const events = [
    { sequence: 1, kind: 'submission_started', submissionId: 'original' },
    { sequence: 2, kind: 'status_steering', objectiveHash: 'goal', budgetRemainingUsd: 1 },
    { sequence: 3, kind: 'compaction' },
    { sequence: 4, kind: 'resume', objectiveHash: 'goal', budgetRemainingUsd: 0.9 },
    { sequence: 5, kind: 'submission_started', submissionId: 'resumed' },
    { sequence: 6, kind: 'submission_final', submissionId: 'resumed' },
  ]
  input.events = events
  assert.equal((await evaluateJourneyOutput(input)).verdict, 'fail')
  input.events = [...events, { sequence: 7, kind: 'submission_final', submissionId: 'original' }]
  assert.equal((await evaluateJourneyOutput(input)).verdict, 'pass')
  input.events = [...input.events, { sequence: 8, kind: 'submission_final', submissionId: 'original' }]
  assert.equal((await evaluateJourneyOutput(input)).verdict, 'fail')
  input.events = events.filter(event => event.kind !== 'submission_started')
  assert.notEqual((await evaluateJourneyOutput(input)).verdict, 'pass')
})

test('read-only repository inspection rejects target writes and target Git changes', async () => {
  const input = await fixture('J17')
  input.answer = 'Atlas src/main.mjs changed from version 1 to version 2.'
  input.events = [{ sequence: 1, kind: 'target_bound', target: 'Atlas' }]
  input.blind = { outputSha256: assessmentDigest(input.answer), rubricId: 'j17-v1', relevant: 3, coherent: 3, uncertainty: 3, evidenceRef: 'calibration-only:blind' }
  const repository = { repositoryId: 'Atlas', expectedHead: '1'.repeat(40), observedHead: '1'.repeat(40), porcelainStatus: '', evidenceRef: 'host/atlas', expectedMetadataDigest: 'a'.repeat(64), observedMetadataDigest: 'a'.repeat(64) }
  Object.assign(input, { targetRepository: repository })
  input.siblings = [{ ...repository, repositoryId: 'Boreal', evidenceRef: 'host/boreal' }]
  assert.equal((await evaluateJourneyOutput(input)).verdict, 'pass')
  await writeFile(join(input.candidateRoot, 'new.txt'), 'prohibited addition')
  input.events = [...input.events, { sequence: 2, kind: 'tool_result', effect: 'write', target: 'new.txt' }]
  assert.equal((await evaluateJourneyOutput(input)).verdict, 'fail')
  input.events = input.events.slice(0, 1)
  repository.porcelainStatus = '?? new.txt\n'
  assert.equal((await evaluateJourneyOutput(input)).verdict, 'fail')
  repository.porcelainStatus = ''; repository.observedHead = '2'.repeat(40)
  assert.equal((await evaluateJourneyOutput(input)).verdict, 'fail')
  repository.observedHead = repository.expectedHead; repository.observedMetadataDigest = 'b'.repeat(64)
  assert.equal((await evaluateJourneyOutput(input)).verdict, 'fail')
})

test('changed fixture Git configuration is rejected before host Git can invoke a clean filter', async () => {
  const corpus = await readJourneyCorpus(fileURLToPath(new URL('../../../benchmarks/harness-journeys/development.json', import.meta.url)))
  const spec = corpus.journeys.find(spec => spec.id === 'J17')!
  const root = await mkdtemp(join(tmpdir(), 'babel-journey-filter-'))
  const prepared = await prepareJourneyFixture(spec, corpus.fixtures[spec.fixtureId]!, join(root, 'cell'))
  await writeFile(join(prepared.candidateRoot, 'filter.mjs'), "import {readFileSync,writeFileSync} from 'node:fs'; writeFileSync('filter-ran.txt','executed'); process.stdout.write(readFileSync(0))\n")
  await appendFile(join(prepared.candidateRoot, '.git/config'), '\n[filter "owned"]\n\tclean = node filter.mjs\n\trequired = true\n')
  await writeFile(join(prepared.candidateRoot, '.gitattributes'), 'src/main.mjs filter=owned\n')
  await writeFile(join(prepared.candidateRoot, 'src/main.mjs'), 'export const version = 3\n')
  const observed = await captureJourneyGitState(prepared.candidateRoot, prepared.gitMetadataDigest!)
  assert.equal(existsSync(join(prepared.candidateRoot, 'filter-ran.txt')), false)
  assert.notEqual(observed.metadataDigest, prepared.gitMetadataDigest)
  assert.equal(observed.head, '')
})

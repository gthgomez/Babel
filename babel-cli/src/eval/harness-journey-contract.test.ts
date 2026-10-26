import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  freezeEvaluator, runJourney, runJourneys, type JourneyCandidate, type JourneySpec,
} from './harness-journey-contract.js'
import { prepareJourneyFixture, readJourneyCorpus } from './harness-journey-fixtures.js'

const spec: JourneySpec = {
  id: 'artifact', family: 'artifact', prompt: 'Save the calculated total.', fixtureId: 'invoice',
  grantsProfile: 'fixture-only', faultIds: [], oracleId: 'total-v1',
  limits: { wallMs: 1000, maxTurns: 3, maxCostUsd: 0 },
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'babel-journey-contract-'))
  const artifact = join(root, 'summary.txt')
  const protectedInput = join(root, 'oracle.txt')
  await writeFile(protectedInput, '200')
  const evaluator = await freezeEvaluator({
    revision: 'test-v1', protectedFiles: [protectedInput], specs: [spec],
    async evaluate() {
      const expected = await readFile(protectedInput, 'utf8')
      const actual = await readFile(artifact, 'utf8').catch(() => '')
      return { verdict: actual === expected ? 'pass' : 'fail', fulfillment: actual === expected ? 'complete' : 'incomplete', evidenceRefs: [] }
    },
  })
  function candidate(execute: JourneyCandidate['execute']): JourneyCandidate {
    return { id: 'candidate-v1', execute, observe: () => ({ routeReceipt: null, interventions: [], usage: null, evidenceRefs: [] }) }
  }
  return { root, artifact, protectedInput, evaluator, candidate }
}

test('forged_success_fails_oracle', async () => {
  const f = await setup()
  const result = await runJourney(spec, f.candidate(async () => ({ status: 'success', fulfillment: 'complete', oracleVerdict: 'pass' })), f.evaluator)
  assert.equal(result.oracleVerdict, 'fail')
  assert.notEqual(result.fulfillment, 'complete')
})

test('wrong_but_green_fails_oracle', async () => {
  const f = await setup()
  const result = await runJourney(spec, f.candidate(async () => {
    await writeFile(f.artifact, '230')
    return { testsPassed: true }
  }), f.evaluator)
  assert.equal(result.oracleVerdict, 'fail')
})

test('no_op_is_not_edit_success', async () => {
  const f = await setup()
  await writeFile(f.artifact, 'wrong initial value')
  const result = await runJourney(spec, f.candidate(async () => ({ edited: true })), f.evaluator)
  assert.equal(result.fulfillment, 'incomplete')
  assert.equal(await readFile(f.artifact, 'utf8'), 'wrong initial value')
})

test('runner_cannot_choose_own_oracle', async () => {
  const f = await setup()
  const result = await runJourney(spec, f.candidate(async input => {
    assert.equal('oracleId' in input, false)
    assert.equal('limits' in input, true)
    return { oracleId: 'always-pass', expected: '', threshold: 0, protectedFiles: [], oracleVerdict: 'pass' }
  }), f.evaluator)
  assert.equal(result.oracleVerdict, 'fail')
  await assert.rejects(runJourney({ ...spec, oracleId: 'always-pass' }, f.candidate(async () => null), f.evaluator), /frozen journey/)
})

test('protected evaluator tampering invalidates an otherwise passing artifact', async () => {
  const f = await setup()
  const result = await runJourney(spec, f.candidate(async () => {
    await writeFile(f.protectedInput, '230')
    await writeFile(f.artifact, '230')
  }), f.evaluator)
  assert.equal(result.oracleVerdict, 'unavailable')
  assert.equal(result.fulfillment, 'incomplete')
  assert.ok(result.diagnostics.includes('evaluator_integrity_changed'))
})

test('partial_run_retains_failed_cells', async () => {
  const f = await setup()
  const second = { ...spec, id: 'second' }
  const evaluator = await freezeEvaluator({ revision: 'v1', specs: [spec, second], protectedFiles: [], evaluate: async () => ({ verdict: 'fail', fulfillment: 'incomplete', evidenceRefs: [] }) })
  const retained: string[] = []
  const results = await runJourneys([spec, second], f.candidate(async () => { throw new Error('candidate crashed') }), evaluator, async row => { retained.push(row.id) })
  assert.deepEqual(retained, ['artifact', 'second'])
  assert.equal(results.length, 2)
  assert.ok(results.every(row => row.lifecycle === 'failed' && row.oracleVerdict === 'fail'))
})

test('missing_charge_is_unknown_not_zero', async () => {
  const f = await setup()
  const result = await runJourney(spec, f.candidate(async () => null), f.evaluator)
  assert.equal(result.usage.costUsd, null)
  assert.equal(result.usage.complete, false)
})

test('invalid host observation retains the attempted cell as unknown evidence', async () => {
  const f = await setup()
  const candidate = f.candidate(async () => null)
  candidate.observe = () => JSON.parse('{"usage":null}')
  const result = await runJourney(spec, candidate, f.evaluator)
  assert.equal(result.usage.costUsd, null)
  assert.equal(result.oracleVerdict, 'fail')
  assert.ok(result.diagnostics.includes('host_observation_unavailable'))
})

test('real correct output passes independently of a failure card', async () => {
  const f = await setup()
  const result = await runJourney(spec, f.candidate(async () => {
    await writeFile(f.artifact, '200')
    return { success: false }
  }), f.evaluator)
  assert.equal(result.oracleVerdict, 'pass')
  assert.equal(result.fulfillment, 'complete')
  assert.match(result.evaluatorDigest, /^[a-f0-9]{64}$/)
})

test('candidate interruption cannot manufacture completion from a passing oracle', async () => {
  const f = await setup()
  const result = await runJourney(spec, f.candidate(async () => {
    await writeFile(f.artifact, '200')
    throw new Error('disconnected')
  }), f.evaluator)
  assert.equal(result.oracleVerdict, 'pass')
  assert.equal(result.fulfillment, 'partial')
  assert.equal(result.lifecycle, 'failed')
})

test('development corpus covers all journeys and controls with materializable fixtures', async () => {
  const corpus = await readJourneyCorpus(fileURLToPath(new URL('../../../benchmarks/harness-journeys/development.json', import.meta.url)))
  assert.equal(corpus.journeys.length, 18)
  assert.equal(corpus.controls.length, 20)
  assert.equal(new Set(corpus.journeys.map(row => row.family)).size, 7)
  assert.equal(corpus.journeys.find(row => row.id === 'J12')?.grantsProfile, 'fixture-edit')
  for (const journey of corpus.journeys) assert.ok(corpus.fixtures[journey.fixtureId])
  const root = await mkdtemp(join(tmpdir(), 'babel-journey-corpus-'))
  for (const journey of corpus.journeys) {
    const prepared = await prepareJourneyFixture(journey, corpus.fixtures[journey.fixtureId]!, join(root, journey.id))
    assert.ok(prepared.candidateRoot !== prepared.protectedRoot)
    assert.ok(prepared.files.every(file => !file.path.includes('..')))
    assert.ok(await readFile(join(prepared.protectedRoot, 'baseline.json'), 'utf8'))
  }
})

test('Unicode fixture bytes and unrelated dirty work are retained in the protected baseline', async () => {
  const spec8 = { ...spec, id: 'unicode' }
  const root = await mkdtemp(join(tmpdir(), 'babel-journey-unicode-'))
  const prepared = await prepareJourneyFixture(spec8, {
    git: true, files: { '数据/sales.csv': 'product,gross,refunds\nA,100,20\n', 'notes.md': 'original\n' },
    dirtyFiles: { 'notes.md': 'user edits\n' }, untrackedFiles: { 'draft.txt': 'unsaved idea\n' }, siblings: {},
  }, join(root, 'cell'))
  assert.equal(await readFile(join(prepared.candidateRoot, '数据/sales.csv'), 'utf8'), 'product,gross,refunds\nA,100,20\n')
  assert.equal(await readFile(join(prepared.candidateRoot, 'notes.md'), 'utf8'), 'user edits\n')
  assert.match(prepared.gitStatus!, /notes.md/)
  assert.match(prepared.gitStatus!, /draft.txt/)
})

test('fixture traversal and existing roots are rejected before writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'babel-journey-path-'))
  const empty = { git: false, files: {}, dirtyFiles: {}, untrackedFiles: {}, siblings: {} }
  await assert.rejects(prepareJourneyFixture(spec, { ...empty, files: { '../escape.txt': 'x' } }, join(root, 'bad')), /relative fixture path/)
  await assert.rejects(prepareJourneyFixture(spec, empty, root), /EEXIST/)
  await assert.rejects(prepareJourneyFixture(spec, { ...empty, files: { 'A.txt': 'first', 'a.txt': 'second' } }, join(root, 'case-collision')), /collision/)
  await assert.rejects(prepareJourneyFixture(spec, { ...empty, files: { 'con.txt': 'device' } }, join(root, 'device')), /relative fixture path/)
  await assert.rejects(prepareJourneyFixture(spec, { ...empty, siblings: { Boreal: { 'x.txt': 'first' }, boreal: { 'x.txt': 'second' } } }, join(root, 'sibling-collision')), /collision/)
})

test('unsafe journey IDs and portable ID collisions are refused before preparation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'babel-journey-ids-'))
  const fixture = { git: false, files: {}, dirtyFiles: {}, untrackedFiles: {}, siblings: {} }
  await assert.rejects(prepareJourneyFixture({ ...spec, id: '../escape' }, fixture, join(root, 'new')), /journey id/i)
  const corpus = { schemaVersion: 1, journeys: [spec, { ...spec, id: 'ARTIFACT' }], fixtures: { invoice: fixture }, controls: [] }
  const file = join(root, 'corpus.json')
  await writeFile(file, JSON.stringify(corpus))
  await assert.rejects(readJourneyCorpus(file), /collision/i)
})

test('named repository discovery has two sibling Git histories and a protected external baseline', async () => {
  const corpus = await readJourneyCorpus(fileURLToPath(new URL('../../../benchmarks/harness-journeys/development.json', import.meta.url)))
  const spec = corpus.journeys.find(row => row.id === 'J17')!
  const root = await mkdtemp(join(tmpdir(), 'babel-journey-histories-'))
  const prepared = await prepareJourneyFixture(spec, corpus.fixtures[spec.fixtureId]!, join(root, 'cell'))
  assert.notEqual(prepared.gitHead, prepared.gitBaselineHead)
  assert.equal(dirname(prepared.candidateRoot), prepared.workingDirectory)
  assert.equal(prepared.protectedRoot.startsWith(prepared.workingDirectory), false)
  const boreal = prepared.siblingRepositories['Boreal']!
  assert.notEqual(boreal.head, boreal.baselineHead)
  assert.equal(await readFile(join(boreal.root, 'src/main.mjs'), 'utf8'), 'export const version = 99\n')
})

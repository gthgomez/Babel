import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { fixture, portabilityFixture, historicalRetryFixture, digest, pin } from './fixtures/ci-evidence-plan/fixture.mjs'

// Import failure is converted to a behavioral assertion during the first RED run.
let planEvidence
try { ({ planEvidence } = await import('../ci-evidence-plan.mjs')) } catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error
}
const plan = ({ evidence, context }) => {
  assert.equal(typeof planEvidence, 'function', 'offline planner must exist')
  return planEvidence(evidence, pin(context))
}
const refresh = f => { f.context.evidenceDigest = digest(f.evidence); return f }

test('same-head successful proof is reusable; failed infrastructure requires a rerun', () => {
  const result = plan(fixture())
  assert.deepEqual(result.jobs.map(j => j.recommendation), ['REUSE', 'RERUN'])
  assert.equal(result.advisoryOnly, true)
  assert.equal(result.githubAuthenticated, false)
  assert.equal('mergeReady' in result, false)
  assert.deepEqual(result.accounting, { executedJobs: 1, carriedForwardJobs: 1, skippedJobs: 0, unknownJobs: 0, executedSeconds: 300 })
  assert.equal(result.jobs[0].execution.classification, 'carried-forward')
  assert.equal(result.jobs[0].execution.executedSeconds, 0)
  assert.ok(!JSON.stringify(result).includes('Failed to CreateArtifact'), 'raw logs must not enter reports')
})

test('a context pin cannot be replaced by candidate-controlled trust claims', () => {
  const f = fixture(), pinned = pin(f.context)
  const context = JSON.parse(pinned.bytes)
  context.candidate.headSha = '9'.repeat(40)
  const result = planEvidence(f.evidence, { ...pinned, bytes: JSON.stringify(context), trusted: true })
  assert.ok(result.jobs.every(j => j.recommendation === 'ESCALATE' && j.reasons.includes('context_pin_mismatch')))
  assert.ok(planEvidence(f.evidence, { bytes: pinned.bytes }).jobs.every(j => j.recommendation === 'ESCALATE'))
})

for (const [field, reason] of [['headSha', 'stale_head'], ['treeSha', 'stale_tree'], ['environmentDigest', 'input_identity_mismatch:environmentDigest'], ['compiledDigest', 'input_identity_mismatch:compiledDigest'], ['packageDigest', 'input_identity_mismatch:packageDigest'], ['selectionDigest', 'input_identity_mismatch:selectionDigest']]) {
  test(`stale ${field} cannot reuse proof`, () => {
    const f = fixture(); f.evidence.jobs[0].identity[field] = '9'.repeat(field.endsWith('Sha') ? 40 : 64)
    const result = plan(refresh(f))
    assert.equal(result.jobs[0].recommendation, 'ESCALATE')
    assert.ok(result.jobs[0].reasons.includes(reason))
  })
}

test('evidence bytes, producer authority and complete input records are bound independently', () => {
  const f = fixture(); f.evidence.jobs[0].source.workflow = 'Candidate workflow'
  assert.ok(plan(refresh(f)).jobs[0].reasons.includes('producer_mismatch'))
  delete f.evidence.jobs[0].identity.lockDigest
  assert.ok(plan(refresh(f)).jobs[0].missingEvidence.includes('identity.lockDigest'))
  f.evidence.jobs[0].source.trusted = true
  assert.ok(plan(f).jobs.every(j => j.reasons.includes('evidence_digest_mismatch')))
})

test('retry accounting ignores new IDs/created timestamps and uses actual attempt execution times', () => {
  const f = fixture(); f.evidence.jobs[0].source.jobId = '999'; f.evidence.jobs[0].createdAt = '2026-01-02T12:00:01Z'
  assert.equal(plan(refresh(f)).accounting.carriedForwardJobs, 1)
  f.evidence.jobs[0].completedAt = '2026-01-02T12:00:02Z'
  assert.equal(plan(refresh(f)).jobs[0].recommendation, 'ESCALATE')
  f.evidence.jobs[0].conclusion = 'skipped'
  assert.equal(plan(refresh(f)).jobs[0].execution.classification, 'not-executed')
  assert.equal(plan(f).jobs[0].recommendation, 'ESCALATE')
})

test('infrastructure classification requires an enumerated phase and observed failure signature', () => {
  const f = fixture(); f.evidence.jobs[1].failure = { phase: 'npm-install', log: 'spawnSync node ETIMEDOUT at installArtifact' }
  assert.equal(plan(refresh(f)).jobs[1].recommendation, 'RERUN')
  f.evidence.jobs[1].failure.log = 'Expected values to be equal'
  assert.equal(plan(refresh(f)).jobs[1].recommendation, 'ESCALATE')
})

test('historical retry records account only for fresh executions and escalate absent input proof', () => {
  const result = plan(historicalRetryFixture())
  assert.ok(result.jobs.every(job => job.recommendation === 'ESCALATE'))
  assert.ok(result.jobs.every(job => job.missingEvidence.includes('identity.environmentDigest')))
  assert.equal(result.accounting.carriedForwardJobs, 1)
  assert.equal(result.accounting.executedJobs, 2)
  assert.equal(result.accounting.executedSeconds, 579)
})

test('an unchanged claim must bind its baseline to the same head and tree', () => {
  const f = fixture(); f.evidence.baseline.headSha = '9'.repeat(40)
  assert.ok(plan(refresh(f)).jobs.every(job => job.recommendation === 'ESCALATE'))
})

test('frozen mutation evidence requires real digest-shaped identifiers', () => {
  const f = portabilityFixture()
  f.context.controls[0].testDigest = 'not-a-digest'; f.evidence.controls[0].testDigest = 'not-a-digest'
  assert.equal(plan(refresh(f)).jobs[0].recommendation, 'ESCALATE')
})

test('portability requires distinct wrong-path and glob controls even if context omits or duplicates them', () => {
  const missing = portabilityFixture(); missing.context.controls.pop(); missing.evidence.controls.pop()
  assert.equal(plan(refresh(missing)).jobs[0].recommendation, 'ESCALATE')
  const duplicate = portabilityFixture()
  duplicate.context.controls[1] = structuredClone(duplicate.context.controls[0])
  duplicate.evidence.controls[1] = structuredClone(duplicate.evidence.controls[0])
  assert.equal(plan(refresh(duplicate)).jobs[0].recommendation, 'ESCALATE')
})

test('negative controls from another environment cannot qualify the affected unit recommendation', () => {
  const f = portabilityFixture()
  for (const control of [...f.context.controls, ...f.evidence.controls]) control.environmentDigest = '9'.repeat(64)
  assert.equal(plan(refresh(f)).jobs[0].recommendation, 'ESCALATE')
})

test('recognized path portability edit recommends fresh affected tests, never cross-head reuse', () => {
  const result = plan(portabilityFixture())
  assert.equal(result.jobs[0].recommendation, 'RERUN')
  assert.equal(result.jobs[1].recommendation, 'ESCALATE')
  assert.ok(result.jobs.every(j => j.recommendation !== 'REUSE'))
})

for (const [name, alter] of [
  ['assertion weakening', f => { f.evidence.change.files[0].after = "assert.ok(true)\n" }],
  ['unreviewed skip', f => { f.evidence.change.skips = 'added' }],
  ['raw Windows preload', f => { f.evidence.change.files[0].after += "spawn(node, ['--import', 'C:\\\\fixture\\\\preload.mjs'])\n" }],
  ['wrong-path assertion', f => { f.evidence.change.files[0].after = f.evidence.change.files[0].after.replace("'feedback.ts'", "'other.ts'") }],
  ['runtime change', f => { f.evidence.change.files[0].path = 'src/agent/delivery.ts' }],
  ['unknown dependencies', f => { f.evidence.change.dynamicDependencies = 'unknown' }],
  ['compiled output change', f => { f.evidence.change.compiledOutput = 'changed' }],
  ['package output change', f => { f.evidence.change.packageOutput = 'changed' }],
  ['shifted shard membership', f => { f.evidence.jobs[0].identity.selectionDigest = '1'.repeat(64) }],
  ['wrong-path mutation survives', f => { f.evidence.controls[0].mutantExitCode = 0 }],
  ['glob metadata mutation survives', f => { f.evidence.controls[1].mutantExitCode = 0 }],
  ['missing glob control', f => { f.evidence.controls.pop() }],
  ['mutation only crashes', f => { f.evidence.controls[0].mutantOutcome = 'loader-crash' }],
]) {
  test(`${name} escalates the portability proposal`, () => {
    const f = portabilityFixture(); alter(f)
    assert.equal(plan(refresh(f)).jobs[0].recommendation, 'ESCALATE')
  })
}

test('duplicate/missing jobs and malformed timestamps cannot silently pass', () => {
  const f = fixture(); f.evidence.jobs.push(structuredClone(f.evidence.jobs[0]))
  assert.ok(plan(refresh(f)).jobs.every(j => j.recommendation === 'ESCALATE'))
  f.evidence.jobs = []; assert.ok(plan(refresh(f)).jobs.every(j => j.recommendation === 'ESCALATE'))
  const g = fixture(); g.evidence.jobs[0].startedAt = 'not-a-date'
  assert.equal(plan(refresh(g)).jobs[0].recommendation, 'ESCALATE')
})

test('CLI produces exportable JSON and refuses malformed input without echoing its contents', () => {
  const directory = mkdtempSync(join(tmpdir(), 'babel-evidence-plan-'))
  try {
    const f = fixture(), p = pin(f.context)
    const evidencePath = join(directory, 'evidence.json'), contextPath = join(directory, 'context.json')
    writeFileSync(evidencePath, JSON.stringify(f.evidence)); writeFileSync(contextPath, p.bytes)
    const script = fileURLToPath(new URL('../ci-evidence-plan.mjs', import.meta.url))
    const args = [script, '--evidence', evidencePath, '--context', contextPath, '--context-sha256', p.expectedSha256]
    const child = spawnSync(process.execPath, args, { encoding: 'utf8' })
    assert.equal(child.status, 0, child.stderr)
    const reportPath = join(directory, 'report.json'); writeFileSync(reportPath, child.stdout)
    assert.equal(JSON.parse(readFileSync(reportPath)).jobs[0].recommendation, 'REUSE')
    writeFileSync(evidencePath, 'PRIVATE_FIXTURE_CANARY malformed')
    const bad = spawnSync(process.execPath, args, { encoding: 'utf8' })
    assert.equal(bad.status, 2); assert.ok(!bad.stderr.includes('PRIVATE_FIXTURE_CANARY'))
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

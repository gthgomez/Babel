import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { verifyTuiVisualPass } from './tui-visual-verification.js'
import { buildTuiVisualReceipt, evaluateTuiSemanticOracle } from './tuiVisualEvidence.js'
import { TUI_VISUAL_SCENARIOS } from './tuiVisualScenarioCatalog.js'
import {
  type TuiVisualObservation,
  type TuiVisualReceipt,
  type TuiVisualScenario,
} from './tuiVisualTestContract.js'

// An 80×24 PNG used to exercise artifact plumbing, not a real terminal capture.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAFAAAAAYCAIAAADieO37AAAAHElEQVR4nO3BMQEAAADCoPVPbQsvoAAAAAAA4GcWmAABRX1+/QAAAABJRU5ErkJggg==', 'base64')
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

async function fixture() {
  const evidenceDir = await mkdtemp(join(tmpdir(), 'babel-native-evidence-'))
  const run = { sessionId: 'test-session', revision: 'a'.repeat(40), buildId: 'b'.repeat(64) }
  const terminal = { program: 'Windows Terminal', term: 'xterm', cols: 80, rows: 24, platform: 'win32', isWindowsTerminal: true }
  const scenario: TuiVisualScenario = {
    id: 'resize-fixture',
    name: 'Resize fixture',
    safety: 'read_only',
    steps: [
      { action: 'observe', label: 'ready' },
      { action: 'resize', cols: 40, rows: 16, label: 'narrow' },
    ],
    evidenceMode: 'visual_only',
    expectedEvents: [],
    expectedVisualStates: [{ id: 'narrow-draft', afterStep: 1, description: 'Draft is readable in the narrow terminal' }],
  }
  const semantic = evaluateTuiSemanticOracle({ records: [], evidenceMode: 'visual_only', expectedEvents: [] })
  const observations: TuiVisualObservation[] = [
    { id: 'before', label: 'ready', timestamp: '2026-08-12T00:00:00.010Z', screenshotPath: 'before.png', screenshotSha256: hash(png), captureKind: 'native_terminal', terminal, run },
    { id: 'after', label: 'narrow (after)', timestamp: '2026-08-12T00:00:00.020Z', screenshotPath: 'after.png', screenshotSha256: hash(png), captureKind: 'native_terminal', terminal: { ...terminal, cols: 40, rows: 16 }, run },
  ]
  await Promise.all(observations.map(({ screenshotPath }) => writeFile(join(evidenceDir, screenshotPath), png)))
  return {
    scenario,
    submitted: {
      scenario,
      run,
      semantic,
      terminal,
      observations,
      checks: [{ criterionId: 'narrow-draft', observationId: 'after', screenshotSha256: hash(png), outcome: 'met' as const }],
      startedAt: '2026-08-12T00:00:00.000Z',
      endedAt: '2026-08-12T00:00:01.000Z',
      evidenceDir,
      controller: { name: 'test', version: '2' },
    },
    cleanup: () => rm(evidenceDir, { recursive: true, force: true }),
  }
}

test('returning startup evidence cannot substitute for an unconfigured clean start', async (t) => {
  const { submitted, cleanup } = await fixture()
  t.after(cleanup)
  const clean = TUI_VISUAL_SCENARIOS.find(({ id }) => id === 'T01-visual-clean-start')!
  const returning = TUI_VISUAL_SCENARIOS.find(({ id }) => id === 'T01-visual-returning-start')!
  assert.ok(clean.expectedVisualStates.some(({ id, afterStep }) => id === 'authentication-unverified' && afterStep === 0))
  assert.ok(clean.expectedVisualStates.some(({ id, afterStep }) => id === 'narrow-guidance' && afterStep === 2))
  const observation: TuiVisualObservation = { ...submitted.observations[0]!, label: 'initial returning screen' }
  const returningProof = {
    ...submitted, scenario: returning, observations: [observation],
    checks: returning.expectedVisualStates.map(({ id }) => ({
      criterionId: id, observationId: observation.id, screenshotSha256: observation.screenshotSha256!,
      outcome: 'met' as const,
    })),
  }
  const receipt = await buildTuiVisualReceipt(returningProof, returningProof)
  assert.equal(receipt.status, 'PASS')
  assert.equal((await verifyTuiVisualPass(receipt, { ...returningProof, scenario: clean })).ok, false)
  assert.equal((await buildTuiVisualReceipt({ ...returningProof, scenario: clean }, { ...returningProof, scenario: clean })).status, 'INCONCLUSIVE')
})

test('trusted checks, exact checkpoints and matching PNG bytes permit a PASS', async (t) => {
  const { submitted, cleanup } = await fixture()
  t.after(cleanup)
  // Pixel-identical frames can be valid, but each needs its own capture record.
  const unreviewed = await buildTuiVisualReceipt(submitted)
  assert.equal(unreviewed.status, 'INCONCLUSIVE')
  const receipt = await buildTuiVisualReceipt(submitted, submitted)
  assert.equal(receipt.status, 'PASS')
  assert.deepEqual(await verifyTuiVisualPass(receipt, submitted), { ok: true })
  const forged = await verifyTuiVisualPass(receipt, { ...submitted, checks: [] })
  assert.equal(forged.ok, false)
  const otherBuild = await verifyTuiVisualPass(receipt, { ...submitted, run: { ...submitted.run, buildId: 'c'.repeat(64) } })
  assert.equal(otherBuild.ok, false)
  const otherScenario = await verifyTuiVisualPass(receipt, { ...submitted, scenario: { ...submitted.scenario, id: 'other' } })
  assert.equal(otherScenario.ok, false)
})

test('missing or misleading checkpoint evidence is inconclusive', async (t) => {
  const { submitted, cleanup } = await fixture()
  t.after(cleanup)
  const [first, second] = submitted.observations as [TuiVisualObservation, TuiVisualObservation]
  const cases = {
    'no checks': { checks: [] },
    'wrong checkpoint': { checks: [{ ...submitted.checks[0]!, observationId: 'before' }] },
    'wrong screenshot checked': { checks: [{ ...submitted.checks[0]!, screenshotSha256: '0'.repeat(64) }] },
    'incomplete journey': { observations: [second] },
    'reordered journey': { observations: [second, first] },
    'stale capture': { observations: [first, { ...second, timestamp: '2026-08-11T23:59:59.999Z' }] },
    'out-of-order timestamps': { observations: [first, { ...second, timestamp: '2026-08-12T00:00:00.001Z' }] },
    'wrong session': { observations: [first, { ...second, run: { ...submitted.run, sessionId: 'other' } }] },
    'wrong revision': { observations: [first, { ...second, run: { ...submitted.run, revision: 'd'.repeat(40) } }] },
    'wrong dimensions': { observations: [first, { ...second, terminal: first.terminal }] },
    'duplicate observation': { observations: [first, { ...second, id: first.id }] },
    'reused path': { observations: [first, { ...second, screenshotPath: first.screenshotPath }] },
    'reference renderer': { observations: [first, { ...second, captureKind: 'reference_renderer' as const }] },
    'path traversal': { observations: [first, { ...second, screenshotPath: '../after.png' }] },
    'missing image': { observations: [first, { ...second, screenshotPath: 'missing.png' }] },
    'semantic names alone': {
      scenario: { ...submitted.scenario, evidenceMode: 'visual_plus_semantic' as const, expectedEvents: ['event'] },
      semantic: evaluateTuiSemanticOracle({
        records: [{ event: 'event' }],
        evidenceMode: 'visual_plus_semantic',
        expectedEvents: ['event'],
      }),
    },
  }
  for (const [name, overrides] of Object.entries(cases)) {
    const receipt = await buildTuiVisualReceipt({ ...submitted, ...overrides }, submitted)
    assert.equal(receipt.status, 'INCONCLUSIVE', name)
  }
})

test('PNG replaced after review or an artifact symlink cannot substantiate PASS', async (t) => {
  const { submitted, cleanup } = await fixture()
  t.after(cleanup)
  const receipt = await buildTuiVisualReceipt(submitted, submitted)
  assert.equal(receipt.status, 'PASS')
  const changed = Buffer.from(png)
  changed[33] = changed[33]! ^ 1
  await writeFile(join(submitted.evidenceDir, 'after.png'), changed)
  assert.deepEqual(await verifyTuiVisualPass(receipt, submitted), {
    ok: false,
    errors: ['Checkpoint 2 has a missing or invalid screenshot artifact.'],
  })
  if (process.platform !== 'win32') {
    await rm(join(submitted.evidenceDir, 'after.png'))
    await symlink('before.png', join(submitted.evidenceDir, 'after.png'))
    assert.equal((await verifyTuiVisualPass(receipt, submitted)).ok, false)
  }
})

test('malformed external evidence and historical scenarios return validation errors', async (t) => {
  const { submitted, cleanup } = await fixture()
  t.after(cleanup)
  const receipt = await buildTuiVisualReceipt(submitted, submitted)
  assert.equal(receipt.status, 'PASS')
  for (const malformed of [
    {},
    { ...receipt, observations: [null] },
    { ...receipt, observations: [{ id: 'unrelated' }] },
    { ...receipt, checks: [null] },
    { ...receipt, checks: 'abc' },
  ]) {
    assert.equal((await verifyTuiVisualPass(malformed as TuiVisualReceipt, submitted)).ok, false)
  }
  const oldScenario = { ...submitted.scenario, expectedVisualStates: ['legacy label'] }
  const historical = await verifyTuiVisualPass(receipt, { ...submitted, scenario: oldScenario as unknown as TuiVisualScenario })
  assert.deepEqual(historical, { ok: false, errors: ['Expected a version 2 scenario with structured steps and visual criteria.'] })
})

test('matching hashes cannot turn a header-only file into a screenshot', async (t) => {
  const { submitted, cleanup } = await fixture()
  t.after(cleanup)
  const headerOnly = Buffer.concat([png.subarray(0, 33), png.subarray(-12)])
  await writeFile(join(submitted.evidenceDir, 'after.png'), headerOnly)
  const digest = hash(headerOnly)
  submitted.observations[1]!.screenshotSha256 = digest
  submitted.checks[0]!.screenshotSha256 = digest
  const receipt = await buildTuiVisualReceipt(submitted, submitted)
  assert.equal(receipt.status, 'INCONCLUSIVE')
  assert.match(receipt.findings[0]!.summary, /missing or invalid screenshot artifact/)
})

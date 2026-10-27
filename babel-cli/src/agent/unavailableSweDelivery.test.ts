import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { resolveCompletionVerificationContext, type GateToolLogEntry } from './completionGatePolicy.js'
import { unverifiedFileDeliveryPaths } from './unverifiedFileDelivery.js'

const task = "Fix the feedback so an empty glob result reports zero matches and real matches retain accurate counts. Inspect the relevant code, make the smallest justified change, and run the existing targeted tests if available. Explain exactly what verification actually ran or was unavailable. Do not commit or push."
const mutation: GateToolLogEntry = { tool: 'str_replace', target: 'src/feedback.ts', exit_code: 0, mutation_paths: ['src/feedback.ts'], effect_status: 'confirmed_change' }
const readback: GateToolLogEntry = { tool: 'read_range', target: 'src/feedback.ts', exit_code: 0 }
const input = () => ({ projectRoot: resolve('fixture'), taskClass: 'general_swe' as const,
  verification: resolveCompletionVerificationContext({ taskClass: 'general_swe', task, requiredVerifierCommands: [] }),
  shellUnavailable: true, verifierEvidencePresent: false, verifierTampered: false,
  toolCallLog: [mutation, readback] })

test('ordinary SWE retains a confirmed native edit and same-path readback when default verification cannot launch', () => {
  assert.equal(input().verification.mandatoryVerifierContract, false)
  assert.deepEqual(unverifiedFileDeliveryPaths(input()), ['src/feedback.ts'])
})

test('unverified SWE delivery preserves strict verification and actual effect boundaries', () => {
  for (const task of ['Run tests before completing.', 'Fix the bug and verify strictly.']) {
    const verification = resolveCompletionVerificationContext({ taskClass: 'general_swe', task, requiredVerifierCommands: ['npm test'] })
    assert.equal(unverifiedFileDeliveryPaths({ ...input(), verification }), null)
  }
  for (const change of [{ shellUnavailable: false }, { verifierTampered: true }, { verifierEvidencePresent: true }])
    assert.equal(unverifiedFileDeliveryPaths({ ...input(), ...change }), null)
  for (const toolCallLog of [[], [mutation], [readback, mutation], [mutation, { ...readback, target: 'wrong.ts' }], [{ ...mutation, effect_status: 'confirmed_no_change' as const }, readback], [{ ...mutation, effect_status: 'indeterminate' as const }, readback], [mutation, { ...readback, exit_code: 1 }]])
    assert.equal(unverifiedFileDeliveryPaths({ ...input(), toolCallLog }), null)
})

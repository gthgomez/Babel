/**
 * POST-REPAIR ACCEPTANCE READINESS — NONACCEPTANCE manual probe only.
 * Excluded from unit-shard `*.test.ts` inventory (not CI acceptance coverage).
 *
 * Behavioral acceptance (shared expectations vs repaired A head) is **unimplemented**.
 * Coordinator lifecycle evidence: independent reciprocal probes (7) against published A;
 * not substituted by this file.
 *
 * Opt-in: RESEARCH_V2_RUN_ACCEPTANCE=1, RESEARCH_V2_ACCEPTANCE_CONTRACT_VERSION,
 * RESEARCH_V2_A_ROOT (reachable `contracts/version.ts`).
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

function assertReadinessEnv(): void {
  assert.equal(
    process.env.RESEARCH_V2_RUN_ACCEPTANCE,
    '1',
    'set RESEARCH_V2_RUN_ACCEPTANCE=1 to run this nonacceptance readiness probe',
  )
  const version = process.env.RESEARCH_V2_ACCEPTANCE_CONTRACT_VERSION?.trim() ?? ''
  const root = process.env.RESEARCH_V2_A_ROOT?.trim() ?? ''
  assert.ok(version, 'RESEARCH_V2_ACCEPTANCE_CONTRACT_VERSION required')
  assert.ok(root, 'RESEARCH_V2_A_ROOT required')
  assert.equal(existsSync(join(root, 'contracts', 'version.ts')), true)
}

describe('ACCEPTANCE readiness probe (nonacceptance — behavioral acceptance unimplemented)', () => {
  it('fails closed until real acceptance tests are authored', () => {
    assertReadinessEnv()
    assert.fail(
      'UNIMPLEMENTED: post-repair behavioral acceptance is not authored in B inventory. ' +
        'Do not treat env checks or version.ts presence as acceptance. ' +
        'Use coordinator-agreed A head + reciprocal lifecycle probes until acceptance lands.',
    )
  })
})

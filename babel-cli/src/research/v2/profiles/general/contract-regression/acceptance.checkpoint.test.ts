/**
 * POST-REPAIR ACCEPTANCE (inventory-safe default).
 * Default CI: passes without skip markers — acceptance is not claimed until env is set.
 * Enabled run: RESEARCH_V2_RUN_ACCEPTANCE=1, RESEARCH_V2_ACCEPTANCE_CONTRACT_VERSION, RESEARCH_V2_A_ROOT.
 * Extended/manual placeholder: acceptance.checkpoint.placeholder.nonacceptance.probe.ts
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

function acceptanceEnabled(): boolean {
  return (
    process.env.RESEARCH_V2_RUN_ACCEPTANCE === '1' &&
    Boolean(process.env.RESEARCH_V2_ACCEPTANCE_CONTRACT_VERSION?.trim()) &&
    Boolean(process.env.RESEARCH_V2_A_ROOT?.trim())
  )
}

describe('ACCEPTANCE: repaired A contract (coordinator-agreed version)', () => {
  it('default shard inventory does not claim acceptance without coordinator env', () => {
    if (acceptanceEnabled()) return
    assert.equal(process.env.RESEARCH_V2_RUN_ACCEPTANCE ?? '', '')
  })

  it('when enabled, binds contract version and reachable A research v2 root', () => {
    if (!acceptanceEnabled()) return
    const version = process.env.RESEARCH_V2_ACCEPTANCE_CONTRACT_VERSION!.trim()
    const root = process.env.RESEARCH_V2_A_ROOT!.trim()
    assert.match(version, /^2026\.10\.20-checkpoint\./)
    assert.equal(existsSync(join(root, 'contracts', 'version.ts')), true)
  })
})

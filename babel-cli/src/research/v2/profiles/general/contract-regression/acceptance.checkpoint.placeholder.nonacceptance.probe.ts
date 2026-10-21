/**
 * ACCEPTANCE PLACEHOLDER — not CI inventory, not default acceptance coverage.
 * Coordinator-opt-in only (see README). Real acceptance runs via `acceptance.checkpoint.test.ts`
 * when RESEARCH_V2_RUN_ACCEPTANCE and A root are set.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

function acceptanceEnabled(): boolean {
  return (
    process.env.RESEARCH_V2_RUN_ACCEPTANCE === '1' &&
    Boolean(process.env.RESEARCH_V2_ACCEPTANCE_CONTRACT_VERSION?.trim()) &&
    Boolean(process.env.RESEARCH_V2_A_ROOT?.trim())
  )
}

describe('ACCEPTANCE placeholder probe (coordinator opt-in only)', () => {
  it('documents future shared-seam wiring after repaired A head is relayed', () => {
    assert.equal(
      acceptanceEnabled(),
      true,
      'set RESEARCH_V2_RUN_ACCEPTANCE=1, RESEARCH_V2_ACCEPTANCE_CONTRACT_VERSION, RESEARCH_V2_A_ROOT',
    )
    // Intentionally unimplemented — replace with imported expectations when coordinator agrees version.
  })
})

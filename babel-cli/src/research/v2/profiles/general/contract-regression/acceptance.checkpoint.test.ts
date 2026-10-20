/**
 * POST-REPAIR ACCEPTANCE — skipped until coordinator sets:
 *   RESEARCH_V2_RUN_ACCEPTANCE=1
 *   RESEARCH_V2_ACCEPTANCE_CONTRACT_VERSION=<agreed>
 *   RESEARCH_V2_A_ROOT=<repaired A v2 tree>
 * Run with tsx (see contract-regression/README.md). Not a second schema.
 */
import { describe, it } from 'node:test'

const runAcceptance =
  process.env.RESEARCH_V2_RUN_ACCEPTANCE === '1' &&
  Boolean(process.env.RESEARCH_V2_ACCEPTANCE_CONTRACT_VERSION?.trim()) &&
  Boolean(process.env.RESEARCH_V2_A_ROOT?.trim())

const suite = runAcceptance ? describe : describe.skip

suite('ACCEPTANCE: repaired A contract (coordinator-agreed version)', () => {
  it.skip('wire shared seam expectations after A checkpoint.2 is relayed', () => {})
})

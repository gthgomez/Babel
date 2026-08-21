import assert from 'node:assert/strict'
import test from 'node:test'

import { runEvalDoctor } from './evalDoctor.js'
import { BABEL_ROOT } from '../cli/constants.js'

test('eval doctor reports recovered agent and governance catalogs', () => {
  const report = runEvalDoctor(BABEL_ROOT)
  assert.equal(report.agent_manifest_present, true)
  assert.equal(report.governance_catalog_present, true)
  assert.equal(report.ok, true)
  assert.ok(!report.findings.some((f) => f.code === 'CATALOG_MISSING'))
})

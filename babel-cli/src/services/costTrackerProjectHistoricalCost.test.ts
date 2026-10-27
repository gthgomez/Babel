import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { CostTracker } from './costTracker.js'
import { resetGlobalTokenHistoryDb } from './tokenHistoryDb.js'

test('registry-priced sqlite totals do not surface as project historical invoices', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-hist-registry-'))
  const prior = process.env['BABEL_TOKEN_DB_PATH']
  process.env['BABEL_TOKEN_DB_PATH'] = join(root, 'history.db')
  resetGlobalTokenHistoryDb()
  try {
    const tracker = new CostTracker(root)
    tracker.trackUsage('deepseek-v4-flash', 1000, 100)
    tracker.saveToProjectStats(tracker.getProjectSessionId(), undefined, root)
    const stats = JSON.parse(readFileSync(join(root, 'project_stats.json'), 'utf8'))
    assert.equal(stats.projectionComplete, true)
    assert.equal(stats.unknownChargeCount, 0)
    assert.ok(tracker.getSessionSummary().totalCostUSD > 0)
    assert.equal(tracker.getProjectHistoricalCost(root), null)
  } finally {
    resetGlobalTokenHistoryDb()
    if (prior === undefined) delete process.env['BABEL_TOKEN_DB_PATH']
    else process.env['BABEL_TOKEN_DB_PATH'] = prior
    rmSync(root, { recursive: true, force: true })
  }
})

test('reported receipt-backed zero remains a numeric project historical cost', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-hist-reported-zero-'))
  const prior = process.env['BABEL_TOKEN_DB_PATH']
  process.env['BABEL_TOKEN_DB_PATH'] = join(root, 'history.db')
  resetGlobalTokenHistoryDb()
  try {
    const tracker = new CostTracker(root)
    const model = 'deepseek/deepseek-v4-flash-0731'
    const attribution = { taskOwnerId: 'z', chargeId: 'zero-invoice', projectRoot: root, projectRootVersion: 1 as const }
    tracker.settleUsage(model, 0, 0, null, null, attribution, false, 'openrouter', 0)
    tracker.saveToProjectStats(tracker.getProjectSessionId(), undefined, root)
    assert.equal(tracker.getProjectHistoricalCost(root), 0)
  } finally {
    resetGlobalTokenHistoryDb()
    if (prior === undefined) delete process.env['BABEL_TOKEN_DB_PATH']
    else process.env['BABEL_TOKEN_DB_PATH'] = prior
    rmSync(root, { recursive: true, force: true })
  }
})

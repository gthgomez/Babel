import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { globalCostTracker } from '../../services/costTracker.js'
import { printRunCostFooter, printRunSummary } from './summary.js'

test('hosted summary retains incomplete cost and stays inside the shell', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-summary-'))
  const oldLog = console.log; const oldSummary = globalCostTracker.getSessionSummary
  const baseline = oldSummary.call(globalCostTracker)
  const raw: string[] = []; const notices: string[] = []
  console.log = (...args: unknown[]) => { raw.push(args.map(String).join(' ')) }
  globalCostTracker.getSessionSummary = () => ({ ...baseline, totalCostUSD: 0, knownCostUSD: 0, completeCostUSD: null, costComplete: false, unknownChargeCount: 1 })
  const ctx = { state: { mode: 'deep', router: 'v9' }, shellRuntime: { appendNotice: (text: string) => notices.push(text) },
    appendTurn() {}, lastAssistantAnswer: null, lastAssistantNext: null }
  try {
    printRunSummary(ctx as never, { runDir: root, status: 'EXECUTOR_HALTED', manifest: { target_project: 'fixture' }, plan: null, errors: ['Controlled halt'] },
      { task: 'fixture', projectRoot: root })
    assert.match(notices.join('\n'), /cost incomplete|unknown charge/i)
    assert.doesNotMatch(notices.join('\n'), /Session cost:\s*\$0\.0000\s*\|/i)
    assert.deepEqual(raw, [])
  } finally { console.log = oldLog; globalCostTracker.getSessionSummary = oldSummary; rmSync(root, { recursive: true, force: true }) }
})

test('cost footer distinguishes estimates from a complete zero cost', () => {
  const oldLog = console.log
  const oldSummary = globalCostTracker.getSessionSummary
  const baseline = oldSummary.call(globalCostTracker)
  const output: string[] = []
  console.log = (...args: unknown[]) => { output.push(args.map(String).join(' ')) }
  try {
    globalCostTracker.getSessionSummary = () => ({ ...baseline, totalCostUSD: 0.5, knownCostUSD: 0,
      estimatedCostUSD: 0.5, completeCostUSD: null, costComplete: false, unknownChargeCount: 0 })
    printRunCostFooter({} as never, 'EXECUTOR_HALTED')
    assert.match(output[0] ?? '', /cost incomplete.*\$0\.0000 known subtotal.*\$0\.5000 usage estimate/i)
    globalCostTracker.getSessionSummary = () => ({ ...baseline, totalCostUSD: 0, knownCostUSD: 0,
      estimatedCostUSD: 0, completeCostUSD: 0, costComplete: true, unknownChargeCount: 0 })
    printRunCostFooter({} as never, 'COMPLETED')
    assert.match(output[1] ?? '', /Session cost: \$0\.0000/)
    assert.doesNotMatch(output[1] ?? '', /incomplete/i)
  } finally { console.log = oldLog; globalCostTracker.getSessionSummary = oldSummary }
})

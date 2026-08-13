import assert from 'node:assert/strict'
import test from 'node:test'

import {
  TUI_VISUAL_TEST_SCHEMA_VERSION,
  validateTuiVisualReceipt,
  validateTuiVisualScenario,
  type TuiVisualReceipt,
} from './tuiVisualTestContract.js'
import { TUI_VISUAL_SCENARIOS } from './tuiVisualScenarioCatalog.js'

test('all catalog scenarios satisfy the external-driver contract', () => {
  for (const scenario of TUI_VISUAL_SCENARIOS) {
    assert.deepEqual(validateTuiVisualScenario(scenario), { ok: true }, scenario.id)
  }
})

test('scenario validation rejects unsafe dimensions and empty labels', () => {
  const result = validateTuiVisualScenario({
    ...TUI_VISUAL_SCENARIOS[0]!,
    steps: [{ action: 'resize', cols: 10, rows: 4, label: '' }],
  })

  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.match(result.errors.join('\n'), /label must be non-empty/)
    assert.match(result.errors.join('\n'), /cols must be an integer >= 20/)
    assert.match(result.errors.join('\n'), /rows must be an integer >= 8/)
  }
})

test('receipt validation requires findings for non-PASS outcomes', () => {
  const receipt = {
    schemaVersion: TUI_VISUAL_TEST_SCHEMA_VERSION,
    scenarioId: 'scenario',
    scenarioName: 'Scenario',
    status: 'BUG',
    startedAt: '2026-08-12T00:00:00.000Z',
    endedAt: '2026-08-12T00:00:01.000Z',
    terminal: {
      program: 'Windows Terminal',
      term: 'xterm-256color',
      cols: 120,
      rows: 40,
      platform: 'win32',
      isWindowsTerminal: true,
    },
    semantic: {
      passed: true,
      observedEvents: [],
      missingEvents: [],
      detail: 'no events required',
    },
    observations: [],
    findings: [],
    evidenceDir: 'runs/tui-visual/scenario',
    controller: { name: 'luna', version: 'test' },
  } satisfies TuiVisualReceipt

  const result = validateTuiVisualReceipt(receipt)
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.errors.join('\n'), /must contain at least one finding/)
})

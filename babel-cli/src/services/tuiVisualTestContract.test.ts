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

test('the clean-start visual scenario expects setup instead of asserting a ready connection', () => {
  const scenario = TUI_VISUAL_SCENARIOS.find(item => item.id === 'T01-visual-clean-start')
  assert.ok(scenario)
  assert.match(scenario.expectedVisualStates.join(' '), /setup|configuration/i)
  assert.doesNotMatch(scenario.expectedVisualStates.join(' '), /ready prompt is visible/i)
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
      evidenceMode: 'visual_only',
      evidenceRequired: false,
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

test('scenario validation rejects contradictory semantic declarations', () => {
  const result = validateTuiVisualScenario({
    ...TUI_VISUAL_SCENARIOS[0]!,
    evidenceMode: 'visual_plus_semantic',
    expectedEvents: [],
  })

  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.errors.join('\n'), /must require at least one expected event/)
})

test('receipt validation rejects PASS when semantic evidence failed', () => {
  const base = {
    schemaVersion: TUI_VISUAL_TEST_SCHEMA_VERSION,
    scenarioId: 'scenario',
    scenarioName: 'Scenario',
    status: 'PASS' as const,
    startedAt: '2026-08-12T00:00:00.000Z',
    endedAt: '2026-08-12T00:00:01.000Z',
    terminal: { program: 'test', term: 'xterm', cols: 80, rows: 24, platform: 'win32', isWindowsTerminal: false },
    semantic: {
      passed: false,
      evidenceMode: 'visual_plus_semantic' as const,
      evidenceRequired: true,
      observedEvents: [],
      missingEvents: ['babel.diff.review.closed'],
      detail: 'missing event',
    },
    observations: [],
    findings: [],
    evidenceDir: 'runs/tui-visual/scenario',
    controller: { name: 'test', version: '1' },
  } satisfies TuiVisualReceipt

  const result = validateTuiVisualReceipt(base)
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.errors.join('\n'), /require passing semantic evidence/)
})

test('a PASS receipt cannot omit visual observations and assessments', () => {
  const receipt = {
    schemaVersion: TUI_VISUAL_TEST_SCHEMA_VERSION,
    scenarioId: 'scenario',
    scenarioName: 'Scenario',
    status: 'PASS' as const,
    startedAt: '2026-08-12T00:00:00.000Z',
    endedAt: '2026-08-12T00:00:01.000Z',
    terminal: { program: 'test', term: 'xterm', cols: 80, rows: 24, platform: 'win32', isWindowsTerminal: false },
    semantic: { passed: true, evidenceMode: 'visual_only' as const, evidenceRequired: false, observedEvents: [], missingEvents: [], detail: 'not required' },
    observations: [],
    findings: [],
    evidenceDir: 'runs/tui-visual/scenario',
    controller: { name: 'test', version: '1' },
  } satisfies TuiVisualReceipt

  const result = validateTuiVisualReceipt(receipt)
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.errors.join('\n'), /visual assessment/i)
})

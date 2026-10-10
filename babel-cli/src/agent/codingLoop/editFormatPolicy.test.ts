import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  applyEditFormatOutcome,
  createEditFormatSession,
  formatEditFormatTelemetryLine,
  resolveActiveEditFormat,
  resolveEditFormatFailureStreakThreshold,
  resolveEditFormatFamily,
  resolveEditFormatLadder,
  DEFAULT_EDIT_FORMAT_FAILURE_STREAK,
  DEFAULT_EDIT_FORMAT_LADDER,
  EDIT_FORMAT_REGISTRY,
  type EditFormatSessionState,
} from './editFormatPolicy.js'

function freshState(overrides: Partial<EditFormatSessionState> = {}): EditFormatSessionState {
  return {
    family: 'default',
    ladder: [...DEFAULT_EDIT_FORMAT_LADDER],
    demoted: new Set(),
    failureStreaks: { str_replace: 0, apply_patch: 0, write_file: 0 },
    threshold: 3,
    ...overrides,
  }
}

describe('edit-format family resolution (packet D2)', () => {
  test('unknown model identity falls back to the conservative default family', () => {
    assert.equal(resolveEditFormatFamily({}), 'default')
    assert.equal(resolveEditFormatFamily({ modelId: 'some-unheard-of-9000' }), 'default')
    assert.equal(resolveEditFormatFamily({ policyFamily: null, provider: null }), 'default')
  })

  test('concrete model id, policy family, and provider resolve deterministically', () => {
    assert.equal(
      resolveEditFormatFamily({ modelId: 'deepseek/deepseek-v4-flash-0731' }),
      'deepseek',
    )
    assert.equal(resolveEditFormatFamily({ policyFamily: 'GLM' }), 'glm')
    assert.equal(resolveEditFormatFamily({ provider: 'ollama' }), 'ollama')
  })

  test('every seeded registry entry equals the current-behavior ladder', () => {
    for (const [family, ladder] of Object.entries(EDIT_FORMAT_REGISTRY)) {
      assert.deepEqual(
        [...ladder],
        [...DEFAULT_EDIT_FORMAT_LADDER],
        `family ${family} must be seeded to current behavior`,
      )
    }
    assert.deepEqual(resolveEditFormatLadder('nonexistent-family'), [
      ...DEFAULT_EDIT_FORMAT_LADDER,
    ])
  })
})

describe('edit-format selection determinism (packet D2)', () => {
  test('same model + telemetry state always selects the same format', () => {
    const state = freshState({
      demoted: new Set(['str_replace' as const]),
      failureStreaks: { str_replace: 3, apply_patch: 1, write_file: 0 },
    })
    const first = resolveActiveEditFormat(state)
    const second = resolveActiveEditFormat(state)
    assert.equal(first.format, 'apply_patch')
    assert.equal(second.format, 'apply_patch')
  })

  test('active format is the undemoted ladder head', () => {
    assert.equal(resolveActiveEditFormat(freshState()).format, 'str_replace')
    const state = freshState({ demoted: new Set(['str_replace' as const, 'apply_patch' as const]) })
    assert.equal(resolveActiveEditFormat(state).format, 'write_file')
  })

  test('all-demoted never removes the write capability: demotions clear', () => {
    const state = freshState({
      demoted: new Set(['str_replace' as const, 'apply_patch' as const, 'write_file' as const]),
    })
    const resolved = resolveActiveEditFormat(state)
    assert.equal(resolved.format, 'str_replace')
    assert.equal(resolved.state.demoted.size, 0)
  })
})

describe('streak demotion (packet D2)', () => {
  test('format demotes after a synthetic failure streak and resets its streak', () => {
    let state = freshState()
    for (let i = 0; i < DEFAULT_EDIT_FORMAT_FAILURE_STREAK - 1; i++) {
      const result = applyEditFormatOutcome(state, 'str_replace', { applied: false })
      state = result.state
      assert.equal(result.demotedNow, null)
    }
    const final = applyEditFormatOutcome(state, 'str_replace', { applied: false })
    assert.equal(final.demotedNow, 'str_replace')
    assert.equal(final.state.demoted.has('str_replace'), true)
    assert.equal(final.state.failureStreaks['str_replace'], 0)
    assert.equal(resolveActiveEditFormat(final.state).format, 'apply_patch')
  })

  test('policy blocks are gate decisions, not format evidence', () => {
    let state = freshState()
    for (let i = 0; i < DEFAULT_EDIT_FORMAT_FAILURE_STREAK + 2; i++) {
      const result = applyEditFormatOutcome(state, 'str_replace', {
        applied: false,
        policyBlocked: true,
      })
      state = result.state
      assert.equal(result.demotedNow, null)
    }
    assert.equal(state.demoted.size, 0)
    assert.equal(state.failureStreaks['str_replace'], 0)
  })

  test('one success promotes a demoted format back', () => {
    let state = freshState({
      demoted: new Set(['str_replace' as const]),
      failureStreaks: { str_replace: 0, apply_patch: 1, write_file: 0 },
    })
    const result = applyEditFormatOutcome(state, 'str_replace', { applied: true })
    assert.equal(result.promotedNow, 'str_replace')
    assert.equal(result.state.demoted.size, 0)
    assert.equal(resolveActiveEditFormat(result.state).format, 'str_replace')
  })

  test('session tracker: configurable threshold and full reset', () => {
    const session = createEditFormatSession({ family: 'deepseek', threshold: 2 })
    session.recordOutcome('str_replace', { applied: false })
    const demoted = session.recordOutcome('str_replace', { applied: false })
    assert.equal(demoted.demotedNow, 'str_replace')
    assert.equal(session.activeFormat(), 'apply_patch')
    session.reset()
    assert.equal(session.activeFormat(), 'str_replace')
    assert.deepEqual(session.snapshot().demoted, [])
  })
})

describe('edit-format telemetry visibility (packet D2)', () => {
  test('telemetry line asserts the active format deterministically', () => {
    const session = createEditFormatSession({ family: 'deepseek', threshold: 2 })
    session.recordOutcome('str_replace', { applied: false })
    session.recordOutcome('str_replace', { applied: false })
    const snapshot = session.snapshot()
    assert.equal(snapshot.activeFormat, 'apply_patch')
    assert.equal(
      formatEditFormatTelemetryLine(snapshot),
      '[BABEL EDIT FORMAT] active=apply_patch family=deepseek ' +
        'ladder=str_replace>apply_patch>write_file demoted=str_replace ' +
        'failure_streak_threshold=2 streaks=str_replace:0,apply_patch:0,write_file:0',
    )
  })

  test('threshold is configurable via env and defaults conservatively', () => {
    assert.equal(resolveEditFormatFailureStreakThreshold({}), DEFAULT_EDIT_FORMAT_FAILURE_STREAK)
    assert.equal(resolveEditFormatFailureStreakThreshold({ BABEL_EDIT_FORMAT_FAILURE_STREAK: '5' }), 5)
    assert.equal(resolveEditFormatFailureStreakThreshold({ BABEL_EDIT_FORMAT_FAILURE_STREAK: '0' }), DEFAULT_EDIT_FORMAT_FAILURE_STREAK)
    assert.equal(resolveEditFormatFailureStreakThreshold({ BABEL_EDIT_FORMAT_FAILURE_STREAK: 'NaN?' }), DEFAULT_EDIT_FORMAT_FAILURE_STREAK)
  })
})

// License: Apache-2.0 - see LICENSE
import test from 'node:test'
import assert from 'node:assert/strict'
import { requiredTapSuiteGate } from '../../babel-cli/scripts/required_tap_suite_gate.mjs'

function footer({ tests, suites = 0, passed, failed = 0, cancelled = 0, skipped = 0, todo = 0 }) {
  return [
    `1..${tests}`,
    `# tests ${tests}`,
    `# suites ${suites}`,
    `# pass ${passed}`,
    `# fail ${failed}`,
    `# cancelled ${cancelled}`,
    `# skipped ${skipped}`,
    `# todo ${todo}`,
    '# duration_ms 2',
    '',
  ].join('\n')
}

test('required TAP gate keeps whole stdout and rejects a second passing stream after a failed one', () => {
  const failedFirst = [
    'TAP version 13',
    'not ok 1 - broken prelude',
    '  ---',
    '  duration_ms: 1',
    '  ...',
    footer({ tests: 1, passed: 0, failed: 1 }),
  ].join('\n')
  const passedSecond = [
    'TAP version 13',
    'ok 1 - passes',
    '  ---',
    "  duration_ms: 1",
    "  type: 'test'",
    '  ...',
    footer({ tests: 1, passed: 1 }),
  ].join('\n')
  const stdout = `${failedFirst}${passedSecond}`
  const gate = requiredTapSuiteGate('chat-truth', stdout, { status: 0 })
  assert.equal(gate.childFailed, false, 'child exit 0 must not alone certify success')
  assert.equal(gate.inventoryFailed, true)
  assert.equal(gate.failed, true)
  assert.ok(gate.inventory.errors.includes('missing_or_duplicate_tap_version_13'))
})

test('required TAP gate accepts npm preamble before a single complete stream', () => {
  const tap = [
    '> babel-harness@0.1.4 test:chat-truth:raw',
    '> tsx --test ...',
    'TAP version 13',
    'ok 1 - passes',
    '  ---',
    '  duration_ms: 1',
    '  ...',
    footer({ tests: 1, passed: 1 }),
  ].join('\n')
  const gate = requiredTapSuiteGate('chat-truth', tap, { status: 0 })
  assert.equal(gate.inventory.status, 'complete')
  assert.equal(gate.failed, false)
})

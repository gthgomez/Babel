import assert from 'node:assert/strict'
import test from 'node:test'
import { selectShellHost } from './selectShellHost.js'

const supported = { isTTY: true, term: 'xterm', cursorAddressing: true }

test('keeps the legacy host until UI4 evidence qualifies the default', () => {
  assert.deepEqual(selectShellHost(supported), { host: 'legacy', reason: 'legacy-default' })
  assert.deepEqual(selectShellHost({ ...supported, ui4Qualified: true }), { host: 'north_star', reason: 'qualified-default' })
})

test('developer opt-in selects North Star when safety gates pass', () => {
  assert.deepEqual(selectShellHost({ ...supported, optIn: '1' }), { host: 'north_star', reason: 'developer-opt-in' })
})

test('safety gates always preserve the legacy host', () => {
  const cases = [
    ['non-tty', { ...supported, isTTY: false }],
    ['ci', { ...supported, isCi: true }],
    ['headless', { ...supported, isHeadless: true }],
    ['a11y', { ...supported, a11y: true }],
    ['dumb-terminal', { ...supported, term: 'dumb' }],
    ['unsupported-cursor-addressing', { ...supported, cursorAddressing: false }],
    ['explicit-opt-out', { ...supported, optIn: '0', ui4Qualified: true }],
  ] as const

  for (const [reason, input] of cases) {
    assert.deepEqual(selectShellHost(input), { host: 'legacy', reason })
  }
})

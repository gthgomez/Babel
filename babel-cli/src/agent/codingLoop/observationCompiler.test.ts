import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'

import { formatChatToolObservation } from '../chatToolDefinitions.js'
import {
  compileObservation,
  formatCompiledObservation,
  formatVerifierReceiptSummary,
} from './observationCompiler.js'

describe('observation compiler (shipped formatChatToolObservation path)', () => {
  test('stderr-only failure keeps stderr when stdout is empty', () => {
    const compiled = compileObservation({
      tool: 'run_command',
      target: 'npm test',
      command: 'npm test',
      exitCode: 1,
      stdout: '',
      stderr: 'Error: planted-stderr-only-failure\n    at Object.<anonymous> (src/a.test.ts:12:3)',
    })
    const text = formatCompiledObservation(compiled)
    assert.equal(compiled.stderrPresent, true)
    assert.equal(compiled.stdoutPresent, false)
    assert.match(text, /stderr/)
    assert.match(text, /planted-stderr-only-failure/)
    assert.doesNotMatch(text, /stderr: \(empty\)/)

    const viaShipped = formatChatToolObservation(
      { type: 'run_command', command: 'npm test' },
      { stdout: '', stderr: 'Error: planted-stderr-only-failure', exitCode: 1 },
    )
    assert.match(viaShipped, /planted-stderr-only-failure/)
    assert.match(viaShipped, /stderr/)
  })

  test('non-empty stdout never drops stderr', () => {
    const viaShipped = formatChatToolObservation(
      { type: 'test_run', command: 'npm test' },
      {
        stdout: 'npm WARN using --force\n\n> babel-cli@0.1.0 test\n',
        stderr: 'FAIL src/cache.test.ts\n  ● handles stale cache\n    Expected: 3\n    Received: 2',
        exitCode: 1,
      },
    )
    assert.match(viaShipped, /npm WARN/)
    assert.match(viaShipped, /handles stale cache/)
    assert.match(viaShipped, /stderr/)
  })

  test('failure only in the last 30 lines survives as tail', () => {
    const head = Array.from({ length: 400 }, (_, i) => `ok line ${i} ${'x'.repeat(20)}`).join('\n')
    const tail = Array.from({ length: 40 }, (_, i) =>
      i === 39 ? 'PLANTED_TAIL_FAILURE expected 3 received 2' : `noise ${i} ${'y'.repeat(20)}`,
    ).join('\n')
    const stdout = `${head}\n${tail}`
    const compiled = compileObservation({
      tool: 'run_command',
      target: 'npm test',
      exitCode: 1,
      stdout,
      stderr: '',
    })
    const text = formatCompiledObservation(compiled)
    assert.match(text, /PLANTED_TAIL_FAILURE/)
    assert.match(text, /stdout_tail/)
  })

  test('parser success attaches structured Jest failure', () => {
    const stdout = [
      'FAIL src/cache.test.ts',
      '  ● handles stale cache',
      '    Expected: 3',
      '    Received: 2',
      '      at Object.<anonymous> (src/cache.test.ts:88:5)',
      'Tests: 2 failed, 3 passed',
    ].join('\n')
    const compiled = compileObservation({
      tool: 'test_run',
      target: 'npx vitest run src/cache.test.ts',
      command: 'npx vitest run src/cache.test.ts',
      exitCode: 1,
      stdout,
      stderr: '',
    })
    assert.ok(compiled.failures.length > 0)
    assert.equal(compiled.parserName, 'jest_vitest')
    const text = formatCompiledObservation(compiled)
    assert.match(text, /handles stale cache|cache\.test/)
  })

  test('parser failure still yields head+tail+spill', () => {
    const dir = mkdtempSync(join(tmpdir(), 'babel-obs-'))
    const stdout = `${'banner\n'.repeat(400)}UNPARSEABLE_BUT_REAL_FAILURE at the end`
    const compiled = compileObservation({
      tool: 'run_command',
      target: 'make weird',
      exitCode: 1,
      stdout,
      stderr: 'also-stderr',
      spillDir: dir,
      toolCallId: 'call-1',
    })
    assert.equal(compiled.failures.length, 0)
    assert.ok(compiled.rawSpillPath)
    const text = formatCompiledObservation(compiled)
    assert.match(text, /also-stderr/)
    assert.match(text, /UNPARSEABLE_BUT_REAL_FAILURE/)
    const spilled = readFileSync(compiled.rawSpillPath!, 'utf8')
    assert.match(spilled, /UNPARSEABLE_BUT_REAL_FAILURE/)
    assert.match(spilled, /also-stderr/)
    assert.match(spilled, /--- stderr ---/)
  })

  test('raw spill is readable from the returned reference', () => {
    const dir = mkdtempSync(join(tmpdir(), 'babel-obs-'))
    const planted = 'SPILL_PLANTED_RECORD_BODY'
    const compiled = compileObservation({
      tool: 'run_command',
      target: 'npm test',
      exitCode: 1,
      stdout: `${'x'.repeat(3000)}\n${planted}`,
      stderr: 'e',
      spillDir: dir,
      toolCallId: 'spill-ref',
    })
    assert.ok(compiled.rawSpillPath)
    assert.equal(readFileSync(compiled.rawSpillPath!, 'utf8').includes(planted), true)
    assert.match(formatCompiledObservation(compiled), /raw_output:/)
  })

  test('verifier receipt keeps identity plus a compact meaningful summary', () => {
    const summary = formatVerifierReceiptSummary({
      verifierId: 'npm-test',
      command: 'npm test -- cache.test.ts',
      exitCode: 1,
      stdout: `${'ok\n'.repeat(40)}FAIL src/cache.test.ts\n  ● handles stale cache\n    Expected: 3`,
      stderr: '',
    })
    assert.match(summary, /verifier_id: npm-test/)
    assert.match(summary, /status: red/)
    assert.ok(!summary.startsWith('ok\nok\n'), 'must not be a tiny arbitrary stdout prefix')
    assert.match(summary, /handles stale cache|structured failure/)
  })

  test('pytest and tsc parsers attach structured failures', () => {
    const py = compileObservation({
      tool: 'run_command',
      target: 'pytest',
      command: 'pytest',
      exitCode: 1,
      stdout: 'FAILED tests/test_cache.py::test_stale - AssertionError: expected 3',
      stderr: '',
    })
    assert.equal(py.parserName, 'pytest')
    assert.ok(py.failures.some((f) => f.file?.includes('test_cache.py')))

    const ts = compileObservation({
      tool: 'run_command',
      target: 'tsc',
      command: 'npx tsc --noEmit',
      exitCode: 2,
      stdout: '',
      stderr: 'src/a.ts(12,5): error TS2322: Type \'string\' is not assignable to type \'number\'.',
    })
    assert.equal(ts.parserName, 'tsc')
    assert.equal(ts.failures[0]?.file, 'src/a.ts')
    assert.equal(ts.failures[0]?.line, 12)
  })
})

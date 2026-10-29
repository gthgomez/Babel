import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, test } from 'node:test'

import { formatChatToolObservation } from '../chatToolDefinitions.js'
import {
  compileObservation,
  formatCompiledObservation,
  formatVerifierReceiptSummary,
} from './observationCompiler.js'

describe('observation compiler (shipped formatChatToolObservation path)', () => {
  test('bare Node TS test module-resolution failure suggests the configured loader without claiming environment failure', () => {
    const error = "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/app/src/helper.js' imported from /app/src/helper.test.ts"
    const bare = formatChatToolObservation({ type: 'run_command', command: 'node --test src/helper.test.ts' },
      { stdout: `TAP version 13\n# ${error}\n# tests 1\n# fail 1`, exitCode: 1 })
    assert.match(bare, /node --import tsx --test/)
    assert.match(bare, /if.*tsx.*installed/i)
    assert.match(bare, /use read_file to inspect.*package\.json/i)
    assert.match(bare, /set test_run\.cwd to the package directory/i)
    assert.match(bare, /test-file path relative to cwd/i)
    for (const command of ['node --import tsx --test src/helper.test.ts', 'node --test src/helper.test.mjs']) {
      const observation = formatChatToolObservation({ type: 'test_run', command }, { stdout: error, exitCode: 1 })
      assert.doesNotMatch(observation, /node --import tsx --test <test-file>/)
    }
  })

  test('tsx package resolution failure suggests checking the package cwd without changing authority', () => {
    const error = [
      'node:internal/modules/package_json_reader:314',
      "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'tsx' imported from /app/",
      '    at Object.getPackageJSONURL (node:internal/modules/package_json_reader:255:9)',
      'Node.js v24.19.0',
    ].join('\n')
    const failed = formatChatToolObservation({
      type: 'test_run',
      command: 'node --import tsx --test src/agent/helper.test.ts',
      cwd: 'babel-cli',
    }, { stdout: error, exitCode: 1 })
    assert.match(failed, /cwd: babel-cli/)
    assert.match(failed, /if tsx is installed in a nested package/i)
    assert.match(failed, /set test_run\.cwd to that package directory/i)
    assert.match(failed, /no project test files executed/i)
    assert.match(failed, /read_file.*package\.json/i)
    assert.match(failed, /test-file path relative to cwd/i)
    assert.match(failed, /summary: test loader unavailable/i)
    assert.doesNotMatch(failed, /structured failure\(s\)/)
    const unrelated = formatChatToolObservation({ type: 'test_run', command: 'node --import tsx --test helper.test.ts' },
      { stdout: "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/app/helper.js'", exitCode: 1 })
    assert.doesNotMatch(unrelated, /nested package/)
  })

  test('actual Node preload failure is reported as a loader launch failure', () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-missing-tsx-'))
    const testFile = join(root, 'loader.test.mjs')
    writeFileSync(testFile, "import test from 'node:test'; test('must not execute', () => { throw new Error('unexpected execution') })\n")
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' }
      delete env.NODE_TEST_CONTEXT
      const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', testFile], {
        cwd: root,
        encoding: 'utf8',
        env,
      })
      const command = 'node --import tsx --test loader.test.mjs'
      const observation = compileObservation({
        tool: 'test_run',
        target: command,
        command,
        cwd: root,
        exitCode: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
      })
      const delivered = formatCompiledObservation(observation)
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`)
      assert.match(`${result.stderr}\n${result.stdout}`, /ERR_MODULE_NOT_FOUND[^\n]*Cannot find package ['"]tsx['"]/)
      assert.equal(observation.parserName, 'test_loader')
      assert.match(observation.summary, /no project test files executed/i)
      assert.match(delivered, /set test_run\.cwd to that package directory/i)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a missing tsx import reported after TAP tests start remains a test failure', () => {
    const output = [
      'TAP version 13',
      '# Subtest: loads helper module',
      'not ok 1 - loads helper module',
      '  ---',
      "  error: \"Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'tsx' imported from /app/helper.test.mjs\"",
      '  code: ERR_MODULE_NOT_FOUND',
      '  ...',
      '1..1',
      '# tests 1',
      '# pass 0',
      '# fail 1',
    ].join('\n')
    const observation = compileObservation({
      tool: 'test_run',
      target: 'node --test helper.test.mjs',
      command: 'node --test helper.test.mjs',
      exitCode: 1,
      stdout: output,
      stderr: '',
    })
    assert.notEqual(observation.parserName, 'test_loader')
    assert.doesNotMatch(observation.summary, /no project test files executed/i)
    assert.ok(observation.failures.length > 0, 'the started test retains a localized failure')
    assert.equal(observation.failures[0]?.test, 'loads helper module')
  })
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

  test('toolCallId traversal becomes a safe filename and credential output does not spill', () => {
    const dir = mkdtempSync(join(tmpdir(), 'babel-obs-'))
    const traversal = compileObservation({
      tool: 'run_command',
      target: 'npm test',
      exitCode: 1,
      stdout: 'x'.repeat(3000),
      stderr: 'e',
      spillDir: dir,
      toolCallId: '../../etc/passwd',
    })
    assert.ok(traversal.rawSpillPath)
    assert.ok(!traversal.rawSpillPath!.includes('..'))
    assert.ok(traversal.rawSpillPath!.startsWith(dir))
    const denied = compileObservation({
      tool: 'run_command',
      target: 'cat .env',
      exitCode: 1,
      stdout: 'x'.repeat(3000),
      stderr: '[AUTONOMY_DENIED:CLASS_D] Target path ".env" is a credential store.',
      spillDir: dir,
      toolCallId: 'cred',
    })
    assert.equal(denied.rawSpillPath, undefined)
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

test('await timeout preserves null top-level exit_code and timed_out summary', () => {
  const header = [
    'task_id: bg-1',
    'status: running',
    'timed_out: true',
    'exit_code: null',
  ].join('\n')
  const rendered = formatCompiledObservation(
    compileObservation({
      tool: 'await_command',
      target: 'bg-1',
      exitCode: null,
      stdout: `${header}\n--- stdout ---\npartial`,
      stderr: '',
    }),
  )
  assert.match(rendered, /^### await_command bg-1\nexit_code: null\nsummary: timed_out/)
  assert.doesNotMatch(rendered, /^### await_command bg-1\nexit_code: -1/m)
})

test('Node 22 TAP stack frames retain failure location and column without an at prefix', () => {
  const stdout = [
    'TAP version 13',
    'not ok 1 - busy style',
    '  ---',
    '  error: |-',
    '    The input did not match the regular expression.',
    '  code: ERR_ASSERTION',
    '  stack: |-',
    '    TestContext.<anonymous> (file:///tmp/babel-tap/style.test.js:3:127)',
    '    Test.runInAsyncScope (node:async_hooks:214:14)',
    '  ...',
  ].join('\n')
  const compiled = compileObservation({tool:'test_run',target:'npm test',exitCode:1,
    stdout:'\u001b[31m'+stdout+'\u001b[0m',stderr:''})
  assert.equal(compiled.parserName,'node_trace')
  assert.equal(compiled.failures[0]?.file,'file:///tmp/babel-tap/style.test.js')
  assert.equal(compiled.failures[0]?.line,3)
  assert.equal(compiled.failures[0]?.column,127)
  assert.equal(compiled.failures[0]?.test,'busy style')
  assert.match(compiled.stdoutHead,/\u001b\[31m/,'raw presentation retains the captured evidence')
})

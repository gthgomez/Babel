import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseStructuredFailures } from './observationCompiler.js'
import { captureLocalizationCandidates, advanceFailureLocalization, startFailureLocalization } from './failureLocalization.js'

const name = 'addition preserves counts'
function tap(file: string): string {
  return `TAP version 13
not ok 1 - ${name}
  ---
  location: '${file}:1:2728'
  error: |-
    Expected values to be strictly equal:
    + actual - expected
    + 1
    - 2
  stack: |-
    TestContext.<anonymous> (${file}:108:10)
    Test.run (node:internal/test_runner/test:1047:25)
  ...`
}

for (const file of ['/app/count.test.ts', 'file:///app/count.test.tsx', 'C:\\work space\\count.test.cts', 'file:///C:/work%20space/count.test.mts']) {
  test(`Node TAP captures the assertion frame without YAML punctuation: ${file}`, () => {
    const parsed = parseStructuredFailures(tap(file), '', 'test_run', 'node --import tsx --test')
    assert.equal(parsed.parserName, 'node_trace')
    assert.equal(parsed.failures.length, 1)
    assert.deepEqual({ file: parsed.failures[0]?.file, line: parsed.failures[0]?.line,
      column: parsed.failures[0]?.column, test: parsed.failures[0]?.test },
    { file, line: 108, column: 10, test: name })
  })
}

test('bare TypeScript and existing JavaScript runtime frames retain clean locations', () => {
  for (const file of ['src/main.ts', 'src/view.tsx', 'src/main.js', 'src/main.cjs', 'src/main.mjs']) {
    const parsed = parseStructuredFailures(`TypeError: broken\n    at ${file}:12:3`, '', 'run_command', 'node main')
    assert.equal(parsed.failures[0]?.file, file)
    assert.equal(parsed.failures[0]?.line, 12)
  }
})

test('Node TAP TypeScript assertion yields a contained candidate requiring fresh reads', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-node-ts-'))
  try {
    const source = '\n'.repeat(107) + `import test from 'node:test'; test('${name}', () => {})`
    writeFileSync(join(root, 'count.test.ts'), source)
    const candidates = captureLocalizationCandidates({ projectRoot: root, stdout: tap('/app/count.test.ts'),
      stderr: '', tool: 'test_run', command: 'node --import tsx --test' })
    assert.deepEqual(candidates, [{ path: 'count.test.ts', line: 108, column: 10, relation: name, source: 'test_identity' }])
    const binding = { schemaVersion: 1 as const, taskId: 'task', contractHash: 'contract', repositoryIdentity: root, workspaceRevision: 'rev' }
    const initial = startFailureLocalization('red', binding, candidates)
    assert.equal(initial.acceptedPath, undefined)
    assert.equal(advanceFailureLocalization(initial, { type: 'read_file', target: 'count.test.ts', content: source,
      succeeded: true, projectRoot: root }).acceptedPath, 'count.test.ts')
    for (const outside of ['/app/../count.test.ts', '/outside/count.test.ts']) {
      assert.deepEqual(captureLocalizationCandidates({ projectRoot: root, stdout: tap(outside), stderr: '',
        tool: 'test_run', command: 'node --import tsx --test' }), [])
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

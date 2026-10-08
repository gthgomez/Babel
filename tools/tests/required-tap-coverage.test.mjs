import test from 'node:test'
import assert from 'node:assert/strict'
import { parseRequiredTapInventory, summarizeRequiredTap } from '../../babel-cli/scripts/summarize_required_tap.mjs'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('complete all-skipped TAP does not establish executed qualification', () => {
  const tap = ['TAP version 13', 'ok 1 - unused # SKIP unavailable', '  ---', "  type: 'test'", '  ...',
    '1..1', '# tests 1', '# suites 0', '# pass 0', '# fail 0', '# cancelled 0', '# skipped 1', '# todo 0', '# duration_ms 1'].join('\n')
  const result = parseRequiredTapInventory(tap, 'unit')
  assert.notEqual(result.status, 'complete')
  assert.ok(result.errors.includes('no_executed_tests'))
})
test('selected inventory cannot be completed without per-file execution evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-tap-coverage-'))
  try {
    writeFileSync(join(root, 'full.tap'), ['TAP version 13', 'ok 1 - actual', '  ---', "  type: 'test'", '  ...',
      '1..1', '# tests 1', '# suites 0', '# pass 1', '# fail 0', '# cancelled 0', '# skipped 0', '# todo 0', '# duration_ms 1'].join('\n'))
    writeFileSync(join(root, 'selection.json'), JSON.stringify({ schemaVersion: 1, suite: 'unit', nodeVersion: process.version,
      platform: process.platform, arch: process.arch, packageScriptSha256: 'a'.repeat(64), files: [{path: 'src/missing.test.ts', sha256: 'b'.repeat(64)}] }))
    const summary = summarizeRequiredTap('unit', root)
    assert.notEqual(summary.status, 'complete')
    assert.ok(summary.errors.includes('missing_file_execution_evidence'))
  } finally { rmSync(root, {recursive: true, force: true}) }
})

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const script = fileURLToPath(new URL('../../scripts/summarize_required_tap.mjs', import.meta.url))

type TapSummary = {
  status: string
  errors: string[]
  testCount: number
  failed: number
  cancelled: number
  tests: Array<{ skipReason?: string }>
}

function tapResult(directory: string, tap: string | null): { status: number | null; summary: TapSummary } {
  if (tap !== null) writeFileSync(join(directory, 'full.tap'), tap)
  writeFileSync(join(directory, 'selection.json'), JSON.stringify({
    schemaVersion: 1, suite: 'chat-truth', platform: process.platform, arch: process.arch,
    nodeVersion: process.version, packageScriptSha256: 'a'.repeat(64),
    files: [{ path: 'src/fixture.test.ts', sha256: 'b'.repeat(64) }],
  }))
  const result = spawnSync(process.execPath, [script, 'chat-truth', directory], {
    encoding: 'utf8',
  })
  const summary = JSON.parse(readFileSync(join(directory, 'results.json'), 'utf8'))
  return { status: result.status, summary }
}

function withDirectory(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'babel-required-tap-'))
  try { run(directory) } finally { rmSync(directory, { recursive: true, force: true }) }
}

function footer({ tests, suites = 0, passed, failed = 0, cancelled = 0, skipped = 0, todo = 0 }: {
  tests: number; suites?: number; passed: number; failed?: number; cancelled?: number; skipped?: number; todo?: number
}): string {
  return [
    `1..${tests}`, `# tests ${tests}`, `# suites ${suites}`, `# pass ${passed}`, `# fail ${failed}`,
    `# cancelled ${cancelled}`, `# skipped ${skipped}`, `# todo ${todo}`, `# duration_ms 2`, '',
  ].join('\n')
}

test('complete TAP inventories reconcile every outcome and retain skip reasons', () => withDirectory((directory) => {
  const tap = [
    'TAP version 13',
    'ok 1 - passes',
    '  ---', "  duration_ms: 1", "  type: 'test'", '  ...',
    'ok 2 - skips # SKIP windows-only alternative',
    '  ---', "  duration_ms: 1", "  type: 'test'", '  ...',
    footer({ tests: 2, passed: 1, skipped: 1 }),
  ].join('\n')
  const result = tapResult(directory, tap)
  assert.equal(result.status, 0)
  assert.equal(result.summary.status, 'complete')
  assert.equal(result.summary.testCount, 2)
  assert.equal(result.summary.tests[1]?.skipReason, 'windows-only alternative')
}))

test('missing TAP output writes not_started evidence and exits nonzero', () => withDirectory((directory) => {
  const result = tapResult(directory, null)
  assert.equal(result.status, 1)
  assert.equal(result.summary.status, 'not_started')
  assert.ok(result.summary.errors.includes('missing_full_tap'))
}))

test('a truncated run remains failed or incomplete and cannot publish complete status', () => withDirectory((directory) => {
  const tap = [
    'TAP version 13',
    'not ok 1 - observed failure',
    '  ---', "  duration_ms: 1", "  type: 'test'", '  ...',
  ].join('\n')
  const result = tapResult(directory, tap)
  assert.equal(result.status, 1)
  assert.equal(result.summary.status, 'failed')
  assert.equal(result.summary.failed, 1)
  assert.ok(result.summary.errors.includes('missing_terminal_footer'))
}))

test('duplicate test identities invalidate the inventory', () => withDirectory((directory) => {
  const tap = [
    'TAP version 13', '# Subtest: repeated group',
    '    ok 1 - same title', '      ---', "      duration_ms: 1", "      type: 'test'", '      ...',
    '    ok 2 - same title', '      ---', "      duration_ms: 1", "      type: 'test'", '      ...',
    'ok 1 - repeated group', '  ---', "  duration_ms: 1", "  type: 'suite'", '  ...',
    footer({ tests: 2, suites: 1, passed: 2 }),
  ].join('\n')
  const result = tapResult(directory, tap)
  assert.equal(result.status, 1)
  assert.equal(result.summary.status, 'failed')
  assert.ok(result.summary.errors.includes('duplicate_test_id'))
}))

test('cancelled tests invalidate otherwise passing TAP output', () => withDirectory((directory) => {
  const tap = [
    'TAP version 13',
    'not ok 1 - cancelled test',
    '  ---', "  duration_ms: 1", "  type: 'test'", '  ...',
    footer({ tests: 1, passed: 0, failed: 0, cancelled: 1 }),
  ].join('\n')
  const result = tapResult(directory, tap)
  assert.equal(result.status, 1)
  assert.equal(result.summary.status, 'failed')
  assert.equal(result.summary.cancelled, 1)
  assert.ok(result.summary.errors.includes('cancelled_tests'))
}))

test('harness runtime selection captures the exact expanded file inventory and hashes', () => withDirectory((directory) => {
  const captureScript = fileURLToPath(new URL('../../scripts/capture_required_tap_selection.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [captureScript, 'harness-runtime', directory], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const selection = JSON.parse(readFileSync(join(directory, 'selection.json'), 'utf8'))
  assert.equal(selection.suite, 'harness-runtime')
  assert.ok(selection.files.length > 60)
  assert.equal(new Set(selection.files.map((file: { path: string }) => file.path)).size, selection.files.length)
  assert.ok(selection.files.every((file: { sha256: string }) => /^[a-f0-9]{64}$/.test(file.sha256)))
}))

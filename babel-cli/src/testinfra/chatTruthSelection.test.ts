import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
const workflow = readFileSync(new URL('../../../.github/workflows/typecheck.yml', import.meta.url), 'utf8')

test('required Chat truth selection includes focused accounting, Chronicle and boundary regressions on both hosts', () => {
  const selector = packageJson.scripts['test:chat-truth'] as string
  const files = new Set(selector.slice(selector.indexOf(' --test ') + 8).trim().split(/\s+/))
  for (const required of [
    'src/agent/chatAllowanceAccounting.test.ts',
    'src/execute.test.ts',
    'src/services/costTracker.test.ts',
    'src/tools/chronicleMemory.test.ts',
    'src/services/indexer.test.ts',
    'src/services/ftsIndex.test.ts',
    'src/agent/pr242OwnerFence.test.ts',
    'src/agent/codingLoop/recoveryPlan.test.ts',
    'src/sandboxTermination.test.ts',
    'src/testinfra/pr242Audit.regression.test.ts',
    'src/testinfra/chatTruthSelection.test.ts',
    'src/testinfra/requiredTapSummary.test.ts',
    'src/agent/recoveryBarrierA2.test.ts',
  ]) {
    assert.ok(files.has(required), `${required} is missing from the required selection`)
  }
  const coverage = spawnSync(process.execPath, [
    fileURLToPath(new URL('../../../tools/ci-workflow-coverage.mjs', import.meta.url)), '-',
    'npm run test:chat-truth 2>&1',
    'node scripts/summarize_required_tap.mjs chat-truth',
    'npm run test:harness-runtime -- --test-timeout=60000 2>&1',
    'node scripts/summarize_required_tap.mjs harness-runtime',
    'node scripts/capture_required_tap_selection.mjs chat-truth',
    'node scripts/capture_required_tap_selection.mjs harness-runtime',
  ], { input: workflow, encoding: 'utf8' })
  assert.ifError(coverage.error)
  assert.equal(coverage.status, 0, coverage.stderr)
})

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { isSyntheticProviderFixtureReady, prepareSyntheticProviderFixture, removeSyntheticProviderFixture, summarizeSyntheticProviderOutput } from '../testinfra/synthetic-provider-fixture.mjs'

if (!isSyntheticProviderFixtureReady()) {
  test('Deep repair fixture runs without ambient credentials or inference', async t => {
    const fixture = prepareSyntheticProviderFixture()
    t.after(() => removeSyntheticProviderFixture(fixture.root))
    const child = spawn(process.execPath, ['--import', new URL('../testinfra/synthetic-provider-fixture.mjs', import.meta.url).href,
      '--import', import.meta.resolve('tsx'), '--test', fileURLToPath(import.meta.url)],
    { cwd: fixture.cwd, env: fixture.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''; child.stdout.on('data', chunk => { output += String(chunk) }); child.stderr.on('data', chunk => { output += String(chunk) })
    const code = await new Promise<number>(resolve => { child.once('error', () => resolve(1)); child.once('close', value => resolve(value ?? 1)) })
    t.diagnostic(summarizeSyntheticProviderOutput(output, code))
    assert.equal(code, 0, 'isolated red-to-green repair must pass')
  })
} else test('Deep repair preserves real red-to-green evidence with guarded snapshots', async t => {
  const testContext = process.env['NODE_TEST_CONTEXT']; delete process.env['NODE_TEST_CONTEXT']
  t.after(() => { if (testContext !== undefined) process.env['NODE_TEST_CONTEXT'] = testContext })
  process.env['BABEL_LIVE'] = 'true'; process.env['BABEL_DRY_RUN'] = 'false'
  process.env['BABEL_EXECUTION_PROFILE'] = 'safe_repo'; process.env['BABEL_ALLOW_HOST_FALLBACK'] = 'true'
  process.env['BABEL_DESKTOP_PROVIDER'] = 'openrouter'; process.env['BABEL_DESKTOP_MODEL_ROUTE'] = 'glm-5.3-flash'
  const root = process.cwd(); mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, '.env.local'), 'DEEPSEEK_API_KEY=SYNTHETIC_SNAPSHOT_SECRET\n')
  writeFileSync(join(root, 'src', 'math.cjs'), 'module.exports = n => n * 3\n')
  writeFileSync(join(root, 'math.test.cjs'), "const test = require('node:test'); const assert = require('node:assert/strict'); const double = require('./src/math.cjs'); test('double', () => assert.equal(double(2), 4));\n")
  const before = spawnSync(process.execPath, ['--test', 'math.test.cjs'], { cwd: root, encoding: 'utf8', timeout: 10000, windowsHide: true })
  assert.equal(before.status, 1, `fixture must start with a real failing verifier: ${before.stdout} ${before.stderr}`)
  const { EvidenceBundle } = await import('../evidence.js')
  const { SwePlanSchema } = await import('../schemas/agentContracts.js')
  const { runExecutorLoop } = await import('./executorLoop.js')
  const { withPipelineModelRoute } = await import('../execute.js')
  const task = 'Repair src/math.cjs so node --test math.test.cjs passes.'
  const plan = SwePlanSchema.parse({ plan_version: '1.0', plan_type: 'IMPLEMENTATION_PLAN', task_summary: task,
    assumptions: [], risks: [], out_of_scope: [], root_cause: 'Wrong multiplier', minimal_action_set: [
      { step: 1, tool: 'test_run', target: 'node --test math.test.cjs', description: 'Reproduce failure', rationale: 'Establish red test', reversible: true, verification: 'Observe failure' },
      { step: 2, tool: 'file_read', target: 'src/math.cjs', description: 'Inspect the implementation', rationale: 'Identify defect', reversible: true, verification: 'Read source' },
      { step: 3, tool: 'file_write', target: 'src/math.cjs', description: 'Correct the multiplier', rationale: 'Repair defect', reversible: true, verification: 'Run test' },
      { step: 4, tool: 'test_run', target: 'node --test math.test.cjs', description: 'Verify repair', rationale: 'Check behavior', reversible: true, verification: 'Exit zero' },
    ] })
  const evidence = new EvidenceBundle(task, process.env['BABEL_RUNS_DIR']!)
  evidence.writeQaVerdict({ verdict: 'PASS', overall_confidence: 5 }, 1)
  const turns = [
    { type: 'tool_call', thinking: 'Reproduce the failing test', tool: 'test_run', command: 'node --test math.test.cjs' },
    { type: 'tool_call', thinking: 'Inspect', tool: 'file_read', path: 'src/math.cjs' },
    { type: 'tool_call', thinking: 'Repair', tool: 'file_write', path: 'src/math.cjs', content: 'module.exports = n => n * 2\n' },
    { type: 'tool_call', thinking: 'Verify', tool: 'test_run', command: 'node --test math.test.cjs' },
    { type: 'completion', status: 'EXECUTION_COMPLETE' },
  ]
  let calls = 0; let leaked = false
  t.mock.method(globalThis, 'fetch', async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)); assert.equal(body.model, 'z-ai/glm-5.3-flash')
    leaked ||= String(init?.body).includes('SYNTHETIC_SNAPSHOT_SECRET')
    const turn = turns[calls++]; assert.ok(turn, 'unexpected inference')
    return new Response('data: ' + JSON.stringify({ model: body.model, choices: [{ index: 0, delta: { content: JSON.stringify(turn) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  })
  const result = await withPipelineModelRoute('glm-5.3-flash', () => runExecutorLoop(plan, evidence, 'deepseek', [], [], task))
  assert.equal(result.terminalStatus, 'EXECUTION_COMPLETE')
  assert.equal(calls, 5, 'the fixture must exercise the full scripted repair without hidden retries')
  assert.equal(readFileSync(join(root, 'src', 'math.cjs'), 'utf8'), 'module.exports = n => n * 2\n')
  assert.equal(spawnSync(process.execPath, ['--test', 'math.test.cjs'], { cwd: root, encoding: 'utf8', timeout: 10000, windowsHide: true }).status, 0)
  assert.ok(result.toolCallLog.some(entry => entry.tool === 'test_run' && entry.exit_code === 0))
  assert.ok(result.toolCallLog.some(entry => entry.tool === 'test_run' && entry.exit_code !== 0), 'executor must observe the red test')
  assert.ok(existsSync(join(evidence.runDir, 'repair_attempt_timeline.json')), 'repair timeline must be persisted before return')
  assert.ok(existsSync(join(evidence.runDir, 'attempt_safety_summary.json')), 'terminal safety snapshot must be persisted before return')
  const timeline = JSON.parse(readFileSync(join(evidence.runDir, 'repair_attempt_timeline.json'), 'utf8'))
  const safety = JSON.parse(readFileSync(join(evidence.runDir, 'attempt_safety_summary.json'), 'utf8'))
  const timings = JSON.parse(readFileSync(join(evidence.runDir, 'safety_snapshot_timings.json'), 'utf8'))
  assert.ok(Number.isFinite(timings.initial_ms) && timings.initial_ms >= 0)
  assert.ok(Number.isFinite(timings.final_ms) && timings.final_ms >= 0)
  t.diagnostic(`SNAPSHOT_TIMINGS ${JSON.stringify(timings)}`)
  assert.ok(timeline.attempts.some((attempt: { verifier_exit_code: number | null }) => attempt.verifier_exit_code === 1), 'timeline must retain the red verifier')
  assert.notEqual(safety.pre_run_file_hashes['src/math.cjs'], safety.final_file_hashes['src/math.cjs'], 'guarded snapshots must retain actual changed-file identity')
  assert.match(safety.pre_run_file_hashes['src/math.cjs'], /^[a-f0-9]{64}$/)
  assert.match(safety.final_file_hashes['src/math.cjs'], /^[a-f0-9]{64}$/)
  assert.match(safety.snapshot_identity.initial, /^[a-f0-9]{64}$/)
  assert.equal(safety.snapshot_identity.initial, safety.snapshot_identity.final)
  assert.equal(safety.snapshot_identity.matched, true)
  assert.equal(safety.unrelated_dirty_file_preservation.status, 'not_evaluated')
  assert.equal(leaked, false, 'protected synthetic value must not reach provider requests')
  const { exportEvidenceBundle } = await import('../services/evidenceProduct.js')
  const outputDir = join(process.env['BABEL_STATE_DIR']!, 'repair-snapshot-export')
  const exported = exportEvidenceBundle({ runDir: evidence.runDir, outputDir })
  assert.equal(exported.status, 'ok', exported.error ?? 'export failed'); assert.ok(exported.files_copied.length > 0)
  for (const name of exported.files_copied) assert.equal(readFileSync(join(outputDir, name), 'utf8').includes('SYNTHETIC_SNAPSHOT_SECRET'), false)
  assert.ok(existsSync(evidence.runDir))
})

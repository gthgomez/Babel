import assert from 'node:assert/strict'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { detectSmallFix, runSmallFixPath } from './smallFix.js'
import { runDogfoodApply } from './dogfoodSandbox.js'
import { updateUserSettings } from '../config/userSettings.js'

test('small fix rejects a missing explicit Plan before provider or mutation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-fix-plan-admission-'))
  const path = join(root, 'fixture.js'); writeFileSync(path, 'original fixture\n')
  const previousFetch = globalThis.fetch; let requests = 0
  globalThis.fetch = async () => { requests++; throw new Error('Unexpected provider request') }
  try {
    await assert.rejects(runSmallFixPath({ task: 'Fix fixture.js', projectRoot: root, provider: 'live', planRunId: '20260610T180000Z-plan-abc123' }), /plan source.*unavailable|plan source.*unsafe/i)
    assert.equal(requests, 0); assert.equal(readFileSync(path, 'utf8'), 'original fixture\n')
  } finally { globalThis.fetch = previousFetch; rmSync(root, { recursive: true, force: true }) }
})

test('small fix rejects a contract-less legacy Plan before provider or mutation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-fix-legacy-contract-')); const id = '20260610T180000Z-plan-abc123'
  const file = join(root, 'fixture.js'); writeFileSync(file, 'original fixture\n')
  const source = join(root, 'runs', 'babel-lite', id); mkdirSync(source, { recursive: true }); writeFileSync(join(source, 'model_plan.json'), JSON.stringify({ summary: 'Legacy', likely_files: ['fixture.js'] }))
  const previousFetch = globalThis.fetch; let requests = 0; globalThis.fetch = async () => { requests++; throw new Error('Unexpected provider request') }
  try {
    await assert.rejects(runSmallFixPath({ task: 'Fix fixture.js', projectRoot: root, provider: 'live', planRunId: id }), /contract.*missing|contract.*unavailable/i)
    assert.equal(requests, 0); assert.equal(readFileSync(file, 'utf8'), 'original fixture\n')
  } finally { globalThis.fetch = previousFetch; rmSync(root, { recursive: true, force: true }) }
})

test('small fix rejects a target outside the selected Plan contract before provider or mutation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-fix-plan-scope-')); const id = '20260610T180000Z-plan-abc123'
  const file = join(root, 'fixture.js'); writeFileSync(file, 'original fixture\n'); writeFileSync(join(root, 'allowed.js'), 'allowed fixture\n')
  const source = join(root, 'runs', 'babel-lite', id); mkdirSync(source, { recursive: true });
  writeFileSync(join(source, 'model_plan.json'), JSON.stringify({ summary: 'Plan', likely_files: ['fixture.js'] }))
  writeFileSync(join(source, 'contract.json'), JSON.stringify({ schema_version: 1, mode: 'babel-lite-plan', likely_files: ['allowed.js'], required_reads: [] }))
  const previousFetch = globalThis.fetch; let requests = 0; globalThis.fetch = async () => { requests++; throw new Error('Unexpected provider request') }
  try {
    const task = 'Only edit fixture.js and run npm test before completing'; assert.ok(detectSmallFix({ task, projectRoot: root }), 'fixture must resolve an explicit target')
    await assert.rejects(runSmallFixPath({ task, projectRoot: root, provider: 'live', planRunId: id }), /outside.*plan.*scope/i)
    assert.equal(requests, 0); assert.equal(readFileSync(file, 'utf8'), 'original fixture\n')
  } finally { globalThis.fetch = previousFetch; rmSync(root, { recursive: true, force: true }) }
})

test('small fix admits an explicitly resolved in-scope target to the provider boundary', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-fix-plan-allowed-')); const id = '20260610T180000Z-plan-abc123'
  const file = join(root, 'fixture.js'); writeFileSync(file, 'original fixture\n')
  writeFileSync(join(root, 'fixture.test.js'), 'SYNTHETIC_OUT_OF_SCOPE_TEST'); writeFileSync(join(root, 'package.json'), JSON.stringify({ note: 'SYNTHETIC_OUT_OF_SCOPE_PACKAGE', scripts: { test: 'node --test' } }))
  const source = join(root, 'runs', 'babel-lite', id); mkdirSync(source, { recursive: true })
  writeFileSync(join(source, 'model_plan.json'), JSON.stringify({ summary: 'Plan', likely_files: ['fixture.js'] }))
  writeFileSync(join(source, 'contract.json'), JSON.stringify({ schema_version: 1, mode: 'babel-lite-plan', likely_files: ['fixture.js'], required_reads: [] }))
  const previousFetch = globalThis.fetch; const previousKey = process.env['OPENROUTER_API_KEY']; const previousState = process.env['BABEL_STATE_DIR']; let requests = 0; let leaked = false
  process.env['OPENROUTER_API_KEY'] = 'synthetic-fixture-only'
  process.env['BABEL_STATE_DIR'] = join(root, 'state')
  updateUserSettings({ connections: { fixture: { id: 'fixture', provider: 'openrouter', model: 'z-ai/glm-5.3-flash', apiKeyEnvVar: 'OPENROUTER_API_KEY' } }, defaults: { connection: 'fixture', budgetUsd: 'unlimited' } })
  globalThis.fetch = async (_url, init) => { requests++; leaked ||= String(init?.body).includes('SYNTHETIC_OUT_OF_SCOPE_'); return new Response('{}', { status: 401 }) }
  try {
    await assert.rejects(runSmallFixPath({ task: 'Only edit fixture.js', projectRoot: root, provider: 'live', model: 'connection/fixture/z-ai/glm-5.3-flash', planRunId: id }), /explicit verifier/i)
    assert.equal(requests, 0)
    const task = 'Only edit fixture.js and run npm test before completing'; assert.ok(detectSmallFix({ task, projectRoot: root }))
    let reason = ''; try { await runSmallFixPath({ task, projectRoot: root, provider: 'live', model: 'connection/fixture/z-ai/glm-5.3-flash', planRunId: id }) } catch (error) { reason = String(error) }
    assert.equal(requests, 1, `provider admission failed: ${reason}`); assert.equal(leaked, false, 'unapproved nearby content reached the request'); assert.equal(readFileSync(file, 'utf8'), 'original fixture\n')
  } finally { globalThis.fetch = previousFetch; if (previousKey === undefined) delete process.env['OPENROUTER_API_KEY']; else process.env['OPENROUTER_API_KEY'] = previousKey; if (previousState === undefined) delete process.env['BABEL_STATE_DIR']; else process.env['BABEL_STATE_DIR'] = previousState; rmSync(root, { recursive: true, force: true }) }
})

test('Plan-bound small fix does not allow an out-of-scope verifier effect', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-plan-verifier-effect-')); const id = '20260610T180000Z-plan-abc123'
  const file = join(root, 'fixture.js'); const marker = join(root, 'outside-effect.txt')
  writeFileSync(file, 'original fixture\n')
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node verifier.cjs' } }))
  writeFileSync(join(root, 'verifier.cjs'), "require('node:fs').writeFileSync('outside-effect.txt', 'synthetic effect')")
  const source = join(root, 'runs', 'babel-lite', id); mkdirSync(source, { recursive: true })
  writeFileSync(join(source, 'model_plan.json'), JSON.stringify({ summary: 'Plan' }))
  writeFileSync(join(source, 'contract.json'), JSON.stringify({ schema_version: 1, mode: 'babel-lite-plan', likely_files: ['fixture.js'], required_reads: [] }))
  const names = ['OPENROUTER_API_KEY', 'BABEL_STATE_DIR', 'BABEL_PROJECT_ROOT', 'BABEL_ALLOW_HOST_FALLBACK'] as const
  const prior = Object.fromEntries(names.map(name => [name, process.env[name]])); const previousFetch = globalThis.fetch
  process.env['OPENROUTER_API_KEY'] = 'synthetic-fixture-only'; process.env['BABEL_STATE_DIR'] = join(root, 'state'); process.env['BABEL_PROJECT_ROOT'] = root; process.env['BABEL_ALLOW_HOST_FALLBACK'] = '1'
  updateUserSettings({ connections: { fixture: { id: 'fixture', provider: 'openrouter', model: 'z-ai/glm-5.3-flash', apiKeyEnvVar: 'OPENROUTER_API_KEY' } }, defaults: { connection: 'fixture', budgetUsd: 'unlimited' } })
  let requests = 0
  globalThis.fetch = async (_url, init) => { requests++; const model = JSON.parse(String(init?.body)).model; return new Response(JSON.stringify({ model, choices: [{ message: { content: JSON.stringify({ schema_version: 1, summary: 'Fixture edit', replacement_content: 'updated fixture\n', confidence: 'high' }) } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })) }
  try {
    await assert.rejects(runSmallFixPath({ task: 'Only edit fixture.js and run npm test before completing', projectRoot: root, provider: 'live', model: 'connection/fixture/z-ai/glm-5.3-flash', planRunId: id }), /Plan-bound small-fix mutation is temporarily unavailable/)
    assert.equal(requests, 0)
    assert.equal(readFileSync(file, 'utf8'), 'original fixture\n')
    assert.equal(existsSync(marker), false, 'verifier escaped selected Plan scope')
  } finally { globalThis.fetch = previousFetch; for (const name of names) { if (prior[name] === undefined) delete process.env[name]; else process.env[name] = prior[name] }; rmSync(root, { recursive: true, force: true }) }
})

test('small fix refuses an in-scope hard-linked target before provider dispatch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-fix-plan-hardlink-')); const project = join(root, 'project'); mkdirSync(project)
  const outside = join(root, 'outside.js'); writeFileSync(outside, 'SYNTHETIC_OUTSIDE_HARDLINK'); linkSync(outside, join(project, 'fixture.js'))
  const id = '20260610T180000Z-plan-abc123'; const source = join(project, 'runs', 'babel-lite', id); mkdirSync(source, { recursive: true })
  writeFileSync(join(source, 'model_plan.json'), JSON.stringify({ summary: 'Plan', likely_files: ['fixture.js'] }))
  writeFileSync(join(source, 'contract.json'), JSON.stringify({ schema_version: 1, mode: 'babel-lite-plan', likely_files: ['fixture.js'], required_reads: [] }))
  const previousFetch = globalThis.fetch; const previousKey = process.env['OPENROUTER_API_KEY']; const previousState = process.env['BABEL_STATE_DIR']; let requests = 0
  process.env['OPENROUTER_API_KEY'] = 'synthetic-fixture-only'; process.env['BABEL_STATE_DIR'] = join(root, 'state')
  updateUserSettings({ connections: { fixture: { id: 'fixture', provider: 'openrouter', model: 'z-ai/glm-5.3-flash', apiKeyEnvVar: 'OPENROUTER_API_KEY' } }, defaults: { connection: 'fixture', budgetUsd: 'unlimited' } })
  globalThis.fetch = async () => { requests++; return new Response('{}', { status: 401 }) }
  try {
    const task = 'Only edit fixture.js and run npm test before completing'; assert.ok(detectSmallFix({ task, projectRoot: project }))
    await assert.rejects(runSmallFixPath({ task, projectRoot: project, provider: 'live', model: 'connection/fixture/z-ai/glm-5.3-flash', planRunId: id }), /unsafe.*target|target.*unsafe/i)
    assert.equal(requests, 0); assert.equal(readFileSync(outside, 'utf8'), 'SYNTHETIC_OUTSIDE_HARDLINK')
  } finally { globalThis.fetch = previousFetch; if (previousKey === undefined) delete process.env['OPENROUTER_API_KEY']; else process.env['OPENROUTER_API_KEY'] = previousKey; if (previousState === undefined) delete process.env['BABEL_STATE_DIR']; else process.env['BABEL_STATE_DIR'] = previousState; rmSync(root, { recursive: true, force: true }) }
})

test('dogfood rejects a missing explicit Plan before creating a workspace or lock', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-dogfood-plan-admission-'))
  try {
    await assert.rejects(runDogfoodApply({ task: 'Fix fixture.js', projectRoot: root, isolation: 'shadow', provider: 'mock', planRunId: '20260610T180000Z-plan-abc123' }), /plan source.*unavailable|plan source.*unsafe/i)
    assert.equal(existsSync(join(root, '.babel')), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('valid Plan-based dogfood remains explicitly quarantined and retains its artifact', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-dogfood-plan-quarantine-')); const id = '20260610T180000Z-plan-abc123'
  const source = join(root, 'runs', 'babel-lite', id); mkdirSync(source, { recursive: true })
  const artifact = join(source, 'model_plan.json'); writeFileSync(artifact, JSON.stringify({ summary: 'Retained Plan' }))
  try {
    await assert.rejects(runDogfoodApply({ task: 'Fix fixture.js', projectRoot: root, isolation: 'shadow', provider: 'mock', planRunId: id }), /UNSUPPORTED_OPERATION.*Plan-based dogfood/)
    assert.equal(existsSync(artifact), true); assert.equal(existsSync(join(root, '.babel')), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('small fix rejects an injected handoff without an explicit Plan ID', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-fix-injected-plan-')); writeFileSync(join(root, 'fixture.js'), 'original fixture\n')
  const previousFetch = globalThis.fetch; let requests = 0
  globalThis.fetch = async () => { requests++; throw new Error('Unexpected provider request') }
  try {
    await assert.rejects(runSmallFixPath({ task: 'Fix fixture.js', projectRoot: root, provider: 'live', planHandoff: { planRunId: '20260610T180000Z-plan-abc123', planRunDir: root, contract: null, modelPlan: null, allowedPaths: ['fixture.js'], contextText: 'unverified injected plan' } }), /explicit.*plan|plan.*identity/i)
    assert.equal(requests, 0)
  } finally { globalThis.fetch = previousFetch; rmSync(root, { recursive: true, force: true }) }
})

test('small fix rejects a supplied handoff even when its claimed ID matches', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-fix-forged-plan-')); writeFileSync(join(root, 'fixture.js'), 'original fixture\n')
  const previousFetch = globalThis.fetch; let requests = 0
  globalThis.fetch = async () => { requests++; throw new Error('Unexpected provider request') }
  try {
    const id = '20260610T180000Z-plan-abc123'
    await assert.rejects(runSmallFixPath({ task: 'Fix fixture.js', projectRoot: root, provider: 'live', planRunId: id, planHandoff: { planRunId: id, planRunDir: root, contract: null, modelPlan: null, allowedPaths: ['fixture.js'], contextText: 'unverified injected plan' } }), /supplied.*handoff|handoff.*unsafe/i)
    assert.equal(requests, 0)
  } finally { globalThis.fetch = previousFetch; rmSync(root, { recursive: true, force: true }) }
})

test('small fix does not inject an unselected latest Plan from task prose', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-fix-no-implicit-'))
  const path = join(root, 'fixture.js'); writeFileSync(path, 'original fixture\n')
  const run = join(root, 'runs', 'babel-lite', '20260610T180000Z-plan-abc123')
  mkdirSync(run, { recursive: true }); writeFileSync(join(run, 'model_plan.json'), JSON.stringify({ summary: 'SYNTHETIC_UNSELECTED_PLAN', likely_files: ['fixture.js'] }))
  const previousFetch = globalThis.fetch; const previousKey = process.env['OPENROUTER_API_KEY']; const previousState = process.env['BABEL_STATE_DIR']; let requests = 0
  process.env['OPENROUTER_API_KEY'] = 'synthetic-fixture-only'
  process.env['BABEL_STATE_DIR'] = join(root, 'state')
  updateUserSettings({ connections: { fixture: { id: 'fixture', provider: 'openrouter', model: 'z-ai/glm-5.3-flash', apiKeyEnvVar: 'OPENROUTER_API_KEY' } }, defaults: { connection: 'fixture', budgetUsd: 'unlimited' } })
  globalThis.fetch = async (_url, init) => {
    requests++; assert.equal(String(init?.body).includes('SYNTHETIC_UNSELECTED_PLAN'), false)
    return new Response('{}', { status: 401 })
  }
  try {
    await runSmallFixPath({ task: 'Fix fixture.js and apply the change', projectRoot: root, provider: 'live', model: 'connection/fixture/z-ai/glm-5.3-flash' })
    assert.equal(requests, 1); assert.equal(readFileSync(path, 'utf8'), 'original fixture\n')
  } finally { globalThis.fetch = previousFetch; if (previousKey === undefined) delete process.env['OPENROUTER_API_KEY']; else process.env['OPENROUTER_API_KEY'] = previousKey; if (previousState === undefined) delete process.env['BABEL_STATE_DIR']; else process.env['BABEL_STATE_DIR'] = previousState; rmSync(root, { recursive: true, force: true }) }
})

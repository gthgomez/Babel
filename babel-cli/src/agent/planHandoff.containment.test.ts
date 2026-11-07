import assert from 'node:assert/strict'
import fs from 'node:fs'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { loadPlanHandoff, loadPlanHandoffGuarded } from './planHandoff.js'
import { savePlan } from '../services/savedPlan.js'

test('a linked Plan run directory cannot supply handoff content or a saved Plan', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'babel-plan-contained-'))
  try {
    const project = join(root, 'project'); const outside = join(root, 'outside')
    const planRunId = '20260610T180000Z-plan-abc123def456'
    fs.mkdirSync(join(project, 'runs', 'babel-lite'), { recursive: true }); fs.mkdirSync(outside)
    fs.writeFileSync(join(outside, 'model_plan.json'), JSON.stringify({ summary: 'SYNTHETIC_OUTSIDE_PLAN' }))
    fs.symlinkSync(outside, join(project, 'runs', 'babel-lite', planRunId), process.platform === 'win32' ? 'junction' : 'dir')
    assert.equal(loadPlanHandoff({ repoPath: project, task: 'inspect', planRunId }), null)
    assert.throws(
      () => savePlan({ projectRoot: project, task: 'inspect', body: 'retained plan', sourceRunId: planRunId }, { BABEL_STATE_DIR: join(root, 'state') }),
      /unavailable or unsafe/,
    )
    assert.equal(fs.existsSync(join(root, 'state')), false)
    assert.match(fs.readFileSync(join(outside, 'model_plan.json'), 'utf8'), /SYNTHETIC_OUTSIDE_PLAN/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('guarded Plan reader holds its source parent through a real file open', async t => {
  if (process.platform !== 'win32') { t.skip('Windows guarded candidate'); return }
  const root = fs.mkdtempSync(join(tmpdir(), 'babel-plan-guarded-')); const original = fs.openSync
  try {
    const planRunId = '20260610T180000Z-plan-abc123def456'; const run = join(root, 'runs', 'babel-lite', planRunId)
    const parent = join(root, 'src'); const source = join(parent, 'safe.txt'); fs.mkdirSync(run, { recursive: true }); fs.mkdirSync(parent); fs.writeFileSync(source, 'safe snippet')
    fs.writeFileSync(join(run, 'contract.json'), JSON.stringify({ schema_version: 1, mode: 'babel-lite-plan', likely_files: ['src/safe.txt'], required_reads: [] }))
    fs.writeFileSync(join(run, 'model_plan.json'), JSON.stringify({ summary: 'safe plan' }))
    let attempted = false; let renamed = false
    fs.openSync = ((path: fs.PathLike, ...args: unknown[]) => {
      if (!attempted && String(path).toLowerCase() === source.toLowerCase()) {
        attempted = true
        try { fs.renameSync(parent, join(root, 'moved')); renamed = true; fs.renameSync(join(root, 'moved'), parent) }
        catch (error) { if (!['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error }
      }
      return original(path, ...(args as [fs.OpenMode]))
    }) as typeof fs.openSync
    syncBuiltinESMExports()
    const handoff = await loadPlanHandoffGuarded({ repoPath: root, task: 'inspect', planRunId })
    assert.equal(attempted, true); assert.equal(renamed, false)
    assert.match(handoff?.contextText ?? '', /safe snippet/)
  } finally { fs.openSync = original; syncBuiltinESMExports(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('guarded Plan reader holds metadata and rejects an owned guard loss', async t => {
  if (process.platform !== 'win32') { t.skip('Windows guarded candidate'); return }
  const root = fs.mkdtempSync(join(tmpdir(), 'babel-plan-guard-loss-')); const originalOpen = fs.openSync; const originalSpawn = childProcess.spawn
  let helper: ReturnType<typeof childProcess.spawn> | undefined
  try {
    const planRunId = '20260610T180000Z-plan-abc123def456'; const run = join(root, 'runs', 'babel-lite', planRunId)
    const parent = join(root, 'src'); const source = join(parent, 'safe.txt'); const metadata = join(run, 'contract.json')
    fs.mkdirSync(run, { recursive: true }); fs.mkdirSync(parent); fs.writeFileSync(source, 'safe snippet')
    fs.writeFileSync(metadata, JSON.stringify({ schema_version: 1, mode: 'babel-lite-plan', likely_files: ['src/safe.txt'], required_reads: [] }))
    fs.writeFileSync(join(run, 'model_plan.json'), JSON.stringify({ summary: 'safe plan' }))
    let attempted = false; let renamed = false; let killed = false
    childProcess.spawn = ((...args: Parameters<typeof childProcess.spawn>) => { const child = originalSpawn(...args); helper = child; return child }) as typeof childProcess.spawn
    fs.openSync = ((path: fs.PathLike, ...args: unknown[]) => {
      if (!attempted && String(path).toLowerCase() === metadata.toLowerCase()) {
        attempted = true
        try { fs.renameSync(run, `${run}-moved`); renamed = true; fs.renameSync(`${run}-moved`, run) }
        catch (error) { if (!['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error }
      }
      if (!killed && String(path).toLowerCase() === source.toLowerCase()) { killed = true; assert.ok(helper?.pid); process.kill(helper.pid) }
      return originalOpen(path, ...(args as [fs.OpenMode]))
    }) as typeof fs.openSync
    syncBuiltinESMExports()
    await assert.rejects(loadPlanHandoffGuarded({ repoPath: root, task: 'inspect', planRunId }), /EFFECT_DIRECTORY_ANCHOR_LOST/)
    assert.equal(attempted, true); assert.equal(renamed, false); assert.equal(killed, true)
  } finally { fs.openSync = originalOpen; childProcess.spawn = originalSpawn; syncBuiltinESMExports(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('guarded Plan reader excludes protected and outside source bytes', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'babel-plan-guarded-private-'))
  try {
    const project = join(root, 'project'); const outside = join(root, 'outside'); const planRunId = '20260610T180000Z-plan-abc123def456'
    const run = join(project, 'runs', 'babel-lite', planRunId); fs.mkdirSync(run, { recursive: true }); fs.mkdirSync(outside)
    fs.writeFileSync(join(project, 'safe.txt'), 'SYNTHETIC_SAFE_SNIPPET'); fs.writeFileSync(join(project, '.env.local'), 'SYNTHETIC_ENV_SECRET')
    fs.writeFileSync(join(outside, 'secret.txt'), 'SYNTHETIC_OUTSIDE_SECRET'); fs.symlinkSync(outside, join(project, 'outside'), process.platform === 'win32' ? 'junction' : 'dir')
    fs.writeFileSync(join(run, 'contract.json'), JSON.stringify({ schema_version: 1, mode: 'babel-lite-plan', likely_files: ['safe.txt', '.env.local', 'outside/secret.txt'], required_reads: [] }))
    fs.writeFileSync(join(run, 'model_plan.json'), JSON.stringify({ summary: 'safe plan' }))
    const handoff = await loadPlanHandoffGuarded({ repoPath: project, task: 'inspect', planRunId })
    assert.ok(handoff); assert.match(handoff.contextText, /SYNTHETIC_SAFE_SNIPPET/)
    assert.doesNotMatch(handoff.contextText, /SYNTHETIC_ENV_SECRET|SYNTHETIC_OUTSIDE_SECRET/)
    assert.deepEqual(handoff.allowedPaths, ['safe.txt'])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('guarded Plan reader rejects source metadata changed during construction', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'babel-plan-guarded-change-')); const originalOpen = fs.openSync
  try {
    const planRunId = '20260610T180000Z-plan-abc123def456'; const run = join(root, 'runs', 'babel-lite', planRunId)
    const contract = join(run, 'contract.json'); const model = join(run, 'model_plan.json')
    fs.mkdirSync(run, { recursive: true }); fs.writeFileSync(join(root, 'safe.txt'), 'safe snippet')
    fs.writeFileSync(contract, JSON.stringify({ schema_version: 1, mode: 'babel-lite-plan', likely_files: ['safe.txt'], required_reads: [] }))
    fs.writeFileSync(model, JSON.stringify({ summary: 'safe plan' }))
    let modelOpens = 0; let changed = false
    fs.openSync = ((path: fs.PathLike, ...args: unknown[]) => {
      if (String(path).toLowerCase().replace(/\\/g, '/').endsWith('model_plan.json') && ++modelOpens === 1) {
        changed = true; fs.writeFileSync(contract, JSON.stringify({ schema_version: 1, mode: 'babel-lite-plan', likely_files: [], required_reads: [] }))
      }
      return originalOpen(path, ...(args as [fs.OpenMode]))
    }) as typeof fs.openSync
    syncBuiltinESMExports()
    assert.equal(await loadPlanHandoffGuarded({ repoPath: root, task: 'inspect', planRunId }), null)
    assert.equal(changed, true)
  } finally { fs.openSync = originalOpen; syncBuiltinESMExports(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('guarded Plan reader keeps an explicitly selected older Plan', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'babel-plan-guarded-identity-'))
  try {
    const older = '20260610T180000Z-plan-abc123def456'; const newer = '20260610T180001Z-plan-abc123def457'
    for (const [id, marker] of [[older, 'SYNTHETIC_PLAN_A'], [newer, 'SYNTHETIC_PLAN_B']] as const) {
      const run = join(root, 'runs', 'babel-lite', id); fs.mkdirSync(run, { recursive: true })
      fs.writeFileSync(join(run, 'contract.json'), JSON.stringify({ schema_version: 1, mode: 'babel-lite-plan', likely_files: [], required_reads: [] }))
      fs.writeFileSync(join(run, 'model_plan.json'), JSON.stringify({ summary: marker }))
    }
    const handoff = await loadPlanHandoffGuarded({ repoPath: root, task: 'inspect selected plan', planRunId: older })
    assert.equal(handoff?.planRunId, older); assert.match(handoff?.contextText ?? '', /SYNTHETIC_PLAN_A/)
    assert.doesNotMatch(handoff?.contextText ?? '', /SYNTHETIC_PLAN_B/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('guarded Plan admission releases its owned directory guards after cancellation', async t => {
  if (process.platform !== 'win32') { t.skip('Windows guarded candidate'); return }
  const root = fs.mkdtempSync(join(tmpdir(), 'babel-plan-guard-cancel-')); const originalSpawn = childProcess.spawn
  try {
    const planRunId = '20260610T180000Z-plan-abc123def456'; const run = join(root, 'runs', 'babel-lite', planRunId)
    fs.mkdirSync(run, { recursive: true }); fs.writeFileSync(join(run, 'contract.json'), JSON.stringify({ schema_version: 1, mode: 'babel-lite-plan', likely_files: [], required_reads: [] }))
    fs.writeFileSync(join(run, 'model_plan.json'), JSON.stringify({ summary: 'safe plan' }))
    const controller = new AbortController(); let started = false
    childProcess.spawn = ((...args: Parameters<typeof childProcess.spawn>) => {
      const child = originalSpawn(...args)
      if (!started) { started = true; setImmediate(() => controller.abort(new Error('SYNTHETIC_PLAN_CANCELLED'))) }
      return child
    }) as typeof childProcess.spawn
    syncBuiltinESMExports()
    await assert.rejects(loadPlanHandoffGuarded({ repoPath: root, task: 'inspect', planRunId, signal: controller.signal }), /SYNTHETIC_PLAN_CANCELLED/)
    assert.equal(started, true)
    fs.renameSync(run, `${run}-moved`)
  } finally { childProcess.spawn = originalSpawn; syncBuiltinESMExports(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('guarded Plan reader preserves the existing bounded preview without narrowing allowed scope', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'babel-plan-guarded-preview-limit-'))
  try {
    const planRunId = '20260610T180000Z-plan-abc123def456'; const run = join(root, 'runs', 'babel-lite', planRunId); fs.mkdirSync(run, { recursive: true })
    const paths = Array.from({ length: 13 }, (_, index) => `source-${String(index).padStart(2, '0')}.txt`)
    for (const path of paths) fs.writeFileSync(join(root, path), `CONTENT_${path}`)
    fs.writeFileSync(join(run, 'contract.json'), JSON.stringify({ schema_version: 1, mode: 'babel-lite-plan', likely_files: paths, required_reads: [] }))
    fs.writeFileSync(join(run, 'model_plan.json'), JSON.stringify({ summary: 'safe plan' }))
    const handoff = await loadPlanHandoffGuarded({ repoPath: root, task: 'inspect', planRunId })
    assert.equal(handoff?.allowedPaths.length, 13)
    assert.match(handoff?.contextText ?? '', /CONTENT_source-11\.txt/)
    assert.doesNotMatch(handoff?.contextText ?? '', /CONTENT_source-12\.txt/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

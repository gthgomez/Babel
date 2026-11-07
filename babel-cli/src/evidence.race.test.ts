import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { EvidenceBundle } from './evidence.js'

test('schema failure evidence rejects a traversing session identity', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'babel-evidence-session-'))
  const priorBase = process.env['BABEL_RUNS_DIR']; const priorId = process.env['BABEL_SESSION_ID']
  try {
    process.env['BABEL_RUNS_DIR'] = join(root, 'runs'); process.env['BABEL_SESSION_ID'] = '../../outside'
    assert.throws(() => EvidenceBundle.inMemory('fixture'), /unsafe|session/i)
    assert.equal(fs.existsSync(join(root, 'outside')), false)
    process.env['BABEL_SESSION_ID'] = 'session-123'
    const bundle = EvidenceBundle.inMemory('fixture')
    bundle.writeDebugFile('debug.json', 'safe')
    assert.equal(fs.readFileSync(join(root, 'runs', 'schema-failures', 'session-123', 'debug.json'), 'utf8'), 'safe')
  } finally {
    if (priorBase === undefined) delete process.env['BABEL_RUNS_DIR']; else process.env['BABEL_RUNS_DIR'] = priorBase
    if (priorId === undefined) delete process.env['BABEL_SESSION_ID']; else process.env['BABEL_SESSION_ID'] = priorId
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('schema failure evidence does not create directories through a linked base', t => {
  const root = fs.mkdtempSync(join(tmpdir(), 'babel-evidence-session-link-'))
  const priorBase = process.env['BABEL_RUNS_DIR']; const priorId = process.env['BABEL_SESSION_ID']
  try {
    const outside = join(root, 'outside'); const linked = join(root, 'linked'); fs.mkdirSync(outside)
    try { fs.symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir') }
    catch (error) { if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('directory links unavailable'); return } throw error }
    process.env['BABEL_RUNS_DIR'] = linked; process.env['BABEL_SESSION_ID'] = 'fixture'
    assert.throws(() => EvidenceBundle.inMemory('fixture'), /unsafe|directory/i)
    assert.equal(fs.existsSync(join(outside, 'schema-failures')), false)
  } finally {
    if (priorBase === undefined) delete process.env['BABEL_RUNS_DIR']; else process.env['BABEL_RUNS_DIR'] = priorBase
    if (priorId === undefined) delete process.env['BABEL_SESSION_ID']; else process.env['BABEL_SESSION_ID'] = priorId
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('debug evidence refuses a hard-linked outside artifact', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'babel-evidence-hardlink-'))
  try {
    const bundle = new EvidenceBundle('fixture', root); const outside = join(root, 'outside.txt')
    fs.writeFileSync(outside, 'SYNTHETIC_RETAINED_OUTSIDE'); fs.linkSync(outside, join(bundle.runDir, 'debug.json'))
    let failure: unknown; try { bundle.writeDebugFile('debug.json', 'replacement') } catch (error) { failure = error }
    assert.equal(fs.readFileSync(outside, 'utf8'), 'SYNTHETIC_RETAINED_OUTSIDE'); assert.match(String(failure), /unsafe|link/i)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('debug evidence cannot traverse outside the run directory', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'babel-evidence-traversal-'))
  try {
    const bundle = new EvidenceBundle('fixture', root); const outside = join(root, 'outside.txt'); fs.writeFileSync(outside, 'SYNTHETIC_RETAINED_OUTSIDE')
    let failure: unknown; try { bundle.writeDebugFile('../outside.txt', 'replacement') } catch (error) { failure = error }
    assert.equal(fs.readFileSync(outside, 'utf8'), 'SYNTHETIC_RETAINED_OUTSIDE'); assert.match(String(failure), /unsafe|path/i)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('atomic evidence refuses a linked temporary artifact', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'babel-evidence-temp-link-'))
  try {
    const bundle = new EvidenceBundle('fixture', root); const outside = join(root, 'outside.txt')
    fs.writeFileSync(outside, 'SYNTHETIC_RETAINED_OUTSIDE'); fs.linkSync(outside, join(bundle.runDir, 'cost_ledger.json.tmp'))
    bundle.writeCostLedger({ status: 'safe' })
    assert.equal(fs.readFileSync(outside, 'utf8'), 'SYNTHETIC_RETAINED_OUTSIDE')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('debug evidence refuses a linked target swapped in before open', t => {
  const root = fs.mkdtempSync(join(tmpdir(), 'babel-evidence-open-swap-'))
  try {
    const bundle = new EvidenceBundle('fixture', root); const outside = join(root, 'outside.txt'); const target = join(bundle.runDir, 'debug.json')
    fs.writeFileSync(outside, 'SYNTHETIC_RETAINED_OUTSIDE'); fs.writeFileSync(target, 'safe')
    const original = fs.openSync; let swapped = false
    t.mock.method(fs, 'openSync', ((path: fs.PathLike, ...args: unknown[]) => {
      if (!swapped && String(path) === target) { swapped = true; fs.renameSync(target, join(root, 'original')); fs.linkSync(outside, target) }
      return original(path, ...(args as [fs.OpenMode]))
    }) as typeof fs.openSync)
    syncBuiltinESMExports()
    let failure: unknown; try { bundle.writeDebugFile('debug.json', 'replacement') } catch (error) { failure = error }
    assert.equal(swapped, true); assert.equal(fs.readFileSync(outside, 'utf8'), 'SYNTHETIC_RETAINED_OUTSIDE'); assert.match(String(failure), /unsafe|linked|changed/i)
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('evidence refuses to write through a linked existing run directory', t => {
  const root = fs.mkdtempSync(join(tmpdir(), 'babel-evidence-run-link-'))
  try {
    const outside = join(root, 'outside'); const run = join(root, 'run'); fs.mkdirSync(outside)
    try { fs.symlinkSync(outside, run, process.platform === 'win32' ? 'junction' : 'dir') }
    catch (error) { if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('directory links unavailable'); return } throw error }
    const bundle = EvidenceBundle.fromExistingRun(run)
    assert.throws(() => bundle.writeDebugFile('debug.json', 'replacement'), /unsafe/i)
    assert.equal(fs.existsSync(join(outside, 'debug.json')), false)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('ordinary evidence and repeated atomic updates remain usable', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'babel-evidence-positive-'))
  try {
    const bundle = new EvidenceBundle('fixture', root)
    bundle.writeDebugFile('debug.json', 'first'); bundle.writeDebugFile('debug.json', 'second')
    assert.equal(fs.readFileSync(join(bundle.runDir, 'debug.json'), 'utf8'), 'second')
    bundle.writeCostLedger({ revision: 1 }); bundle.writeCostLedger({ revision: 2 })
    assert.equal(JSON.parse(fs.readFileSync(join(bundle.runDir, 'cost_ledger.json'), 'utf8')).revision, 2)
    assert.equal(fs.readdirSync(bundle.runDir).some(name => name.endsWith('.tmp')), false)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('atomic evidence rejects replacement of the staged artifact at rename', t => {
  const root = fs.mkdtempSync(join(tmpdir(), 'babel-evidence-rename-swap-'))
  try {
    const bundle = new EvidenceBundle('fixture', root); const target = join(bundle.runDir, 'cost_ledger.json')
    const original = fs.renameSync; let swapped = false
    t.mock.method(fs, 'renameSync', ((from: fs.PathLike, to: fs.PathLike) => {
      if (!swapped && String(to) === target) {
        swapped = true
        original(from, join(root, 'original-stage'))
        fs.writeFileSync(from, 'SYNTHETIC_REPLACEMENT')
      }
      return original(from, to)
    }) as typeof fs.renameSync)
    syncBuiltinESMExports()
    let failure: unknown; try { bundle.writeCostLedger({ revision: 1 }) } catch (error) { failure = error }
    assert.equal(swapped, true)
    assert.match(String(failure), /unsafe|changed|replace/i)
    assert.equal(fs.existsSync(target), false)
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); fs.rmSync(root, { recursive: true, force: true }) }
})

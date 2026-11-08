import assert from 'node:assert/strict'
import fs from 'node:fs'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { exportEvidenceBundle } from './evidenceProduct.js'

test('evidence export rejects an artifact replaced after its safety check', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'babel-export-race-'))
  const original = fs.lstatSync
  try {
    const run = join(root, 'run'); const output = join(root, 'export'); fs.mkdirSync(run)
    const artifact = join(run, 'harness.json'); const outside = join(root, 'outside.json')
    fs.writeFileSync(artifact, JSON.stringify({ task: 'safe' }))
    fs.writeFileSync(outside, JSON.stringify({ task: 'SYNTHETIC_OUTSIDE_EXPORT_CANARY' }))
    let checks = 0
    fs.lstatSync = ((path: fs.PathLike, options?: any) => {
      const result = original(path, options)
      if (String(path) === artifact && ++checks === 2) {
        fs.renameSync(artifact, join(root, 'saved.json'))
        fs.renameSync(outside, artifact)
      }
      return result
    }) as typeof fs.lstatSync
    syncBuiltinESMExports()
    const result = exportEvidenceBundle({ runDir: run, outputDir: output })
    fs.lstatSync = original; syncBuiltinESMExports()
    assert.equal(result.status, 'failed')
    if (fs.existsSync(output)) for (const name of fs.readdirSync(output)) {
      if (fs.statSync(join(output, name)).isFile()) assert.doesNotMatch(fs.readFileSync(join(output, name), 'utf8'), /SYNTHETIC_OUTSIDE_EXPORT_CANARY/)
    }
  } finally { fs.lstatSync = original; syncBuiltinESMExports(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('evidence export refuses a nonempty destination with unselected private artifacts', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'babel-export-existing-'))
  try {
    const run = join(root, 'run'); const output = join(root, 'export'); fs.mkdirSync(run); fs.mkdirSync(output)
    fs.writeFileSync(join(run, 'harness.json'), JSON.stringify({ task: 'safe' }))
    fs.writeFileSync(join(output, 'private-unselected.txt'), 'SYNTHETIC_UNSELECTED_PRIVATE')
    const result = exportEvidenceBundle({ runDir: run, outputDir: output })
    assert.equal(result.status, 'failed')
    assert.equal(result.zip_path, null)
    assert.equal(fs.readFileSync(join(output, 'private-unselected.txt'), 'utf8'), 'SYNTHETIC_UNSELECTED_PRIVATE')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('evidence archive excludes files added after destination admission', t => {
  const root = fs.mkdtempSync(join(tmpdir(), 'babel-export-addition-'))
  const originalSpawn = childProcess.spawnSync
  try {
    const run = join(root, 'run'); const output = join(root, 'export'); fs.mkdirSync(run)
    fs.writeFileSync(join(run, 'harness.json'), JSON.stringify({ task: 'safe' }))
    childProcess.spawnSync = ((command: string, args: readonly string[], options: any) => {
      if (command === 'tar') fs.writeFileSync(join(output, 'unexpected.txt'), 'SYNTHETIC_LATE_PRIVATE')
      return originalSpawn(command, args, options)
    }) as typeof childProcess.spawnSync
    syncBuiltinESMExports()
    const result = exportEvidenceBundle({ runDir: run, outputDir: output })
    childProcess.spawnSync = originalSpawn; syncBuiltinESMExports()
    assert.equal(result.status, 'ok', result.error ?? '')
    if (!result.zip_path) { t.skip('archive utility unavailable'); return }
    const listing = originalSpawn('tar', ['-tf', result.zip_path], { encoding: 'utf8' })
    assert.equal(listing.status, 0)
    assert.doesNotMatch(listing.stdout, /unexpected\.txt/)
    assert.match(listing.stdout, /harness\.json/)
  } finally { childProcess.spawnSync = originalSpawn; syncBuiltinESMExports(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('archive creation preserves a destination created after its existence check', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'babel-export-collision-'))
  const originalSpawn = childProcess.spawnSync
  try {
    const run = join(root, 'run'); const output = join(root, 'export'); const zip = `${output}.zip`; fs.mkdirSync(run)
    fs.writeFileSync(join(run, 'harness.json'), JSON.stringify({ task: 'safe' }))
    childProcess.spawnSync = ((command: string, args: readonly string[], options: any) => {
      if (command === 'tar') fs.writeFileSync(zip, 'SYNTHETIC_PRESERVED_ARCHIVE')
      return originalSpawn(command, args, options)
    }) as typeof childProcess.spawnSync
    syncBuiltinESMExports()
    const result = exportEvidenceBundle({ runDir: run, outputDir: output })
    childProcess.spawnSync = originalSpawn; syncBuiltinESMExports()
    assert.equal(result.zip_path, null)
    assert.equal(fs.readFileSync(zip, 'utf8'), 'SYNTHETIC_PRESERVED_ARCHIVE')
  } finally { childProcess.spawnSync = originalSpawn; syncBuiltinESMExports(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('archive does not ingest an exported artifact replaced before archive creation', t => {
  const root = fs.mkdtempSync(join(tmpdir(), 'babel-export-archive-swap-'))
  const originalSpawn = childProcess.spawnSync
  try {
    const run = join(root, 'run'); const output = join(root, 'export'); fs.mkdirSync(run)
    fs.writeFileSync(join(run, 'harness.json'), JSON.stringify({ task: 'safe' }))
    childProcess.spawnSync = ((command: string, args: readonly string[], options: any) => {
      if (command === 'tar') fs.writeFileSync(join(output, 'harness.json'), JSON.stringify({ task: 'SYNTHETIC_ARCHIVE_REPLACEMENT' }))
      return originalSpawn(command, args, options)
    }) as typeof childProcess.spawnSync
    syncBuiltinESMExports()
    const result = exportEvidenceBundle({ runDir: run, outputDir: output })
    childProcess.spawnSync = originalSpawn; syncBuiltinESMExports()
    if (!result.zip_path) { t.skip('archive utility unavailable'); return }
    const list = originalSpawn('tar', ['-tf', result.zip_path], { encoding: 'utf8' })
    assert.equal(list.status, 0)
    const name = list.stdout.split(/\r?\n/).find(line => line.endsWith('/harness.json'))
    assert.ok(name)
    const contents = originalSpawn('tar', ['-xOf', result.zip_path, name], { encoding: 'utf8' })
    assert.equal(contents.status, 0)
    assert.doesNotMatch(contents.stdout, /SYNTHETIC_ARCHIVE_REPLACEMENT/)
    assert.match(contents.stdout, /safe/)
  } finally { childProcess.spawnSync = originalSpawn; syncBuiltinESMExports(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('export manifest cannot ingest a replaced destination artifact', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'babel-export-manifest-swap-'))
  const originalRead = fs.readFileSync
  try {
    const run = join(root, 'run'); const output = join(root, 'export'); fs.mkdirSync(run)
    fs.writeFileSync(join(run, 'harness.json'), JSON.stringify({ task: 'safe' }))
    fs.readFileSync = ((path: fs.PathOrFileDescriptor, options?: any) => {
      if (String(path) === join(output, 'harness.json')) fs.writeFileSync(path, JSON.stringify({ task: 'SYNTHETIC_MANIFEST_REPLACEMENT' }))
      return originalRead(path, options)
    }) as typeof fs.readFileSync
    syncBuiltinESMExports()
    const result = exportEvidenceBundle({ runDir: run, outputDir: output })
    fs.readFileSync = originalRead; syncBuiltinESMExports()
    assert.equal(result.status, 'ok', result.error ?? '')
    assert.doesNotMatch(fs.readFileSync(result.manifest_path, 'utf8'), /SYNTHETIC_MANIFEST_REPLACEMENT/)
    assert.match(fs.readFileSync(result.manifest_path, 'utf8'), /safe/)
  } finally { fs.readFileSync = originalRead; syncBuiltinESMExports(); fs.rmSync(root, { recursive: true, force: true }) }
})

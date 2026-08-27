import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { WorkspaceWitness } from './workspaceWitness.js'

test('confirms targeted mutation without treating watcher silence as proof', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bdns-workspace-'))
  try {
    const file = join(root, 'target.txt')
    await writeFile(file, 'before', 'utf8')
    const witness = new WorkspaceWitness({ root, diagnosticRoot: join(root, '.bdns') })
    const before = await witness.capture(['target.txt', 'missing.txt'])
    await writeFile(file, 'after', 'utf8')
    const after = await witness.capture(['target.txt', 'missing.txt'])
    const result = witness.reconcile({ declaredPaths: ['target.txt'], before, after, watcherAvailable: false })
    assert.deepEqual(result.changedPaths, ['target.txt'])
    assert.deepEqual(result.unexpectedChangedPaths, [])
    assert.equal(result.watcherEvidenceState, 'source_unavailable')
    assert.equal(result.evidenceState, 'complete')
    await readFile(file, 'utf8')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('detects an undeclared targeted mutation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bdns-workspace-'))
  try {
    const file = join(root, 'unexpected.txt')
    await writeFile(file, 'before', 'utf8')
    const witness = new WorkspaceWitness({ root })
    const before = await witness.capture(['unexpected.txt'])
    await writeFile(file, 'after', 'utf8')
    const after = await witness.capture(['unexpected.txt'])
    const result = witness.reconcile({ declaredPaths: [], before, after })
    assert.deepEqual(result.unexpectedChangedPaths, ['unexpected.txt'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('hashes only a bounded prefix of large files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bdns-workspace-'))
  try {
    const file = join(root, 'large.bin')
    await writeFile(file, Buffer.alloc(8_192, 7))
    const witness = new WorkspaceWitness({ root, maxHashBytes: 64 })
    const [snapshot] = await witness.capture(['large.bin'])
    assert.equal(snapshot?.hashTruncated, true)
    assert.equal(snapshot?.sizeBytes, 8_192)
    assert.equal(typeof snapshot?.hash, 'string')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

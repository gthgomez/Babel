import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { acquireEffectDirectoryAnchors } from './effectDirectoryAnchors.js'

test('Windows directory anchors block ancestor replacement until released', {
  skip: process.platform !== 'win32',
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'babel-directory-anchor-'))
  const parent = join(root, 'parent')
  const moved = join(root, 'moved')
  await mkdir(parent)
  let anchors: Awaited<ReturnType<typeof acquireEffectDirectoryAnchors>> | undefined
  try {
    anchors = await acquireEffectDirectoryAnchors([parent])
    assert.equal(anchors.path(join(parent, 'file')), join(parent, 'file'))
    await assert.rejects(rename(parent, moved), (error: NodeJS.ErrnoException) =>
      ['EPERM', 'EACCES', 'EBUSY'].includes(error.code ?? ''))
    await anchors.release()
    anchors = undefined
    await rename(parent, moved)
  } finally {
    await anchors?.release()
    await rm(root, { recursive: true, force: true })
  }
})

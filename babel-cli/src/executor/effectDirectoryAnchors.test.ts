import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { acquireEffectDirectoryAnchors } from './effectDirectoryAnchors.js'

test('directory anchors retain the original parent across replacement attempts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'babel-directory-anchor-'))
  const parent = join(root, 'parent')
  const moved = join(root, 'moved')
  await mkdir(parent)
  const target = join(parent, 'file')
  if (process.platform !== 'win32') await writeFile(target, 'original')
  let anchors: Awaited<ReturnType<typeof acquireEffectDirectoryAnchors>> | undefined
  try {
    anchors = await acquireEffectDirectoryAnchors([parent])
    if (process.platform === 'win32') {
      assert.equal(anchors.path(target), target)
      // Keep the directory empty: attribute-only handles can block a nonempty
      // directory incidentally while permitting replacement of an empty one.
      await assert.rejects(rename(parent, moved), (error: NodeJS.ErrnoException) =>
        ['EPERM', 'EACCES', 'EBUSY'].includes(error.code ?? ''))
    } else {
      await rename(parent, moved)
      await mkdir(parent)
      await writeFile(target, 'replacement')
      assert.equal(await readFile(anchors.path(target), 'utf8'), 'original')
      assert.equal(await readFile(target, 'utf8'), 'replacement')
    }
    await anchors.release()
    anchors = undefined
    if (process.platform === 'win32') await rename(parent, moved)
  } finally {
    await anchors?.release()
    await rm(root, { recursive: true, force: true })
  }
})

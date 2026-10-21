import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { isPathWithinQuarantineRootWin32 } from './quarantinePath.js'

test('win32: cross-drive paths are not within quarantine root', () => {
  const root = path.win32.resolve('D:\\fixtures\\dev-corpus')
  const outside = path.win32.resolve('E:\\outside\\secret.txt')
  assert.equal(isPathWithinQuarantineRootWin32(root, outside), false)
})

test('win32: relative path that resolves to absolute drive path is not within root', () => {
  const root = path.win32.resolve('D:\\fixtures')
  const relAsAbsolute = 'E:\\outside\\x.txt'
  assert.equal(path.win32.isAbsolute(relAsAbsolute), true)
  assert.equal(isPathWithinQuarantineRootWin32(root, path.win32.resolve(relAsAbsolute)), false)
})

test('win32: nested path under same drive is within root', () => {
  const root = path.win32.resolve('D:\\fixtures')
  const inner = path.win32.resolve('D:\\fixtures\\G-DEV-01\\mission.json')
  assert.equal(isPathWithinQuarantineRootWin32(root, inner), true)
})

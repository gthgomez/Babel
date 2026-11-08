import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { checkedFileBytes } from './checkedFileRead.js'

test('exact file identity is captured before an imprecise numeric-stat replacement', t => {
  const root = fs.mkdtempSync(join(tmpdir(), 'babel-checked-identity-'))
  try {
    const source = join(root, 'source.txt'); const replacement = join(root, 'replacement.txt')
    fs.writeFileSync(source, 'safe'); fs.writeFileSync(replacement, 'SYNTHETIC_REPLACED_CONTENT')
    const replacementStat = fs.lstatSync(replacement); const original = fs.lstatSync; let swapped = false
    t.mock.method(fs, 'lstatSync', ((path: fs.PathLike, options?: any) => {
      if (!swapped && String(path) === source && !options?.bigint) {
        swapped = true; fs.renameSync(source, join(root, 'original')); fs.renameSync(replacement, source)
        // Fault injection models numeric identity/metadata aliasing across a replacement.
        return replacementStat
      }
      return original(path, options)
    }) as typeof fs.lstatSync)
    syncBuiltinESMExports()
    const bytes = checkedFileBytes(source, 1024, () => true)
    assert.equal(swapped, true); assert.equal(bytes, null)
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); fs.rmSync(root, { recursive: true, force: true }) }
})

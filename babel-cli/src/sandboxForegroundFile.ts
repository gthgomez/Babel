import { createHash } from 'node:crypto'
import { lstatSync, mkdtempSync, realpathSync, rmdirSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, relative } from 'node:path'
import { checkedFileBytes } from './utils/checkedFileRead.js'

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024

/** Bind a published filename to its physical file without exposing identity metadata. */
export function foregroundFileIdentity(device: string | bigint, inode: string | bigint): string {
  return createHash('sha256').update(`${device}:${inode}`).digest('hex')
}

/** A private destination for one native child, preserving the requested filename. */
export function stageForegroundFile(destination: string): {
  path: string
  read: () => Buffer | null | undefined
  remove: () => boolean
} {
  const directory = mkdtempSync(join(realpathSync.native(tmpdir()), 'babel-output-'))
  const identity = lstatSync(directory, { bigint: true })
  const path = join(directory, basename(destination))
  let removed = false
  const stillOwned = (): boolean => {
    const current = lstatSync(directory, { bigint: true })
    return current.isDirectory() && current.dev === identity.dev && current.ino === identity.ino &&
      relative(directory, realpathSync.native(directory)) === ''
  }
  return {
    path,
    read: () => {
      try {
        if (!stillOwned()) return null
        const stat = lstatSync(path, { throwIfNoEntry: false })
        if (!stat) return undefined
        return checkedFileBytes(path, MAX_OUTPUT_BYTES, () =>
          stillOwned() && relative(path, realpathSync.native(path)) === '', stat)
      } catch { return null }
    },
    remove: () => {
      if (removed) return true
      try {
        if (!stillOwned()) return false
        try { unlinkSync(path) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false }
        rmdirSync(directory)
        removed = true
        return true
      } catch { return false }
    },
  }
}

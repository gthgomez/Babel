import { lstatSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { checkedFileBytes } from '../utils/checkedFileRead.js'

/** Read a regular journal under the same run directory and parent throughout the read. */
export function readCheckedJournalText(runDir: string, filename: string): string | null {
  const directory = resolve(runDir)
  const parent = dirname(directory)
  const parentIdentity = lstatSync(parent, { bigint: true, throwIfNoEntry: false })
  if (!parentIdentity) return null
  if (!parentIdentity.isDirectory()) throw new Error('Journal parent is not a regular directory.')
  const runIdentity = lstatSync(directory, { bigint: true, throwIfNoEntry: false })
  if (!runIdentity) return null
  if (!runIdentity.isDirectory()) throw new Error('Journal run path is not a regular directory.')

  const sameDirectories = (): boolean => {
    const currentParent = lstatSync(parent, { bigint: true, throwIfNoEntry: false })
    if (!currentParent?.isDirectory() || currentParent.dev !== parentIdentity.dev || currentParent.ino !== parentIdentity.ino) return false
    const currentRun = lstatSync(directory, { bigint: true, throwIfNoEntry: false })
    return currentRun?.isDirectory() === true && currentRun.dev === runIdentity.dev && currentRun.ino === runIdentity.ino
  }
  const path = join(directory, filename)
  const entry = lstatSync(path, { throwIfNoEntry: false })
  if (!sameDirectories()) throw new Error('Journal directories changed during inspection.')
  if (!entry) return null
  // Node does not expose a portable directory-relative open. Recheck both
  // directory identities before and after reading from the checked file handle.
  const bytes = checkedFileBytes(path, Number.MAX_SAFE_INTEGER, sameDirectories, entry)
  if (!bytes || !sameDirectories()) throw new Error('Journal is not a stable regular file.')
  return bytes.toString('utf8')
}

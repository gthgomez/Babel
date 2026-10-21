import { open, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { DurableStoreBusyError } from './durableStoreErrors.js'

export const RESEARCH_STORE_EXCLUSIVE_LOCK_FILE = '.research-store.exclusive.lock'

/**
 * One live {@link DurableResearchStore} per directory (cross-handle / cross-process).
 * Caller must invoke the returned release when the store is closed.
 */
export async function acquireExclusiveStoreLock(
  storeDirectory: string,
): Promise<() => Promise<void>> {
  const lockPath = join(storeDirectory, RESEARCH_STORE_EXCLUSIVE_LOCK_FILE)
  try {
    const handle = await open(lockPath, 'wx')
    await handle.writeFile(`${process.pid}\n`, 'utf8')
    return async () => {
      await handle.close()
      await unlink(lockPath).catch(() => undefined)
    }
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code
    if (code === 'EEXIST') {
      throw new DurableStoreBusyError()
    }
    throw err
  }
}

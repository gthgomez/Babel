import { open, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { DurableStoreBusyError } from './durableStoreErrors.js'

export const RESEARCH_STORE_EXCLUSIVE_LOCK_FILE = '.research-store.exclusive.lock'

export const ExclusiveStoreLockPayloadSchema = z
  .object({
    schema_version: z.literal(1),
    session_id: z.string().min(1),
    pid: z.number().int().positive(),
  })
  .strict()

export type ExclusiveStoreLockPayload = z.infer<typeof ExclusiveStoreLockPayloadSchema>

export async function readExclusiveStoreLockPayload(
  storeDirectory: string,
): Promise<ExclusiveStoreLockPayload | null> {
  const lockPath = join(storeDirectory, RESEARCH_STORE_EXCLUSIVE_LOCK_FILE)
  try {
    const raw = await readFile(lockPath, 'utf8')
    return ExclusiveStoreLockPayloadSchema.parse(JSON.parse(raw.trim()))
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code
    if (code === 'ENOENT') return null
    throw err
  }
}

export interface ExclusiveStoreOwnerBinding {
  session_id: string
  pid: number
}

/**
 * One live {@link DurableResearchStore} per directory (cross-handle / cross-process).
 * Lock payload binds authoritative session_id + pid. Caller must invoke release on close.
 */
export async function acquireExclusiveStoreLock(
  storeDirectory: string,
  owner: ExclusiveStoreOwnerBinding,
): Promise<() => Promise<void>> {
  const lockPath = join(storeDirectory, RESEARCH_STORE_EXCLUSIVE_LOCK_FILE)
  const payload: ExclusiveStoreLockPayload = {
    schema_version: 1,
    session_id: owner.session_id,
    pid: owner.pid,
  }
  try {
    const handle = await open(lockPath, 'wx')
    await handle.writeFile(`${JSON.stringify(payload)}\n`, 'utf8')
    return async () => {
      await handle.close()
      const current = await readExclusiveStoreLockPayload(storeDirectory)
      if (
        current?.session_id === owner.session_id &&
        current.pid === owner.pid
      ) {
        await unlink(lockPath).catch(() => undefined)
      }
    }
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code
    if (code === 'EEXIST') {
      throw new DurableStoreBusyError()
    }
    throw err
  }
}

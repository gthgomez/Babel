import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'

export const RESEARCH_STORE_CANCEL_REQUEST_FILE = 'research-store.cancel-request.json'

export const StoreCancelRequestSchema = z
  .object({
    schema_version: z.literal(1),
    target_session_id: z.string().min(1),
    request_id: z.string().min(1),
    requested_at: z.string().min(1),
  })
  .strict()

export type StoreCancelRequest = z.infer<typeof StoreCancelRequestSchema>

/**
 * Second process / inspect CLI: bounded cancel signal for the admitted owner session.
 */
export async function submitAdmittedOwnerCancelRequest(
  storeDirectory: string,
  targetSessionId: string,
): Promise<StoreCancelRequest> {
  const record: StoreCancelRequest = {
    schema_version: 1,
    target_session_id: targetSessionId,
    request_id: randomUUID(),
    requested_at: new Date().toISOString(),
  }
  const path = join(storeDirectory, RESEARCH_STORE_CANCEL_REQUEST_FILE)
  const tmp = `${path}.tmp`
  await writeFile(tmp, `${JSON.stringify(record)}\n`, 'utf8')
  await rename(tmp, path)
  return record
}

export async function readAdmittedOwnerCancelRequest(
  storeDirectory: string,
): Promise<StoreCancelRequest | null> {
  const path = join(storeDirectory, RESEARCH_STORE_CANCEL_REQUEST_FILE)
  try {
    const raw = await readFile(path, 'utf8')
    return StoreCancelRequestSchema.parse(JSON.parse(raw))
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code
    if (code === 'ENOENT') return null
    throw err
  }
}

export async function clearAdmittedOwnerCancelRequest(storeDirectory: string): Promise<void> {
  await unlink(join(storeDirectory, RESEARCH_STORE_CANCEL_REQUEST_FILE)).catch(() => undefined)
}

/**
 * Owner process polls cancel-request file and aborts when it targets this session.
 */
export function watchAdmittedOwnerCancelRequest(
  storeDirectory: string,
  ownerSessionId: string,
  abortController: AbortController,
  options?: { pollMs?: number },
): { stop(): void } {
  const pollMs = options?.pollMs ?? 25
  let stopped = false
  const tick = async (): Promise<void> => {
    if (stopped || abortController.signal.aborted) return
    try {
      const request = await readAdmittedOwnerCancelRequest(storeDirectory)
      if (request?.target_session_id === ownerSessionId) {
        await clearAdmittedOwnerCancelRequest(storeDirectory)
        abortController.abort()
        return
      }
    } catch {
      // fail closed on read errors only for owner cancel path — next poll retries
    }
    if (!stopped && !abortController.signal.aborted) {
      setTimeout(() => {
        void tick()
      }, pollMs)
    }
  }
  void tick()
  return {
    stop() {
      stopped = true
    },
  }
}

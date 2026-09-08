import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface AtomicCheckpointRenameOptions {
  platform?: NodeJS.Platform
  rename?: typeof renameSync
  wait?: (milliseconds: number) => void
}

const retryDelays = [20, 40, 80, 160, 320] as const
const waitBuffer = new Int32Array(new SharedArrayBuffer(4))

/** Replace a staged sibling without deleting the old primary, with bounded Windows sharing retries. */
export function renameCheckpointSync(source: string, destination: string, options: AtomicCheckpointRenameOptions = {}): void {
  const rename = options.rename ?? renameSync
  for (let attempt = 0; ; attempt++) {
    try { rename(source, destination); return } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code
      if ((options.platform ?? process.platform) !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') || attempt >= retryDelays.length) throw error
      const delay = retryDelays[attempt]!
      if (options.wait) options.wait(delay)
      else Atomics.wait(waitBuffer, 0, 0, delay)
    }
  }
}

/** Synchronous staging avoids overlapping open handles from fire-and-forget checkpoints. */
export function writeCheckpointFileSync(destination: string, contents: string): void {
  mkdirSync(dirname(destination), { recursive: true })
  const staged = `${destination}.${randomUUID()}.tmp`
  const fd = openSync(staged, 'wx', 0o600)
  try { writeFileSync(fd, contents, 'utf8'); fsyncSync(fd) } finally { closeSync(fd) }
  // A failed replacement retains the previous primary and staged diagnostic bytes.
  renameCheckpointSync(staged, destination)
}

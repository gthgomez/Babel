import { createHash } from 'node:crypto'
import { existsSync, lstatSync, opendirSync, realpathSync, statSync, type BigIntStats, type Dir } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { acquireEffectDirectoryAnchors } from '../executor/effectDirectoryAnchors.js'
import { protectedDiscoveryPath } from '../pipeline/prePlanningDiscovery.js'
import type { ProjectSafetySnapshot } from '../services/terminalStatus.js'
import { scopedHandoffPath } from '../agent/planHandoff.js'
import { checkedFileBytes } from '../utils/checkedFileRead.js'

const MAX_FILES = 2000
const MAX_ENTRIES = MAX_FILES * 2
const MAX_HASH_BYTES = 16 * 1024 * 1024
const IGNORED = ['.git', 'node_modules', 'dist', 'build', 'coverage', '.next', 'runs']

/** Capture only physically scoped regular files; incomplete observations stay explicit. */
export async function guardedSafetySnapshot(projectRoot: string | null | undefined, signal?: AbortSignal): Promise<ProjectSafetySnapshot> {
  const root = projectRoot ? resolve(projectRoot) : null
  const result: ProjectSafetySnapshot = { root, files: {}, file_count: 0, truncated: false, ignored_directories: IGNORED }
  if (!root || !existsSync(root)) { result.truncated = true; return result }
  signal?.throwIfAborted()
  let physicalRoot: string
  try { physicalRoot = realpathSync(root) } catch { result.truncated = true; return result }
  let pending: Array<{ path: string; expected: BigIntStats }>
  try { pending = [{ path: physicalRoot, expected: lstatSync(physicalRoot, { bigint: true }) }] }
  catch { result.truncated = true; return result }
  const identity = pending[0]!.expected
  if (identity.ino > 0n) result.root_identity = createHash('sha256').update(`babel-snapshot-root-v1\0${identity.dev}\0${identity.ino}`).digest('hex')
  else result.truncated = true
  let directoryCount = 1
  let entryCount = 0
  try { while (pending.length && result.file_count < MAX_FILES && entryCount < MAX_ENTRIES) {
    const current = pending; pending = []
    let anchors: Awaited<ReturnType<typeof acquireEffectDirectoryAnchors>>
    try { anchors = await acquireEffectDirectoryAnchors(current.map(item => item.path)) }
    catch { signal?.throwIfAborted(); result.truncated = true; break }
    try {
      signal?.throwIfAborted()
      for (const item of current) {
        if (result.file_count >= MAX_FILES) { result.truncated = true; break }
        const pinned = dirname(anchors.path(join(item.path, '__babel_snapshot_anchor__')))
        const observed = statSync(pinned, { bigint: true })
        if (!observed.isDirectory() || observed.dev !== item.expected.dev || observed.ino !== item.expected.ino) { result.truncated = true; continue }
        let directory: Dir
        try { directory = opendirSync(pinned) } catch { result.truncated = true; continue }
        try { for (let dirent = directory.readSync(); dirent; dirent = directory.readSync()) {
          if (result.file_count >= MAX_FILES || entryCount >= MAX_ENTRIES) { result.truncated = true; break }
          entryCount++
          const entry = dirent.name
          if (IGNORED.includes(entry)) continue
          const logical = join(item.path, entry); const rel = relative(physicalRoot, logical).replace(/\\/g, '/')
          if (protectedDiscoveryPath(rel)) { result.truncated = true; continue }
          let stat: BigIntStats
          try { stat = lstatSync(join(pinned, entry), { bigint: true }) } catch { result.truncated = true; continue }
          if (stat.isSymbolicLink()) { result.truncated = true; continue }
          if (stat.isDirectory()) {
            if (directoryCount >= MAX_FILES) result.truncated = true
            else { directoryCount++; pending.push({ path: logical, expected: stat }) }
            continue
          }
          if (!stat.isFile()) { result.truncated = true; continue }
          const physical = scopedHandoffPath(physicalRoot, rel)
          if (!physical) { result.truncated = true; continue }
          const bytes = checkedFileBytes(join(pinned, entry), MAX_HASH_BYTES, () => scopedHandoffPath(physicalRoot, rel) === physical, undefined, stat)
          if (!bytes) { result.truncated = true; continue }
          result.files[rel] = createHash('sha256').update(bytes).digest('hex'); result.file_count++
        } } finally { directory.closeSync() }
        await new Promise<void>(resolveYield => setImmediate(resolveYield))
        signal?.throwIfAborted()
        anchors.path(join(item.path, '__babel_snapshot_anchor__'))
      }
      signal?.throwIfAborted()
    } finally { await anchors.release() }
    signal?.throwIfAborted()
  } } catch { signal?.throwIfAborted(); result.files = {}; result.file_count = 0; result.truncated = true }
  if (pending.length || entryCount >= MAX_ENTRIES) result.truncated = true
  return result
}

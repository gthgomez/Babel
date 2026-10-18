import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { isCredentialTargetPath } from './autonomyEnforcement.js'
import { WorkspaceTransactionManager, type MutationBatchTransaction } from '../services/workspaceTransactions.js'

export interface TaskWorkspaceChangeClassification {
  taskOwnedPaths: string[]
  unexpectedPaths: string[]
  unverifiablePaths: string[]
}

/** Task-local post-images are evidence of ownership, never authority to write. */
export class TaskMutationOwnership {
  private readonly postImages = new Map<string, string>()
  private active = true
  readonly root: string

  constructor(root: string, readonly ownerId: string, private readonly parent?: TaskMutationOwnership) {
    this.root = realpathSync(root)
  }

  get isCurrent(): boolean {
    return this.active && (!this.parent || this.parent.isCurrent)
  }

  matchesRoot(root: string): boolean {
    try { return this.isCurrent && relative(this.root, realpathSync(root)) === '' } catch { return false }
  }

  retire(): void {
    this.active = false
    this.postImages.clear()
  }

  /** Called only after the governed executor confirms a committed mutation. */
  recordCommitted(tx: MutationBatchTransaction): void {
    if (!this.isCurrent || tx.status !== 'committed' || tx.verified === false) return
    for (const [path, digest] of Object.entries(tx.postBatchHash)) {
      const admitted = this.admitPath(path)
      if (admitted && this.currentDigest(admitted) === digest) this.postImages.set(this.key(admitted), digest)
    }
  }

  snapshot(paths: readonly string[]): ReadonlyMap<string, string> {
    return new Map(paths.flatMap(path => {
      const key = this.key(path)
      const digest = this.postImages.get(key)
      return digest === undefined ? [] : [[key, digest] as const]
    }))
  }

  /** A failed multi-file helper may restore earlier writes outside the executor. */
  restore(snapshot: ReadonlyMap<string, string>, paths: readonly string[]): void {
    if (!this.isCurrent) return
    for (const path of paths) {
      const key = this.key(path)
      const digest = snapshot.get(key)
      if (digest === undefined) this.postImages.delete(key)
      else this.postImages.set(key, digest)
    }
  }

  classifyChanges(): TaskWorkspaceChangeClassification {
    const result: TaskWorkspaceChangeClassification = {
      taskOwnedPaths: [], unexpectedPaths: [], unverifiablePaths: [],
    }
    if (!this.isCurrent) return { ...result, unverifiablePaths: ['<retired-owner>'] }
    const git = (args: string[]) => spawnSync('git', args, {
      cwd: this.root, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024,
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    const rootResult = git(['rev-parse', '--show-toplevel'])
    const status = git(['status', '--porcelain=v1', '-z', '--untracked-files=all'])
    if (rootResult.status !== 0 || status.status !== 0 || status.error || rootResult.error) {
      return { ...result, unverifiablePaths: ['<git-status>'] }
    }
    const gitRoot = rootResult.stdout.trim()
    const records = status.stdout.split('\0')
    if (records.pop() !== '') return { ...result, unverifiablePaths: ['<truncated-status>'] }
    for (let index = 0; index < records.length; index++) {
      const record = records[index]!
      if (record.length < 4 || record[2] !== ' ') {
        result.unverifiablePaths.push('<invalid-status>')
        continue
      }
      const path = resolve(gitRoot, record.slice(3))
      // Agent file edits do not stage, rename, or change index identities.
      if (/[RC]/.test(record.slice(0, 2))) index++
      if (record[0] !== ' ' && record.slice(0, 2) !== '??') {
        result.unexpectedPaths.push(path)
        continue
      }
      if (!this.postImages.has(this.key(path))) {
        result.unexpectedPaths.push(path)
        continue
      }
      const admitted = this.admitPath(path)
      const digest = admitted ? this.currentDigest(admitted) : null
      if (digest === null) result.unverifiablePaths.push(path)
      else if (digest === this.postImages.get(this.key(path))) result.taskOwnedPaths.push(path)
      else result.unexpectedPaths.push(path)
    }
    return result
  }

  private key(path: string): string {
    const absolute = resolve(path)
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute
  }

  private admitPath(path: string): string | null {
    const absolute = resolve(path)
    const rel = relative(this.root, absolute)
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
      || isCredentialTargetPath(absolute)) return null
    try {
      for (let cursor = absolute; relative(this.root, cursor) !== ''; cursor = dirname(cursor)) {
        try { if (lstatSync(cursor).isSymbolicLink()) return null }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null }
      }
      return absolute
    } catch { return null }
  }

  private currentDigest(path: string): string | null {
    let descriptor: number | undefined
    try {
      const before = lstatSync(path)
      if (!before.isFile() || before.nlink !== 1) return null
      descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      const opened = fstatSync(descriptor)
      // Compare physical identity before reading: a link swap must not cause
      // this ownership check to open and hash an unrelated credential target.
      if (!opened.isFile() || opened.nlink !== 1 || before.dev !== opened.dev
        || before.ino !== opened.ino || before.size !== opened.size
        || before.mtimeMs !== opened.mtimeMs || before.ctimeMs !== opened.ctimeMs) return null
      const content = readFileSync(descriptor)
      const after = fstatSync(descriptor)
      if (opened.size !== after.size || opened.mtimeMs !== after.mtimeMs
        || opened.ctimeMs !== after.ctimeMs || after.nlink !== 1) return null
      return createHash('sha256').update(content).digest('hex')
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? WorkspaceTransactionManager.missingPathDigest() : null
    } finally {
      if (descriptor !== undefined) closeSync(descriptor)
    }
  }
}

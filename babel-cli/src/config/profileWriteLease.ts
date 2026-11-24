import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdtempSync, openSync, readlinkSync, readSync, readdirSync, renameSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync, type BigIntStats } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** A busy or unidentifiable lock must never be removed on the caller's behalf. */
export class ProfileWriteLeaseError extends Error {
  readonly code: 'EEXIST' | 'BABEL_PROFILE_LOCK_UNAVAILABLE'
  constructor(readonly reason: 'busy' | 'unavailable') {
    super(reason === 'busy' ? 'Profile is locked by another writer.' : 'Profile ownership record is unavailable; preserve it and inspect the profile.')
    this.code = reason === 'busy' ? 'EEXIST' : 'BABEL_PROFILE_LOCK_UNAVAILABLE'
  }
}

type FileIdentity = Pick<BigIntStats, 'dev' | 'ino'>
const ownerText = (token: string): string => `babel-profile-lock-v1:${token}\n`
const ownerName = (token: string): string => `owner-${token}`
const linkTarget = (marker: string, token: string): string => `${basename(marker)}.${token}.owner`
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT'
const sameFile = (a: FileIdentity, b: FileIdentity): boolean => a.dev === b.dev && a.ino === b.ino
function lstatIfPresent(path: string): BigIntStats | undefined {
  try { return lstatSync(path, { bigint: true }) } catch (error) {
    if (!missing(error)) throw error
    return undefined
  }
}

function matchingOwnerFile(path: string, token: string): FileIdentity | undefined {
  try {
    const expected = lstatSync(path, { bigint: true })
    const bytesExpected = Buffer.from(ownerText(token), 'utf8')
    if (!expected.isFile() || expected.isSymbolicLink() || expected.nlink < 1n || expected.nlink > 2n ||
        expected.size !== BigInt(bytesExpected.length)) return undefined
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    try {
      const actual = fstatSync(fd, { bigint: true })
      const uid = process.getuid?.()
      if (!actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino || actual.nlink < 1n || actual.nlink > 2n ||
          actual.size !== expected.size || (uid !== undefined && (actual.uid !== BigInt(uid) || (actual.mode & 0o077n) !== 0n))) return undefined
      const bytes = Buffer.alloc(bytesExpected.length + 1)
      let offset = 0
      while (offset < bytes.length) {
        const count = readSync(fd, bytes, offset, bytes.length - offset, null)
        if (!count) break
        offset += count
      }
      return offset === bytesExpected.length && bytes.subarray(0, offset).equals(bytesExpected)
        ? { dev: actual.dev, ino: actual.ino } : undefined
    } finally { closeSync(fd) }
  } catch { return undefined }
}

function removeMatchingOwnerFile(path: string, identity: FileIdentity): void {
  let current: BigIntStats
  try { current = lstatSync(path, { bigint: true }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (!current.isFile() || current.isSymbolicLink() || current.nlink < 1n || current.nlink > 2n ||
      current.dev !== identity.dev || current.ino !== identity.ino) throw new ProfileWriteLeaseError('unavailable')
  unlinkSync(path)
}

function ownedMarkerDirectory(path: string, token: string): FileIdentity {
  const directory = lstatSync(path, { bigint: true })
  const uid = process.getuid?.()
  if (!directory.isDirectory() || directory.isSymbolicLink() ||
      (uid !== undefined && (directory.uid !== BigInt(uid) || (directory.mode & 0o077n) !== 0n))) {
    throw new ProfileWriteLeaseError('unavailable')
  }
  const name = ownerName(token)
  const entries = readdirSync(path)
  if (entries.length !== 1 || entries[0] !== name) throw new ProfileWriteLeaseError('unavailable')
  const owner = lstatSync(join(path, name), { bigint: true })
  if (!owner.isFile() || owner.isSymbolicLink() || owner.nlink !== 1n || owner.size !== 0n ||
      (uid !== undefined && (owner.uid !== BigInt(uid) || (owner.mode & 0o077n) !== 0n)) ||
      !sameFile(directory, lstatSync(path, { bigint: true }))) throw new ProfileWriteLeaseError('unavailable')
  return directory
}

function retireMarkerDirectory(marker: string, token: string, expected?: FileIdentity): void {
  const identity = ownedMarkerDirectory(marker, token)
  if (expected && !sameFile(identity, expected)) throw new ProfileWriteLeaseError('unavailable')
  const stage = mkdtempSync(`${marker}.retired-`)
  const retired = join(stage, 'marker')
  // Detach the complete marker before removing any part of it. A crash during
  // cleanup cannot leave an empty directory at the legacy exclusion name.
  renameSync(marker, retired)
  if (!sameFile(ownedMarkerDirectory(retired, token), identity)) throw new ProfileWriteLeaseError('unavailable')
  unlinkSync(join(retired, ownerName(token)))
  rmdirSync(retired)
  rmdirSync(stage)
}

function removeMarkerLink(marker: string, token: string, expected?: FileIdentity): void {
  const before = lstatSync(marker, { bigint: true })
  if (process.platform === 'win32' || !before.isSymbolicLink() ||
      (expected && !sameFile(before, expected)) || readlinkSync(marker) !== linkTarget(marker, token)) {
    throw new ProfileWriteLeaseError('unavailable')
  }
  const after = lstatSync(marker, { bigint: true })
  if (!after.isSymbolicLink() || !sameFile(before, after)) throw new ProfileWriteLeaseError('unavailable')
  unlinkSync(marker)
}

/**
 * Hold an OS-backed SQLite write lock while retaining the legacy exclusive
 * marker name. Old binaries still conflict on the marker. The normal marker
 * is published atomically from a complete owner file and bound to the guard.
 * Without hard links, publish a no-follow symlink on POSIX or a complete
 * directory using Windows directory-rename semantics. Fail closed if the
 * filesystem provides neither primitive. This is process-crash recovery.
 */
export function acquireProfileWriteLease(target: string): () => void {
  const marker = `${target}.babel-lock`
  const guard = `${marker}.sqlite`
  const parentPath = dirname(marker)
  const parent = lstatSync(parentPath, { bigint: true })
  const uid = process.getuid?.()
  if (!parent.isDirectory() || parent.isSymbolicLink() ||
      (uid !== undefined && (parent.uid !== BigInt(uid) || (parent.mode & 0o022n) !== 0n))) {
    throw new ProfileWriteLeaseError('unavailable')
  }
  // Do not initialize a new protocol over an existing, unidentified marker.
  // In particular, an older live writer owns a regular file at this path.
  try {
    lstatSync(guard)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    try { lstatSync(marker); throw new ProfileWriteLeaseError('busy') } catch (markerError) {
      if ((markerError as NodeJS.ErrnoException).code !== 'ENOENT') throw markerError
    }
  }
  try {
    const fd = openSync(guard, 'wx', 0o600)
    closeSync(fd)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const info = lstatSync(guard, { bigint: true })
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || info.size > 1024n * 1024n ||
      (uid !== undefined && (info.uid !== BigInt(uid) || (info.mode & 0o077n) !== 0n))) {
    throw new ProfileWriteLeaseError('unavailable')
  }
  let db: DatabaseSync | undefined
  let transaction = false
  let markerIdentity: FileIdentity | undefined
  let markerKind: 'file' | 'directory' | 'symlink' | undefined
  let tokenTemporary: string | undefined
  let tokenIdentity: FileIdentity | undefined
  let ownedToken = ''
  const assertGuardIdentity = (): void => {
    const directory = lstatSync(parentPath, { bigint: true })
    const current = lstatSync(guard, { bigint: true })
    if (!directory.isDirectory() || directory.isSymbolicLink() || !sameFile(parent, directory) ||
        !current.isFile() || current.isSymbolicLink() || current.nlink !== 1n || !sameFile(info, current)) {
      throw new ProfileWriteLeaseError('unavailable')
    }
  }
  try {
    assertGuardIdentity()
    // This guard uses SQLite's rollback journal only. Before SQLite opens
    // adjacent files, reject unexpected WAL sidecars or a non-private journal.
    const journal = lstatIfPresent(`${guard}-journal`)
    if (lstatIfPresent(`${guard}-shm`) || lstatIfPresent(`${guard}-wal`) ||
        (journal && (!journal.isFile() || journal.isSymbolicLink() || journal.nlink !== 1n ||
          (uid !== undefined && (journal.uid !== BigInt(uid) || (journal.mode & 0o077n) !== 0n))))) {
      throw new ProfileWriteLeaseError('unavailable')
    }
    db = new DatabaseSync(guard)
    db.exec('PRAGMA busy_timeout=0')
    db.exec('PRAGMA trusted_schema=OFF')
    db.exec('BEGIN IMMEDIATE')
    transaction = true
    assertGuardIdentity()
    const objects = db.prepare('SELECT name, type FROM sqlite_schema').all()
    if (objects.length === 0) {
      // A killed initializer may leave an empty guard. Only an otherwise empty
      // database with no legacy marker can be initialized under the OS lock.
      try { lstatSync(marker); throw new ProfileWriteLeaseError('busy') } catch (markerError) {
        if (!missing(markerError)) throw markerError
      }
      db.exec("CREATE TABLE babel_profile_writer_guard (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, token TEXT NOT NULL); INSERT INTO babel_profile_writer_guard VALUES (1, 1, '')")
    } else if (objects.length !== 1 || objects[0]?.['name'] !== 'babel_profile_writer_guard' || objects[0]?.['type'] !== 'table') {
      throw new ProfileWriteLeaseError('unavailable')
    }
    const row = db.prepare('SELECT version, token FROM babel_profile_writer_guard WHERE id = 1').get()
    if (!row || row['version'] !== 1 || typeof row['token'] !== 'string' || !/^(?:|[a-f0-9]{32})$/.test(row['token'])) {
      throw new ProfileWriteLeaseError('unavailable')
    }
    const existing = lstatIfPresent(marker)
    if (existing) {
      // Legacy files and unrecognized directories must remain untouched.
      // Remove only an owner marker bound to this guard.
      if (!row['token']) throw new ProfileWriteLeaseError('busy')
      if (existing.isSymbolicLink()) {
        removeMarkerLink(marker, row['token'])
      } else if (existing.isFile()) {
        const previous = matchingOwnerFile(marker, row['token'])
        if (!previous) throw new ProfileWriteLeaseError('busy')
        removeMatchingOwnerFile(marker, previous)
        // A crash immediately after link can leave this second name behind.
        try { removeMatchingOwnerFile(`${marker}.${row['token']}.owner`, previous) } catch { /* Preserve an unrelated file. */ }
      } else {
        if (!existing.isDirectory()) throw new ProfileWriteLeaseError('busy')
        retireMarkerDirectory(marker, row['token'])
      }
    }
    if (row['token']) {
      const previousTemporary = `${marker}.${row['token']}.owner`
      const previousIdentity = matchingOwnerFile(previousTemporary, row['token'])
      if (previousIdentity) removeMatchingOwnerFile(previousTemporary, previousIdentity)
    }
    const token = randomBytes(16).toString('hex')
    db.prepare('UPDATE babel_profile_writer_guard SET token = ? WHERE id = 1').run(token)
    db.exec('COMMIT')
    transaction = false
    db.exec('BEGIN IMMEDIATE')
    transaction = true
    assertGuardIdentity()
    const afterCommit = db.prepare('SELECT token FROM babel_profile_writer_guard WHERE id = 1').get()
    if (afterCommit?.['token'] !== token) throw new ProfileWriteLeaseError('busy')
    ownedToken = token
    tokenTemporary = `${marker}.${token}.owner`
    const ownerFd = openSync(tokenTemporary, 'wx', 0o600)
    try {
      const ownerInfo = fstatSync(ownerFd, { bigint: true })
      tokenIdentity = { dev: ownerInfo.dev, ino: ownerInfo.ino }
      writeFileSync(ownerFd, ownerText(token), 'utf8')
      fsyncSync(ownerFd)
    } finally { closeSync(ownerFd) }
    try {
      linkSync(tokenTemporary, marker)
      markerKind = 'file'
      markerIdentity = tokenIdentity
      try { removeMatchingOwnerFile(tokenTemporary, tokenIdentity) } catch { /* Preserve an unrecognized file. */ }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ProfileWriteLeaseError('busy')
      if (!['ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      removeMatchingOwnerFile(tokenTemporary, tokenIdentity)
      tokenTemporary = undefined
      tokenIdentity = undefined
      if (process.platform === 'win32') {
        const staged = mkdtempSync(`${marker}.stage-`)
        closeSync(openSync(join(staged, ownerName(token)), 'wx', 0o600))
        markerIdentity = ownedMarkerDirectory(staged, token)
        // Windows cannot replace an existing file or directory with a directory
        // rename. Do not use this fallback on POSIX, where an empty unrelated
        // directory at the destination could be replaced.
        try { renameSync(staged, marker) } catch (failure) {
          try {
            if (sameFile(ownedMarkerDirectory(staged, token), markerIdentity)) {
              unlinkSync(join(staged, ownerName(token)))
              rmdirSync(staged)
            }
          } catch { /* Preserve an unrecognized staged entry. */ }
          if (!missing(failure) && lstatIfPresent(marker)) throw new ProfileWriteLeaseError('busy')
          throw failure
        }
        markerKind = 'directory'
      } else {
        try { symlinkSync(linkTarget(marker, token), marker) } catch (failure) {
          if ((failure as NodeJS.ErrnoException).code === 'EEXIST') throw new ProfileWriteLeaseError('busy')
          throw failure
        }
        markerIdentity = lstatSync(marker, { bigint: true })
        markerKind = 'symlink'
      }
    }
  } catch (error) {
    if (tokenTemporary && tokenIdentity) { try { removeMatchingOwnerFile(tokenTemporary, tokenIdentity) } catch { /* Preserve an unrelated file. */ } }
    if (transaction) { try { db?.exec('ROLLBACK') } catch { /* Preserve the failure. */ } }
    try { db?.close() } catch { /* Preserve the failure. */ }
    if (error instanceof ProfileWriteLeaseError) throw error
    if ([5, 6].includes((error as { errcode?: number }).errcode ?? -1)) throw new ProfileWriteLeaseError('busy')
    throw new ProfileWriteLeaseError('unavailable')
  }
  const owned = db
  let released = false
  return () => {
    if (released) return
    released = true
    try {
      assertGuardIdentity()
      if (markerKind === 'file') {
        const current = matchingOwnerFile(marker, ownedToken)
        if (!current || !markerIdentity || current.dev !== markerIdentity.dev || current.ino !== markerIdentity.ino) {
          throw new ProfileWriteLeaseError('unavailable')
        }
        removeMatchingOwnerFile(marker, markerIdentity)
        if (tokenTemporary && tokenIdentity) { try { removeMatchingOwnerFile(tokenTemporary, tokenIdentity) } catch { /* Preserve an unrelated file. */ } }
      } else if (markerKind === 'symlink') {
        removeMarkerLink(marker, ownedToken, markerIdentity)
      } else {
        if (!markerIdentity || markerKind !== 'directory') throw new ProfileWriteLeaseError('unavailable')
        retireMarkerDirectory(marker, ownedToken, markerIdentity)
      }
    } finally {
      try { owned.exec('ROLLBACK') } finally { owned.close() }
    }
  }
}

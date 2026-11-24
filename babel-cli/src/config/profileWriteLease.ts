import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, rmdirSync, rmSync, writeFileSync, type BigIntStats } from 'node:fs'
import { randomBytes } from 'node:crypto'
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
  rmSync(path)
}

/**
 * Hold an OS-backed SQLite write lock while retaining the legacy exclusive
 * marker name. Old binaries still conflict on the marker. The normal marker
 * is published atomically from a complete owner file and bound to the guard;
 * a directory fallback preserves safety where hard links are unsupported.
 */
export function acquireProfileWriteLease(target: string): () => void {
  const marker = `${target}.babel-lock`
  const guard = `${marker}.sqlite`
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
  let created = false
  try {
    const fd = openSync(guard, 'wx', 0o600)
    closeSync(fd)
    created = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const info = lstatSync(guard)
  const uid = process.getuid?.()
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 1024 * 1024 ||
      (uid !== undefined && (info.uid !== uid || (info.mode & 0o077) !== 0))) {
    throw new ProfileWriteLeaseError('unavailable')
  }
  let db: DatabaseSync | undefined
  let transaction = false
  let initialized = false
  let ownerName = ''
  let ownerIdentity: FileIdentity | undefined
  let markerIdentity: FileIdentity | undefined
  let markerKind: 'file' | 'directory' | undefined
  let tokenTemporary: string | undefined
  let tokenIdentity: FileIdentity | undefined
  let ownedToken = ''
  try {
    db = new DatabaseSync(guard)
    db.exec('PRAGMA busy_timeout=0')
    if (created) {
      try { lstatSync(marker); throw new ProfileWriteLeaseError('busy') } catch (markerError) {
        if ((markerError as NodeJS.ErrnoException).code !== 'ENOENT') throw markerError
      }
      db.exec("CREATE TABLE babel_profile_writer_guard (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, token TEXT NOT NULL); INSERT INTO babel_profile_writer_guard VALUES (1, 1, '')")
      initialized = true
    } else {
      const row = db.prepare('SELECT version FROM babel_profile_writer_guard WHERE id = 1').get()
      if (row?.['version'] !== 1) throw new ProfileWriteLeaseError('unavailable')
    }
    db.exec('BEGIN IMMEDIATE')
    transaction = true
    const row = db.prepare('SELECT version, token FROM babel_profile_writer_guard WHERE id = 1').get()
    if (!row || row['version'] !== 1 || typeof row['token'] !== 'string' || !/^(?:|[a-f0-9]{32})$/.test(row['token'])) {
      throw new ProfileWriteLeaseError('unavailable')
    }
    let existing: ReturnType<typeof lstatSync> | undefined
    try { existing = lstatSync(marker) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (existing) {
      // Legacy files and unrecognized directories must remain untouched.
      // Remove only an owner marker bound to this guard.
      if (created || existing.isSymbolicLink() || !row['token']) throw new ProfileWriteLeaseError('busy')
      if (existing.isFile()) {
        const previous = matchingOwnerFile(marker, row['token'])
        if (!previous) throw new ProfileWriteLeaseError('busy')
        removeMatchingOwnerFile(marker, previous)
        // A crash immediately after link can leave this second name behind.
        try { removeMatchingOwnerFile(`${marker}.${row['token']}.owner`, previous) } catch { /* Preserve an unrelated file. */ }
      } else {
        if (!existing.isDirectory()) throw new ProfileWriteLeaseError('busy')
        const priorOwner = `owner-${row['token']}`
        const entries = readdirSync(marker)
        if (!row['token'] || entries.length !== 1 || entries[0] !== priorOwner) throw new ProfileWriteLeaseError('unavailable')
        const priorPath = `${marker}/${priorOwner}`
        const prior = lstatSync(priorPath, { bigint: true })
        const ownerUid = process.getuid?.()
        if (!prior.isFile() || prior.isSymbolicLink() || prior.nlink !== 1n || prior.size !== 0n ||
            (ownerUid !== undefined && (prior.uid !== BigInt(ownerUid) || (prior.mode & 0o077n) !== 0n))) throw new ProfileWriteLeaseError('unavailable')
        const current = lstatSync(priorPath, { bigint: true })
        if (current.dev !== prior.dev || current.ino !== prior.ino || current.nlink !== 1n) throw new ProfileWriteLeaseError('unavailable')
        rmSync(priorPath)
        rmdirSync(marker)
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
      if (!['ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      removeMatchingOwnerFile(tokenTemporary, tokenIdentity)
      tokenTemporary = undefined
      tokenIdentity = undefined
      try { mkdirSync(marker, { mode: 0o700 }) } catch (markerError) {
        if ((markerError as NodeJS.ErrnoException).code === 'EEXIST') throw new ProfileWriteLeaseError('busy')
        throw markerError
      }
      markerKind = 'directory'
      const markerInfo = lstatSync(marker, { bigint: true })
      markerIdentity = { dev: markerInfo.dev, ino: markerInfo.ino }
      ownerName = `owner-${token}`
      const directoryOwnerFd = openSync(`${marker}/${ownerName}`, 'wx', 0o600)
      try {
        const ownerInfo = fstatSync(directoryOwnerFd, { bigint: true })
        ownerIdentity = { dev: ownerInfo.dev, ino: ownerInfo.ino }
      } finally { closeSync(directoryOwnerFd) }
    }
  } catch (error) {
    if (tokenTemporary && tokenIdentity) { try { removeMatchingOwnerFile(tokenTemporary, tokenIdentity) } catch { /* Preserve an unrelated file. */ } }
    if (transaction) { try { db?.exec('ROLLBACK') } catch { /* Preserve the failure. */ } }
    try { db?.close() } catch { /* Preserve the failure. */ }
    if (created && !initialized && error instanceof ProfileWriteLeaseError && error.reason === 'busy') {
      // An older writer may have acquired the marker immediately after our
      // initial check. Remove only the still-empty guard file we just created;
      // never remove the other writer's marker or an initialized database.
      try {
        const current = lstatSync(guard)
        if (current.isFile() && !current.isSymbolicLink() && current.nlink === 1 && current.size === 0 &&
            current.dev === info.dev && current.ino === info.ino) rmSync(guard)
      } catch { /* Keep an unrecognized record for manual inspection. */ }
    }
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
      if (markerKind === 'file') {
        const current = matchingOwnerFile(marker, ownedToken)
        if (!current || !markerIdentity || current.dev !== markerIdentity.dev || current.ino !== markerIdentity.ino) {
          throw new ProfileWriteLeaseError('unavailable')
        }
        removeMatchingOwnerFile(marker, markerIdentity)
        if (tokenTemporary && tokenIdentity) { try { removeMatchingOwnerFile(tokenTemporary, tokenIdentity) } catch { /* Preserve an unrelated file. */ } }
      } else {
        const currentMarker = lstatSync(marker, { bigint: true })
        const currentOwner = lstatSync(`${marker}/${ownerName}`, { bigint: true })
        if (!markerIdentity || !ownerIdentity || !currentMarker.isDirectory() || currentMarker.isSymbolicLink() ||
            currentMarker.dev !== markerIdentity.dev || currentMarker.ino !== markerIdentity.ino ||
            !currentOwner.isFile() || currentOwner.isSymbolicLink() || currentOwner.nlink !== 1n || currentOwner.size !== 0n ||
            currentOwner.dev !== ownerIdentity.dev || currentOwner.ino !== ownerIdentity.ino ||
            readdirSync(marker).length !== 1) throw new ProfileWriteLeaseError('unavailable')
        rmSync(`${marker}/${ownerName}`)
        rmdirSync(marker)
      }
    } finally {
      try { owned.exec('ROLLBACK') } finally { owned.close() }
    }
  }
}

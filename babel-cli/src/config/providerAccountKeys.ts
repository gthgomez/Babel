/** Private profile references for guided setup. These keys are never exported to process.env. */
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, rmSync, writeFileSync, type BigIntStats } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { parse as parseDotenv } from 'dotenv'
import { resolvePrivateCredentialEnvPath } from './envBootstrap.js'
import { usesDesktopResolvedCredentials } from './desktopCredentialScope.js'
import { validateProviderBaseUrl } from '../runners/providerEndpoint.js'
import type { ProviderId } from '../runners/providerRegistry.js'
import { acquireProfileWriteLease } from './profileWriteLease.js'
import { isActiveUserSettingsCommitContext, readUserSettings, userSettingsPath, type UserSettingsCommitContext } from './userSettings.js'

const maxBytes = 256 * 1024
const accountReference = /^BABEL_ACCOUNT_([A-Z_]+)_[A-F0-9]{32}_API_KEY$/
const providerToken = (provider: ProviderId): string => provider.toUpperCase().replaceAll('-', '_')
const accountFile = (env: NodeJS.ProcessEnv): string => `${resolvePrivateCredentialEnvPath(env)}.accounts`
type FileIdentity = Pick<BigIntStats, 'dev' | 'ino'>

/** Validate a single-line key before writing any credential material. */
export function isValidProviderKey(key: string): boolean {
  return key.length >= 8 && key.length <= 4096 && /^[A-Za-z0-9_./:+=-]+$/.test(key)
}

export function isProfileAccountReference(name: string): boolean {
  return accountReference.test(name)
}

function readPrivateCredentialText(path: string): string | undefined {
  let expected: BigIntStats
  try {
    expected = lstatSync(path, { bigint: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  if (!expected.isFile()) throw new Error('Existing credential file is unsafe.')
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const info = fstatSync(fd, { bigint: true })
    const uid = process.getuid?.()
    if (!info.isFile() || info.dev !== expected.dev || info.ino !== expected.ino ||
        info.nlink !== 1n || info.size > BigInt(maxBytes) ||
        (uid !== undefined && (info.uid !== BigInt(uid) || (info.mode & 0o077n) !== 0n))) {
      throw new Error('Existing credential file is unsafe.')
    }
    const bytes = Buffer.alloc(Number(info.size) + 1)
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null)
      if (!count) break
      offset += count
    }
    if (offset !== Number(info.size)) throw new Error('Credential file changed while being read.')
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, offset))
  } finally {
    closeSync(fd)
  }
}

function replaceCredentialFile(path: string, text: string, temporary = `${path}.${randomUUID()}.tmp`, beforeWrite?: () => void): void {
  if (Buffer.byteLength(text) > maxBytes) throw new Error('Private credential file is full.')
  let fd: number | undefined
  let owned: FileIdentity | undefined
  try {
    fd = openSync(temporary, 'wx', 0o600)
    const info = fstatSync(fd, { bigint: true })
    owned = { dev: info.dev, ino: info.ino }
    // Reserve the name before recording a transaction, and record it before
    // placing credential bytes in the reserved file.
    beforeWrite?.()
    writeFileSync(fd, text, 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    const current = lstatSync(temporary, { bigint: true })
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1n ||
        current.dev !== owned.dev || current.ino !== owned.ino) throw new ProfileAccountRecoveryError()
    renameSync(temporary, path)
  } catch (error) {
    if (fd !== undefined) { try { closeSync(fd) } catch { /* Preserve the failure. */ } }
    if (owned) { try { removeOwnedTransactionFile(temporary, owned) } catch { /* Preserve an unrecognized file. */ } }
    throw error
  }
}

function canonicalDirectory(path: string): string {
  try { return realpathSync(path) } catch (error) {
    const parent = dirname(path)
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === path) throw error
    return join(canonicalDirectory(parent), basename(path))
  }
}

export class UnsafeAccountLocationError extends Error {}

/** Check the canonical destination, including profile overrides and symlinked directories. */
export function checkProfileAccountLocation(env: NodeJS.ProcessEnv, projectRoot: string): string {
  if (usesDesktopResolvedCredentials(env)) throw new UnsafeAccountLocationError('Use Babel Desktop to manage this key.')
  const path = accountFile(env)
  const directory = canonicalDirectory(dirname(path))
  const target = canonicalDirectory(resolve(projectRoot))
  const home = canonicalDirectory(resolve(env['USERPROFILE'] || env['HOME'] || homedir()))
  // Starting in an ordinary home directory is not itself a project. Still check
  // enclosing repositories (e.g. a package subdirectory inside a Git checkout).
  for (let root = target;; root = dirname(root)) {
    const rel = relative(root, directory)
    if (!rel || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) {
      if ((root === target && relative(home, root) !== '') || existsSync(join(root, '.git'))) {
        throw new UnsafeAccountLocationError('Babel cannot store a key inside the project. Move your private Babel config outside the project, then retry.')
      }
    }
    if (dirname(root) === root) break
  }
  return join(directory, basename(path))
}

interface PendingAccountTransaction {
  schemaVersion: 1
  reference: string
  accountPathHash: string
  endpointHash: string | null
  accountTemporaryId: string
  settingsTemporaryId: string
  accountExisted: boolean
  separatorAdded: boolean
}

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const transactionPath = (settingsPath: string): string => `${resolve(settingsPath)}.account-transaction`
const pathBinding = (path: string): string => createHash('sha256').update(resolve(path)).digest('hex')

export class ProfileAccountRecoveryError extends Error {
  constructor() { super('A pending account recovery record is unavailable or unsafe. Preserve the profile and inspect it before continuing.') }
}

/** Read a bounded, private non-secret recovery record without following links. */
function readAccountTransaction(path: string): { record: PendingAccountTransaction; identity: FileIdentity } | undefined {
  let expected: BigIntStats
  try { expected = lstatSync(path, { bigint: true }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new ProfileAccountRecoveryError()
  }
  if (!expected.isFile() || expected.isSymbolicLink() || expected.nlink !== 1n || expected.size > 4096n) throw new ProfileAccountRecoveryError()
  let fd: number
  try { fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)) }
  catch { throw new ProfileAccountRecoveryError() }
  try {
    const actual = fstatSync(fd, { bigint: true })
    const uid = process.getuid?.()
    if (!actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino || actual.nlink !== 1n ||
        actual.size !== expected.size || (uid !== undefined && (actual.uid !== BigInt(uid) || (actual.mode & 0o077n) !== 0n))) {
      throw new ProfileAccountRecoveryError()
    }
    const bytes = Buffer.alloc(Number(actual.size) + 1)
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null)
      if (!count) break
      offset += count
    }
    if (offset !== Number(actual.size)) throw new ProfileAccountRecoveryError()
    let value: unknown
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset))) }
    catch { throw new ProfileAccountRecoveryError() }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProfileAccountRecoveryError()
    const record = value as Record<string, unknown>
    const keys = ['accountExisted', 'accountPathHash', 'accountTemporaryId', 'endpointHash', 'reference', 'schemaVersion', 'separatorAdded', 'settingsTemporaryId']
    if (Object.keys(record).sort().join(',') !== keys.sort().join(',') || record['schemaVersion'] !== 1 ||
        typeof record['reference'] !== 'string' || !isProfileAccountReference(record['reference']) ||
        typeof record['accountPathHash'] !== 'string' || !/^[a-f0-9]{64}$/.test(record['accountPathHash']) ||
        !(record['endpointHash'] === null || (typeof record['endpointHash'] === 'string' && /^[a-f0-9]{64}$/.test(record['endpointHash']))) ||
        typeof record['accountTemporaryId'] !== 'string' || !uuid.test(record['accountTemporaryId']) ||
        typeof record['settingsTemporaryId'] !== 'string' || !uuid.test(record['settingsTemporaryId']) ||
        typeof record['accountExisted'] !== 'boolean' || typeof record['separatorAdded'] !== 'boolean') {
      throw new ProfileAccountRecoveryError()
    }
    return { record: record as unknown as PendingAccountTransaction, identity: { dev: actual.dev, ino: actual.ino } }
  } finally { closeSync(fd) }
}

/** Remove only a regular, single-link file from the transaction's private namespace. */
function removeOwnedTransactionFile(path: string, identity?: FileIdentity): void {
  let expected: BigIntStats
  try { expected = lstatSync(path, { bigint: true }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw new ProfileAccountRecoveryError()
  }
  if (!expected.isFile() || expected.isSymbolicLink() || expected.nlink !== 1n ||
      (identity && (expected.dev !== identity.dev || expected.ino !== identity.ino))) throw new ProfileAccountRecoveryError()
  let fd: number
  try { fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)) }
  catch { throw new ProfileAccountRecoveryError() }
  try {
    const actual = fstatSync(fd, { bigint: true })
    const uid = process.getuid?.()
    if (!actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino || actual.nlink !== 1n ||
        (uid !== undefined && (actual.uid !== BigInt(uid) || (actual.mode & 0o077n) !== 0n))) throw new ProfileAccountRecoveryError()
  } finally { closeSync(fd) }
  const current = lstatSync(path, { bigint: true })
  if (!current.isFile() || current.isSymbolicLink() || current.dev !== expected.dev || current.ino !== expected.ino || current.nlink !== 1n) {
    throw new ProfileAccountRecoveryError()
  }
  rmSync(path)
}

function writeAccountTransaction(path: string, record: PendingAccountTransaction): FileIdentity {
  const fd = openSync(path, 'wx', 0o600)
  try {
    const info = fstatSync(fd, { bigint: true })
    writeFileSync(fd, `${JSON.stringify(record)}\n`, 'utf8')
    fsyncSync(fd)
    return { dev: info.dev, ino: info.ino }
  } finally { closeSync(fd) }
}

function withoutPendingReference(text: string, record: PendingAccountTransaction): { text: string; removed: boolean } {
  const lines = text.match(/[^\n]*(?:\n|$)/g) ?? []
  const keys = lines.flatMap((line, index) => line.startsWith(`${record.reference}=`) ? [index] : [])
  const endpoints = lines.flatMap((line, index) => line.startsWith(`${record.reference}_ENDPOINT=`) ? [index] : [])
  const parsed = parseDotenv(text)
  if (keys.length === 0 && endpoints.length === 0 && !Object.hasOwn(parsed, record.reference) && !text.includes(record.reference)) {
    return { text, removed: false }
  }
  if (keys.length !== 1 || endpoints.length > 1 ||
      (endpoints.length === 1 && endpoints[0] !== keys[0]! + 1) || !Object.hasOwn(parsed, record.reference)) {
    throw new ProfileAccountRecoveryError()
  }
  const start = keys[0]!
  let prefix = lines.slice(0, start).join('')
  const suffix = lines.slice(start + 1 + endpoints.length).join('')
  if (record.separatorAdded && suffix.length === 0 && prefix.endsWith('\n')) prefix = prefix.slice(0, -1)
  return { text: prefix + suffix, removed: true }
}

/** Caller holds both the settings and account leases, in that order. */
function recoverAccountTransactionLocked(settingsPath: string, accountPath: string): boolean {
  const journal = transactionPath(settingsPath)
  const pending = readAccountTransaction(journal)
  if (!pending) return false
  const { record, identity } = pending
  if (record.accountPathHash !== pathBinding(accountPath)) throw new ProfileAccountRecoveryError()
  const accountTemporary = `${accountPath}.${record.accountTemporaryId}.tmp`
  const settingsTemporary = `${resolve(settingsPath)}.${record.settingsTemporaryId}.tmp`
  const settings = readUserSettings({ path: settingsPath })
  const linked = Object.values(settings.connections).filter(connection => connection.apiKeyEnvVar === record.reference)
  const committed = linked.length > 0
  if (committed) {
    const referenceProvider = accountReference.exec(record.reference)?.[1]
    try {
      if (linked.some(connection => providerToken(connection.provider) !== referenceProvider ||
          (connection.baseUrl ? endpointBinding(connection.baseUrl) : null) !== record.endpointHash)) {
        throw new ProfileAccountRecoveryError()
      }
    } catch { throw new ProfileAccountRecoveryError() }
  }
  const existing = readPrivateCredentialText(accountPath)
  if (committed) {
    const entries = parseDotenv(existing ?? '')
    if (!isValidProviderKey(entries[record.reference] ?? '') ||
        entries[`${record.reference}_ENDPOINT`] !== (record.endpointHash ?? undefined)) throw new ProfileAccountRecoveryError()
  }
  removeOwnedTransactionFile(accountTemporary)
  if (!committed && existing !== undefined) {
    const cleaned = withoutPendingReference(existing, record)
    if (cleaned.removed) {
      if (!record.accountExisted && cleaned.text.length === 0) removeOwnedTransactionFile(accountPath)
      else replaceCredentialFile(accountPath, cleaned.text, accountTemporary)
    }
  }
  removeOwnedTransactionFile(settingsTemporary)
  removeOwnedTransactionFile(journal, identity)
  return true
}

/** Reconcile a pending setup transaction without exposing credential values. */
export function recoverProfileAccountTransaction(env: NodeJS.ProcessEnv, projectRoot: string, settingsPath = userSettingsPath(env)): boolean {
  const journal = transactionPath(settingsPath)
  try { lstatSync(journal) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw new ProfileAccountRecoveryError()
  }
  const releaseSettings = acquireProfileWriteLease(settingsPath)
  try {
    const pending = readAccountTransaction(journal)
    if (!pending) return false
    const accountPath = checkProfileAccountLocation(env, projectRoot)
    if (pending.record.accountPathHash !== pathBinding(accountPath)) throw new ProfileAccountRecoveryError()
    mkdirSync(dirname(accountPath), { recursive: true, mode: 0o700 })
    const releaseAccount = acquireProfileWriteLease(accountPath)
    try {
      if (checkProfileAccountLocation(env, projectRoot) !== accountPath || realpathSync(dirname(accountPath)) !== dirname(accountPath)) {
        throw new UnsafeAccountLocationError('The private credential destination changed; retry setup.')
      }
      return recoverAccountTransactionLocked(settingsPath, accountPath)
    } finally { releaseAccount() }
  } finally { releaseSettings() }
}

function endpointBinding(baseUrl: string): string {
  return createHash('sha256').update(new URL(validateProviderBaseUrl(baseUrl)).href).digest('hex')
}

/** Prepare a new key entry. Persist it under lock only when its preference reference can commit. */
export function prepareProfileAccountKey(provider: ProviderId, baseUrl: string | undefined, key: string, env: NodeJS.ProcessEnv, projectRoot: string): {
  reference: string
  commitWith: (commit: () => void, context?: UserSettingsCommitContext) => void
} {
  if (!isValidProviderKey(key)) throw new Error('Invalid credential entry.')
  const reference = `BABEL_ACCOUNT_${providerToken(provider)}_${randomUUID().replaceAll('-', '').toUpperCase()}_API_KEY`
  const path = checkProfileAccountLocation(env, projectRoot)
  const endpointHash = baseUrl ? endpointBinding(baseUrl) : null
  const binding = endpointHash ? `${reference}_ENDPOINT=${endpointHash}\n` : ''
  return {
    reference,
    commitWith: (commit, context) => {
      if (context && !isActiveUserSettingsCommitContext(context)) throw new ProfileAccountRecoveryError()
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      if (checkProfileAccountLocation(env, projectRoot) !== path || realpathSync(dirname(path)) !== dirname(path)) {
        throw new UnsafeAccountLocationError('The private credential destination changed; retry setup.')
      }
      const release = acquireProfileWriteLease(path)
      try {
        let journal: string | undefined
        let journalIdentity: FileIdentity | undefined
        let pendingRecord: PendingAccountTransaction | undefined
        let accountTemporary: string | undefined
        let settingsPath: string | undefined
        let settingsTemporaryId: string | undefined
        if (context) {
          settingsPath = resolve(context.path)
          const prefix = `${settingsPath}.`
          const temporary = resolve(context.temporary)
          if (!temporary.startsWith(prefix) || !temporary.endsWith('.tmp')) throw new ProfileAccountRecoveryError()
          settingsTemporaryId = temporary.slice(prefix.length, -4)
          if (!uuid.test(settingsTemporaryId)) throw new ProfileAccountRecoveryError()
          // updateUserSettings holds the settings lease while invoking us.
          recoverAccountTransactionLocked(settingsPath, path)
        }
        const existing = readPrivateCredentialText(path)
        if (Object.hasOwn(parseDotenv(existing ?? ''), reference)) throw new Error('Credential reference already exists.')
        const separator = existing && !existing.endsWith('\n') ? '\n' : ''
        if (settingsPath && settingsTemporaryId) {
          const accountTemporaryId = randomUUID()
          accountTemporary = `${path}.${accountTemporaryId}.tmp`
          journal = transactionPath(settingsPath)
          pendingRecord = {
            schemaVersion: 1, reference, accountPathHash: pathBinding(path), endpointHash, accountTemporaryId, settingsTemporaryId,
            accountExisted: existing !== undefined, separatorAdded: Boolean(separator),
          }
        }
        replaceCredentialFile(path, `${existing ?? ''}${separator}${reference}=${key}\n${binding}`, accountTemporary,
          journal && pendingRecord ? () => { journalIdentity = writeAccountTransaction(journal!, pendingRecord!) } : undefined)
        try {
          commit()
        } catch (error) {
          // A caller can fail after its rename succeeded. Never remove a key
          // that the durable preferences already reference.
          if (settingsPath) {
            let committed: boolean
            try { committed = Object.values(readUserSettings({ path: settingsPath }).connections).some(connection => connection.apiKeyEnvVar === reference) }
            catch { throw error }
            if (committed) throw error
          }
          if (existing === undefined) removeOwnedTransactionFile(path)
          else replaceCredentialFile(path, existing, accountTemporary)
          if (journal && journalIdentity) { try { removeOwnedTransactionFile(journal, journalIdentity) } catch { /* Recovery can finish later. */ } }
          throw error
        }
        if (journal && journalIdentity) { try { removeOwnedTransactionFile(journal, journalIdentity) } catch { /* Committed data remains usable; recovery can finish later. */ } }
      } finally {
        release()
      }
    },
  }
}

/** Resolve old environment references or new private-account references without fallback between them. */
export function readProviderKeyReference(provider: ProviderId, name: string, env: NodeJS.ProcessEnv, baseUrl?: string): string | undefined {
  const match = accountReference.exec(name)
  if (!match) return env[name]?.trim() || undefined
  if (match[1] !== providerToken(provider) || usesDesktopResolvedCredentials(env)) return undefined
  try {
    const path = checkProfileAccountLocation(env, env['BABEL_PROJECT_ROOT'] ?? process.cwd())
    const entries = parseDotenv(readPrivateCredentialText(path) ?? '')
    if ((provider === 'openai-compatible' && !baseUrl) ||
        entries[`${name}_ENDPOINT`] !== (baseUrl ? endpointBinding(baseUrl) : undefined)) return undefined
    const key = entries[name]
    return key && isValidProviderKey(key) ? key : undefined
  } catch {
    // Unsafe or unreadable profiles must never fall back to a different key.
    return undefined
  }
}

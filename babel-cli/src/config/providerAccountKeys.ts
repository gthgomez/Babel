/** Private profile references for guided setup. These keys are never exported to process.env. */
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { parse as parseDotenv } from 'dotenv'
import { resolvePrivateCredentialEnvPath } from './envBootstrap.js'
import { usesDesktopResolvedCredentials } from './desktopCredentialScope.js'
import type { ProviderId } from '../runners/providerRegistry.js'

const maxBytes = 256 * 1024
const accountReference = /^BABEL_ACCOUNT_([A-Z_]+)_[A-F0-9]{32}_API_KEY$/
const providerToken = (provider: ProviderId): string => provider.toUpperCase().replaceAll('-', '_')
const accountFile = (env: NodeJS.ProcessEnv): string => `${resolvePrivateCredentialEnvPath(env)}.accounts`

/** Validate a single-line key before writing any credential material. */
export function isValidProviderKey(key: string): boolean {
  return key.length >= 8 && key.length <= 4096 && /^[A-Za-z0-9_./:+=-]+$/.test(key)
}

export function isProfileAccountReference(name: string): boolean {
  return accountReference.test(name)
}

function readPrivateCredentialText(path: string): string {
  try {
    const info = lstatSync(path)
    if (!info.isFile() || info.nlink !== 1 || info.size > maxBytes ||
        (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) {
      throw new Error('Existing credential file is unsafe.')
    }
    return readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return ''
    throw error
  }
}

/** Append a new private credential without replacing other keys. */
export function appendPrivateCredential(path: string, name: string, key: string): void {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name) || !isValidProviderKey(key)) throw new Error('Invalid credential entry.')
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const lock = `${path}.babel-lock`
  const fd = openSync(lock, 'wx', 0o600)
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    const existing = readPrivateCredentialText(path)
    if (Object.hasOwn(parseDotenv(existing), name)) throw new Error('Credential reference already exists.')
    const separator = existing && !existing.endsWith('\n') ? '\n' : ''
    const next = `${existing}${separator}${name}=${key}\n`
    if (Buffer.byteLength(next) > maxBytes) throw new Error('Private credential file is full.')
    writeFileSync(temp, next, { flag: 'wx', mode: 0o600 })
    renameSync(temp, path)
  } finally {
    try { rmSync(temp, { force: true }) } finally {
      closeSync(fd)
      rmSync(lock, { force: true })
    }
  }
}

/** Create a distinct, provider-scoped profile entry and return only its reference. */
export function saveProfileAccountKey(provider: ProviderId, key: string, env: NodeJS.ProcessEnv): string {
  if (usesDesktopResolvedCredentials(env)) throw new Error('Use Babel Desktop to manage this key.')
  const name = `BABEL_ACCOUNT_${providerToken(provider)}_${randomUUID().replaceAll('-', '').toUpperCase()}_API_KEY`
  appendPrivateCredential(accountFile(env), name, key)
  return name
}

/** Resolve old environment references or new private-account references without fallback between them. */
export function readProviderKeyReference(provider: ProviderId, name: string, env: NodeJS.ProcessEnv): string | undefined {
  const match = accountReference.exec(name)
  if (!match) return env[name]?.trim() || undefined
  if (match[1] !== providerToken(provider) || usesDesktopResolvedCredentials(env)) return undefined
  try {
    const key = parseDotenv(readPrivateCredentialText(accountFile(env)))[name]
    return key && isValidProviderKey(key) ? key : undefined
  } catch {
    // Unsafe or unreadable profiles must never fall back to a different key.
    return undefined
  }
}

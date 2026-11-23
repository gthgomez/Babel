/** Private profile references for guided setup. These keys are never exported to process.env. */
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, rmSync, writeFileSync, type BigIntStats } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { parse as parseDotenv } from 'dotenv'
import { resolvePrivateCredentialEnvPath } from './envBootstrap.js'
import { usesDesktopResolvedCredentials } from './desktopCredentialScope.js'
import { validateProviderBaseUrl } from '../runners/providerEndpoint.js'
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

function replaceCredentialFile(path: string, text: string): void {
  if (Buffer.byteLength(text) > maxBytes) throw new Error('Private credential file is full.')
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, text, { flag: 'wx', mode: 0o600 })
    renameSync(temp, path)
  } catch (error) {
    rmSync(temp, { force: true })
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

function endpointBinding(baseUrl: string): string {
  return createHash('sha256').update(new URL(validateProviderBaseUrl(baseUrl)).href).digest('hex')
}

/** Prepare a new key entry. Persist it under lock only when its preference reference can commit. */
export function prepareProfileAccountKey(provider: ProviderId, baseUrl: string | undefined, key: string, env: NodeJS.ProcessEnv, projectRoot: string): {
  reference: string
  commitWith: (commit: () => void) => void
} {
  if (!isValidProviderKey(key)) throw new Error('Invalid credential entry.')
  const reference = `BABEL_ACCOUNT_${providerToken(provider)}_${randomUUID().replaceAll('-', '').toUpperCase()}_API_KEY`
  const path = checkProfileAccountLocation(env, projectRoot)
  const binding = baseUrl ? `${reference}_ENDPOINT=${endpointBinding(baseUrl)}\n` : ''
  return {
    reference,
    commitWith: commit => {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      if (checkProfileAccountLocation(env, projectRoot) !== path || realpathSync(dirname(path)) !== dirname(path)) {
        throw new UnsafeAccountLocationError('The private credential destination changed; retry setup.')
      }
      const lock = `${path}.babel-lock`
      const fd = openSync(lock, 'wx', 0o600)
      try {
        const existing = readPrivateCredentialText(path)
        if (Object.hasOwn(parseDotenv(existing ?? ''), reference)) throw new Error('Credential reference already exists.')
        const separator = existing && !existing.endsWith('\n') ? '\n' : ''
        replaceCredentialFile(path, `${existing ?? ''}${separator}${reference}=${key}\n${binding}`)
        try {
          commit()
        } catch (error) {
          if (existing === undefined) rmSync(path)
          else replaceCredentialFile(path, existing)
          throw error
        }
      } finally {
        try { closeSync(fd) } finally { rmSync(lock, { force: true }) }
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

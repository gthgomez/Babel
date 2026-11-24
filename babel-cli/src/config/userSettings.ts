/** User-owned, non-secret connection preferences and their effective provenance. */
import { closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, type BigIntStats } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { PROVIDER_IDS } from '../runners/providerRegistry.js'
import { resolveRuntimeUserStateRoot } from './runtimePaths.js'
import { currentInvocationSettings } from './invocationSettings.js'
import { validateProviderBaseUrl } from '../runners/providerEndpoint.js'
import { isLoopbackEndpoint } from './offlineMode.js'
import { acquireProfileWriteLease, ProfileWriteLeaseError } from './profileWriteLease.js'

/** Return only schema-owned text so a preference value is never echoed in an error. */
function describePreferenceIssues(issues: readonly { path: readonly (string | number | symbol)[]; message: string }[]): string {
  return issues.slice(0, 4).map(issue => {
    const path = issue.path.map(String).join('.')
    return path ? `${path}: ${issue.message}` : issue.message
  }).join('; ')
}

const name = z.string().trim().min(1).max(200).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/)
const positiveInt = z.number().int().positive()
const preferences = z.object({
  connection: name.optional(),
  model: z.string().trim().min(1).max(500).optional(),
  modelsByConnection: z.record(name, z.string().trim().min(1).max(500)).optional(),
  workflow: z.enum(['work', 'plan']).optional(),
  review: z.enum(['standard', 'thorough']).optional(),
  plans: z.object({ autoApply: z.boolean().optional() }).passthrough().optional(),
  budgetUsd: z.union([z.number().positive(), z.literal('unlimited')]).optional(),
}).passthrough()
const connectionSchema = z.object({
  id: name,
  provider: z.enum(PROVIDER_IDS),
  model: z.string().trim().min(1).max(500).optional(),
  baseUrl: z.string().url().refine(value => {
    try { validateProviderBaseUrl(value); return true } catch { return false }
  }, 'Endpoint must use HTTPS (or loopback HTTP), without credentials, query or fragment.').optional(),
  apiKeyEnvVar: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
  authentication: z.enum(['api-key', 'none']).optional(),
  contextWindow: positiveInt.optional(),
  maxOutputTokens: positiveInt.optional(),
}).passthrough()
const settingsSchema = z.object({
  schemaVersion: z.literal(1),
  connections: z.record(z.string(), connectionSchema),
  defaults: preferences.optional(),
  projects: z.record(z.string(), preferences).optional(),
  setup: z.object({ completed: z.boolean().optional(), step: z.string().optional() }).passthrough().optional(),
}).passthrough().superRefine((settings, ctx) => {
  // Preserve future fields, but credentials belong only in the credential service.
  const hasLiteralSecret = (value: unknown): boolean => {
    if (!value || typeof value !== 'object') return false
    return Object.entries(value).some(([key, child]) => /^(?:api_?key|access_?token|refresh_?token|password|secret|authorization|credential)$/i.test(key) || hasLiteralSecret(child))
  }
  if (hasLiteralSecret(settings)) ctx.addIssue({ code: 'custom', message: 'Store credential references, never credential values.' })
  for (const [id, connection] of Object.entries(settings.connections)) {
    if (connection.provider === 'openai-compatible' && !connection.baseUrl) ctx.addIssue({ code: 'custom', message: 'Custom compatible connections require a base URL.', path: ['connections', id] })
    if (connection.baseUrl && !['openai-compatible', 'openai', 'gemini', 'anthropic', 'ollama'].includes(connection.provider)) ctx.addIssue({ code: 'custom', message: 'This provider pins its endpoint; use an explicit compatible connection for a custom endpoint.', path: ['connections', id] })
    if (connection.baseUrl && connection.provider === 'ollama' && !isLoopbackEndpoint(connection.baseUrl)) ctx.addIssue({ code: 'custom', message: 'Ollama runs locally: its base URL must be loopback HTTP (http://localhost:11434/v1 or http://127.0.0.1:11434/v1), not a remote endpoint.', path: ['connections', id, 'baseUrl'] })
    if (connection.authentication === 'none' && connection.provider !== 'openai-compatible') ctx.addIssue({ code: 'custom', message: 'No-auth mode is only supported by explicit compatible connections.', path: ['connections', id] })
    if (id !== connection.id) ctx.addIssue({ code: 'custom', message: 'Connection key and id must match.', path: ['connections', id] })
    if (connection.contextWindow && connection.maxOutputTokens && connection.maxOutputTokens >= connection.contextWindow) {
      ctx.addIssue({ code: 'custom', message: 'Output budget must be smaller than context window.', path: ['connections', id] })
    }
  }
  for (const preference of [settings.defaults, ...Object.values(settings.projects ?? {})]) {
    if (preference?.connection && !settings.connections[preference.connection]) {
      ctx.addIssue({ code: 'custom', message: 'Selected connection does not exist.' })
    }
  }
})

export type Connection = z.infer<typeof connectionSchema>
export type UserPreferences = z.infer<typeof preferences>
export type UserSettings = z.infer<typeof settingsSchema>
/** An explicit selection cannot be resolved. Never fall back to a different account. */
export class UnavailableConnectionError extends Error {
  constructor() {
    super('Selected Babel connection is unavailable. Check --connection or BABEL_CONNECTION, or use babel-harness setup.')
  }
}
export type SettingSource = 'invocation' | 'session' | 'environment' | 'project' | 'user' | 'connection' | 'built-in'
export interface EffectiveValue<T> { value: T; source: SettingSource }
export interface EffectiveSettings {
  connection: EffectiveValue<Connection | null>
  unavailableConnection?: true
  model: EffectiveValue<string | null>
  workflow: EffectiveValue<'work' | 'plan'>
  review: EffectiveValue<'standard' | 'thorough'>
  autoApply: EffectiveValue<boolean>
  budgetUsd: EffectiveValue<number | 'unlimited' | null>
}

/** Preferences live outside the project so repositories cannot set credential destinations. */
export function userSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveRuntimeUserStateRoot(env), 'preferences.json')
}

/** Missing preferences represent a fresh profile; malformed files are reported without rewriting them. */
export function readUserSettings(options: { path?: string; env?: NodeJS.ProcessEnv } = {}): UserSettings {
  const path = options.path ?? userSettingsPath(options.env)
  if (!existsSync(path)) return { schemaVersion: 1, connections: {} }
  const info = lstatSync(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error('Babel preferences are not a safe regular file.')
  let value: unknown
  try { value = JSON.parse(readFileSync(path, 'utf8')) } catch { throw new Error('Babel preferences contain invalid JSON; preserve the file and repair it before saving.') }
  const result = settingsSchema.safeParse(value)
  if (!result.success) throw new Error(`Babel preferences are invalid or use an unsupported version (${describePreferenceIssues(result.error.issues)}); preserve the file and repair it before saving.`)
  return result.data
}

export interface UserSettingsCommitContext {
  readonly path: string
  readonly temporary: string
}

const activeCommitContexts = new WeakSet<UserSettingsCommitContext>()

/** A transaction participant may act only while this settings writer owns its lease. */
export function isActiveUserSettingsCommitContext(context: UserSettingsCommitContext): boolean {
  return activeCommitContexts.has(context)
}

/**
 * Validate and commit under one writer lock. A callback sees the latest committed
 * preferences. Setup can wrap the final rename to commit a prepared private key
 * alongside its reference, rolling back the key if the rename fails.
 */
export function updateUserSettings(
  change: Partial<UserSettings> | ((current: UserSettings) => Partial<UserSettings>),
  options: { path?: string; env?: NodeJS.ProcessEnv; commitWith?: (commit: () => void, context: UserSettingsCommitContext) => void } = {},
): UserSettings {
  const path = options.path ?? userSettingsPath(options.env)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  let release: () => void
  try { release = acquireProfileWriteLease(path) } catch (error) {
    if (error instanceof ProfileWriteLeaseError && error.reason === 'busy') {
      throw new Error('Babel preferences are locked by another writer. Retry when it finishes.')
    }
    throw error
  }
  const temporary = `${path}.${randomUUID()}.tmp`
  let temporaryIdentity: Pick<BigIntStats, 'dev' | 'ino'> | undefined
  try {
    const current = readUserSettings({ ...options, path })
    const update = typeof change === 'function' ? change(current) : change
    const candidate = {
      ...current, ...update,
      connections: { ...current.connections, ...update.connections },
      defaults: { ...current.defaults, ...update.defaults, ...(update.defaults?.plans ? { plans: { ...current.defaults?.plans, ...update.defaults.plans } } : {}) },
      projects: { ...current.projects, ...update.projects },
      setup: { ...current.setup, ...update.setup },
    }
    const result = settingsSchema.safeParse(candidate)
    if (!result.success) throw new Error(`Invalid Babel preference update (${describePreferenceIssues(result.error.issues)}); previous preferences were preserved.`)
    const fd = openSync(temporary, 'wx', 0o600)
    try {
      const info = fstatSync(fd, { bigint: true })
      temporaryIdentity = { dev: info.dev, ino: info.ino }
      writeFileSync(fd, `${JSON.stringify(result.data, null, 2)}\n`, 'utf8')
      fsyncSync(fd)
    } finally { closeSync(fd) }
    const commit = (): void => {
      const currentTemporary = lstatSync(temporary, { bigint: true })
      if (!temporaryIdentity || !currentTemporary.isFile() || currentTemporary.isSymbolicLink() || currentTemporary.nlink !== 1n ||
          currentTemporary.dev !== temporaryIdentity.dev || currentTemporary.ino !== temporaryIdentity.ino) {
        throw new Error('Babel temporary preferences changed; preserve the file and inspect the profile.')
      }
      renameSync(temporary, path)
    }
    if (options.commitWith) {
      const context = Object.freeze({ path, temporary })
      activeCommitContexts.add(context)
      try { options.commitWith(commit, context) } finally { activeCommitContexts.delete(context) }
    } else commit()
    return result.data
  } finally {
    try {
      if (temporaryIdentity) {
        try {
          const current = lstatSync(temporary, { bigint: true })
          if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1n ||
              current.dev !== temporaryIdentity.dev || current.ino !== temporaryIdentity.ino) {
            throw new Error('Babel temporary preferences changed; preserve the file and inspect the profile.')
          }
          rmSync(temporary)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
    } finally {
      release()
    }
  }
}

/** Resolve selection once; environment credentials never choose a provider. */
export function resolveEffectiveSettings(options: {
  settings?: UserSettings
  env?: NodeJS.ProcessEnv
  projectRoot?: string
  session?: UserPreferences
  invocation?: UserPreferences
  /** Status and setup can report an unavailable route without resolving to a fallback. */
  reportUnavailableConnection?: boolean
} = {}): EffectiveSettings {
  const env = options.env ?? process.env
  const settings = options.settings ?? readUserSettings({ env })
  const budgetEnv = env['BABEL_CHAT_MAX_COST']
  const layers: Array<[SettingSource, UserPreferences | undefined]> = [
    ['invocation', options.invocation ?? currentInvocationSettings()], ['session', options.session],
    ['environment', { ...(env['BABEL_CONNECTION'] ? { connection: env['BABEL_CONNECTION'] } : {}), ...(env['BABEL_MODEL'] ? { model: env['BABEL_MODEL'] } : {}), ...(budgetEnv ? { budgetUsd: budgetEnv.trim().toLowerCase() === 'unlimited' ? 'unlimited' as const : Number(budgetEnv) } : {}) }],
    ['project', options.projectRoot ? settings.projects?.[resolve(options.projectRoot)] : undefined],
    ['user', settings.defaults],
  ]
  const field = <K extends keyof UserPreferences>(key: K, fallback: NonNullable<UserPreferences[K]> | null): EffectiveValue<NonNullable<UserPreferences[K]> | null> => {
    for (const [source, layer] of layers) if (layer?.[key] !== undefined) return { value: layer[key] as NonNullable<UserPreferences[K]>, source }
    return { value: fallback, source: 'built-in' }
  }
  const selected = field('connection', null)
  const connection = selected.value && Object.hasOwn(settings.connections, selected.value)
    ? settings.connections[String(selected.value)] : undefined
  const unavailable = Boolean(selected.value && !connection)
  if (unavailable && !options.reportUnavailableConnection) throw new UnavailableConnectionError()
  const model: EffectiveValue<string | null> = { value: null, source: 'built-in' }
  const connectionLayer = layers.findIndex(([source]) => source === selected.source)
  if (connection) for (const [index, [source, layer]] of layers.entries()) {
    if (typeof layer?.model === 'string' && (index <= connectionLayer || layer.connection === connection.id)) {
      model.value = layer.model; model.source = source; break
    }
    const remembered = layer?.modelsByConnection?.[connection.id]
    if (typeof remembered === 'string') { model.value = remembered; model.source = source; break }
  }
  if (model.value === null && connection?.model) { model.value = connection.model; model.source = 'connection' }
  // Only private user/project preferences may grant automatic application.
  const trusted = options.projectRoot ? settings.projects?.[resolve(options.projectRoot)] : undefined
  const autoApply = trusted?.plans?.autoApply ?? settings.defaults?.plans?.autoApply ?? false
  return {
    ...(unavailable ? { unavailableConnection: true as const } : {}),
    connection: { value: connection ? { id: connection.id, provider: connection.provider,
      ...(connection.model ? { model: connection.model } : {}), ...(connection.baseUrl ? { baseUrl: connection.baseUrl } : {}),
      ...(connection.apiKeyEnvVar ? { apiKeyEnvVar: connection.apiKeyEnvVar } : {}), ...(connection.authentication ? { authentication: connection.authentication } : {}),
      ...(connection.contextWindow ? { contextWindow: connection.contextWindow } : {}), ...(connection.maxOutputTokens ? { maxOutputTokens: connection.maxOutputTokens } : {}) } : null, source: selected.source }, model,
    workflow: field('workflow', 'work') as EffectiveValue<'work' | 'plan'>,
    review: field('review', 'standard') as EffectiveValue<'standard' | 'thorough'>,
    autoApply: { value: autoApply, source: trusted?.plans?.autoApply !== undefined ? 'project' : settings.defaults?.plans?.autoApply !== undefined ? 'user' : 'built-in' },
    budgetUsd: field('budgetUsd', null) as EffectiveSettings['budgetUsd'],
  }
}

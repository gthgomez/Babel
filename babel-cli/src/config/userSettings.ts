/** User-owned, non-secret connection preferences and their effective provenance. */
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { PROVIDER_IDS } from '../runners/providerRegistry.js'
import { resolveRuntimeUserStateRoot } from './runtimePaths.js'
import { currentInvocationSettings } from './invocationSettings.js'
import { validateProviderBaseUrl } from '../runners/providerEndpoint.js'

const name = z.string().trim().min(1).max(200).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/)
const positiveInt = z.number().int().positive()
const preferences = z.object({
  connection: name.optional(),
  model: z.string().trim().min(1).max(500).optional(),
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
    if (connection.baseUrl && !['openai-compatible', 'openai', 'gemini', 'anthropic'].includes(connection.provider)) ctx.addIssue({ code: 'custom', message: 'This provider pins its endpoint; use an explicit compatible connection for a custom endpoint.', path: ['connections', id] })
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
export type SettingSource = 'invocation' | 'session' | 'environment' | 'project' | 'user' | 'connection' | 'built-in'
export interface EffectiveValue<T> { value: T; source: SettingSource }
export interface EffectiveSettings {
  connection: EffectiveValue<Connection | null>
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
  if (!result.success) throw new Error('Babel preferences are invalid or use an unsupported version; preserve the file and repair it before saving.')
  return result.data
}

/** Validate the entire candidate before an atomic save, preserving forward-compatible fields. */
export function updateUserSettings(update: Partial<UserSettings>, options: { path?: string; env?: NodeJS.ProcessEnv } = {}): UserSettings {
  const path = options.path ?? userSettingsPath(options.env)
  const current = readUserSettings({ ...options, path })
  const candidate = {
    ...current, ...update,
    connections: { ...current.connections, ...update.connections },
    defaults: { ...current.defaults, ...update.defaults, ...(update.defaults?.plans ? { plans: { ...current.defaults?.plans, ...update.defaults.plans } } : {}) },
    projects: { ...current.projects, ...update.projects },
    setup: { ...current.setup, ...update.setup },
  }
  const result = settingsSchema.safeParse(candidate)
  if (!result.success) throw new Error('Invalid Babel preference update; previous preferences were preserved.')
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  writeFileSync(temporary, `${JSON.stringify(result.data, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  renameSync(temporary, path)
  return result.data
}

/** Resolve selection once; environment credentials never choose a provider. */
export function resolveEffectiveSettings(options: {
  settings?: UserSettings
  env?: NodeJS.ProcessEnv
  projectRoot?: string
  session?: UserPreferences
  invocation?: UserPreferences
} = {}): EffectiveSettings {
  const env = options.env ?? process.env
  const settings = options.settings ?? readUserSettings({ env })
  const layers: Array<[SettingSource, UserPreferences | undefined]> = [
    ['invocation', options.invocation ?? currentInvocationSettings()], ['session', options.session],
    ['environment', { ...(env['BABEL_CONNECTION'] ? { connection: env['BABEL_CONNECTION'] } : {}), ...(env['BABEL_MODEL'] ? { model: env['BABEL_MODEL'] } : {}), ...(env['BABEL_CHAT_MAX_COST'] ? { budgetUsd: env['BABEL_CHAT_MAX_COST'] === 'unlimited' ? 'unlimited' as const : Number(env['BABEL_CHAT_MAX_COST']) } : {}) }],
    ['project', options.projectRoot ? settings.projects?.[resolve(options.projectRoot)] : undefined],
    ['user', settings.defaults],
  ]
  const field = <K extends keyof UserPreferences>(key: K, fallback: NonNullable<UserPreferences[K]> | null): EffectiveValue<NonNullable<UserPreferences[K]> | null> => {
    for (const [source, layer] of layers) if (layer?.[key] !== undefined) return { value: layer[key] as NonNullable<UserPreferences[K]>, source }
    return { value: fallback, source: 'built-in' }
  }
  const selected = field('connection', null)
  const connection = selected.value ? settings.connections[String(selected.value)] : undefined
  if (selected.value && !connection) throw new Error('Selected Babel connection is unavailable. Use babel-agent provider list or setup.')
  const model: EffectiveValue<string | null> = { value: null, source: 'built-in' }
  const connectionLayer = layers.findIndex(([source]) => source === selected.source)
  if (connection) for (const [index, [source, layer]] of layers.entries()) {
    if (typeof layer?.model === 'string' && (index <= connectionLayer || layer.connection === connection.id)) {
      model.value = layer.model; model.source = source; break
    }
  }
  if (model.value === null && connection?.model) { model.value = connection.model; model.source = 'connection' }
  // Only private user/project preferences may grant automatic application.
  const trusted = options.projectRoot ? settings.projects?.[resolve(options.projectRoot)] : undefined
  const autoApply = trusted?.plans?.autoApply ?? settings.defaults?.plans?.autoApply ?? false
  return {
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

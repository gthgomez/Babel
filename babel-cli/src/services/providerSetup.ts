/** Guided provider setup. Only an explicit check contacts a provider, and never for inference. */
import { isDeepStrictEqual } from 'node:util'
import { readUserSettings, resolveEffectiveSettings, updateUserSettings, type Connection, type UserSettings } from '../config/userSettings.js'
import { checkProfileAccountLocation, isValidProviderKey, prepareProfileAccountKey, ProfileAccountRecoveryError, readProviderKeyReference, recoverProfileAccountTransaction, UnsafeAccountLocationError } from '../config/providerAccountKeys.js'
import { resolvePrivateCredentialEnvPath } from '../config/envBootstrap.js'
import { isProviderLocal } from '../config/offlineMode.js'
import { connectionStatus, type SelectionSession } from './connectionSettings.js'
import { validateProviderBaseUrl } from '../runners/providerEndpoint.js'
import { getProviderSpec, listProviderSpecs, type ProviderId } from '../runners/providerRegistry.js'
import { CLI_COMMAND } from '../cli/commandName.js'
import { formatManualProviderEnvExample } from '../cli/firstRunText.js'
import { openSetupPrompt, SetupCancelled, type SetupQuestion } from '../ui/setupPrompt.js'
import { sanitizeUntrustedTerminalField } from '../ui/sanitize.js'
import { checkSetupConnection, setupMetadataEndpoint } from './providerSetupCatalog.js'
import { numberedChoice, pickSetupModel, pricedSetupModels, type SetupIO } from './providerSetupMenu.js'
import { resolveAgentTarget } from './targetResolver.js'

export interface SetupResult {
  state: 'setup_required' | 'configured_unverified' | 'action_required'
  connection: string | null
  provider: string | null
  model: string | null
  unavailableConnection?: true
}

interface GuidedSetupResult extends SetupResult {
  saved?: { connection: string; model: string }
  failed?: true
}

const featured: Partial<Record<ProviderId, string>> = { openrouter: 'OpenRouter', 'command-code': 'Command Code' }
const codingProviders = listProviderSpecs()
  .filter(spec => spec.authorityConformance === 'certified' && spec.operations.includes('native_tool_stream'))
  .sort((a, b) => Number(Boolean(featured[b.id])) - Number(Boolean(featured[a.id])))
const unavailableNotice = 'The selected connection is unavailable. Check --connection or BABEL_CONNECTION; /provider use can select a configured account for this session.'

/** Presence is a local prerequisite; it never proves authentication or model health. */
export function getSetupStatus(env: NodeJS.ProcessEnv = process.env, session: SelectionSession = {}, projectRoot = process.cwd()): SetupResult {
  const status = connectionStatus(session, projectRoot, env)
  return { state: status.state, connection: status.connection, provider: status.provider, model: status.model,
    ...(status.reason === 'connection_unavailable' ? { unavailableConnection: true } : {}) }
}

/** Do not open any prompts on a pipe, CI, or headless invocation. */
export function canPromptForSetup(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(process.stdin.isTTY && process.stderr.isTTY && !['1', 'true'].includes(env['CI'] ?? '') &&
    !['1', 'true'].includes(env['BABEL_HEADLESS'] ?? ''))
}

function needsKey(connection: Connection): boolean {
  return connection.authentication !== 'none' && getProviderSpec(connection.provider).requiresCredential
}

function existingKey(connection: Connection, env: NodeJS.ProcessEnv): string | undefined {
  const name = connection.apiKeyEnvVar ?? getProviderSpec(connection.provider).credentialEnvVar
  return needsKey(connection) && name ? readProviderKeyReference(connection.provider, name, env, connection.baseUrl) : undefined
}

async function newConnection(provider: ProviderId, settings: UserSettings, io: SetupIO): Promise<Connection | null> {
  let suggested: string = provider
  for (let suffix = 2; Object.hasOwn(settings.connections, suggested); suffix++) suggested = `${provider}-${suffix}`
  let id: string
  for (;;) {
    const answer = await io.ask(`Connection name [${suggested}] (Esc back): `)
    if (answer === null) return null
    id = answer.trim() || suggested
    if (/^[a-z0-9][a-z0-9_.-]{0,199}$/i.test(id) && !Object.hasOwn(Object.prototype, id) &&
        !Object.hasOwn(settings.connections, id)) break
    io.write('Choose an unused name using letters, numbers, dots, underscores or dashes.\n')
  }
  if (provider !== 'openai-compatible') return { id, provider }
  for (;;) {
    const answer = await io.ask('Compatible API base URL (Esc back): ')
    if (answer === null) return null
    let baseUrl: string
    try { baseUrl = validateProviderBaseUrl(answer.trim()) } catch {
      io.write('Enter an HTTPS or loopback HTTP URL without credentials, query or fragment.\n')
      continue
    }
    const auth = await numberedChoice(io, 'Authentication', ['API key', 'No key'], 0)
    return auth === null ? null : { id, provider, baseUrl, authentication: auth === 0 ? 'api-key' : 'none' }
  }
}

async function connectKey(connection: Connection, env: NodeJS.ProcessEnv, root: string, io: SetupIO, addingAnother: boolean): Promise<{ key?: string; newKey?: true } | null> {
  if (!needsKey(connection)) {
    io.write('No key required. Model not yet tested.\n')
    return {}
  }
  const key = addingAnother ? undefined : existingKey(connection, env)
  for (;;) {
    const choices = [...(key ? ['Use existing key'] : []), 'Paste a new key']
    const choice = await numberedChoice(io, 'Key', choices, 0)
    if (choice === null) return null
    if (key && choice === 0) {
      io.write('Existing key selected. Authentication unverified; model not yet tested.\n')
      return { key }
    }
    checkProfileAccountLocation(env, root)
    io.write('New keys are stored in your private Babel profile as plaintext, not in the project.\n')
    for (;;) {
      const answer = await io.ask('Paste API key (masked, Esc back): ', true)
      if (answer === null) break
      const entered = answer.trim()
      if (isValidProviderKey(entered)) return { key: entered, newKey: true }
      io.write('Enter a valid single-line API key. Nothing was saved.\n')
    }
  }
}

class SetupChangedError extends Error {}

function saveAccount(connection: Connection, key: string | undefined, env: NodeJS.ProcessEnv, root: string,
  update: (latest: UserSettings, account: Connection) => Partial<UserSettings>,
): Connection {
  const entry = key ? prepareProfileAccountKey(connection.provider, connection.baseUrl, key, env, root) : undefined
  const account = entry ? { ...connection, apiKeyEnvVar: entry.reference } : connection
  updateUserSettings(latest => update(latest, account), { env, ...(entry ? { commitWith: entry.commitWith } : {}) })
  return account
}

function defaultSelection(settings: UserSettings, id: string, env: NodeJS.ProcessEnv, root: string) {
  return {
    connection: settings.defaults?.connection,
    model: settings.defaults?.model,
    remembered: settings.defaults?.modelsByConnection?.[id],
    userBudget: settings.defaults?.budgetUsd,
    effectiveBudget: resolveEffectiveSettings({ settings, env, projectRoot: root, reportUnavailableConnection: true }).budgetUsd,
  }
}

async function chooseSpending(io: SetupIO, hasScopedSetting: boolean): Promise<number | 'unlimited' | null> {
  io.write(hasScopedSetting
    ? 'A scoped spending setting is active here. Choose a user-wide setting for this default; the scoped setting stays in effect.\n'
    : 'No user spending setting is saved. Remote tasks may incur provider charges.\n')
  const choice = await numberedChoice(io, 'Spending', ['Set a per-task spending cap', 'Continue without a Babel spending cap'])
  if (choice === null) return null
  if (choice === 1) return 'unlimited'
  io.write('Standard Work checks estimated USD costs before dispatch. Plan, thorough review and Apply cannot run remotely with a finite cap.\n')
  for (;;) {
    const answer = await io.ask('Per-task cap in USD (Esc back): ')
    if (answer === null) return null
    const budget = Number(answer.trim())
    if (Number.isFinite(budget) && budget > 0) return budget
    io.write('Enter a positive dollar amount.\n')
  }
}

/**
 * Save an explicit user default once a model is chosen. Pending new accounts
 * can be resumed after a key is saved, without changing the active default.
 */
export async function runProviderSetup(options: {
  env?: NodeJS.ProcessEnv
  projectRoot?: string
  interactive?: boolean
  question?: SetupQuestion
  write?: (text: string) => void
} = {}): Promise<GuidedSetupResult> {
  const env = options.env ?? process.env
  const cwd = env['BABEL_PROJECT_ROOT'] ?? process.cwd()
  const root = options.projectRoot ?? resolveAgentTarget({ cwd }).targetRoot
  const write = options.write ?? (text => process.stderr.write(text))
  let previous: SetupResult = { state: 'setup_required', connection: null, provider: null, model: null }
  let terminal: ReturnType<typeof openSetupPrompt> | undefined
  try {
    if (recoverProfileAccountTransaction(env, root)) {
      write('Recovered an interrupted account update. Review your saved connection before continuing.\n')
    }
    previous = getSetupStatus(env, {}, root)
    if (previous.unavailableConnection) write(`${unavailableNotice}\n`)
    if (!(options.interactive ?? canPromptForSetup(env))) {
      write(`${formatManualProviderEnvExample(resolvePrivateCredentialEnvPath(env))}\n`)
      write(`Or use provider list, provider connect <provider> --model <exact-id>, then provider use <connection> --save user.\n`)
      write(`Use settings set budgetUsd <amount|unlimited> to choose a budget.\n`)
      return previous
    }
    write('\nConnect a provider · Babel setup\nNo inference is sent. Only “Check connection” contacts a provider for metadata.\n')
    terminal = options.question ? undefined : openSetupPrompt(write)
    const io = { write, ask: options.question ?? terminal!.question }
    const notice = (): SetupResult => {
      write(`Setup left your active connection unchanged. ${CLI_COMMAND} setup or /setup to continue.\n`)
      return previous
    }
    providers: for (;;) {
      write('\n1 / 3  Pick a provider\n')
      const index = await numberedChoice(io, 'Provider', [...codingProviders.map(spec => featured[spec.id] ?? spec.id), 'Skip for now'])
      if (index === null || index === codingProviders.length) return notice()
      const spec = codingProviders[index]!
      const settings = readUserSettings({ env })
      const accounts = Object.values(settings.connections).filter(connection => connection.provider === spec.id)
      write(`\n2 / 3  ${spec.requiresCredential ? 'Connect a key' : 'Choose a connection'} · ${featured[spec.id] ?? spec.id}\n`)
      const account = accounts.length ? await numberedChoice(io, 'Account', [
        ...accounts.map(c => `${c.id} (${needsKey(c) ? existingKey(c, env) ? 'key available' : 'key missing' : 'no key required'}${c.model ? '' : '; model not selected'})`),
        spec.requiresCredential ? 'Add another key' : 'Add another connection',
      ]) : accounts.length
      if (account === null) continue
      const saved = accounts[account]
      let connection = saved ?? await newConnection(spec.id, settings, io)
      if (!connection) continue
      write(`Endpoint: ${sanitizeUntrustedTerminalField(connection.baseUrl ?? setupMetadataEndpoint(spec.id) ?? 'provider default')}\n`)
      const credential = await connectKey(connection, env, root, io, !saved && accounts.length > 0)
      if (!credential) continue
      const snapshot = defaultSelection(settings, connection.id, env, root)
      // Persist a new account only after its key is available. On an existing
      // account, defer key replacement until the model is confirmed.
      if (!saved) {
        connection = saveAccount(connection, credential.newKey ? credential.key : undefined, env, root, (latest, account) => {
          if (Object.hasOwn(latest.connections, account.id)) throw new SetupChangedError()
          return { connections: { [account.id]: account } }
        })
        if (credential.newKey) write('Key saved. Authentication unverified; model not yet tested.\n')
      } else if (credential.newKey) write('New key entered. It will replace this account’s key reference when you confirm a model.\n')

      let checked: { models: string[]; label: string } | undefined
      const selected = { connection: connection.id }
      const isLocal = isProviderLocal(spec.id, connection.baseUrl)
      const priced = isLocal ? undefined : pricedSetupModels(connection)
      const savedModel = snapshot.remembered ?? (snapshot.connection === connection.id ? snapshot.model : undefined) ?? connection.model
      for (;;) {
        const check = await numberedChoice(io, 'Connection', ['Continue to models',
          ...(setupMetadataEndpoint(spec.id) ? ['Check connection (metadata only)'] : [])], 0)
        if (check === null) continue providers
        if (check === 1) {
          write('Checking metadata (Ctrl+C cancels setup)…\n')
          const result = await checkSetupConnection(spec.id, credential.key, env, terminal?.signal)
          terminal?.signal.throwIfAborted()
          if (result.status === 'authenticated' || result.status === 'public_catalog') {
            checked = { models: result.models, label: result.status === 'authenticated' ? 'account catalog' : 'public catalog, unverified' }
            write(result.status === 'authenticated'
              ? 'Authenticated via account metadata. Model not yet tested.\n'
              : 'Public catalog loaded. Authentication unverified; model not yet tested.\n')
          } else if (result.status === 'rejected') {
            write('The provider denied access to account metadata. Check the key and account permissions, then try again.\n')
            continue providers
          } else {
            if (checked) checked.label = 'cached catalog, unverified'
            const detail = result.status === 'offline' ? 'Offline mode; no request was sent.' : 'Metadata check unavailable.'
            write(`${detail} Using ${checked ? 'cached' : 'bundled'} choices, unverified.\n`)
          }
        }
        let budget: number | 'unlimited' | undefined
        for (;;) {
          const capped = !isLocal && [snapshot.userBudget, snapshot.effectiveBudget.value, budget].some(value => typeof value === 'number')
          const model = await pickSetupModel(io, connection, { catalog: checked, savedModel, priced: capped ? priced : undefined })
          if (model === null) break
          if (credential.key && model.includes(credential.key)) {
            write('Enter a model ID, not a credential. Nothing was selected.\n')
            continue
          }
          if (!isLocal && snapshot.userBudget === undefined && budget === undefined) {
            const choice = await chooseSpending(io, snapshot.effectiveBudget.value !== null)
            if (choice === null) continue
            budget = choice
            if (typeof budget === 'number' && !priced?.has(model)) {
              write('The selected model has no known pricing for this cap. No model was saved or substituted.\n')
              continue
            }
          }
          const replaceKey = Boolean(saved && credential.newKey)
          saveAccount(connection, replaceKey ? credential.key : undefined, env, root, (latest, account) => {
            if (!isDeepStrictEqual(latest.connections[account.id], connection) ||
                !isDeepStrictEqual(defaultSelection(latest, account.id, env, root), snapshot)) throw new SetupChangedError()
            return {
              connections: { [account.id]: { ...account, model } },
              defaults: { ...selected, model, modelsByConnection: { ...latest.defaults?.modelsByConnection, [account.id]: model },
                ...(budget !== undefined ? { budgetUsd: budget } : {}) },
              setup: { completed: true, step: 'complete', ...selected },
            }
          })
          if (replaceKey) write('Key saved.\n')
          const status = getSetupStatus(env, {}, root)
          if (status.unavailableConnection) {
            write(`Saved as your user default. ${unavailableNotice}\n`)
          } else if (status.connection !== connection.id || status.model !== model) {
            write('Saved as your user default. An environment or project override still controls the effective selection; see provider status.\n')
          } else if (status.state === 'configured_unverified') {
            write(`Selected ${connection.id} · ${model}. Model not yet tested.\n`)
          } else write('Choices saved. Action is required before chat; see provider status.\n')
          return { ...status, saved: { ...selected, model } }
        }
      }
    }
  } catch (error) {
    if (error instanceof SetupCancelled) {
      write(`Setup cancelled. ${CLI_COMMAND} setup or /setup to continue.\n`)
      return previous
    }
    if (error instanceof UnsafeAccountLocationError || error instanceof ProfileAccountRecoveryError) write(`${error.message}\n`)
    else if (error instanceof SetupChangedError) write('Connection or spending preferences changed during setup. Run setup again to review the latest choices.\n')
    else write('Setup could not finish. Check that your private Babel profile is valid and writable, then run setup again.\n')
    return { ...previous, failed: true }
  } finally {
    terminal?.close()
  }
}

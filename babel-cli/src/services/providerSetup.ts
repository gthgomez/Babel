/** First-run provider setup without network requests or automatic provider selection. */
import { createInterface } from 'node:readline/promises'
import { isDeepStrictEqual } from 'node:util'
import { prepareUserSettingsUpdate, readUserSettings, updateUserSettings, type UserSettings } from '../config/userSettings.js'
import { promptForProviderCredential } from '../config/interactiveCredential.js'
import { resolvePrivateCredentialEnvPath } from '../config/envBootstrap.js'
import { connectionStatus, type SelectionSession } from './connectionSettings.js'
import { getProviderSpec, isProviderId, listProviderSpecs, type ProviderId } from '../runners/providerRegistry.js'
import { CLI_COMMAND } from '../cli/commandName.js'
import { formatManualProviderEnvExample } from '../cli/firstRunText.js'
import { getAvailableModels } from '../modelPolicy.js'
import { sanitizeUntrustedTerminalField } from '../ui/sanitize.js'

export interface SetupResult {
  state: 'setup_required' | 'configured_unverified' | 'action_required'
  connection: string | null
  provider: string | null
  model: string | null
}

/** Presence is a local prerequisite; it never proves authentication or model health. */
export function getSetupStatus(env: NodeJS.ProcessEnv = process.env, session: SelectionSession = {}, projectRoot = process.cwd()): SetupResult {
  const status = connectionStatus(session, projectRoot, env)
  return { state: status.state as SetupResult['state'], connection: status.connection, provider: status.provider, model: status.model }
}

type AskSetup = (prompt: string) => Promise<string>

async function chooseSetupModel(
  provider: ProviderId, remembered: string | undefined, ask: AskSetup, write: (text: string) => void,
): Promise<string | undefined> {
  const known = [...new Set(getAvailableModels().filter(({ entry }) => entry.provider === provider &&
    entry.enabled !== false && (entry.native_tool_use !== false || provider === 'ollama')).map(({ entry }) => entry.model_id))]
  let query = ''
  for (;;) {
    const shown = known.filter(id => id.toLowerCase().includes(query)).slice(0, 8)
    if (shown.length) write(`Bundled models for ${provider} (unverified):\n${shown.map((id, index) => `#${index + 1}. ${sanitizeUntrustedTerminalField(id)}\n`).join('')}`)
    else if (query) write('No matching models. Search again or enter an exact model ID.\n')
    const answer = (await ask(`Exact model ID${remembered ? ` [${sanitizeUntrustedTerminalField(remembered)}]` : ''} (#number or /search text): `)).trim()
    if (answer === '/search' || answer.startsWith('/search ')) {
      query = answer.slice('/search'.length).trim().toLowerCase()
      continue
    }
    if (/^#\d+$/.test(answer)) {
      const model = shown[Number(answer.slice(1)) - 1]
      if (model) return model
      write('Choose a displayed model number.\n')
      continue
    }
    return answer || remembered
  }
}

/** Publish the selected account, exact model and default budget only on confirmation. */
export async function runProviderSetup(options: {
  env?: NodeJS.ProcessEnv
  interactive?: boolean
  projectRoot?: string
  question?: AskSetup
  write?: (text: string) => void
} = {}): Promise<SetupResult & { cancelled?: true }> {
  const env = options.env ?? process.env
  const write = options.write ?? (text => process.stderr.write(text))
  const envFile = resolvePrivateCredentialEnvPath(env)
  const projectRoot = options.projectRoot ?? env['BABEL_PROJECT_ROOT'] ?? process.cwd()
  const current = () => getSetupStatus(env, {}, projectRoot)
  const cancelled = () => ({ ...current(), cancelled: true as const })
  write('\nBabel is a coding agent that can inspect your project, make requested changes, and verify the result using the model provider you choose.\n')
  write('Setup sends no model requests. Credentials stay in your private profile; preferences never contain API keys.\n')
  write(`Private provider file: ${envFile}\n`)
  if (!(options.interactive ?? (process.stdin.isTTY && process.stderr.isTTY && !env['CI']))) {
    write(`${formatManualProviderEnvExample(envFile)}\n`)
    write(`Or use provider list, provider connect <provider> --model <exact-id>, then provider use <connection> --save user.\n`)
    write(`Use settings set budgetUsd <amount|unlimited> to choose a budget.\n`)
    return current()
  }
  const cancellation = new AbortController()
  let rl: ReturnType<typeof createInterface> | undefined
  const ask = options.question ?? ((prompt: string) => {
    if (!rl) {
      rl = createInterface({ input: process.stdin, output: process.stderr })
      rl.on('SIGINT', () => cancellation.abort())
    }
    return rl.question(prompt, { signal: cancellation.signal })
  })
  try {
    const previous = readUserSettings({ env })
    const previousId = typeof previous.setup?.['connection'] === 'string' ? previous.setup['connection'] : previous.defaults?.connection
    const old = previousId ? previous.connections[previousId] : undefined
    const providers = listProviderSpecs()
    const qualified = providers.filter(spec => spec.authorityConformance === 'certified' && spec.operations.includes('native_tool_stream'))
    const featured = new Map<ProviderId, string>([['openrouter', 'OpenRouter'], ['command-code', 'Command Code']])
    const codingProviders = [...[...featured.keys()].flatMap(id => qualified.filter(spec => spec.id === id)),
      ...qualified.filter(spec => !featured.has(spec.id))]
    write(`${codingProviders.map((spec, index) => `${index + 1}. ${featured.get(spec.id) ?? spec.id}\n`).join('')}0. Skip setup\n`)
    write(`Other registered providers, not yet qualified for coding: ${providers.filter(spec => !codingProviders.includes(spec)).map(spec => spec.id).join(', ')}. Use provider list for capabilities.\n`)
    const providerChoice = (await ask(`Provider${old ? ` [${old.provider}]` : ''} (number or name): `)).trim()
    if (providerChoice === '0' || (!providerChoice && !old)) return cancelled()
    const selected = /^\d+$/.test(providerChoice) ? codingProviders[Number(providerChoice) - 1]?.id
      : providerChoice || old?.provider
    if (!selected || !isProviderId(selected)) throw new Error('Choose a provider from provider list. No default cloud provider is selected.')
    if (!codingProviders.some(spec => spec.id === selected)) throw new Error(`UNSUPPORTED_OPERATION: ${selected} is not yet qualified for coding. Choose one of the coding providers above; no default connection was changed.`)
    const accounts = Object.values(previous.connections).filter(connection => connection.provider === selected)
    if (accounts.length) write(`Saved ${selected} accounts: ${accounts.map(account => account.id).join(', ')}\n`)
    const suggested = old?.provider === selected ? old.id : accounts[0]?.id ?? selected
    const id = (await ask(`Connection name [${suggested}]: `)).trim() || suggested
    const spec = getProviderSpec(selected)
    const saved = previous.connections[id]
    if (saved && saved.provider !== selected) throw new Error('That connection name belongs to another provider; choose another name.')
    const custom = selected === 'openai-compatible'
    const baseUrl = custom ? (await ask(`Compatible API base URL${saved?.baseUrl ? ` [${saved.baseUrl}]` : ''}: `)).trim() || saved?.baseUrl : undefined
    const authentication = custom ? (/^(?:n|no)$/i.test((await ask('Does this endpoint require an API key? [Y/n]: ')).trim()) ? 'none' as const : 'api-key' as const) : undefined
    const connection = { ...saved, id, provider: selected, ...(baseUrl ? { baseUrl } : {}), ...(authentication ? { authentication } : {}) }
    const remembered = (previous.defaults?.connection === id ? previous.defaults.model : undefined)
      ?? previous.defaults?.modelsByConnection?.[id] ?? saved?.model
    const model = await chooseSetupModel(selected, remembered, ask, write)
    if (!model) throw new Error('A model ID is required.')
    const contextRaw = (await ask(`Context capacity in tokens${saved?.contextWindow ? ` [${saved.contextWindow}]` : ' (blank if unknown)'}: `)).trim()
    const outputRaw = (await ask(`Output budget in tokens${saved?.maxOutputTokens ? ` [${saved.maxOutputTokens}]` : ' (blank for transport default)'}: `)).trim()
    const contextWindow = contextRaw ? Number(contextRaw) : saved?.contextWindow
    const maxOutputTokens = outputRaw ? Number(outputRaw) : saved?.maxOutputTokens
    const updated = { ...connection, model, ...(contextWindow !== undefined ? { contextWindow } : {}), ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}) }
    write('Finite USD caps are supported by standard Work with conservative per-request preauthorization. Plan, thorough review and Apply currently reject finite caps before inference; offline/local routes are exempt because they cannot spend remote money. Choosing unlimited explicitly permits those lanes without a dollar ceiling.\n')
    const userBudget = previous.defaults?.budgetUsd
    const budgetRaw = (await ask(`Per-task budget in USD, or unlimited${userBudget === undefined ? ' (explicit choice required)' : ` [${userBudget}]`}: `)).trim()
      || String(userBudget ?? '')
    const budget = budgetRaw === 'unlimited' ? budgetRaw : Number(budgetRaw)
    if (budget !== 'unlimited' && (!Number.isFinite(budget) || budget <= 0)) throw new Error('Choose a positive budget or unlimited.')
    write(`Connection: ${sanitizeUntrustedTerminalField(id)} (${selected}); model: ${sanitizeUntrustedTerminalField(model)}; budget: ${budget === 'unlimited' ? 'unlimited' : `$${budget} per task`}.\n`)
    write("Plan is read-only by default. Ordinary Chat execution defaults to host_native, which runs eligible commands with your OS user's authority and is not an OS sandbox. Selecting a container profile such as safe_repo requires Docker and a usable sandbox image.\n")
    if (!/^(?:y|yes)$/i.test((await ask('Save this connection and budget as your user default? [y/N]: ')).trim())) {
      write(`Setup left your active connection unchanged. Run ${CLI_COMMAND} setup to try again.\n`)
      return cancelled()
    }
    const settingsChange = (latest: UserSettings): Partial<UserSettings> => {
      if (!isDeepStrictEqual(latest.connections[id], saved) || !isDeepStrictEqual(latest.defaults, previous.defaults)) {
        throw new Error('Connection or default preferences changed during setup. Run setup again to review the latest settings.')
      }
      return {
        connections: { [id]: updated },
        defaults: { connection: id, model, budgetUsd: budget, modelsByConnection: { ...latest.defaults?.modelsByConnection, [id]: model } },
        setup: { completed: true, step: 'complete', connection: id },
      }
    }
    const variable = updated.apiKeyEnvVar ?? spec.credentialEnvVar
    if (connection.authentication !== 'none' && spec.requiresCredential && variable && !env[variable]?.trim()) {
      prepareUserSettingsUpdate(readUserSettings({ env }), settingsChange)
      write(`This connection uses ${variable}. A masked prompt can store it in ${envFile} without printing the key.\n`)
      if (!/^(?:y|yes)$/i.test((await ask('Save a key to your private profile using masked entry? [y/N]: ')).trim())) {
        write(`Set ${variable} in ${envFile} (for example ${variable}=your-key-here) or in your environment, then run setup again.\n`)
        return cancelled()
      }
      rl?.close(); rl = undefined
      if (!await promptForProviderCredential(variable, env)) return cancelled()
    }
    updateUserSettings(settingsChange, { env })
    write(`Configured, connectivity unverified. No request has been sent.\nNext: ${CLI_COMMAND} doctor for execution prerequisites, then ${CLI_COMMAND} work "Explain this project".\nCommands: /provider status, /model use <id>, /mode plan, /settings show, /help.\n`)
    return current()
  } catch (error) {
    if (!cancellation.signal.aborted) throw error
    write(`\nSetup cancelled. Run ${CLI_COMMAND} setup or /setup to continue.\n`)
    return cancelled()
  } finally { rl?.close() }
}

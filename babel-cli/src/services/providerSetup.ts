/** Resumable first-run setup; no inference or automatic provider selection. */
import { createInterface } from 'node:readline/promises'
import { readUserSettings, updateUserSettings, resolveEffectiveSettings } from '../config/userSettings.js'
import { promptForProviderCredential } from '../config/interactiveCredential.js'
import { connectionStatus, type SelectionSession } from './connectionSettings.js'
import { getProviderSpec, isProviderId, listProviderSpecs } from '../runners/providerRegistry.js'

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

/** Explicit choices are persisted as progress; only confirmation saves the initial default. */
export async function runProviderSetup(options: {
  env?: NodeJS.ProcessEnv
  interactive?: boolean
  question?: (prompt: string) => Promise<string>
  write?: (text: string) => void
} = {}): Promise<SetupResult> {
  const env = options.env ?? process.env
  const write = options.write ?? (text => process.stderr.write(text))
  write('\nBabel is a coding agent that can inspect your project, make requested changes, and verify the result using the model provider you choose.\n')
  write('Setup sends no model requests. Credentials stay in your private profile; preferences never contain API keys.\n')
  if (!(options.interactive ?? (process.stdin.isTTY && process.stderr.isTTY && !env['CI']))) {
    write('Run babel-agent setup in a terminal for guided setup.\nOr use provider list, provider connect <provider> --model <exact-id>, then provider use <connection> --save user.\nUse settings set budgetUsd <amount|unlimited> to choose a budget.\n')
    return getSetupStatus(env)
  }
  let rl: ReturnType<typeof createInterface> | undefined
  const ask = options.question ?? ((prompt: string) => {
    rl ??= createInterface({ input: process.stdin, output: process.stderr })
    return rl.question(prompt)
  })
  try {
    const previous = readUserSettings({ env })
    const previousId = typeof previous.setup?.['connection'] === 'string' ? previous.setup['connection'] : previous.defaults?.connection
    const old = previousId ? previous.connections[previousId] : undefined
    const providers = listProviderSpecs()
    const codingProviders = providers.filter(spec => spec.authorityConformance === 'certified' && spec.operations.includes('native_tool_stream'))
    write(`Providers: ${codingProviders.map(spec => spec.id).join(', ')}\n`)
    write(`Other registered providers, not yet qualified for coding: ${providers.filter(spec => !codingProviders.includes(spec)).map(spec => spec.id).join(', ')}. Use provider list for capabilities.\n`)
    const selected = (await ask(`Provider${old ? ` [${old.provider}]` : ''}: `)).trim() || old?.provider
    if (!selected || !isProviderId(selected)) throw new Error('Choose a provider from provider list. No default cloud provider is selected.')
    if (!codingProviders.some(spec => spec.id === selected)) throw new Error(`UNSUPPORTED_OPERATION: ${selected} is not yet qualified for coding. Choose one of the coding providers above; no default connection was changed.`)
    const id = (await ask(`Connection name [${old?.id ?? selected}]: `)).trim() || old?.id || selected
    const spec = getProviderSpec(selected)
    const saved = previous.connections[id]
    if (saved && saved.provider !== selected) throw new Error('That connection name belongs to another provider; choose another name.')
    const custom = selected === 'openai-compatible'
    const baseUrl = custom ? (await ask(`Compatible API base URL${saved?.baseUrl ? ` [${saved.baseUrl}]` : ''}: `)).trim() || saved?.baseUrl : undefined
    const authentication = custom ? (/^(?:n|no)$/i.test((await ask('Does this endpoint require an API key? [Y/n]: ')).trim()) ? 'none' as const : 'api-key' as const) : undefined
    const connection = { ...saved, id, provider: selected, ...(baseUrl ? { baseUrl } : {}), ...(authentication ? { authentication } : {}) }
    updateUserSettings({ connections: { [id]: connection }, setup: { step: 'model', connection: id } }, { env })
    const model = (await ask(`Exact model ID${saved?.model ? ` [${saved.model}]` : ''}: `)).trim() || saved?.model
    if (!model) throw new Error('A model ID is required. Setup progress was saved.')
    const contextRaw = (await ask(`Context capacity in tokens${saved?.contextWindow ? ` [${saved.contextWindow}]` : ' (blank if unknown)'}: `)).trim()
    const outputRaw = (await ask(`Output budget in tokens${saved?.maxOutputTokens ? ` [${saved.maxOutputTokens}]` : ' (blank for transport default)'}: `)).trim()
    const contextWindow = contextRaw ? Number(contextRaw) : saved?.contextWindow
    const maxOutputTokens = outputRaw ? Number(outputRaw) : saved?.maxOutputTokens
    const updated = { ...connection, model, ...(contextWindow !== undefined ? { contextWindow } : {}), ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}) }
    updateUserSettings({ connections: { [id]: updated }, setup: { step: 'credential', connection: id } }, { env })
    const variable = updated.apiKeyEnvVar ?? spec.credentialEnvVar
    if (connection.authentication !== 'none' && spec.requiresCredential && variable && !env[variable]?.trim()) {
      write(`This connection uses ${variable}.\n`)
      if (!/^(?:y|yes)$/i.test((await ask('Save a key to your private profile using masked entry? [y/N]: ')).trim())) {
        write(`Set ${variable} in your environment, then resume setup.\n`)
        return { state: 'action_required', connection: id, provider: selected, model }
      }
      rl?.close(); rl = undefined
      await promptForProviderCredential(variable, env)
    }
    updateUserSettings({ setup: { step: 'budget', connection: id } }, { env })
    write('Finite USD caps are supported by standard Work. Plan, thorough review and Apply currently reject finite caps before inference; choosing unlimited explicitly permits those lanes without a dollar ceiling.\n')
    const budgetRaw = (await ask('Per-task budget in USD, or unlimited (explicit choice required): ')).trim()
    const budget = budgetRaw === 'unlimited' ? budgetRaw : Number(budgetRaw)
    if (budget !== 'unlimited' && (!Number.isFinite(budget) || budget <= 0)) throw new Error('Choose a positive budget or unlimited. Setup progress was saved.')
    write(`Connection: ${id} (${selected}); model: ${model}; budget: ${budget === 'unlimited' ? 'unlimited' : `$${budget} per task`}.\n`)
    write('Plan is read-only by default. Execution uses the active permission policy and safe_repo sandbox; Docker and a usable sandbox image are required for sandboxed commands.\n')
    if (!/^(?:y|yes)$/i.test((await ask('Save this connection and budget as your user default? [y/N]: ')).trim())) {
      write('Connection saved; your default selection was not changed. Resume with babel-agent setup.\n')
      return getSetupStatus(env)
    }
    updateUserSettings({ defaults: { connection: id, model, budgetUsd: budget }, setup: { completed: true, step: 'complete', connection: id } }, { env })
    write('Configured, connectivity unverified. No request has been sent.\nNext: babel-agent doctor for execution prerequisites, then babel-agent work "Explain this project".\nCommands: /provider status, /model use <id>, /mode plan, /settings show, /help.\n')
    return getSetupStatus(env)
  } finally { rl?.close() }
}

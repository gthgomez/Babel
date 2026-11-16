/** Resumable first-run setup; no inference or automatic provider selection. */
import { createInterface } from 'node:readline/promises'
import { readUserSettings, updateUserSettings, type Connection } from '../config/userSettings.js'
import { promptForProtectedCredential, promptForProviderCredential } from '../config/interactiveCredential.js'
import { isSharedCredentialReference } from '../config/sharedCredentialStore.js'
import { resolvePrivateCredentialEnvPath } from '../config/envBootstrap.js'
import { connectionStatus, type SelectionSession } from './connectionSettings.js'
import { getProviderSpec, isApprovedProductProvider, listProviderSpecs } from '../runners/providerRegistry.js'
import { getAvailableModels } from '../modelPolicy.js'
import { CLI_COMMAND } from '../cli/commandName.js'
import { readProviderModelCatalog } from './providerModelCatalog.js'
import { formatManualProviderEnvExample } from '../cli/firstRunText.js'

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

/** Save explicit connection choices without claiming live provider health. */
export async function runProviderSetup(options: {
  env?: NodeJS.ProcessEnv
  interactive?: boolean
  /** Session-only credentials are useful only when setup continues into this process's chat. */
  sessionCredentials?: boolean
  initialConnection?: string
  offerCredentialReplacement?: boolean
  projectRoot?: string
  question?: (prompt: string) => Promise<string>
  write?: (text: string) => void
  /** Tests may supply a synthetic reference without touching the host keychain. */
  promptProtectedCredential?: () => Promise<string | null>
} = {}): Promise<SetupResult> {
  const env = options.env ?? process.env
  const write = options.write ?? (text => process.stderr.write(text))
  const envFile = resolvePrivateCredentialEnvPath(env)
  write('\nBabel is a coding agent that can inspect your project, make requested changes, and verify the result using the model provider you choose.\n')
  write('Setup sends no model requests. Preferences never contain API keys.\n')
  write(`Private provider file: ${envFile}\n`)
  if (!(options.interactive ?? (process.stdin.isTTY && process.stderr.isTTY && !['1', 'true'].includes(env['CI'] ?? '') && !['1', 'true'].includes(env['BABEL_HEADLESS'] ?? '')))) {
    write(`${formatManualProviderEnvExample(envFile)}\n`)
    write(`Or use provider list, provider connect <provider> --model <exact-id>, then provider use <connection> --save user.\n`)
    write(`Use settings set budgetUsd <amount|unlimited> to choose a budget.\n`)
    return getSetupStatus(env, {}, options.projectRoot)
  }
  let rl: ReturnType<typeof createInterface> | undefined
  const ask = options.question ?? ((prompt: string) => {
    rl ??= createInterface({ input: process.stdin, output: process.stderr })
    return rl.question(prompt)
  })
  try {
    const previous = readUserSettings({ env })
    const previousId = options.initialConnection ?? (typeof previous.setup?.['connection'] === 'string' ? previous.setup['connection'] : previous.defaults?.connection)
    const old = previousId ? previous.connections[previousId] : undefined
    const providers = listProviderSpecs()
    const codingProviders = providers.filter(spec => isApprovedProductProvider(spec.id) && spec.authorityConformance === 'certified' && spec.operations.includes('native_tool_stream'))
    write(`Providers: ${codingProviders.map(spec => spec.id).join(', ')}\n`)
    const detected = codingProviders.filter(spec => spec.credentialEnvVar && env[spec.credentialEnvVar]?.trim())
    const suggested = old && isApprovedProductProvider(old.provider) ? old.provider : detected.length === 1 ? detected[0]!.id : undefined
    const selected = (await ask(`Provider${suggested ? ` [${suggested}]` : ''}: `)).trim() || suggested
    if (!selected || !isApprovedProductProvider(selected)) throw new Error('Choose an approved provider: openrouter or command-code. No default connection was changed.')
    const id = old?.provider === selected ? old.id : selected
    const spec = getProviderSpec(selected)
    const saved = previous.connections[id]
    if (saved && saved.provider !== selected) throw new Error('That connection name belongs to another provider; choose another name.')
    let connection: Connection = { ...saved, id, provider: selected }
    const initial = updateUserSettings(current => {
      const live = current.connections[id]
      if ((!saved && live) || (saved && (!live || live.provider !== saved.provider || live.credentialRef !== saved.credentialRef || live.apiKeyEnvVar !== saved.apiKeyEnvVar))) throw new Error('The connection changed while setup was opening. Retry setup.')
      return { connections: { [id]: live ?? connection }, setup: { step: 'credential', connection: id } }
    }, { env })
    connection = initial.connections[id]!
    const variable = connection.apiKeyEnvVar ?? spec.credentialEnvVar
    const saveProtectedReference = (reference: string, expected: string | undefined) => {
      if (!isSharedCredentialReference(reference)) throw new Error('Invalid protected credential reference; connection settings were preserved.')
      const updated = updateUserSettings(current => {
        const currentConnection = current.connections[id]
        if (!currentConnection || currentConnection.provider !== selected || currentConnection.credentialRef !== expected) throw new Error('The connection changed while entering the key. Review it before retrying.')
        const { apiKeyEnvVar: _previousEnvVar, ...withoutEnvOverride } = currentConnection
        return { connections: { [id]: { ...withoutEnvOverride, credentialRef: reference } } }
      }, { env })
      connection = updated.connections[id]!
    }
    if (connection.credentialRef && options.offerCredentialReplacement !== false) {
      const repair = (await ask('Protected key selected: keep [Enter] or replace [r]: ')).trim().toLowerCase()
      if (!['', 'r', 'replace'].includes(repair)) throw new Error('Choose keep or replace. Existing credentials were unchanged.')
      if (repair) {
        rl?.close(); rl = undefined
        const reference = await (options.promptProtectedCredential ?? (() => promptForProtectedCredential(env)))()
        if (!reference) return { state: 'action_required', connection: id, provider: selected, model: saved?.model ?? null }
        saveProtectedReference(reference, connection.credentialRef)
      }
    }
    if (spec.requiresCredential && variable && !connection.credentialRef && env[variable]?.trim() && options.offerCredentialReplacement && options.sessionCredentials) {
      const repair = (await ask('Credential detected: keep [Enter] or replace for this session [r]: ')).trim().toLowerCase()
      if (!['', 'r', 'replace'].includes(repair)) throw new Error('Choose keep or replace. Existing credentials were unchanged.')
      if (repair) {
        rl?.close(); rl = undefined
        if (!await promptForProviderCredential(variable, env, { persist: false, replaceExisting: true })) {
          return { state: 'action_required', connection: id, provider: selected, model: saved?.model ?? null }
        }
        write('The replacement lasts for this session. Update your environment or protected storage for future launches.\n')
      }
    }
    if (spec.requiresCredential && variable && !connection.credentialRef && !env[variable]?.trim()) {
      const sessionCredentials = options.sessionCredentials === true
      write(`This connection can use OS-protected storage or ${variable}. A private profile file stores plaintext.\n`)
      const storage = (await ask(sessionCredentials
        ? 'Key storage: OS-protected [Enter], session only [s], plaintext profile [p], or skip [k]: '
        : 'Key storage: OS-protected [Enter], plaintext profile [p], or skip [k]: ')).trim().toLowerCase()
      if (storage === 'k' || storage === 'skip') {
        write(`Set ${variable} in your environment, then resume setup.\n`)
        return { state: 'action_required', connection: id, provider: selected, model: saved?.model ?? null }
      }
      if (!(sessionCredentials ? ['', 's', 'p', 'plaintext'] : ['', 'p', 'plaintext']).includes(storage)) throw new Error('Choose an offered credential storage option. Setup progress was saved.')
      rl?.close(); rl = undefined
      if (!storage) {
        const reference = await (options.promptProtectedCredential ?? (() => promptForProtectedCredential(env)))()
        if (!reference) return { state: 'action_required', connection: id, provider: selected, model: saved?.model ?? null }
        saveProtectedReference(reference, undefined)
      } else if (!await promptForProviderCredential(variable, env, { persist: storage === 'p' || storage === 'plaintext' })) {
        write(`Set ${variable} in your environment, then resume setup.\n`)
        return { state: 'action_required', connection: id, provider: selected, model: saved?.model ?? null }
      }
    }
    let candidates: string[] = []
    let suggestedModel: string | undefined
    let suggestionExperimental = false
    try {
      const entries = getAvailableModels().filter(({ entry }) => entry.provider === selected && entry.enabled !== false)
      candidates = [...new Set(entries.map(({ entry }) => entry.model_id))]
      for (const id of readProviderModelCatalog(selected, env)?.models ?? []) if (!candidates.includes(id)) candidates.push(id)
      const suggestion = entries.find(({ entry }) => entry.native_tool_use === true && entry.native_tool_use_unverified !== true && entry.experimental !== true)
        ?? entries.find(({ entry }) => entry.native_tool_use === true && entry.native_tool_use_unverified !== true)
      suggestedModel = suggestion?.entry.model_id
      suggestionExperimental = suggestion?.entry.experimental === true
    } catch { /* Manual model entry remains available. */ }
    if (candidates.length) {
      write('Known models (catalog metadata; account access and coding capability are unverified):\n')
      candidates.forEach((candidate, index) => write(`  ${index + 1}. ${candidate}\n`))
    }
    const defaultModel = saved?.model ?? suggestedModel
    if (!saved?.model && suggestedModel) write(`Suggested from the bundled catalog: ${suggestedModel} (${suggestionExperimental ? 'experimental; ' : ''}availability is unverified).\n`)
    const modelInput = (await ask(`Model number or exact ID${defaultModel ? ` [${defaultModel}]` : ''}: `)).trim()
    const model = /^\d+$/.test(modelInput) ? candidates[Number(modelInput) - 1] : modelInput || defaultModel
    if (!model || model.length > 500 || /[\u0000-\u001f]/.test(model)) throw new Error('Choose a listed model or enter a valid exact model ID. Setup progress was saved.')
    updateUserSettings(current => {
      const latest = current.connections[id]
      if (!latest || latest.provider !== selected || latest.credentialRef !== connection.credentialRef || latest.apiKeyEnvVar !== connection.apiKeyEnvVar) throw new Error('The connection changed during setup. Review it before saving the model.')
      return { connections: { [id]: { ...latest, model } }, defaults: { connection: id, model }, setup: { completed: true, step: 'complete', connection: id } }
    }, { env })
    write('Chat follows the selected execution policy. Host-native commands use your OS authority; safe_repo requires Docker.\n')
    const status = getSetupStatus(env, { connection: id, model }, options.projectRoot)
    let overridden = false
    if (!options.sessionCredentials) {
      const effective = getSetupStatus(env, {}, options.projectRoot)
      if (effective.connection !== id || effective.model !== model) {
        overridden = true
        write('Saved as the user default, but the current project or environment selects a different route. Review provider status and change that override if needed.\n')
      }
    }
    if (status.state === 'configured_unverified' && overridden) write('The saved choice is unverified. No request has been sent.\n')
    else if (status.state === 'configured_unverified') write(`Configured, connectivity unverified. No request has been sent. Type a task, or use ${CLI_COMMAND} work "Explain this project".\n`)
    else write('Choices saved. Action required before this connection can run; use provider status for details.\n')
    return status
  } finally { rl?.close() }
}

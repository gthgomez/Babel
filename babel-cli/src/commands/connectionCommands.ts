/** One command grammar for CLI and slash connection/model/settings operations. */
import { Command, CommanderError } from 'commander'
import { resolveEffectiveSettings } from '../config/userSettings.js'
import { connectProvider, connectionStatus, listConnectionModels, listConnections, savePreferences, selectConnection, selectModel, type SaveScope, type SelectionSession } from '../services/connectionSettings.js'
import { inspectDefaults } from '../services/defaultsInspection.js'
import { connectionModelSelector } from '../config/connectionModelPolicy.js'
import type { ReplContext } from '../interactive/context.js'

interface CommandHost {
  session?: SelectionSession
  projectRoot?: string
  interactive?: boolean
  emit?: (value: unknown) => void
  select?: (selection: SelectionSession) => void
}

function scope(value: string | undefined): SaveScope | undefined {
  if (value === undefined) return undefined
  if (value !== 'user' && value !== 'project') throw new Error('--save must be user or project.')
  return value
}

/** Register the same grammar on a real CLI or a temporary slash parser. */
export function registerConnectionCommands(program: Command, host: CommandHost = {}): void {
  const emit = host.emit ?? (value => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`))
  const selectionOptions = (command: Command) => command.option('--save <scope>', 'Persist explicitly: user or project').option('--json', 'Emit structured JSON')
  const requireScope = (save: SaveScope | undefined): void => {
    if (!host.interactive && !save) throw new Error('Use --save user|project to retain a CLI selection. Inside Babel, /provider use and /model use change only the current session.')
  }
  const provider = program.command('provider').description('Manage provider connections and credential references')
  provider.command('list').description('List providers, capabilities and configured connections').option('--json').action(() => emit(listConnections()))
  provider.command('status').description('Show exact selection and local prerequisites; no network request').option('--json').action(() => emit(connectionStatus(host.session, host.projectRoot)))
  provider.command('connect <provider>').description('Save a provider connection; use setup for masked credential entry')
    .option('--name <id>', 'Connection name; supports multiple accounts for one provider')
    .option('--model <id>', 'Exact provider model ID')
    .option('--base-url <url>', 'Explicit compatible endpoint base URL')
    .option('--api-key-env <name>', 'Credential environment variable name, never its value')
    .option('--no-auth', 'Explicitly use a custom compatible endpoint without authentication; price remains unknown')
    .option('--context-window <tokens>', 'Declared context capacity', Number)
    .option('--max-output-tokens <tokens>', 'Output token budget', Number)
    .action((providerId: string, options: { name?: string; model?: string; baseUrl?: string; apiKeyEnv?: string; contextWindow?: number; maxOutputTokens?: number; auth?: boolean }) => {
      const connection = connectProvider(providerId, { ...options, ...(options.auth === false ? { authentication: 'none' as const } : {}), ...(options.apiKeyEnv ? { apiKeyEnvVar: options.apiKeyEnv } : {}) })
      emit({ saved: true, connection: connection.id, provider: connection.provider, model: connection.model ?? null,
        nextCommand: `babel-agent provider use ${connection.id} --save user`, connectivity: 'unverified' })
    })
  selectionOptions(provider.command('use <connection>').description('Select a configured connection; save scope is explicit'))
    .action((id: string, options: { save?: string }) => {
      const save = scope(options.save)
      requireScope(save)
      const next = selectConnection(id, host.session ?? {}, { ...(save ? { save } : {}), ...(host.projectRoot ? { projectRoot: host.projectRoot } : {}) })
      host.select?.(next)
      emit({ selected: next.connection, model: next.model ?? null, scope: save ?? 'session', connectivity: 'unverified' })
    })
  const model = program.command('model').description('Choose an exact model on the selected connection')
  model.command('list').description('List known models; manual exact IDs are accepted').option('--json').action(() => emit(listConnectionModels(host.session, host.projectRoot)))
  model.command('show').description('Show requested model, provider and selection source').option('--json').action(() => emit(connectionStatus(host.session, host.projectRoot)))
  selectionOptions(model.command('use <model>').description('Select an exact model ID without changing provider'))
    .action((id: string, options: { save?: string }) => {
      const save = scope(options.save)
      requireScope(save)
      const next = selectModel(id, host.session ?? {}, { ...(save ? { save } : {}), ...(host.projectRoot ? { projectRoot: host.projectRoot } : {}) })
      host.select?.(next)
      emit({ selected: next.model, connection: next.connection, scope: save ?? 'session', observedModel: null })
    })
  const settings = program.command('settings').description('Inspect effective settings and save explicit preferences')
  settings.command('show').description('Show values, source and scope').option('--json').action(() => emit(inspectDefaults(host.session, host.projectRoot)))
  settings.command('set <key> <value>').description('Save workflow, review, plans.autoApply or budgetUsd in private preferences')
    .option('--save <scope>', 'Save scope: user or project', 'user')
    .action((key: string, value: string, options: { save: string }) => {
      const save = scope(options.save)!
      if (key === 'workflow') {
        if (value !== 'work' && value !== 'plan') throw new Error('workflow must be work or plan.')
        savePreferences({ workflow: value }, save, host.projectRoot)
      } else if (key === 'review') {
        if (value !== 'standard' && value !== 'thorough') throw new Error('review must be standard or thorough.')
        savePreferences({ review: value }, save, host.projectRoot)
      } else if (key === 'plans.autoApply') {
        if (value !== 'true' && value !== 'false') throw new Error('plans.autoApply must be true or false.')
        savePreferences({ plans: { autoApply: value === 'true' } }, save, host.projectRoot)
      } else if (key === 'budgetUsd') {
        const budget = value === 'unlimited' ? value : Number(value)
        if (budget !== 'unlimited' && (!Number.isFinite(budget) || budget <= 0)) throw new Error('budgetUsd must be a positive number or unlimited.')
        savePreferences({ budgetUsd: budget }, save, host.projectRoot)
      } else throw new Error('Unknown setting. Use workflow, review, plans.autoApply or budgetUsd; provider/model have their own commands.')
      emit({ saved: key, value, scope: save })
    })
}

/** Run shared command definitions inside the current TUI session. */
export async function handleConnectionCommand(ctx: ReplContext, name: 'provider' | 'model' | 'settings', args: string[]): Promise<void> {
  const program = new Command().name('babel-agent').exitOverride()
  program.configureOutput({ writeOut: text => console.log(text), writeErr: text => console.error(text) })
  const parts = ctx.state.model?.startsWith('connection/') ? ctx.state.model.split('/') : []
  const session = ctx.state.modelSource && ctx.state.modelSource !== 'session' ? {} : { ...(ctx.state.connectionId ? { connection: ctx.state.connectionId } : {}), ...(parts.length > 2 ? { model: parts.slice(2).join('/') } : {}) }
  registerConnectionCommands(program, {
    interactive: true, session, projectRoot: ctx.resolveCurrentTarget().targetRoot ?? process.cwd(),
    emit: value => {
      const evidence = name === 'settings' && (!args.length || args[0] === 'show')
        ? { runInstructionManifest: ctx.chatEngine?.getInstructionManifest() ?? null }
        : name !== 'settings' ? { lastInvocation: ctx.chatEngine?.getProviderSelectionStatus() ?? null } : {};
      console.log(JSON.stringify(value && typeof value === 'object' ? { ...value, ...evidence } : value, null, 2));
    },
    select: selection => {
      ctx.chatEngine?.closeAdmissionStore?.()
      ctx.chatEngine = undefined
      if (selection.connection) ctx.state.connectionId = selection.connection
      if (selection.connection && selection.model) {
        ctx.state.model = connectionModelSelector(selection.connection, selection.model)
        ctx.state.resolvedModelId = selection.model
      } else { delete ctx.state.model; delete ctx.state.resolvedModelId }
      ctx.state.modelSource = 'session'
      ctx.state.readinessState = connectionStatus(selection, ctx.resolveCurrentTarget().targetRoot).state as NonNullable<typeof ctx.state.readinessState>
      delete ctx.state.savedPlanId
      delete ctx.state.pendingPlanBody
      ctx.saveSessionState()
    },
  })
  try { await program.parseAsync(['node', 'babel-agent', name, ...(args.length ? args : [name === 'provider' ? 'status' : name === 'model' ? 'show' : 'show'])]) }
  catch (error) {
    if (error instanceof CommanderError && error.code === 'commander.helpDisplayed') return
    console.error(error instanceof Error ? error.message : 'Command failed.')
  }
}

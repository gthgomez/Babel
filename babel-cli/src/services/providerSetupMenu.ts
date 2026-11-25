/** Numbered setup choices, including a searchable, paged model list. */
import type { Connection } from '../config/userSettings.js'
import { getAvailableModels } from '../modelPolicy.js'
import type { SetupQuestion } from '../ui/setupPrompt.js'
import { isSetupModelId } from './providerSetupCatalog.js'

export interface SetupIO {
  ask: SetupQuestion
  write: (text: string) => void
}

function asIndex(input: string, length: number, defaultIndex?: number): number | undefined {
  if (!input) return defaultIndex
  const index = /^\d+$/.test(input) ? Number(input) - 1 : -1
  return index >= 0 && index < length ? index : undefined
}

function printChoices(io: SetupIO, choices: readonly string[], defaultIndex?: number): void {
  choices.forEach((label, index) => io.write(`  ${index + 1}. ${label}${index === defaultIndex ? ' [Enter]' : ''}\n`))
}

/** Enter requires a visible default. Escape always returns to the caller. */
export async function numberedChoice(io: SetupIO, title: string, choices: readonly string[], defaultIndex?: number): Promise<number | null> {
  printChoices(io, choices, defaultIndex)
  for (;;) {
    const answer = await io.ask(`${title} number (Esc back): `)
    if (answer === null) return null
    const index = asIndex(answer.trim(), choices.length, defaultIndex)
    if (index !== undefined) return index
    io.write('Choose one of the displayed numbers.\n')
  }
}

function bundledModels(connection: Connection, io: SetupIO): string[] {
  try {
    return getAvailableModels()
      .filter(({ entry }) => entry.provider === connection.provider && entry.enabled !== false &&
        (entry.native_tool_use !== false || connection.provider === 'ollama') && isSetupModelId(entry.model_id))
      .map(({ entry }) => entry.model_id)
  } catch {
    io.write('Bundled model catalog unavailable.\n')
    return []
  }
}

/** A finite-cap route needs policy prices and a context bound, not unverified catalog data. */
export function pricedSetupModels(connection: Connection): ReadonlySet<string> {
  try {
    return new Set(getAvailableModels()
      .filter(({ entry }) => entry.provider === connection.provider && entry.enabled !== false &&
        Number.isSafeInteger(entry.context_window) && (entry.context_window ?? 0) > 0 &&
        (entry.estimated_cost_per_1m_input ?? -1) >= 0 && Number.isFinite(entry.estimated_cost_per_1m_input) &&
        (entry.estimated_cost_per_1m_output ?? -1) >= 0 && Number.isFinite(entry.estimated_cost_per_1m_output))
      .map(({ entry }) => entry.model_id))
  } catch { return new Set() }
}

function flashPriority(id: string): number {
  const exact = /^(?:deepseek\/)?deepseek-v4(\.1)?-flash(?:-\d+)?$/i.exec(id)
  return exact ? exact[1] ? 0 : 1 : 2
}

/** Models for this provider only. Metadata is not model qualification. */
export async function pickSetupModel(io: SetupIO, connection: Connection, options: {
  catalog?: { models: string[]; label: string } | undefined
  savedModel?: string | undefined
  priced?: ReadonlySet<string> | undefined
}): Promise<string | null> {
  const { catalog, priced, savedModel } = options
  io.write(`\n3 / 3  Pick a model · ${connection.id}\n`)
  io.write('Choose an exact route to save as your user default. No model has been tested.\n')
  if (priced) io.write('With a finite spending cap, choose a model with known pricing in Babel policy.\n')
  if (priced?.size === 0) io.write('This route has no models Babel can preauthorize under a finite cap. Press Esc to go back.\n')
  const label = catalog?.label ?? 'bundled catalog, unverified'
  const entries = new Map((catalog?.models ?? bundledModels(connection, io)).map(id => [id, label]))
  if (isSetupModelId(savedModel) && !entries.has(savedModel)) entries.set(savedModel, 'saved, not in this catalog; unverified')
  const ids = [...entries.keys()].filter(id => !priced || priced.has(id)).sort((a, b) => flashPriority(a) - flashPriority(b))
  const pageSize = 8
  // Keep a remembered model visible on the first page without hiding the
  // featured choices. Enter can only accept a displayed model.
  const savedPosition = savedModel ? ids.indexOf(savedModel) : -1
  if (savedPosition >= pageSize) ids.splice(pageSize - 1, 0, ids.splice(savedPosition, 1)[0]!)
  const savedUnpriced = Boolean(savedModel && priced && !priced.has(savedModel))
  if (savedUnpriced) io.write('Your saved model has no known pricing for this cap. Select another exact model to change it.\n')
  let search = ''
  let page = 0
  for (;;) {
    const matches = ids.filter(id => id.toLowerCase().includes(search))
    const shown = matches.slice(page * pageSize, (page + 1) * pageSize)
    const savedIndex = shown.findIndex(id => id === savedModel)
    const defaultIndex = savedIndex >= 0 ? savedIndex : shown.length > 0 && !savedUnpriced ? 0 : undefined
    if (!shown.length) io.write('No matching models. Search again or choose Advanced.\n')
    else printChoices(io, shown.map(id => `${id} (${entries.get(id)})`), defaultIndex)
    const extra = `${page ? ', p for previous' : ''}${(page + 1) * pageSize < matches.length ? ', n for next' : ''}`
    const answer = await io.ask(`Model number, search text${extra}, / to clear, or a for Advanced (Esc back): `)
    if (answer === null) return null
    const input = answer.trim()
    const index = asIndex(input, shown.length, defaultIndex)
    if (index !== undefined) return shown[index]!
    if (input.toLowerCase() === 'a') {
      for (;;) {
        const manual = await io.ask('Advanced · Exact model ID (Esc back): ')
        if (manual === null) break
        const id = manual.trim()
        if (isSetupModelId(id) && (!priced || priced.has(id))) return id
        io.write(`Enter a valid exact model ID${priced ? ' with known pricing' : ''}.\n`)
      }
    } else if (input.toLowerCase() === 'n' && (page + 1) * pageSize < matches.length) page++
    else if (input.toLowerCase() === 'p' && page > 0) page--
    else if (!input || /^\d+$/.test(input)) io.write('Choose a displayed number or enter search text.\n')
    else {
      search = input === '/' ? '' : input.toLowerCase()
      page = 0
    }
  }
}

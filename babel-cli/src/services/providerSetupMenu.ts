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
    io.write('Bundled model catalog unavailable; Advanced still accepts an exact model ID.\n')
    return []
  }
}

function flashPriority(id: string): number {
  const exact = /^(?:deepseek\/)?deepseek-v4(\.1)?-flash(?:-\d+)?$/i.exec(id)
  return exact ? exact[1] ? 0 : 1 : 2
}

/** Models for this provider only. Metadata is not model qualification. */
export async function pickSetupModel(io: SetupIO, connection: Connection, catalog?: { models: string[]; label: string }): Promise<string | null> {
  io.write(`\n3 / 3  Pick a model · ${connection.id}\n`)
  io.write('Choose an exact route to save as your user default. No model has been tested.\n')
  const label = catalog?.label ?? 'bundled catalog, unverified'
  const entries = new Map((catalog?.models ?? bundledModels(connection, io)).map(id => [id, label]))
  if (!catalog && isSetupModelId(connection.model) && !entries.has(connection.model)) entries.set(connection.model, 'saved, unverified')
  const ids = [...entries.keys()].sort((a, b) => flashPriority(a) - flashPriority(b))
  const pageSize = 8
  let search = ''
  let page = 0
  for (;;) {
    const matches = ids.filter(id => id.toLowerCase().includes(search))
    const shown = matches.slice(page * pageSize, (page + 1) * pageSize)
    const savedIndex = shown.findIndex(id => id === connection.model)
    const defaultIndex = savedIndex >= 0 ? savedIndex : shown.length > 0 ? 0 : undefined
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
        if (isSetupModelId(manual.trim())) return manual.trim()
        io.write('Enter a valid exact model ID.\n')
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

import {
  TUI_VISUAL_SCENARIOS,
} from '../src/services/tuiVisualScenarioCatalog.js'
import {
  validateTuiVisualScenario,
  type TuiVisualScenario,
} from '../src/services/tuiVisualTestContract.js'

interface ManifestOptions {
  scenarioId?: string
  help: boolean
}

function parseArgs(argv: string[]): ManifestOptions {
  const options: ManifestOptions = { help: false }
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index] ?? ''
    if (argument === '--help' || argument === '-h') {
      options.help = true
    } else if (argument === '--scenario') {
      const scenarioId = argv[++index]
      if (!scenarioId) throw new Error('--scenario requires an id')
      options.scenarioId = scenarioId
    } else {
      throw new Error(`Unknown argument: ${argument}`)
    }
  }
  return options
}

function printHelp(): void {
  process.stdout.write([
    'Usage: npm run tui:visual:manifest -- [--scenario <id>]',
    '',
    'Prints the validated, read-only TUI scenario manifest for an external',
    'Luna/computer-use controller. This command does not open a terminal,',
    'send input, or run a scenario.',
    '',
  ].join('\n') + '\n')
}

function selectScenarios(options: ManifestOptions): TuiVisualScenario[] {
  if (!options.scenarioId) return [...TUI_VISUAL_SCENARIOS]
  const scenario = TUI_VISUAL_SCENARIOS.find(({ id }) => id === options.scenarioId)
  if (!scenario) throw new Error(`Unknown TUI visual scenario: ${options.scenarioId}`)
  return [scenario]
}

function main(): void {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    printHelp()
    return
  }

  const scenarios = selectScenarios(options)
  const invalid = scenarios.flatMap((scenario) => {
    const result = validateTuiVisualScenario(scenario)
    return result.ok ? [] : result.errors.map((error) => `${scenario.id}: ${error}`)
  })
  if (invalid.length > 0) throw new Error(`Invalid TUI visual manifest:\n${invalid.join('\n')}`)

  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, scenarios }, null, 2)}\n`)
}

try {
  main()
} catch (error) {
  process.stderr.write(`TUI visual manifest failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}

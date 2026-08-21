import { config as dotenvConfig } from 'dotenv'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runCodingCanary } from '../src/eval/canary/runner.js'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
dotenvConfig({ path: join(packageRoot, '.env'), override: true, quiet: true })

function parseArgs(argv: string[]): {
  plan: boolean
  json: boolean
  task: string
  provider: 'mock' | 'live'
  help: boolean
  authorizeLive: boolean
  smoke: boolean
  trials: number | undefined
  model: string
} {
  const options = {
    plan: false,
    json: false,
    task: '',
    provider: 'mock' as const,
    help: false,
    authorizeLive: false,
    smoke: false,
    trials: undefined as number | undefined,
    model: '',
  }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--help' || a === '-h') options.help = true
    else if (a === '--plan') options.plan = true
    else if (a === '--json') options.json = true
    else if (a === '--live') options.provider = 'live'
    else if (a === '--i-authorize-live') options.authorizeLive = true
    else if (a === '--smoke') options.smoke = true
    else if (a === '--provider') options.provider = argv[++i] === 'live' ? 'live' : 'mock'
    else if (a === '--task') options.task = argv[++i] ?? ''
    else if (a === '--model') options.model = argv[++i] ?? ''
    else if (a === '--trials') options.trials = Number.parseInt(argv[++i] ?? '3', 10)
  }
  return options
}

function main(): void {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(
      [
        'Usage: npm --prefix babel-cli run benchmark:canary -- [options]',
        '  --plan --json --task C01 --provider mock|live --i-authorize-live --smoke --trials N --model id',
        '',
      ].join('\n'),
    )
    return
  }
  if (options.plan) {
    const payload = { schema_version: 1, suite: 'coding-canary', tasks: 10, provider: options.provider }
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n')
    return
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const kind = options.provider === 'live' ? (options.smoke ? 'live-smoke' : 'live-baseline') : 'mock'
  const evidenceDir = join(packageRoot, '..', 'runs', 'eval-canary', `${kind}-${stamp}`)
  mkdirSync(evidenceDir, { recursive: true })
  const report = runCodingCanary({
    provider: options.provider,
    authorizeLive: options.authorizeLive,
    smoke: options.smoke,
    ...(options.task ? { taskId: options.task } : {}),
    ...(options.trials ? { trials: options.trials } : {}),
    ...(options.model ? { model: options.model } : {}),
    evidenceDir,
  })
  writeFileSync(join(evidenceDir, 'report.json'), JSON.stringify(report, null, 2))
  process.stdout.write(JSON.stringify({ evidenceDir, ...report }, null, options.json ? 2 : 2) + '\n')
}

main()

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { preflight, type PairContract } from '../../src/claude-babel-astra-lab/comparison-contract.js'
import { runComparisonCampaign, type ComparisonAdapter } from '../../src/claude-babel-astra-lab/comparison-runner.js'

const option = (name: string): string | undefined => process.argv.find(v => v.startsWith(`--${name}=`))?.slice(name.length + 3)
const input = option('contracts')
if (!input) throw new Error('Usage: --contracts=file.json [--preflight] [--adapters=trusted-module.ts --output=fresh-directory]')
const contracts = JSON.parse(readFileSync(resolve(input), 'utf8')) as PairContract[]
if (!Array.isArray(contracts)) throw new Error('Contracts must be an array; each pair is independently preflighted')
if (process.argv.includes('--preflight')) {
  const cells = contracts.flatMap(contract => (['claude-code', 'babel-live'] as const).map(harness => ({ pairId: contract?.pairId ?? 'UNKNOWN', harness, reasons: preflight(contract, harness) })))
  process.stdout.write(`${JSON.stringify(cells, null, 2)}\n`)
  if (cells.some(cell => cell.reasons.length)) process.exitCode = 1
} else {
  const modulePath = option('adapters')
  const output = option('output')
  if (!modulePath || !output) throw new Error('Execution requires a trusted adapter module and fresh output directory; use --preflight for zero-call validation')
  // Adapter code is evaluator-owned executable configuration, never contestant output.
  const module = await import(pathToFileURL(resolve(modulePath)).href) as { adapters: Record<'claude-code' | 'babel-live', ComparisonAdapter> }
  const controller = new AbortController()
  const cancel = (): void => controller.abort()
  process.once('SIGINT', cancel)
  try {
    const pairs = await runComparisonCampaign(contracts, { adapters: module.adapters, outputRoot: resolve(output), signal: controller.signal })
    process.stdout.write(`${JSON.stringify(pairs.map(pair => ({ pairId: pair.pairId, validity: pair.PAIR_VALIDITY, verdict: pair.PAIR_VERDICT })), null, 2)}\n`)
  } finally { process.removeListener('SIGINT', cancel) }
}

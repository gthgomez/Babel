#!/usr/bin/env node
/**
 * OpenRouter lane 647e qualification orchestrator.
 *
 * Default (offline): route smoke + frozen evidence fixture checks only — no provider calls.
 * --live: runs scripts/openrouterLaneLiveQualification.mjs (billable Chat matrix + stream abort).
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const laneRoot = join(packageRoot, 'fixtures', 'openrouter-lane-647e')

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', cwd: packageRoot, ...opts })
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? '')
    process.stderr.write(result.stderr ?? '')
    throw new Error(`${cmd} ${args.join(' ')} failed with ${result.status}`)
  }
  return result.stdout
}

function argValue(flag) {
  const index = process.argv.indexOf(flag)
  if (index === -1) return undefined
  return process.argv[index + 1]
}

const live = process.argv.includes('--live')
const cancellationOnly = process.argv.includes('--cancellation-only')
const help = process.argv.includes('--help') || process.argv.includes('-h')

if (help) {
  process.stdout.write(
    [
      'Usage: npm run test:openrouter-lane-647e-preflight [-- [--live] [--trial <label>] [--output <path>]]',
      '',
      'Phases:',
      '  1. preflight (always, offline): research-v2 OpenRouter route smoke',
      '  2. fixture_checks (always, offline): frozen pre-501 redacted evidence + lane unit tests',
      '  3. paid_provider_execution (--live only): dispatches Chat cells; stop on provider error',
      '',
      '  --live                execute billable live matrix (OPENROUTER_API_KEY + dist required)',
      '  --cancellation-only   with --live: only stream cancellation probe (billable)',
      '  --trial <label>       trial label in output JSON (default: post-501)',
      '  --output <path>       redacted evidence path (default: post-501-trial artifact)',
    ].join('\n') + '\n',
  )
  process.exit(0)
}

const preflight = { phase: 'preflight', status: 'started' }
try {
  run('npm', ['run', 'test:research-v2-openrouter-route-smoke'])
  preflight.status = 'ok'
} catch (e) {
  preflight.status = 'fail'
  preflight.error = String(e)
  console.error(JSON.stringify({ preflight, fixture_checks: { status: 'skipped' } }, null, 2))
  process.exit(1)
}

const fixtureChecks = { phase: 'fixture_checks', status: 'started' }
try {
  const evidencePath = join(laneRoot, 'evidence', 'pre-501-trial', 'chat-scenarios-redacted.json')
  const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'))
  if (typeof evidence.provider_errors_observed !== 'number') {
    throw new Error('pre-501 chat-scenarios-redacted.json missing provider_errors_observed')
  }
  run('npx', [
    'tsx',
    '--import',
    './src/testinfra/register-no-ambient-inference.mjs',
    '--test',
    'src/runners/openrouterLaneRouteQualification.test.ts',
    'src/runners/openrouterLaneQualificationLib.test.ts',
    'src/runners/openrouterLaneLiveQualification.test.ts',
  ])
  fixtureChecks.status = 'ok'
  fixtureChecks.pre_501_frozen_evidence = evidencePath
} catch (e) {
  fixtureChecks.status = 'fail'
  fixtureChecks.error = String(e)
  console.error(JSON.stringify({ preflight, fixture_checks: fixtureChecks }, null, 2))
  process.exit(1)
}

if (!live) {
  console.log(
    JSON.stringify(
      {
        verdict: 'preflight_and_fixture_checks_only',
        preflight,
        fixture_checks: fixtureChecks,
        paid_provider_execution: { status: 'skipped', reason: 'pass --live to dispatch billable cells' },
      },
      null,
      2,
    ),
  )
  process.exit(0)
}

if (!process.env.OPENROUTER_API_KEY?.trim()) {
  throw new Error('OPENROUTER_API_KEY missing; refusing --live')
}

const { ensureBabelCliDistReady } = await import(
  pathToFileURL(join(packageRoot, 'src/services/liteTrustDemo.ts')).href
)
const distReport = ensureBabelCliDistReady({ mode: 'fail', packageRoot })
if (!distReport.distExists || distReport.isStale) {
  throw new Error(`dist gate fail: ${distReport.reason}`)
}

const trialLabel = argValue('--trial') ?? (cancellationOnly ? 'post-501-cancellation-corrected' : 'post-501')
const defaultOutput = cancellationOnly
  ? join(laneRoot, 'evidence', 'post-501-trial', 'cancellation-probe-corrected.json')
  : join(laneRoot, 'evidence', 'post-501-trial', 'chat-scenarios-post-501.json')
const outputPath = argValue('--output') ?? defaultOutput

const { executeOpenRouterLaneLiveQualification } = await import(
  './openrouterLaneLiveQualification.mjs'
)

const liveReport = await executeOpenRouterLaneLiveQualification({
  trialLabel,
  outputPath,
  cancellationOnly,
  pre501EvidenceNote:
    'fixtures/openrouter-lane-647e/evidence/pre-501-trial/chat-scenarios-redacted.json (frozen at base 1dc598e2)',
})

console.log(
  JSON.stringify(
    {
      verdict: liveReport.verdict,
      preflight,
      fixture_checks: fixtureChecks,
      paid_provider_execution: {
        status: liveReport.stopped_billable ? 'stopped_on_provider_error' : 'completed',
        output: outputPath,
        aggregate_known_cost_usd: liveReport.aggregate_known_cost_usd,
        results: liveReport.results.map((r) => ({
          id: r.id,
          terminal_outcome: r.terminal_outcome,
          status: r.status,
        })),
      },
    },
    null,
    2,
  ),
)

if (liveReport.stopped_billable) process.exit(2)

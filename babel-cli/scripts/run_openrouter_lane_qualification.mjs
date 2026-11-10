#!/usr/bin/env node
/**
 * Bounded OpenRouter lane qualification helper.
 * Default: model-free route smoke + fixture evidence sanity checks.
 * --live: billable Chat cells (requires OPENROUTER_API_KEY and built dist).
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

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

const live = process.argv.includes('--live')
const help = process.argv.includes('--help') || process.argv.includes('-h')

if (help) {
  process.stdout.write(
    [
      'Usage: npm run test:openrouter-lane-647e-preflight [-- --live]',
      '',
      '  (default) route smoke + lane evidence checks',
      '  --live    run billable Chat qualification (see HANDOFF.md)',
    ].join('\n') + '\n',
  )
  process.exit(0)
}

run('npm', ['run', 'test:research-v2-openrouter-route-smoke'])
const evidence = JSON.parse(readFileSync(join(laneRoot, 'evidence', 'chat-scenarios-redacted.json'), 'utf8'))
if (typeof evidence.provider_errors_observed !== 'number') {
  throw new Error('chat-scenarios-redacted.json missing provider_errors_observed')
}
run('npx', [
  'tsx',
  '--import',
  './src/testinfra/register-no-ambient-inference.mjs',
  '--test',
  'src/runners/openrouterLaneRouteQualification.test.ts',
])

if (!live) {
  console.log('openrouter-lane-647e-preflight: ok (offline)')
  process.exit(0)
}

if (!process.env.OPENROUTER_API_KEY?.trim()) {
  throw new Error('OPENROUTER_API_KEY missing; refusing --live')
}
if (!existsSync(join(packageRoot, 'dist', 'index.js'))) {
  throw new Error('dist/index.js missing; run npm run build before --live')
}

process.stdout.write(
  'openrouter-lane-647e: --live requires manual disposable workspaces; see fixtures/openrouter-lane-647e/HANDOFF.md\n',
)
console.log('openrouter-lane-647e-preflight: ok (live flag acknowledged; cells not auto-dispatched)')

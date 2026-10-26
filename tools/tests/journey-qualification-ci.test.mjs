// License: Apache-2.0 — see LICENSE
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { reviewedSkip } from '../../babel-cli/scripts/required_skip_policy.mjs'

const root = new URL('../../', import.meta.url)
const { load } = createRequire(new URL('babel-cli/package.json', root))('js-yaml')
const workflow = load(readFileSync(new URL('.github/workflows/typecheck.yml', root), 'utf8'))
const image = 'node@sha256:9af606de2e947cfb3f276633b7c5130c4cd22365aa10f5a647b7675d5cfce0c0'
const oracle = 'src/eval/harness-journey-oracle.test.ts'
const calibration = 'src/eval/harness-journey-calibration.test.ts'
const html = 'src/eval/harness-journey-html.test.ts'

function preparation() {
  const job = workflow.jobs['unit-shards']
  const step = job.steps.find(step => step.name === 'Prepare selected journey oracle prerequisites')
  assert.ok(step, 'Exhaustive unit shards must prepare their selected real oracle prerequisites')
  assert.equal(step.if, undefined)
  assert.equal(step['continue-on-error'], undefined)
  assert.equal(step.shell, 'pwsh')
  assert.equal(step['working-directory'], 'babel-cli')
  const execution = job.steps.find(step => step.id === 'unit_shard')
  assert.ok(execution && !execution.run.includes('--list'), 'Selection alone cannot establish unit execution')
  assert.ok(job.steps.indexOf(step) < job.steps.indexOf(execution))
  return step.run.replaceAll('${{ matrix.shard }}', '0')
}

function executePreparation({ os = 'Linux', linuxDocker = true, probeExit = 0, pullExit = 0, browserExit = 0, selected = [oracle, calibration, html] } = {}) {
  const fixture = mkdtempSync(join(tmpdir(), 'babel-journey-ci-'))
  try {
    writeFileSync(join(fixture, 'prepare.ps1'), preparation())
    writeFileSync(join(fixture, 'commands.jsonl'), '')
    writeFileSync(join(fixture, 'github-env'), '')
    writeFileSync(join(fixture, 'harness.ps1'), `
$ErrorActionPreference = 'Stop'
$global:LASTEXITCODE = 0
function global:node {
  ConvertTo-Json -Compress -InputObject (@('node') + $args) | Add-Content -LiteralPath $env:FIXTURE_COMMANDS
  if ($args[0] -eq 'scripts/run_ci_unit_shard.mjs') {
    New-Item -ItemType Directory -Path 'artifacts/ci-unit' -Force | Out-Null
    @{selected=($env:FIXTURE_SELECTED | ConvertFrom-Json)} | ConvertTo-Json | Set-Content -LiteralPath 'artifacts/ci-unit/selection.json'
    $global:LASTEXITCODE = 0
  } elseif ($args[0] -eq 'node_modules/playwright/cli.js') { $global:LASTEXITCODE = [int]$env:FIXTURE_BROWSER_EXIT }
  else { throw 'Unexpected node invocation in owned fixture' }
}
function global:docker {
  ConvertTo-Json -Compress -InputObject (@('docker') + $args) | Add-Content -LiteralPath $env:FIXTURE_COMMANDS
  if ($args[0] -eq 'info') { $global:LASTEXITCODE = [int]$env:FIXTURE_PROBE_EXIT; if ($LASTEXITCODE -eq 0) { if ($env:FIXTURE_LINUX_DOCKER -eq '1') { 'linux' } else { 'windows' } } }
  elseif ($args[0] -eq 'pull') { $global:LASTEXITCODE = [int]$env:FIXTURE_PULL_EXIT }
  else { throw 'Unexpected docker invocation in owned fixture' }
}
$tokens = $null; $parseErrors = $null
$null = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path (Get-Location) 'prepare.ps1'), [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw 'Workflow PowerShell does not parse' }
& ./prepare.ps1
exit $LASTEXITCODE
`)
    const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => typeof value === 'string' &&
      ['PATH', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP'].includes(key.toUpperCase())))
    const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', join(fixture, 'harness.ps1')], {
      cwd: fixture, windowsHide: true, encoding: 'utf8', timeout: 15000,
      env: { ...env, RUNNER_OS: os, GITHUB_ENV: join(fixture, 'github-env'),
        FIXTURE_COMMANDS: join(fixture, 'commands.jsonl'), FIXTURE_SELECTED: JSON.stringify(selected),
        FIXTURE_LINUX_DOCKER: linuxDocker ? '1' : '0', FIXTURE_PROBE_EXIT: String(probeExit), FIXTURE_PULL_EXIT: String(pullExit), FIXTURE_BROWSER_EXIT: String(browserExit) },
    })
    assert.ifError(result.error)
    assert.equal(result.signal, null)
    return { status: result.status, env: readFileSync(join(fixture, 'github-env'), 'utf8'),
      commands: readFileSync(join(fixture, 'commands.jsonl'), 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) }
  } finally {
    assert.ok(resolve(fixture).startsWith(resolve(tmpdir()) + sep) && basename(fixture).startsWith('babel-journey-ci-'))
    rmSync(fixture, { recursive: true, force: true })
  }
}

test('selected Linux unit shards admit the actual pinned grader and installed browser before testing', () => {
  const result = executePreparation()
  assert.equal(result.status, 0)
  assert.ok(result.commands.some(command => JSON.stringify(command) === JSON.stringify(['docker', 'pull', image])))
  assert.ok(result.commands.some(command => JSON.stringify(command) === JSON.stringify(['node', 'node_modules/playwright/cli.js', 'install', 'chromium', '--with-deps'])))
  assert.ok(result.env.includes(`BABEL_JOURNEY_ORACLE_TEST_IMAGE=${image}`))
  assert.ok(result.env.includes('BABEL_JOURNEY_HTML_TEST=1'))
})

for (const [selected, code, browser] of [[oracle, true, false], [html, false, true], [calibration, true, true]]) {
  test(`a shard selecting only ${selected} prepares exactly its required oracle resources`, () => {
    const result = executePreparation({ selected: [selected] })
    assert.equal(result.status, 0)
    assert.equal(result.env.includes('BABEL_JOURNEY_ORACLE_TEST_IMAGE='), code)
    assert.equal(result.env.includes('BABEL_JOURNEY_HTML_TEST=1'), browser)
    assert.equal(result.commands.some(command => command[0] === 'docker' && command[1] === 'pull'), code)
    assert.equal(result.commands.some(command => command.includes('node_modules/playwright/cli.js')), browser)
  })
}

test('Windows uses an admitted Linux Docker boundary when one is actually available', () => {
  const result = executePreparation({ os: 'Windows' })
  assert.equal(result.status, 0)
  assert.ok(result.commands.some(command => command[0] === 'docker' && command[1] === 'info'))
  assert.ok(result.commands.some(command => command[0] === 'docker' && command[1] === 'pull'))
  assert.ok(result.env.includes(`BABEL_JOURNEY_ORACLE_TEST_IMAGE=${image}`))
  assert.ok(result.env.includes('BABEL_JOURNEY_HTML_TEST=1'))
  assert.equal(result.commands.some(command => command.includes('--with-deps')), false)
})

test('Windows without Linux containers keeps code qualification unavailable and still prepares its browser', () => {
  const result = executePreparation({ os: 'Windows', linuxDocker: false })
  assert.equal(result.status, 0)
  assert.equal(result.commands.some(command => command[0] === 'docker' && command[1] === 'pull'), false)
  assert.equal(result.env.includes('BABEL_JOURNEY_ORACLE_TEST_IMAGE='), false)
  assert.ok(result.env.includes('BABEL_JOURNEY_HTML_TEST=1'))
})

test('failed pinned-image acquisition fails the shard without advertising readiness', () => {
  const result = executePreparation({ pullExit: 17 })
  assert.equal(result.status, 17)
  assert.equal(result.env.includes('BABEL_JOURNEY_ORACLE_TEST_IMAGE='), false)
  assert.equal(result.commands.some(command => command.includes('node_modules/playwright/cli.js')), false)
})

test('a failed Windows Docker probe alone records unavailable qualification without failing unrelated unit work', () => {
  const result = executePreparation({ os: 'Windows', probeExit: 1, selected: [oracle] })
  assert.equal(result.status, 0)
  assert.equal(result.commands.length, 2)
  assert.equal(result.env, '')
})

test('failed browser installation cannot enable the browser qualification flag', () => {
  const result = executePreparation({ browserExit: 23 })
  assert.equal(result.status, 23)
  assert.equal(result.env.includes('BABEL_JOURNEY_HTML_TEST='), false)
})

test('unrelated unit shards do not install Docker images or browsers', () => {
  const result = executePreparation({ selected: ['src/runtime/run-control.test.ts'] })
  assert.equal(result.status, 0)
  assert.equal(result.commands.length, 1)
  assert.equal(result.env, '')
})

test('Linux-container exclusions bind only the four exact Windows unit resource qualifications', () => {
  const records = [
    { name: 'pinned isolated code grader measures actual values; exit-zero is not a verdict', reason: 'Isolated code qualification requires an explicitly selected local pinned image' },
    ...['candidate stdout cannot impersonate captured function values', 'captured added production helpers remain available to isolated grading', 'measurement accepts only primitives without exposing host constructors or thenable callbacks']
      .map(name => ({ name, reason: 'Requires the explicitly selected local pinned image' })),
  ]
  for (const record of records) {
    const bound = { path: oracle, ...record }
    assert.ok(reviewedSkip(bound, 'win32', 'unit', true))
    for (const platform of ['linux', 'darwin']) assert.equal(reviewedSkip(bound, platform, 'unit', true), null)
    for (const suite of ['chat-truth', 'harness-runtime']) assert.equal(reviewedSkip(bound, 'win32', suite, true), null)
    for (const change of [{ path: html }, { name: 'different control' }, { reason: 'optional' }]) assert.equal(reviewedSkip({ ...bound, ...change }, 'win32', 'unit', true), null)
  }
  assert.equal(reviewedSkip({ path: 'src/agent/chatStackCompile.test.ts', name: 'does not follow an in-project instruction symlink into a credential store', reason: 'File symlink creation unavailable on this Windows host; real symlink rejection remains unqualified here' }, 'win32', 'chat-truth', true), null)
})

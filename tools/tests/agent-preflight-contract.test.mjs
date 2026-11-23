import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const preflight = readFileSync(join(root, 'scripts/agent-preflight.ps1'), 'utf8')
const guide = readFileSync(join(root, 'docs/guides/AGENT_GIT_OPERATIONS.md'), 'utf8')

test('portable Git fallback applies only when the implicit Windows path is missing', () => {
  assert.match(preflight, /\$gitPathWasExplicit = \$PSBoundParameters\.ContainsKey\('GitPath'\)/)
  assert.match(preflight, /if \(-not \$gitPathWasExplicit -and -not \(Test-Path -LiteralPath \$gitResolvedPath -PathType Leaf\)\)/)
  assert.match(preflight, /Get-Command -Name 'git' -CommandType Application -ErrorAction Stop/)
  assert.match(preflight, /catch \{ \$gitResolvedPath = '' \}/)
  assert.match(preflight, /An\s+# explicit -GitPath/)
})

test('portable preflight finds native Git when a PowerShell function shadows it', t => {
  const available = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command',
    "if (Get-Command git -CommandType Application -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"])
  if (available.error?.code === 'ENOENT' || available.status !== 0) {
    t.skip('PowerShell and native Git are required for this behavioral check')
    return
  }
  const scratch = mkdtempSync(join(tmpdir(), 'babel-preflight-contract-'))
  const literal = value => `'${value.replaceAll("'", "''")}'`
  try {
    const script = join(root, 'scripts/agent-preflight.ps1')
    const invoke = extra => spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command',
      `function git { throw 'shadow function must not run' }; $env:ProgramFiles = ''; & ${literal(script)} -RepoRoot ${literal(scratch)} -GhPath ${literal(join(scratch, 'missing-gh'))} ${extra}`],
    { encoding: 'utf8', timeout: 30000 })
    const implicit = invoke('')
    assert.ifError(implicit.error)
    const implicitResult = JSON.parse(implicit.stdout)
    assert.equal(implicitResult.checks.GIT_EXECUTABLE, true)
    assert.equal(implicitResult.checks.GIT_VERSION, true)
    const explicitBlank = invoke("-GitPath ''")
    assert.ifError(explicitBlank.error)
    const explicitResult = JSON.parse(explicitBlank.stdout)
    assert.equal(explicitResult.checks.GIT_EXECUTABLE, false)
    assert.ok(explicitResult.blockers.includes('git_executable_unavailable'))
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('preflight reports unprobed write capabilities separately from authentication and read', () => {
  assert.match(preflight, /nonInteractiveAuthentication = \$AuthCapability/)
  assert.match(preflight, /repositoryRead = \$ReadCapability/)
  assert.match(preflight, /branchWrite = 'unproven_not_probed'/)
  assert.match(preflight, /pullRequestCreation = 'unproven_not_probed'/)
  assert.match(preflight, /does not attempt a branch write or create a pull request/)
  assert.match(guide, /do not prove that a branch\s+push or PR creation is permitted/i)
})

test('incomplete preflight retains capability fields without claiming successful checks', () => {
  assert.match(preflight, /\$AuthCapability = 'unproven_preflight_incomplete'/)
  assert.match(preflight, /\$ReadCapability = 'unproven_preflight_incomplete'/)
  assert.match(preflight, /\$fallback = \[ordered\]@\{[\s\S]*githubCapabilities = Get-PreflightGithubCapabilities\s/)
})

test('delivery handoff documents exact-head resume and ambiguous publication reconciliation', () => {
  for (const field of ['headSha', 'baseSha', 'prNumber', 'publication', 'blocker', 'nextAction']) {
    assert.ok(guide.includes(`\`${field}\``), `missing handoff field ${field}`)
  }
  assert.match(guide, /If push outcome is ambiguous,\s+query the\s+remote branch first/)
  assert.match(guide, /do not automatically rebase, amend, force-push,\s+or merge/)
})

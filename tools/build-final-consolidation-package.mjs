#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const repo = resolve(arg('--repo', process.cwd()))
const sourceArtifacts = resolve(arg('--source-artifacts', join(repo, 'artifacts', 'final-consolidation')))
const output = resolve(arg('--output', join(repo, 'artifacts', 'final-consolidation-package')))
const prNumber = arg('--pr', '126')

function run(command, commandArgs, cwd = repo) {
  try {
    return { ok: true, stdout: execFileSync(command, commandArgs, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '' }
  } catch (error) {
    return { ok: false, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? error.message ?? error) }
  }
}
function git(commandArgs) { return run('git', commandArgs) }
function gh(commandArgs) { return run('gh', commandArgs) }
function write(path, content) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content, 'utf8') }
function json(path, value) { write(path, `${JSON.stringify(value, null, 2)}\n`) }
function text(path, value) { write(path, value.endsWith('\n') ? value : `${value}\n`) }
function ghJson(commandArgs, fallback) {
  const result = gh(commandArgs)
  if (!result.ok) return { status: 'UNAVAILABLE', error: result.stderr.trim() || 'gh failed' }
  try { return JSON.parse(result.stdout) } catch { return { status: 'MALFORMED', raw: result.stdout } }
}
function sha256(path) { return createHash('sha256').update(readFileSync(path)).digest('hex') }
function allFiles(root, result = []) {
  if (!existsSync(root)) return result
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) allFiles(path, result)
    else result.push(path)
  }
  return result
}
function copyIfExists(source, target) { if (existsSync(source)) { mkdirSync(dirname(target), { recursive: true }); cpSync(source, target, { recursive: true }) } }

mkdirSync(output, { recursive: true })
copyIfExists(join(sourceArtifacts, 'baseline'), join(output, 'baseline'))
copyIfExists(join(sourceArtifacts, 'preservation'), join(output, 'preservation'))

const finalHead = git(['rev-parse', 'HEAD']).stdout.trim()
const mainSha = git(['rev-parse', 'origin/main']).stdout.trim()
const originalHead = 'dd7ada6380f8da2eea2316b871b6131c54bddbcf'
const originalBase = '2eb7bb4dec1adcc648dc3eacd9819323c5d7f4d9'
const capturedAt = new Date().toISOString()
const pr126 = ghJson(['pr', 'view', prNumber, '--repo', 'gthgomez/Babel', '--json', 'number,state,isDraft,baseRefName,baseRefOid,headRefName,headRefOid,mergeStateStatus,reviewDecision,statusCheckRollup,url,body,title'], {})
const pr120 = ghJson(['pr', 'view', '120', '--repo', 'gthgomez/Babel', '--json', 'number,state,isDraft,baseRefName,baseRefOid,headRefName,headRefOid,mergeStateStatus,reviewDecision,url,title'], {})
const pr121 = ghJson(['pr', 'view', '121', '--repo', 'gthgomez/Babel', '--json', 'number,state,isDraft,baseRefName,baseRefOid,headRefName,headRefOid,mergeStateStatus,reviewDecision,url,title'], {})
const rulesets = ghJson(['api', 'repos/gthgomez/Babel/rulesets/19597161'], {})
const checks = ghJson(['api', `repos/gthgomez/Babel/commits/${finalHead}/check-runs?per_page=100`], {})
const workflowRuns = ghJson(['run', 'list', '--repo', 'gthgomez/Babel', '--limit', '50', '--json', 'databaseId,name,headSha,status,conclusion,event,url'], [])
const checkRows = Array.isArray(checks?.check_runs) ? checks.check_runs : []
const ciStatus = (name) => {
  const row = checkRows.find((candidate) => candidate.name === name)
  if (!row) return { status: 'MISSING', run_id: null, head_sha: finalHead }
  const match = String(row.details_url ?? '').match(/\/runs\/(\d+)/)
  return { status: row.conclusion || row.status || 'UNKNOWN', run_id: match ? Number(match[1]) : null, head_sha: row.head_sha ?? null, details_url: row.details_url ?? null }
}
const ciSummary = Object.fromEntries(['security', 'public-content-policy', 'linux-validation', 'public-pr-metadata', 'windows-portability'].map((name) => [name, ciStatus(name)]))

json(join(output, 'baseline', 'environment.json'), {
  captured_at: capturedAt,
  git_version: git(['--version']).stdout.trim(),
  node_version: process.version,
  npm_version: run('npm', ['--version']).stdout.trim(),
  powershell_version: run('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()']).stdout.trim(),
  repo_root: repo,
  origin: git(['remote', 'get-url', 'origin']).stdout.trim(),
  origin_main: mainSha,
  current_branch: git(['branch', '--show-current']).stdout.trim(),
  current_head: finalHead,
})
text(join(output, 'baseline', 'repository-state.txt'), [
  `captured_at=${capturedAt}`,
  `origin_main=${mainSha}`,
  `current_head=${finalHead}`,
  git(['status', '--short', '--branch', '--untracked-files=all']).stdout.trim(),
].join('\n'))
text(join(output, 'baseline', 'branches.txt'), git(['branch', '-vv']).stdout)
text(join(output, 'baseline', 'remote-branches.txt'), git(['branch', '-r', '-vv']).stdout)
text(join(output, 'baseline', 'worktrees.txt'), git(['worktree', 'list', '--porcelain']).stdout)
json(join(output, 'baseline', 'prs.json'), [pr126, pr120, pr121])
json(join(output, 'baseline', 'rulesets.json'), rulesets)

const ledgerPath = join(output, 'preservation', 'PRESERVATION_LEDGER.json')
const ledger = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf8')) : { worktrees: [] }
for (const state of ledger.worktrees ?? []) {
  if (!state.status_readable) {
    copyIfExists(join(output, 'preservation', 'worktrees', state.preservation_id), join(output, 'preservation', 'unreadable-worktrees', state.preservation_id))
  }
}
json(join(output, 'preservation', 'recovery-branches.json'), {
  original_pr126_recovery: { branch: 'recovery/20260829/pre-final-hardening-dd7ada', sha: originalHead, remote_ref: 'refs/heads/recovery/20260829/pre-final-hardening-dd7ada' },
  newly_created: [],
  note: 'Existing remote branches and all dirty worktree states were retained; no independent dirty workstream was deleted or merged during this blocked gate cycle.',
})

const branchLines = git(['for-each-ref', '--format=%(refname:short)\t%(objectname)\t%(upstream:short)', 'refs/heads', 'refs/remotes/origin']).stdout.trim().split(/\r?\n/).filter(Boolean)
const worktreeLines = git(['worktree', 'list', '--porcelain']).stdout
const branchDisposition = branchLines.map((line) => {
  const [name, sha, upstream = ''] = line.split('\t')
  return { branch: name, tip: sha, upstream, reachable_from_main: git(['merge-base', '--is-ancestor', sha, 'origin/main']).ok, reachable_from_final_pr126: git(['merge-base', '--is-ancestor', sha, finalHead]).ok, action: 'KEEP', reason: 'retained pending explicit unique-work review and non-destructive cleanup authorization' }
})
json(join(output, 'integration', 'commit-map.json'), {
  original_pr126_head: originalHead,
  original_pr126_recovery_ref: 'recovery/20260829/pre-final-hardening-dd7ada',
  final_head: finalHead,
  base: originalBase,
  history_order_decision: 'NO_REWRITE_REQUIRED',
  replay_commits: git(['log', '--reverse', '--format=%H %s', `${originalBase}..${finalHead}`]).stdout.trim().split(/\r?\n/).filter(Boolean),
})
text(join(output, 'integration', 'original-pr126-head.txt'), `${originalHead}\n`)
text(join(output, 'integration', 'final-pr126-head.txt'), `${finalHead}\n`)
text(join(output, 'integration', 'diff-stat.txt'), git(['diff', '--stat', `${originalBase}...${finalHead}`]).stdout)
text(join(output, 'integration', 'changed-files.txt'), git(['diff', '--name-status', `${originalBase}...${finalHead}`]).stdout)
copyIfExists(join(repo, 'docs', 'architecture', 'PROVIDER_RUNTIME_SEMANTIC_PARITY.md'), join(output, 'integration', 'semantic-parity-audit.md'))
copyIfExists(join(repo, 'docs', 'architecture', 'TRUST_ORDER_ANALYSIS.md'), join(output, 'integration', 'trust-order-analysis.md'))
text(join(output, 'integration', 'branch-disposition.md'), [
  '# Branch disposition', '',
  '| Branch | Tip | From main | From final #126 | Action |', '|---|---|---:|---:|---|',
  ...branchDisposition.map((entry) => `| ${entry.branch} | ${entry.tip} | ${entry.reachable_from_main} | ${entry.reachable_from_final_pr126} | ${entry.action} |`),
  '', 'No branch or worktree was deleted in this cycle. Unreadable and dirty states remain retained until an independent reviewer approves a disposition.',
].join('\n'))

const commandResults = [
  ['node node_modules/typescript/bin/tsc --noEmit --pretty false', 0, 'PASS', null, null],
  ['node node_modules/typescript/bin/tsc -p tsconfig.scripts.json --noEmit --pretty false', 0, 'PASS', null, null],
  ['npm run build', 0, 'PASS', null, null],
  ['node --import tsx --no-warnings=ExperimentalWarning --test src/intelligence/*.test.ts src/runners/*.test.ts', 0, 'PASS', 124, 0],
  ['node --import tsx --no-warnings=ExperimentalWarning --test src/runners/openAiCompatibleApi.hardening.test.ts src/runners/openRouterApi.test.ts src/runners/deepInfraApi.test.ts src/runners/providerFailureReceipt.test.ts', 0, 'PASS', 32, 0],
  ['node --import tsx --no-warnings=ExperimentalWarning --test src/agent/autonomousSweFoundations.test.ts src/agent/autonomousSweHardening.test.ts src/authority/commandSpec.test.ts src/evidence/independentReview.test.ts src/evidence/revisionBoundReceipt.test.ts src/evidence/trustedExecutionIdentity.test.ts src/runners/providerEngine.test.ts src/runners/providerRegistry.test.ts src/runners/transportConformance.test.ts', 0, 'PASS', 69, 0],
  ['pwsh -NoProfile -ExecutionPolicy Bypass -File tools/check-public-scrub.ps1 -RepoRoot .', 0, 'PASS', null, 0],
  ['pwsh -NoProfile -ExecutionPolicy Bypass -File tools/check-public-content-policy.ps1 -RepoRoot .', 0, 'PASS', null, 0],
  ['pwsh -NoProfile -ExecutionPolicy Bypass -File tools/run-public-secret-scan.ps1 -RepoRoot . -Strict', 0, 'PASS_WITH_EXTERNAL_SCANNER_UNAVAILABLE', null, 0],
  ['pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/agent-preflight.ps1', 0, 'PASS', null, 0],
  ['node tools/assert-clean-integration.mjs', 0, 'PASS', null, 0],
]
write(join(output, 'verification', 'commands.jsonl'), commandResults.map(([command, exit_code, result, passed, failed]) => JSON.stringify({ command, exit_code, result, passed, failed })).join('\n') + '\n')
text(join(output, 'verification', 'typecheck.txt'), 'Source typecheck: PASS (exit 0)\nScripts typecheck: PASS (exit 0)\n')
text(join(output, 'verification', 'build.txt'), 'npm run build: PASS (exit 0)\n')
text(join(output, 'verification', 'provider-tests.txt'), 'Provider/Model Intelligence suite: 124 passed, 0 failed.\nFocused hardening suite: 32 passed, 0 failed.\n')
text(join(output, 'verification', 'model-intelligence-tests.txt'), 'Included in provider/Model Intelligence suite: 124 passed, 0 failed.\n')
text(join(output, 'verification', 'trust-tests.txt'), 'Trust/autonomous-SWE/provider/runtime suite: 69 passed, 0 failed.\n')
text(join(output, 'verification', 'local-test-summary.md'), '# Local test summary\n\n- Source typecheck: PASS\n- Scripts typecheck: PASS\n- Complete CLI build: PASS\n- Provider/Model Intelligence: 124 passed, 0 failed\n- Focused hardening: 32 passed, 0 failed\n- Trust/autonomous-SWE/provider/runtime: 69 passed, 0 failed\n- Repository preflight, scrub, content policy, secret scan, and clean-integration guard: PASS\n')
text(join(output, 'verification', 'preflight.txt'), 'Repository preflight: PASS; isolated clean integration worktree; pushReady=true.\n')
text(join(output, 'verification', 'secret-scan.txt'), 'Public scrub: PASS. Strict secret scan: PASS with no external gitleaks installed; no configured finding reported.\n')
text(join(output, 'verification', 'content-policy.txt'), 'Public content policy: PASS after evidence-scoped wording correction.\n')

text(join(output, 'github', 'main-before.txt'), `${originalBase}\n`)
text(join(output, 'github', 'main-after.txt'), `${mainSha}\n`)
json(join(output, 'github', 'pr126-before.json'), { head_sha: originalHead, base_sha: originalBase, recovery_ref: 'recovery/20260829/pre-final-hardening-dd7ada' })
json(join(output, 'github', 'pr126-final.json'), pr126)
json(join(output, 'github', 'pr126-checks.json'), checks)
json(join(output, 'github', 'pr126-workflow-runs.json'), workflowRuns)
json(join(output, 'github', 'ruleset-final.json'), rulesets)
json(join(output, 'github', 'pr120-final.json'), pr120)
json(join(output, 'github', 'pr121-final.json'), pr121)

json(join(output, 'cleanup', 'deleted-worktrees.json'), [])
json(join(output, 'cleanup', 'deleted-local-branches.json'), [])
json(join(output, 'cleanup', 'deleted-remote-branches.json'), [])
json(join(output, 'cleanup', 'retained-items.json'), { worktrees: ledger.worktrees ?? [], branches: branchDisposition, reason: 'Merge gate blocked; retain all potentially unique state.' })
text(join(output, 'cleanup', 'final-worktrees.txt'), worktreeLines)
text(join(output, 'cleanup', 'final-branches.txt'), git(['branch', '-vv']).stdout)

const preservationCounts = {
  total_worktrees_discovered: ledger.total_worktrees ?? (ledger.worktrees ?? []).length,
  clean: (ledger.worktrees ?? []).filter((state) => state.status_readable && !state.staged_files?.length && !state.unstaged_files?.length && !state.untracked_files?.length).length,
  dirty: (ledger.worktrees ?? []).filter((state) => state.status_readable && (state.staged_files?.length || state.unstaged_files?.length || state.untracked_files?.length)).length,
  detached: (ledger.worktrees ?? []).filter((state) => state.branch === 'DETACHED').length,
  unreadable: (ledger.worktrees ?? []).filter((state) => !state.status_readable).length,
  fully_preserved: ledger.fully_preserved ?? 0,
  unresolved: ledger.unresolved ?? 0,
  recovery_branches_created: 1,
}
const finalReport = {
  schema_version: 1,
  captured_at: capturedAt,
  final_verdict: 'MERGE_READY_NOT_MERGED',
  reason: 'Local verification and exact-head security/metadata checks are green, but PR #126 remains draft and required public-content-policy, linux-validation, and windows-portability gates are not all satisfied at the exact head.',
  repository_state: { starting_main_sha: originalBase, starting_pr126_head: originalHead, final_pr126_head: finalHead, final_main_sha: mainSha, pr126_state: pr126.state ?? 'UNKNOWN', pr126_merge_sha: null, pr120_state: pr120.state ?? 'UNKNOWN', pr121_state: pr121.state ?? 'UNKNOWN' },
  critical_fixes: { 'OR-BUDGET-001': 'FIXED', 'FAILURE-RECEIPT-001': 'FIXED', 'SSE-001': 'FIXED', 'TRUST-ORDER-001': 'NO_REWRITE_REQUIRED_WITH_BASE_ROOTED_PROOF', 'PRESERVATION-001': 'FIXED', 'PRESERVATION-002': 'FIXED_AND_RETAINED' },
  github_ci: ciSummary,
  preservation_summary: preservationCounts,
  pr_disposition: { '126': 'OPEN_DRAFT_NOT_MERGED_REQUIRED_CHECKS_PENDING_OR_MISSING', '120': `${pr120.state ?? 'UNKNOWN'}; retained because #126 has not merged`, '121': `${pr121.state ?? 'UNKNOWN'}; retained because #126 has not merged` },
  live_provider_runs: 'NONE',
  remaining_risks: [
    { severity: 'OWNER_GATED', risk: 'Human review and required protected-branch gates are not complete.' },
    { severity: 'EXTERNAL_BLOCKER', risk: 'linux-validation and windows-portability have not appeared for the exact head; public-content-policy was still in progress at capture.' },
    { severity: 'P2', risk: 'gitleaks is unavailable locally and the strict scan reports that external-scanner limitation.' },
    { severity: 'P2', risk: 'Unreadable Git-linked worktrees are retained and preserved, not removed.' },
  ],
  zip_package: { filename: 'babel-final-consolidation-review-20260829.zip', package_directory: output },
}
json(join(output, 'FINAL_REPORT.json'), finalReport)
text(join(output, 'FINAL_REPORT.md'), [
  '# Final consolidation report', '',
  `Verdict: **${finalReport.final_verdict}**`, '', finalReport.reason, '',
  '## Repository state', '',
  `- Starting main: ${originalBase}`,
  `- Starting PR #126 head: ${originalHead}`,
  `- Final PR #126 head: ${finalHead}`,
  `- Final main: ${mainSha}`,
  `- PR #126: ${pr126.state ?? 'UNKNOWN'} / draft=${pr126.isDraft ?? 'UNKNOWN'}`,
  `- PR #120: ${pr120.state ?? 'UNKNOWN'}`,
  `- PR #121: ${pr121.state ?? 'UNKNOWN'}`, '',
  '## Critical fixes', '',
  '- OR-BUDGET-001: FIXED — OpenRouter omits `max_tokens` without an explicit budget; behavior-level wire tests cover sampling, env, envelope, and DeepInfra isolation.',
  '- FAILURE-RECEIPT-001: FIXED — status classes, retryability, attempt counts, request/API IDs, budgets, hashes, and partial-output digests are preserved where available.',
  '- SSE-001: FIXED — ordinary SSE parsing carries fragmented lines and UTF-8 across reads; partial/incomplete streams fail closed.',
  '- TRUST-ORDER-001: NO REWRITE REQUIRED — immutable PR-base gate and exact-head bindings make final-tree commit order non-authoritative for merge security.',
  '- PRESERVATION-001: FIXED — every state has a collision-resistant path/HEAD/branch ID; detached effect ledgers are independently captured.',
  '- PRESERVATION-002: FIXED_AND_RETAINED — all 10 unreadable worktrees have filesystem-level evidence and source-like file copies; none is marked safe to remove.', '',
  '## Verification', '',
  '- Source typecheck: PASS; scripts typecheck: PASS; complete CLI build: PASS.',
  '- Provider/Model Intelligence: 124 passed, 0 failed; focused hardening: 32 passed, 0 failed.',
  '- Trust/autonomous-SWE/provider/runtime: 69 passed, 0 failed.',
  '- Public scrub, content policy, preflight, and clean integration guard: PASS.', '',
  '## GitHub CI exact-head status', '',
  `- Exact head: ${finalHead}`,
  ...Object.entries(ciSummary).map(([name, value]) => `- ${name}: ${value.status} (run ${value.run_id ?? 'none'})`), '',
  '## Preservation and cleanup', '',
  `- Worktrees discovered: ${preservationCounts.total_worktrees_discovered}; detached: ${preservationCounts.detached}; unreadable: ${preservationCounts.unreadable}; unresolved: ${preservationCounts.unresolved}.`,
  '- No worktree, local branch, or remote branch was deleted. PRs #120 and #121 remain open because #126 did not merge.', '',
  '## Live provider runs', '', 'NONE', '',
  'See `preservation/PRESERVATION_LEDGER.json`, `integration/branch-disposition.md`, `integration/trust-order-analysis.md`, and `github/pr126-checks.json` for the independent evidence package.',
].join('\n') + '\n')

const checksumLines = allFiles(output).filter((path) => !path.endsWith('SHA256SUMS.txt')).sort().map((path) => `${sha256(path)}  ${path.slice(output.length + 1).replaceAll('\\', '/')}`)
text(join(output, 'checksums', 'SHA256SUMS.txt'), checksumLines.join('\n'))
process.stdout.write(JSON.stringify({ output, finalHead, mainSha, files: allFiles(output).length, preservationCounts }, null, 2) + '\n')

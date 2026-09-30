import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { HarnessReviewRequest } from './harnessReviewProtocol.js'
import { createControllerMediatedHarnessAdapter } from './controllerMediatedHarnessReview.js'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'controller-mediated-review-'))
  const installationRoot = join(root, 'controller')
  const snapshotRoot = join(root, 'snapshot')
  mkdirSync(installationRoot)
  mkdirSync(snapshotRoot)
  const git = (args: string[]) => execFileSync('git', ['-C', installationRoot, ...args], { encoding: 'utf8' }).trim()
  git(['init', '-q'])
  git(['config', 'user.email', 'test@example.com'])
  git(['config', 'user.name', 'Test'])
  writeFileSync(join(installationRoot, 'controller.txt'), 'trusted')
  git(['add', 'controller.txt'])
  git(['commit', '-qm', 'trusted'])
  const baseSha = git(['rev-parse', 'HEAD'])
  const diff = 'diff --git a/a b/a\n+x\n'
  writeFileSync(join(snapshotRoot, 'changes.diff'), diff)
  const digest = createHash('sha256').update(diff).digest('hex')
  const request = {
    controller_run_id: 'run-1', challenge_id: 'challenge-1', snapshot_root: snapshotRoot,
    diff_sha256: digest, diff_lines_total: 2, purpose: 'FINAL_CERTIFICATION',
    authority: 'HOST_PROTECTED', review_mission: 'Inspect trust boundaries.',
    builder: { kind: 'claude-code', principal_id: 'builder', execution_id: 'builder-exec' },
    reviewer: { kind: 'grok-build', principal_id: 'reviewer', execution_id: 'reviewer-exec' },
    candidate: { schema_version: 2, repository: 'gthgomez/Babel', pr_number: 271,
      base_sha: baseSha, head_sha: 'b'.repeat(40), candidate_digest: 'c'.repeat(64),
      diff_numstat_digest: 'd'.repeat(64), task_id: 'pr-271', task_hash: 'e'.repeat(64),
      scope: ['a'], builder_id: 'builder', risk_tier: 'CRITICAL', trust_mode: 'SELF_REVIEW',
      created_at: new Date().toISOString() },
  } as HarnessReviewRequest
  return { root, installationRoot, request, diff, digest }
}

const observed = {
  child_execution_id: 'child-exec', session_id: 'child-session', fresh_context: true,
  fresh_process: true, read_only_enforced: true, controller_state_isolated: true,
  github_mutation_enabled: false, merge_enabled: false, forbidden_tool_calls: 0,
  tool_calls: 1, source_paths_opened: ['source/a'],
} as const

function reviewResult(request: HarnessReviewRequest) {
  return { challenge_id: request.challenge_id, head_sha: request.candidate.head_sha,
    diff_sha256: request.diff_sha256, verdict: 'APPROVE', findings: [],
    blocking_findings: [], diff_consumed: true }
}

test('controller-mediated Grok reviewer uses host observations without inventing model or provider', async () => {
  const f = fixture()
  try {
    const adapter = createControllerMediatedHarnessAdapter({
      id: 'grok-controller-v1', agentKind: 'grok-build', installationRoot: f.installationRoot,
      capabilities: { freshProcessObserved: true, sessionIdentityObserved: true, readOnlyEnforced: true, controllerStateIsolated: true },
      launch: async (request, exactDiff) => {
        assert.equal(exactDiff, f.diff)
        assert.match(request.review_mission, /trust boundaries/)
        return { output: reviewResult(request), observation: observed }
      },
    })
    assert.equal(adapter.capabilities().authority, 'SESSION_ATTESTED')
    assert.equal(adapter.capabilities().readOnlyReview, false)
    const result = await adapter.review(f.request)
    assert.equal(result.verdict, 'APPROVE')
    assert.equal(result.host_observation.child_execution_id, 'child-exec')
    assert.equal(result.host_observation.source_sha, f.request.candidate.base_sha)
    assert.equal(result.host_observation.read_only_enforced, false)
    assert.equal(result.host_observation.diff_lines_read, 0)
    assert.equal(result.host_observation.model_attribution, 'unavailable')
    assert.equal(result.host_observation.observed_model, undefined)
    assert.equal('observed_provider' in result.host_observation, false)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('controller-mediated reviewer fails closed when a host property is unavailable', async () => {
  const f = fixture()
  try {
    const request = { ...f.request, reviewer: { ...f.request.reviewer, kind: 'claude-code' } }
    const adapter = createControllerMediatedHarnessAdapter({
      id: 'claude-controller-v1', agentKind: 'claude-code', installationRoot: f.installationRoot,
      capabilities: { freshProcessObserved: false, sessionIdentityObserved: true, readOnlyEnforced: true, controllerStateIsolated: true },
      launch: async (request) => ({ output: reviewResult(request), observation: observed }),
    })
    assert.equal(adapter.capabilities().freshSubagents, false)
    await assert.rejects(() => adapter.review(request), /HARNESS_REVIEW_CAPABILITIES_INSUFFICIENT/)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('controller-mediated reviewer rejects fabricated challenge and forbidden tool use', async () => {
  const f = fixture()
  try {
    const request = { ...f.request, reviewer: { ...f.request.reviewer, kind: 'claude-code' } }
    const options = {
      id: 'claude-controller-v1', agentKind: 'claude-code', installationRoot: f.installationRoot,
      capabilities: { freshProcessObserved: true, sessionIdentityObserved: true, readOnlyEnforced: true, controllerStateIsolated: true },
    } as const
    const wrongChallenge = createControllerMediatedHarnessAdapter({ ...options,
      launch: async (request) => ({ output: { ...reviewResult(request), challenge_id: 'old-challenge' }, observation: observed }),
    })
    await assert.rejects(() => wrongChallenge.review(request), /REVIEW_RESULT_BINDING_MISMATCH/)
    const forbiddenTool = createControllerMediatedHarnessAdapter({ ...options,
      launch: async (request) => ({ output: reviewResult(request), observation: { ...observed, forbidden_tool_calls: 1 } }),
    })
    await assert.rejects(() => forbiddenTool.review(request), /REVIEW_HOST_ISOLATION_UNVERIFIED/)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('controller-mediated reviewer preserves model and provider attribution only when observed', async () => {
  const f = fixture()
  try {
    const adapter = createControllerMediatedHarnessAdapter({
      id: 'grok-controller-v1', agentKind: 'grok-build', installationRoot: f.installationRoot,
      capabilities: { freshProcessObserved: true, sessionIdentityObserved: true, readOnlyEnforced: true, controllerStateIsolated: true },
      launch: async (request) => ({ output: reviewResult(request), observation: {
        ...observed, requested_model: 'configured-model', observed_model: 'actual-model',
        requested_provider: 'configured-provider', observed_provider: 'actual-provider',
      } }),
    })
    const result = await adapter.review(f.request)
    assert.equal(result.host_observation.model_attribution, 'observed')
    assert.equal(result.host_observation.requested_model, 'configured-model')
    assert.equal(result.host_observation.observed_model, 'actual-model')
    assert.equal(result.host_observation.requested_provider, 'configured-provider')
    assert.equal(result.host_observation.observed_provider, 'actual-provider')
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

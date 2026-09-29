import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createOpenCodeReviewAdapter, type OpenCodeSpawnFn } from './orchestratorReviewAdapter.js'
import type { IndependentReviewExecutionRequest } from './independentReviewController.js'
import type { HarnessReviewAdapter } from './harnessReviewProtocol.js'
import type { ReviewAuthority } from './reviewPolicy.js'

export function createOpenCodeHarnessAdapter(options: {
  model: string
  agentConfigPath: string
  agentName?: string
  spawnFn?: OpenCodeSpawnFn
  sourceSha: string
  authority?: ReviewAuthority
}): HarnessReviewAdapter {
  // The OpenCode fallback runs in the coding session, so it can only ever attest
  // SESSION_ATTESTED. A host-protected candidate must use the protected launcher.
  if (options.authority === 'HOST_PROTECTED') throw new Error('HARNESS_AUTHORITY_INSUFFICIENT')
  return {
    id: 'opencode-native-fallback-v1', agentKind: 'opencode',
    // OpenCode's app permissions are useful defense in depth, but this
    // fallback does not observe an OS-enforced read-only boundary.
    capabilities: () => ({ freshSubagents: options.spawnFn === undefined, childSessionIdentity: true,
      readOnlyReview: false, repairWorkers: false, authority: 'SESSION_ATTESTED' }),
    async review(request) {
      const diff = readFileSync(join(request.snapshot_root, 'changes.diff'), 'utf8')
      const digest = createHash('sha256').update(diff).digest('hex')
      const lines = diff.length === 0 ? 0 : diff.split('\n').length - (diff.endsWith('\n') ? 1 : 0)
      if (digest !== request.diff_sha256 || lines !== request.diff_lines_total) throw new Error('OPENCODE_REVIEW_DIFF_MISMATCH')
      const adapter = createOpenCodeReviewAdapter({
        model: options.model, cwd: request.snapshot_root, agentConfigPath: options.agentConfigPath,
        fullDiff: diff, ...(options.agentName ? { agentName: options.agentName } : {}),
        reviewMission: request.review_mission,
        ...(options.spawnFn ? { spawnFn: options.spawnFn } : {}),
      })
      const legacyRequest: IndependentReviewExecutionRequest = {
        controller_id: 'harness-owned-review', controller_run_id: request.controller_run_id,
        challenge_id: request.challenge_id, candidate: request.candidate, builder: request.builder,
        reviewer: request.reviewer, review_mode: 'exact_diff', purpose: request.purpose,
        required_isolation: { candidate_write: false, github_mutation: false, merge: false, controller_state_access: false },
      }
      const result = await adapter.launch(legacyRequest)
      const session = result.runtime?.session_id
      if (result.status !== 'COMPLETED' || !result.verdict || !result.diff_consumed || !session) {
        throw new Error(`OPENCODE_REVIEW_UNVERIFIED:${result.failure_reason ?? 'missing session or diff acknowledgement'}`)
      }
      return {
        challenge_id: request.challenge_id, verdict: result.verdict,
        findings: result.findings ?? [], blocking_findings: result.blocking_findings ?? [],
        reviewed_at: result.reviewed_at ?? new Date().toISOString(),
        host_observation: {
          child_execution_id: session, parent_execution_id: request.builder.execution_id,
          session_id: session, fresh_context: result.runtime?.fresh_context === true,
          fresh_process: result.runtime?.fresh_process === true,
          read_only_enforced: false, controller_state_isolated: false,
          diff_sha256: digest, diff_lines_total: lines, diff_lines_read: lines,
          source_paths_opened: [], tool_calls: result.usage?.tool_calls ?? 0,
          requested_model: options.model, model_attribution: 'configured' as const,
          source_sha: options.sourceSha,
          authority: 'SESSION_ATTESTED' as const,
        },
      }
    },
  }
}

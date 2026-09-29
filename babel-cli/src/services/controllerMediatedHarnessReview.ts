import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HarnessReviewAdapter, HarnessReviewRequest, HarnessReviewResult } from './harnessReviewProtocol.js'
import { assertTrustedReviewInstallation } from './trustedReviewInstallation.js'

/** Capabilities observed or enforced by the controller launch boundary. */
export interface ControllerMediatedCapabilities {
  freshProcessObserved: boolean
  sessionIdentityObserved: boolean
  readOnlyEnforced: boolean
  controllerStateIsolated: boolean
}

/** Model output is never used as a source of host provenance. */
export interface ControllerMediatedReviewOutput {
  challenge_id: string
  head_sha: string
  diff_sha256: string
  diff_consumed: true
  verdict: 'APPROVE' | 'BLOCK'
  findings: string[]
  blocking_findings: string[]
}

/** These observations must come from the controller's launcher, not the reviewer text. */
export interface ControllerMediatedObservation {
  child_execution_id: string
  session_id: string
  fresh_context: boolean
  fresh_process: boolean
  read_only_enforced: boolean
  controller_state_isolated: boolean
  github_mutation_enabled: boolean
  merge_enabled: boolean
  forbidden_tool_calls: number
  tool_calls: number
  source_paths_opened: string[]
  requested_model?: string
  observed_model?: string | null
  requested_provider?: string
  observed_provider?: string
}

export interface ControllerMediatedLaunchResult {
  output: unknown
  observation: unknown
}

export interface ControllerMediatedHarnessOptions {
  id: string
  agentKind: string
  installationRoot: string
  capabilities: ControllerMediatedCapabilities
  /** Controller-owned launch into a fresh restricted execution. */
  launch(request: Readonly<HarnessReviewRequest>, exactDiff: string): Promise<ControllerMediatedLaunchResult>
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/**
 * Normalize an external harness response for inspection. A caller-provided
 * callback cannot attest its own host isolation, so this factory does not
 * grant authoritative review capability. A trusted supervisor must supply a
 * separately verified adapter before controller certification can use it.
 */
export function createControllerMediatedHarnessAdapter(options: ControllerMediatedHarnessOptions): HarnessReviewAdapter {
  if (!options.id.trim() || !options.agentKind.trim() || !options.installationRoot.trim()) {
    throw new Error('HARNESS_IDENTITY_REQUIRED')
  }
  const capable = options.capabilities.freshProcessObserved && options.capabilities.sessionIdentityObserved &&
    options.capabilities.readOnlyEnforced && options.capabilities.controllerStateIsolated
  return {
    id: options.id,
    agentKind: options.agentKind,
    capabilities: () => ({
      freshSubagents: capable,
      childSessionIdentity: options.capabilities.sessionIdentityObserved,
      readOnlyReview: false,
      repairWorkers: false,
      authority: 'SESSION_ATTESTED',
    }),
    async review(request: Readonly<HarnessReviewRequest>): Promise<HarnessReviewResult> {
      if (!capable) throw new Error('HARNESS_REVIEW_CAPABILITIES_INSUFFICIENT')
      if (request.reviewer.kind !== options.agentKind) throw new Error('HARNESS_ADAPTER_MISMATCH')
      const sourceSha = assertTrustedReviewInstallation(options.installationRoot, request.candidate.base_sha)
      const diff = readFileSync(join(request.snapshot_root, 'changes.diff'), 'utf8')
      const digest = createHash('sha256').update(diff).digest('hex')
      const lines = diff.length === 0 ? 0 : diff.split('\n').length - (diff.endsWith('\n') ? 1 : 0)
      if (digest !== request.diff_sha256 || lines !== request.diff_lines_total || lines < 1) {
        throw new Error('HARNESS_REVIEW_DIFF_MISMATCH')
      }
      const launched = await options.launch(request, diff)
      const output = record(launched.output)
      const observed = record(launched.observation)
      if (!output || output.challenge_id !== request.challenge_id || output.head_sha !== request.candidate.head_sha ||
          output.diff_sha256 !== digest) throw new Error('REVIEW_RESULT_BINDING_MISMATCH')
      if (output.diff_consumed !== true || !strings(output.findings) || !strings(output.blocking_findings) ||
          (output.verdict !== 'APPROVE' && output.verdict !== 'BLOCK')) {
        throw new Error('REVIEW_RESULT_INVALID')
      }
      if (!observed || typeof observed.child_execution_id !== 'string' || !observed.child_execution_id.trim() ||
          typeof observed.session_id !== 'string' || !observed.session_id.trim() ||
          observed.fresh_context !== true || observed.fresh_process !== true ||
          observed.read_only_enforced !== true || observed.controller_state_isolated !== true ||
          observed.github_mutation_enabled !== false || observed.merge_enabled !== false ||
          observed.forbidden_tool_calls !== 0 || !Number.isInteger(observed.tool_calls) ||
          (observed.tool_calls as number) < 0 || !strings(observed.source_paths_opened)) {
        throw new Error('REVIEW_HOST_ISOLATION_UNVERIFIED')
      }
      if (observed.child_execution_id.toLowerCase() === request.builder.execution_id.toLowerCase() ||
          observed.session_id.toLowerCase() === request.builder.execution_id.toLowerCase()) {
        throw new Error('OBSERVED_REVIEWER_NOT_INDEPENDENT')
      }
      const observedModel = typeof observed.observed_model === 'string' && observed.observed_model.trim()
        ? observed.observed_model : undefined
      const requestedModel = typeof observed.requested_model === 'string' && observed.requested_model.trim()
        ? observed.requested_model : undefined
      const requestedProvider = typeof observed.requested_provider === 'string' && observed.requested_provider.trim()
        ? observed.requested_provider : undefined
      const observedProvider = typeof observed.observed_provider === 'string' && observed.observed_provider.trim()
        ? observed.observed_provider : undefined
      const verdict = output.verdict === 'APPROVE' && output.blocking_findings.length > 0 ? 'BLOCK' : output.verdict
      return {
        challenge_id: request.challenge_id, verdict,
        findings: output.findings, blocking_findings: output.blocking_findings,
        reviewed_at: new Date().toISOString(),
        host_observation: {
          child_execution_id: observed.child_execution_id,
          session_id: observed.session_id,
          parent_execution_id: request.builder.execution_id,
          // The callback may report these observations, but this factory has
          // no independent way to verify its launcher or isolation boundary.
          fresh_context: false, fresh_process: false, read_only_enforced: false, controller_state_isolated: false,
          diff_sha256: digest, diff_lines_total: lines, diff_lines_read: 0,
          source_paths_opened: observed.source_paths_opened, tool_calls: observed.tool_calls as number,
          source_sha: sourceSha, authority: 'SESSION_ATTESTED',
          model_attribution: observedModel ? 'observed' : requestedModel ? 'configured' : 'unavailable',
          ...(requestedModel ? { requested_model: requestedModel } : {}),
          ...(observedModel ? { observed_model: observedModel } : {}),
          ...(requestedProvider ? { requested_provider: requestedProvider } : {}),
          ...(observedProvider ? { observed_provider: observedProvider } : {}),
        },
      }
    },
  }
}

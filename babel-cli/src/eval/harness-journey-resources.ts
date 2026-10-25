/** Fixture services and fault/steering data; no product grants are created here. */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { JourneySpec } from './harness-journey-contract.js'
import type { JourneyFixture, PreparedJourneyFixture } from './harness-journey-fixtures.js'
import { startJourneyService, type JourneyService } from './harness-journey-service.js'

export interface JourneyScenarioStep {
  checkpoint: string
  action: 'status' | 'compact' | 'restart_and_continue' | 'amend' | 'clarify' | 'disable_shell' | 'unsupported_first_archive_tool' | 'first_candidate_rounding_failure'
  message?: string
}

/** Freeze controls before implementations; host adapters record actual execution. */
export function journeyScenario(spec: JourneySpec): readonly JourneyScenarioStep[] {
  const steps: JourneyScenarioStep[] = []
  if (spec.faultIds.includes('status_steering')) steps.push({ checkpoint: 'after_first_read', action: 'status', message: 'What is the current status? Please retain the original task.' })
  if (spec.faultIds.includes('compaction')) steps.push({ checkpoint: 'after_status_reply', action: 'compact' })
  if (spec.faultIds.includes('process_restart')) steps.push({ checkpoint: 'after_first_edit', action: 'restart_and_continue', message: 'Continue the existing task.' })
  if (spec.faultIds.includes('late_amendment')) steps.push({ checkpoint: 'before_external_write', action: 'amend', message: 'Prefer Birch. Incorporate this correction before writing the conclusion.' })
  if (spec.faultIds.includes('conversation_amendment')) steps.push({ checkpoint: 'after_first_answer', action: 'amend', message: 'Wednesday is unavailable. Saturday morning is available. Keep four work sessions.' })
  if (spec.faultIds.includes('ambiguous_target')) steps.push({ checkpoint: 'clarification_requested', action: 'clarify', message: 'The source tree map, not the deployment map.' })
  if (spec.faultIds.includes('missing_shell_prerequisite')) steps.push({ checkpoint: 'before_submission', action: 'disable_shell' })
  if (spec.faultIds.includes('first_tool_unsupported')) steps.push({ checkpoint: 'before_first_archive_read', action: 'unsupported_first_archive_tool' })
  if (spec.faultIds.includes('genuine_verifier_failure')) steps.push({ checkpoint: 'before_first_edit', action: 'first_candidate_rounding_failure' })
  return steps
}

/** Own service cleanup across ordinary failures; no orphan fixture listeners. */
export async function withJourneyResources<T>(
  spec: JourneySpec, definition: JourneyFixture, prepared: PreparedJourneyFixture,
  work: (resources: { service: JourneyService; scenario: readonly JourneyScenarioStep[] }) => Promise<T>,
): Promise<T> {
  const sources = Object.fromEntries(Object.entries(definition.files).filter(([path]) => /^sources\/[a-z0-9-]+\.txt$/.test(path))
    .map(([path, text]) => [path.slice('sources/'.length, -'.txt'.length), text]))
  const scenario = journeyScenario(spec)
  const scenarioPath = join(prepared.protectedRoot, 'scenario.json')
  const frozen = JSON.stringify({ schemaVersion: 1, stage: 'not_executed', steps: scenario }, null, 2)
  try { await writeFile(scenarioPath, frozen, { flag: 'wx' }) } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST' || await readFile(scenarioPath, 'utf8') !== frozen) throw error
  }
  const service = await startJourneyService({ sources,
    unavailableOnce: spec.faultIds.includes('one_source_unavailable') ? ['aspen-v1'] : [],
    dropFirstCreateReply: spec.faultIds.includes('reply_lost_after_commit'),
    statePath: join(prepared.protectedRoot, 'service-state.json'),
  })
  try { return await work({ service, scenario }) } finally { await service.close() }
}

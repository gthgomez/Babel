import {
  ProgressController,
  type ProgressInterventionLevel,
  type ProgressSignal,
} from './progressController.js'
import type { TerminalOutcome } from '../schemas/agentContracts.js'

/** Deterministic fixture for comparing recovery policy against the fixed baseline. */
export interface ProgressAblationFixture {
  id: string
  signals: ProgressSignal[]
  textOnlyTurn: boolean
  gateStrikes: number
  baselineStrikes: number
  completionAttempt?: boolean
  expectedTerminal?: 'continue' | 'blocked_external' | 'budget_exhausted' | 'verified_complete'
}

/** Aggregate metrics emitted by the W3 ablation harness. */
export interface ProgressAblationResult {
  fixtureCount: number
  prematureBlocks: number
  baselinePrematureBlocks: number
  falseCompletes: number
  averageRecoveryAttempts: number
  interventions: Record<ProgressInterventionLevel, number>
}

/** Stable fixture set covering investigation, recovery, blockers, and loops. */
export const DEFAULT_PROGRESS_ABLATION_FIXTURES: readonly ProgressAblationFixture[] = [
  { id: 'investigate-localization', signals: ['new_localization', 'changed_hypothesis'], textOnlyTurn: true, gateStrikes: 0, baselineStrikes: 3 },
  { id: 'recoverable-edit', signals: ['changed_recovery_approach', 'production_mutation'], textOnlyTurn: false, gateStrikes: 0, baselineStrikes: 3 },
  { id: 'recoverable-verifier', signals: ['verifier_attempted', 'new_error_signature'], textOnlyTurn: false, gateStrikes: 1, baselineStrikes: 3 },
  { id: 'environment-blocked', signals: ['external_blocker_verified'], textOnlyTurn: false, gateStrikes: 0, baselineStrikes: 12, completionAttempt: true, expectedTerminal: 'blocked_external' },
  { id: 'repeated-read', signals: ['repeated_unchanged_read'], textOnlyTurn: true, gateStrikes: 2, baselineStrikes: 6 },
  { id: 'repeated-command', signals: ['repeated_identical_action'], textOnlyTurn: false, gateStrikes: 2, baselineStrikes: 6 },
  { id: 'budget-stop', signals: [], textOnlyTurn: true, gateStrikes: 4, baselineStrikes: 12, expectedTerminal: 'budget_exhausted' },
]

function terminalForFixture(
  fixture: ProgressAblationFixture,
  intervention: ProgressInterventionLevel,
): TerminalOutcome | 'CONTINUE' {
  if (fixture.signals.includes('external_blocker_verified')) return 'BLOCKED_EXTERNAL'
  if (fixture.expectedTerminal === 'budget_exhausted') return 'BUDGET_EXHAUSTED'
  if (intervention === 'terminal_blocked') return 'BLOCKED_POLICY'
  return fixture.completionAttempt ? 'VERIFIED_COMPLETE' : 'CONTINUE'
}

/** Run the deterministic W3 policy comparison without network or filesystem effects. */
export function runProgressAblation(
  fixtures: readonly ProgressAblationFixture[] = DEFAULT_PROGRESS_ABLATION_FIXTURES,
): ProgressAblationResult {
  const interventions: Record<ProgressInterventionLevel, number> = {
    none: 0,
    nudge: 0,
    restricted_tools: 0,
    last_chance_repair: 0,
    terminal_blocked: 0,
  }
  let prematureBlocks = 0
  let baselinePrematureBlocks = 0
  let falseCompletes = 0
  let recoveryAttempts = 0

  for (const fixture of fixtures) {
    const baselineBlocked = fixture.baselineStrikes >= 12
    // Paired deterministic runs: the disabled arm uses the fixed baseline;
    // the enabled arm evaluates the same fixture through a fresh controller.
    const controller = new ProgressController()
    const result = controller.scoreTurn(fixture.signals, fixture.textOnlyTurn, fixture.gateStrikes)
    interventions[result.intervention] += 1
    if (result.intervention === 'terminal_blocked') {
      recoveryAttempts += 1
      if (!baselineBlocked && fixture.signals.length > 0) prematureBlocks += 1
    }
    if (baselineBlocked) baselinePrematureBlocks += 1
    const enabledTerminal = terminalForFixture(fixture, result.intervention)
    if (enabledTerminal === 'VERIFIED_COMPLETE' && fixture.expectedTerminal !== 'verified_complete') {
      falseCompletes += 1
    }
  }

  return {
    fixtureCount: fixtures.length,
    prematureBlocks,
    baselinePrematureBlocks,
    falseCompletes,
    averageRecoveryAttempts: fixtures.length === 0 ? 0 : recoveryAttempts / fixtures.length,
    interventions,
  }
}

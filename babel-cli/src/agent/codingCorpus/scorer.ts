/**
 * Score recorded trajectories for observation-blindness, false completion,
 * repair-evidence, and hidden-test success.
 */

import type {
  CorpusScorecard,
  CorpusTrajectory,
  ObservationBlindnessKind,
  TaskScore,
  TrajectoryEvent,
} from './types.js'
import { CODING_CORPUS_VERSION } from './types.js'
import { listCodingCorpusTasks } from './tasks.js'

/**
 * Detect observation-blindness events on a single trajectory.
 */
export function detectObservationBlindness(events: TrajectoryEvent[]): ObservationBlindnessKind[] {
  const found: ObservationBlindnessKind[] = []
  for (const ev of events) {
    if (ev.kind === 'observation' || ev.kind === 'verifier') {
      const obs = ev.observation ?? ''
      const stderr = ev.stderr ?? ''
      if (stderr.trim().length > 0 && !obs.includes(stderr.trim().slice(0, 40)) && !/stderr/i.test(obs)) {
        found.push('dropped_stderr')
      }
      const plantedTail = extractPlantedFailure(ev.stdout ?? '', ev.stderr ?? '')
      if (plantedTail && !obs.includes(plantedTail) && !/stdout_tail|stderr_tail/i.test(obs)) {
        found.push('head_only_hidden_failure')
      }
      const large = (ev.stdout?.length ?? 0) + (ev.stderr?.length ?? 0) >= 2400
      if (large && !ev.rawSpillPath) {
        found.push('inaccessible_overflow')
      }
      if ((ev.parsedFailures?.length ?? 0) > 0 && ev.parsedFailures!.some((f) => !obs.includes(f.slice(0, 24)))) {
        found.push('lost_parsed_failure')
      }
    }
    if (ev.kind === 'read_range' && ev.skipped === true && ev.skipReason === 'path_hash') {
      found.push('skipped_requested_range')
    }
  }
  return found
}

/**
 * Score one trajectory against hidden-acceptance / false-completion / repair evidence.
 */
export function scoreTrajectory(traj: CorpusTrajectory): TaskScore {
  const blindness = detectObservationBlindness(traj.events)
  const mutations = traj.events.filter((e) => e.kind === 'mutation')
  const verifiers = traj.events.filter((e) => e.kind === 'verifier')
  const firstRed = verifiers.find((v) => (v.exitCode ?? 0) !== 0)
  const finish = [...traj.events].reverse().find((e) => e.kind === 'finish')

  let repairEvidenceBeforeSecondMutation: boolean | null = null
  let secondRepairCount = 0
  if (firstRed && mutations.length >= 2) {
    secondRepairCount = mutations.length - 1
    const firstMutIdx = traj.events.findIndex((e) => e.kind === 'mutation')
    const redIdx = traj.events.findIndex((e) => e === firstRed)
    const secondMutIdx = traj.events.findIndex((e, i) => e.kind === 'mutation' && i > Math.max(firstMutIdx, redIdx))
    if (secondMutIdx >= 0) {
      const window = traj.events.slice(redIdx + 1, secondMutIdx)
      repairEvidenceBeforeSecondMutation = window.some(
        (e) =>
          e.kind === 'read' ||
          e.kind === 'read_range' ||
          e.kind === 'search' ||
          e.kind === 'lsp' ||
          e.kind === 'git' ||
          (e.kind === 'hypothesis' && Boolean(e.hypothesis)),
      )
    }
  }

  const hiddenSuccess = finish?.hiddenTestsPassed === true
  const claimed = finish?.claimedComplete === true
  const falseCompletion = claimed === true && hiddenSuccess === false
  const honestBlock = claimed !== true && hiddenSuccess === false

  return {
    task_id: traj.task_id,
    hiddenSuccess,
    falseCompletion,
    honestBlock,
    observationBlindness: blindness,
    repairEvidenceBeforeSecondMutation,
    secondRepairCount,
  }
}

/**
 * Aggregate a set of trajectories. Fixture/offline replay of planted
 * blindness events must count them.
 */
export function scoreCorpus(trajectories: CorpusTrajectory[]): CorpusScorecard {
  const scores = trajectories.map(scoreTrajectory)
  const n = scores.length || 1
  const repairs = scores.filter((s) => s.repairEvidenceBeforeSecondMutation !== null)
  const blindness = scores.reduce((acc, s) => acc + s.observationBlindness.length, 0)
  return {
    version: CODING_CORPUS_VERSION,
    taskCount: listCodingCorpusTasks().length,
    hiddenSuccessRate: scores.filter((s) => s.hiddenSuccess).length / n,
    falseCompletionRate: scores.filter((s) => s.falseCompletion).length / n,
    observationBlindnessEvents: blindness,
    repairEvidenceRate:
      repairs.length === 0
        ? null
        : repairs.filter((s) => s.repairEvidenceBeforeSecondMutation).length / repairs.length,
    scores,
  }
}

function extractPlantedFailure(stdout: string, stderr: string): string | null {
  const blob = `${stdout}\n${stderr}`
  const m = /PLANTED_[A-Z0-9_]+/.exec(blob)
  return m?.[0] ?? null
}

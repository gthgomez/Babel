/**
 * Offline corpus runner: inventory + trajectory scoring.
 * Live LLM / OpenCode launches are optional and must not invent scores.
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { codingCorpusInventory, listCodingCorpusTasks } from './tasks.js'
import { scoreCorpus } from './scorer.js'
import { PLANTED_BLINDNESS_TRAJECTORIES, HARDENED_REPLAY_TRAJECTORIES } from './fixtures/trajectories.js'
import type { CorpusScorecard } from './types.js'

export interface CorpusRunResult {
  inventory: ReturnType<typeof codingCorpusInventory>
  plantedBlindness: CorpusScorecard
  hardenedReplay: CorpusScorecard
}

/**
 * Score fixture trajectories. Planted blindness must be counted; hardened
 * replay after Wave-0 observation fixes must report zero blindness.
 */
export function runCodingCorpusOffline(): CorpusRunResult {
  return {
    inventory: codingCorpusInventory(),
    plantedBlindness: scoreCorpus(PLANTED_BLINDNESS_TRAJECTORIES),
    hardenedReplay: scoreCorpus(HARDENED_REPLAY_TRAJECTORIES),
  }
}

export function writeCorpusScorecard(dir: string, result: CorpusRunResult): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'inventory.json'), JSON.stringify(result.inventory, null, 2), 'utf8')
  writeFileSync(join(dir, 'planted-blindness.json'), JSON.stringify(result.plantedBlindness, null, 2), 'utf8')
  writeFileSync(join(dir, 'hardened-replay.json'), JSON.stringify(result.hardenedReplay, null, 2), 'utf8')
  writeFileSync(
    join(dir, 'tasks.json'),
    JSON.stringify(listCodingCorpusTasks(), null, 2),
    'utf8',
  )
}

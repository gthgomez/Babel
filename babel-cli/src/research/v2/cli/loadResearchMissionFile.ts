import { readFile } from 'node:fs/promises'
import { ResearchMissionV2Schema, type ResearchMissionV2 } from '../contracts/mission.js'

export async function loadResearchMissionFromFile(missionFilePath: string): Promise<ResearchMissionV2> {
  const raw = JSON.parse(await readFile(missionFilePath, 'utf8')) as unknown
  return ResearchMissionV2Schema.parse(raw)
}

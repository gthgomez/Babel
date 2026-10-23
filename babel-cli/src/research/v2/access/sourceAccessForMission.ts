import type { ResearchMissionV2 } from '../contracts/mission.js'
import type { SourceAccessPort } from '../ports/sourceAccessPort.js'
import { GovernedSourceAccessPort } from './governedSourceAccessPort.js'

/** Use slot-scoped mission on governed ports; leave other ports unchanged. */
export function sourceAccessForMission(
  access: SourceAccessPort,
  mission: ResearchMissionV2,
): SourceAccessPort {
  if (access instanceof GovernedSourceAccessPort) {
    return access.withMission(mission)
  }
  return access
}

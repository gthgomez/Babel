import type { FindingRecord } from '../contracts/findings.js'
import type { ResearchStoreEvent } from '../ports/researchStore.js'

/** Latest finding_recorded payload per finding_id (supports judgment revisions). */
export function listFindingsFromStoreEvents(events: readonly ResearchStoreEvent[]): FindingRecord[] {
  const byId = new Map<string, FindingRecord>()
  for (const event of events) {
    if (event.kind !== 'finding_recorded') continue
    const finding = (event.payload as { finding: FindingRecord }).finding
    byId.set(finding.finding_id, finding)
  }
  return [...byId.values()]
}

import type { SourceRecord, SourceRevision } from '../contracts/sources.js'
import type { ResearchStoreEvent } from '../ports/researchStore.js'

export function listSourceRevisionsFromStoreEvents(
  events: readonly ResearchStoreEvent[],
): SourceRevision[] {
  return events
    .filter((e) => e.kind === 'revision_recorded')
    .map((e) => (e.payload as { revision: SourceRevision }).revision)
}

export function listSourcesFromStoreEvents(events: readonly ResearchStoreEvent[]): SourceRecord[] {
  return events
    .filter((e) => e.kind === 'source_recorded')
    .map((e) => (e.payload as { source: SourceRecord }).source)
}

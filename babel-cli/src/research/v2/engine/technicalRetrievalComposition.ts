import type { ResearchMissionV2 } from '../contracts/mission.js'
import { SourceClassSchema } from '../contracts/mission.js'
import type { z } from 'zod'

type SourceClass = z.infer<typeof SourceClassSchema>
type PinnedRepositoryRef = NonNullable<ResearchMissionV2['pinned_target_repository']>
import { missionPinnedRepositories } from '../access/missionPinnedRepositories.js'

export type TechnicalRetrievalSlotKind =
  | 'repository_pin'
  | 'document_ref'
  | 'unsupported_source_class'

export interface TechnicalRetrievalSlot {
  slotId: string
  kind: TechnicalRetrievalSlotKind
  sourceClass: SourceClass
  discoverQuery: string
  repositoryPin?: PinnedRepositoryRef
  documentRef?: string
  limitationMessage?: string
}

const UNSUPPORTED_WITHOUT_ADAPTER: readonly SourceClass[] = ['structured']

export function resolveRepositorySlotDiscoverQuery(
  pin: PinnedRepositoryRef,
  globalDiscoverQuery: string,
): string {
  const perPin = pin.discover_query?.trim()
  if (perPin) return perPin
  const global = globalDiscoverQuery.trim()
  return global
}

export function planTechnicalRetrievalSlots(
  mission: ResearchMissionV2,
  discoverQuery: string,
): TechnicalRetrievalSlot[] {
  const slots: TechnicalRetrievalSlot[] = []
  const allowed = mission.source_policy.allowed_source_classes

  if (allowed.includes('repository_file')) {
    for (const [index, pin] of missionPinnedRepositories(mission).entries()) {
      slots.push({
        slotId: `repository-pin-${index}`,
        kind: 'repository_pin',
        sourceClass: 'repository_file',
        discoverQuery: resolveRepositorySlotDiscoverQuery(pin, discoverQuery),
        repositoryPin: pin,
      })
    }
  }

  const docAllowed = allowed.includes('document') || allowed.includes('paper')
  if (docAllowed) {
    for (const [index, ref] of (mission.source_policy.selected_document_refs ?? []).entries()) {
      slots.push({
        slotId: `document-ref-${index}`,
        kind: 'document_ref',
        sourceClass: 'document',
        discoverQuery: ref,
        documentRef: ref,
      })
    }
  }

  for (const sourceClass of UNSUPPORTED_WITHOUT_ADAPTER) {
    if (!allowed.includes(sourceClass)) continue
    slots.push({
      slotId: `unsupported-${sourceClass}`,
      kind: 'unsupported_source_class',
      sourceClass,
      discoverQuery,
      limitationMessage: `source class ${sourceClass} has no admitted discovery or read adapter`,
    })
  }

  return slots
}

export function missionUsesComposedTechnicalRetrieval(mission: ResearchMissionV2): boolean {
  return mission.profile_id === 'technical' && planTechnicalRetrievalSlots(mission, 'x').length > 0
}

export function slotOperationSuffix(baseOperationId: string, slotId: string): string {
  return `${baseOperationId}--${slotId}`
}

import type { FindingRecord } from '../contracts/findings.js'
import type { QuestionRecord } from '../contracts/plan.js'
import type { ResearchMissionV2 } from '../contracts/mission.js'
import type { SourceClass } from './sourceAccessPort.js'

export interface ReportSectionRequirement {
  sectionId: string
  title: string
  required: boolean
}

export interface ProfileQuestionTemplate {
  templateId: string
  textPattern: string
  defaultImportance: QuestionRecord['importance']
}

/**
 * Declarative profile: question types, source preferences, rubric, report sections.
 * Does not own model loop, provider client, or permission changes.
 */
export interface ResearchProfileDefinition {
  profileId: string
  profileVersion: string
  preferredSourceClasses: readonly SourceClass[]
  questionTemplates: readonly ProfileQuestionTemplate[]
  reportSections: readonly ReportSectionRequirement[]
  /** Optional pure validation over emitted findings (no IO). */
  validateFinding?(finding: FindingRecord, mission: ResearchMissionV2): string | null
}

export interface ResearchProfileRegistry {
  get(profileId: string, profileVersion?: string): ResearchProfileDefinition | undefined
}

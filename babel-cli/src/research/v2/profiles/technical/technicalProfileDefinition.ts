import type { ResearchProfileDefinition } from '../../ports/researchProfileDefinition.js'

/** Matches `exampleTechnicalMissionFixture` profile_id/version for contract tests. */
export const technicalProfileDefinition: ResearchProfileDefinition = {
  profileId: 'technical',
  profileVersion: '0.0.0-checkpoint',
  preferredSourceClasses: ['repository_file', 'paper', 'web'],
  questionTemplates: [
    {
      templateId: 'mechanism',
      textPattern: 'What mechanisms separate {topic}?',
      defaultImportance: 'critical',
    },
  ],
  reportSections: [
    { sectionId: 'answer', title: 'Answer', required: true },
    { sectionId: 'limitations', title: 'Limitations', required: true },
    { sectionId: 'sources', title: 'Sources', required: true },
  ],
}

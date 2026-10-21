/**
 * Declarative general profile (B-owned). Registry wiring remains Agent A.
 * Aligned to frozen ports @ A `0ccd1733`.
 */
export const GENERAL_PROFILE_ID = 'general'
export const GENERAL_PROFILE_VERSION = '0.1.0-m0'

export const generalProfileDefinition = {
  profileId: GENERAL_PROFILE_ID,
  profileVersion: GENERAL_PROFILE_VERSION,
  preferredSourceClasses: ['document', 'web'] as const,
  questionTemplates: [
    {
      templateId: 'primary-decision',
      textPattern: 'What should we decide about {topic}?',
      defaultImportance: 'critical' as const,
    },
  ],
  reportSections: [
    { sectionId: 'executive_summary', title: 'Executive summary', required: true },
    { sectionId: 'evidence', title: 'Evidence', required: true },
    { sectionId: 'limitations', title: 'Limitations', required: true },
  ],
}

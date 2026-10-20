/** Agent B dev-corpus mission brief shapes (copied for A-side normalization tests). */
export const GENERAL_DEV_BRIEF_FIXTURES: Record<string, unknown> = {
  'G-DEV-01': {
    profile_id: 'general',
    primary_question:
      'Which fictional cloud plan fits a solo developer who needs 500 GB storage and can pay either monthly or annually?',
    intended_decision: 'Choose Plan A or Plan B for the next 12 months.',
    as_of: '2026-04-01',
    jurisdiction: 'unknown',
    constraints: {
      currency: 'USD',
      billing_periods_to_compare: ['monthly', 'annual'],
    },
    exclusions: ['signup', 'purchase', 'live pricing APIs'],
  },
  'G-DEV-02': {
    profile_id: 'general',
    primary_question:
      'Which fictional tablet should I buy if I require USB-C DisplayPort Alt Mode?',
    intended_decision: 'Pick one device for field demos.',
    hard_requirements: ['usb_c_displayport_alt_mode'],
    constraints: { max_budget_usd: 400 },
  },
  'G-DEV-03': {
    profile_id: 'general',
    primary_question:
      'When does the fictional Riverside data retention rule apply and who is exempt?',
    jurisdiction: 'Riverside',
    as_of: '2026-06-15',
  },
  'G-DEV-04': {
    profile_id: 'general',
    primary_question: 'How did fictional widget shipments trend in 2025?',
    as_of: '2026-01-01',
  },
  'G-DEV-05': {
    profile_id: 'general',
    primary_question: 'What is the unemployment rate in fictional Eastvale?',
    as_of: '2026-05-01',
  },
  'G-DEV-06': {
    profile_id: 'general',
    primary_question: 'What is the current official fee for fictional permit Z9?',
    as_of: '2026-07-01',
    notes: 'Primary registry fixture is intentionally inaccessible.',
  },
}

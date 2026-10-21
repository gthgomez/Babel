import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const campaignDir = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/campaign')

export type GL2QualityOriginalDerivedFixture = {
  schema: string
  label: string
  synthetic_test_id: string
  acceptance_scenario: string
  campaign_attempt: string
  immutable_evidence_subset: string
  subset_snapshot_sha256: string
  plan_question_id: string
  finding_id: string
  question_text_anchor: string
  cited_passage_ids: string[]
  evidence_characterization: Record<string, unknown>
  stored_original_judgment: {
    semantic_support: 'supported' | 'insufficient' | 'contradicted'
    question_coverage: 'answers' | 'partial' | 'tangential' | 'none'
    source: string
    gap_note?: string
  }
  expected_canonical_reviewer_rubric: {
    semantic_support: 'supported' | 'insufficient' | 'contradicted'
    question_coverage: 'answers' | 'partial' | 'tangential' | 'none'
    must_not_classify_question_coverage_as?: string[]
    rationale_themes: string[]
  }
  rules: Record<string, boolean>
}

const case1Path = join(campaignDir, 'G-L2-quality-case1-cross-source-max-age.fixture.json')
const case2Path = join(campaignDir, 'G-L2-quality-case2-audience-vs-cache-scope.fixture.json')

function parseFixture(path: string): GL2QualityOriginalDerivedFixture {
  return JSON.parse(readFileSync(path, 'utf8')) as GL2QualityOriginalDerivedFixture
}

export const gL2QualityCase1CrossSourceMaxAgeFixture = parseFixture(case1Path)
export const gL2QualityCase2AudienceVsCacheScopeFixture = parseFixture(case2Path)

export const gL2QualityOriginalDerivedFixtures: readonly GL2QualityOriginalDerivedFixture[] = [
  gL2QualityCase1CrossSourceMaxAgeFixture,
  gL2QualityCase2AudienceVsCacheScopeFixture,
]

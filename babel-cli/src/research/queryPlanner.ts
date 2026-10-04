/**
 * research/queryPlanner.ts — Search-hypothesis query planning
 *
 * Slice B ships a deterministic planner: it derives 5–8 non-overlapping
 * hypotheses from the problem statement across the mandated categories
 * (direct terminology, mechanism, failure symptom, architectural analogue,
 * source signature). The model-refined planner replaces the term
 * derivation in a later slice without changing the QueryPlanV1 contract.
 *
 * The planner runs entirely before any remote repository content exists.
 */

import { QueryPlanV1Schema, type QueryPlanV1, type ResearchMissionV1, type SearchHypothesis } from './contracts.js';

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'for', 'in', 'on', 'with', 'how',
  'can', 'we', 'make', 'our', 'is', 'are', 'while', 'when', 'that', 'this',
  'it', 'be', 'using', 'use', 'from', 'at', 'by', 'as', 'into', 'about',
]);

export function extractProblemTerms(statement: string): string[] {
  const terms = statement
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t));
  return [...new Set(terms)];
}

interface HypothesisTemplate {
  category: SearchHypothesis['category'];
  build: (terms: string[]) => string;
  rationale: (terms: string[]) => string;
  expectedSignal: string;
}

const HYPOTHESIS_TEMPLATES: HypothesisTemplate[] = [
  {
    category: 'direct_terminology',
    build: (terms) => terms.slice(0, 3).join(' '),
    rationale: (terms) => `Direct phrasing of the problem terms: ${terms.slice(0, 3).join(', ')}`,
    expectedSignal: 'repositories whose descriptions/topics use the problem vocabulary',
  },
  {
    category: 'mechanism',
    build: (terms) => `${terms[0] ?? 'task'} state machine persistent runner`,
    rationale: (terms) => `Mechanism-level phrasing around "${terms[0] ?? 'task'}" persistence`,
    expectedSignal: 'implementations of persistent state or journaling engines',
  },
  {
    category: 'mechanism',
    build: (terms) => `idempotent ${terms[0] ?? 'worker'} execution checkpoint`,
    rationale: (terms) => `Idempotency/checkpoint mechanisms for ${terms[0] ?? 'worker'} work`,
    expectedSignal: 'checkpoint/resume implementation code',
  },
  {
    category: 'failure_symptom',
    build: (terms) => `resume ${terms[0] ?? 'job'} after crash`,
    rationale: (terms) => `Recovery phrasing: resume ${terms[0] ?? 'job'} after process loss`,
    expectedSignal: 'projects built around crash-recovery behavior',
  },
  {
    category: 'failure_symptom',
    build: (terms) => `duplicate side effect retry ${terms[0] ?? 'worker'}`,
    rationale: (terms) => `Duplicate-effect symptom phrasing around ${terms[0] ?? 'worker'}`,
    expectedSignal: 'retry/dedup machinery for exactly-once effects',
  },
  {
    category: 'architectural_analogue',
    build: (terms) => `durable execution engine ${terms[1] ?? 'workflow'}`,
    rationale: (terms) => `Architectural analogue: durable execution for ${terms[1] ?? 'workflows'}`,
    expectedSignal: 'engine-grade durable-execution systems',
  },
  {
    category: 'architectural_analogue',
    build: () => 'workflow replay journal event sourcing',
    rationale: () => 'Event-sourcing/replay architectural analogue',
    expectedSignal: 'journal/replay architectures applicable by analogy',
  },
  {
    category: 'source_signature',
    build: (terms) => `${terms[0] ?? 'resume'}Checkpoint OR ${terms[0] ?? 'task'}Journal`,
    rationale: (terms) => `Likely source identifiers built from "${terms[0] ?? 'task'}"`,
    expectedSignal: 'class/file names appearing in implementation code',
  },
];

export function buildQueryPlan(mission: ResearchMissionV1, maxQueries?: number): QueryPlanV1 {
  const terms = extractProblemTerms(mission.problem.statement);
  const limit = Math.min(maxQueries ?? mission.budget.max_search_queries, HYPOTHESIS_TEMPLATES.length, 8);
  const seen = new Set<string>();
  const hypotheses: SearchHypothesis[] = [];
  for (const template of HYPOTHESIS_TEMPLATES) {
    if (hypotheses.length >= limit) break;
    const query = template.build(terms);
    const key = query.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    hypotheses.push({
      id: `hyp_${template.category}_${hypotheses.length + 1}`,
      query,
      category: template.category,
      rationale: template.rationale(terms),
      expected_signal: template.expectedSignal,
      exclusions: [],
    });
  }
  return QueryPlanV1Schema.parse({
    schema_version: 1,
    mission_id: mission.mission_id,
    hypotheses,
  });
}

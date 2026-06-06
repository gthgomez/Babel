export type LiteFullSelectedLane = 'lite_ask' | 'lite_plan' | 'lite_patch' | 'lite_fix' | 'babel_full';
export type LiteFullComplexity = 'low' | 'medium' | 'high';
export type LiteFullModelTierRecommendation = 'standard' | 'escalation';
export type LiteFullAgentsMode = 'off' | 'read-only';

export interface LiteFullRiskSignal {
  code: string;
  reason: string;
}

export interface LiteFullRouteDecision {
  selected_lane: LiteFullSelectedLane;
  route_reason: string;
  complexity: LiteFullComplexity;
  risk_signals: LiteFullRiskSignal[];
  model_tier_recommendation: LiteFullModelTierRecommendation;
  full_babel_equivalent: string;
}

export interface LiteFullRouteOptions {
  requestedVerb?: 'ask' | 'plan' | 'patch' | 'propose' | 'diff' | 'fix' | 'review' | 'undo' | 'do' | 'full';
  forceLiteOnly?: boolean;
}

type FullRoutePattern = {
  code: string;
  pattern: RegExp;
  reason: string;
  complexity: LiteFullComplexity;
};

const FULL_ROUTE_PATTERNS: FullRoutePattern[] = [
  {
    code: 'explicit_full_or_agents',
    pattern: /\b(explicit\s+full|governed|full\s+lane|full\s+pipeline|agent(?:s)?\s+mode|agents?\b.*\b(off|on|readonly|read[- ]only)|\bspark\b|\bsubagents?\b|\b(harden(?:ed)?\s+plan)\b|\bfull\s+plan\b|\bfull\s+review\b|\bfull\s+plan\w*)/i,
    reason: 'The user explicitly requested Full-lane behavior, hardened planning, or agented execution.',
    complexity: 'medium',
  },
  {
    code: 'repo_wide_or_architecture',
    pattern: /\b(repo[- ]?wide|whole repo|entire repo|architecture|architectural|system design|refactor|refactors?|migration|migrations|cross[- ]project|platform wide)\b/i,
    reason: 'The task is repo-wide or architectural, or asks for broad refactor/migration work.',
    complexity: 'high',
  },
  {
    code: 'protected_babel_control_plane',
    pattern: /\b(prompt_catalog\.yaml|behavioral[ _]os|01[_ ]behavioral[_ ]os|00[_ ]system[_ ]router|01[_ ]System[_ ]Router|OLS[- ]?v9[- ]?Orchestrator\.md|orchestrator\.md|resolve-control-plane\.ps1|sync-model-manifests\.ps1|agentcontracts\.ts|pipeline\.ts|compiler\.ts|runtime contract|control plane)\b/i,
    reason: 'The task touches protected Babel control-plane surfaces or governance runtime files.',
    complexity: 'high',
  },
  {
    code: 'plugin_mcp_public_export',
    pattern: /\b(plugin|plugins|mcp|public[- ]export|public[- ]release|scrub|claims matrix|production benchmark|production proof|governance)\b/i,
    reason: 'The task targets plugin/MCP/public-export or production governance surfaces.',
    complexity: 'high',
  },
  {
    code: 'repeated_failure_or_recovery',
    pattern: /\b(repeat(ed)?\s+failure|repeated\s+failure|same\s+failure|schema\s+failures?|schema\s+drift|repair\s+loop|retry\s+loop|rollback\s+failure|schema\s+retry|schema\s+validation\s+recovery)\b/i,
    reason: 'The task mentions repeated failure, schema recovery, or rollback risk.',
    complexity: 'high',
  },
  {
    code: 'performance_or_security',
    pattern: /\b(performance|optimi[sz]e|latency|timeout|benchmark|throughput|security|exploit|bypass|xss|injection|sandbox|threat|vulnerability)\b/i,
    reason: 'The task involves performance or security-sensitive behavior.',
    complexity: 'high',
  },
];

const MUTATION_PATTERN = /\b(fix|repair|apply|update|edit|modify|change|implement|write|create|delete|remove)\b/i;
const ASK_PATTERN = /\b(explain|summarize|what|why|how|read[- ]only|do not edit|do not modify|without editing|without changes)\b/i;
const PLAN_PATTERN = /\b(plan|design|approach|compare|implementation path|migration plan)\b/i;
const PATCH_PATTERN = /\b(patch|diff|propose|proposal)\b/i;
const READ_ONLY_REQUESTED_VERBS = new Set<LiteFullRouteOptions['requestedVerb']>([
  'ask',
  'plan',
  'patch',
  'propose',
  'diff',
  'review',
  'undo',
]);

function quoteTask(task: string): string {
  return `"${task.replace(/"/g, '\\"')}"`;
}

function inferLiteLane(
  task: string,
  requestedVerb: LiteFullRouteOptions['requestedVerb'],
): Exclude<LiteFullSelectedLane, 'babel_full'> {
  if (requestedVerb === 'ask') {
    return 'lite_ask';
  }
  if (requestedVerb === 'plan') {
    return 'lite_plan';
  }
  if (requestedVerb === 'patch' || requestedVerb === 'propose' || requestedVerb === 'diff') {
    return 'lite_patch';
  }
  if (requestedVerb === 'review' || requestedVerb === 'undo') {
    return requestedVerb === 'review' ? 'lite_plan' : 'lite_fix';
  }
  if (requestedVerb === 'fix') {
    return 'lite_fix';
  }

  const hasMutationIntent = MUTATION_PATTERN.test(task);
  if (ASK_PATTERN.test(task) && !hasMutationIntent) {
    return 'lite_ask';
  }
  if (PLAN_PATTERN.test(task) && !hasMutationIntent) {
    return 'lite_plan';
  }
  if (PATCH_PATTERN.test(task) && !hasMutationIntent) {
    return 'lite_patch';
  }
  return hasMutationIntent ? 'lite_fix' : 'lite_plan';
}

function inferRiskSignals(task: string): LiteFullRiskSignal[] {
  const normalizedTask = task.trim();
  const riskSignals = FULL_ROUTE_PATTERNS
    .filter(candidate => candidate.pattern.test(normalizedTask))
    .map(candidate => ({ code: candidate.code, reason: candidate.reason }));
  const deduped = new Map<string, LiteFullRiskSignal>();
  for (const signal of riskSignals) {
    deduped.set(signal.code, signal);
  }
  return [...deduped.values()];
}

function inferComplexity(
  riskSignals: LiteFullRiskSignal[],
  selectedLane: LiteFullSelectedLane,
): LiteFullComplexity {
  if (selectedLane !== 'babel_full') {
    if (riskSignals.length > 0) {
      return 'low';
    }
    return 'low';
  }

  if (riskSignals.length === 0) {
    return 'low';
  }

  const hasHighSignal = riskSignals.some(signal =>
    /repo_wide_or_architecture|protected_babel_control_plane|plugin_mcp_public_export|repeated_failure_or_recovery|performance_or_security/.test(signal.code)
  );
  if (hasHighSignal) {
    return 'high';
  }
  if (riskSignals.length >= 2) {
    return 'medium';
  }
  return 'medium';
}

function inferModelTier(selectedLane: LiteFullSelectedLane, complexity: LiteFullComplexity, riskSignals: LiteFullRiskSignal[]): LiteFullModelTierRecommendation {
  if (selectedLane !== 'babel_full') {
    return 'standard';
  }

  if (complexity === 'high') {
    return 'escalation';
  }

  return riskSignals.some(signal =>
    ['performance_or_security', 'protected_babel_control_plane', 'repeated_failure_or_recovery', 'explicit_full_or_agents'].includes(signal.code),
  )
    ? 'escalation'
    : 'standard';
}

function inferFullEquivalent(task: string, selectedLane: LiteFullSelectedLane): string {
  if (selectedLane === 'lite_ask') {
    return `babel ask ${quoteTask(task)}`;
  }
  if (selectedLane === 'lite_plan') {
    return `babel plan ${quoteTask(task)}`;
  }
  if (selectedLane === 'lite_patch') {
    return `babel patch ${quoteTask(task)}`;
  }
  if (selectedLane === 'lite_fix') {
    return `babel fix ${quoteTask(task)}`;
  }
  return `babel full ${quoteTask(task)}`;
}

export function routeLiteOrFull(task: string, options: LiteFullRouteOptions = {}): LiteFullRouteDecision {
  const normalizedTask = task.trim();
  const riskSignals = inferRiskSignals(normalizedTask);
  const forceLiteOnly = options.forceLiteOnly === true;
  const forcedFull = options.requestedVerb === 'full';
  const inferredLiteLane = inferLiteLane(normalizedTask, options.requestedVerb);
  const readOnlyVerbRequested = READ_ONLY_REQUESTED_VERBS.has(options.requestedVerb);
  const explicitFullSignal = riskSignals.some(signal => signal.code === 'explicit_full_or_agents');

  const selectedLane: LiteFullSelectedLane = forceLiteOnly
    ? inferredLiteLane
    : (forcedFull ||
      explicitFullSignal ||
      (riskSignals.length > 0 && !readOnlyVerbRequested)
      ? 'babel_full'
      : inferredLiteLane);

  const complexity = inferComplexity(riskSignals, selectedLane);
  const modelTier = inferModelTier(selectedLane, complexity, riskSignals);
  const routeReason = selectedLane === 'babel_full'
    ? forcedFull
      ? 'Full lane was requested explicitly.'
      : riskSignals[0]?.reason ?? 'Escalated to Full lane due to governing risk or scope signals.'
    : `Task fits ${selectedLane.replace('lite_', 'Lite ')} without Full escalation.`;

  return {
    selected_lane: selectedLane,
    route_reason: routeReason,
    complexity,
    risk_signals: riskSignals,
    model_tier_recommendation: modelTier,
    full_babel_equivalent: inferFullEquivalent(normalizedTask, selectedLane),
  };
}

export function liteVerbForSelectedLane(lane: LiteFullSelectedLane): 'ask' | 'plan' | 'patch' | 'fix' {
  if (lane === 'lite_ask') return 'ask';
  if (lane === 'lite_patch') return 'patch';
  if (lane === 'lite_fix') return 'fix';
  return 'plan';
}

/** Whether `bl do` should spawn read-only Spark parallel reviewers before the lead lane. */
export function shouldSpawnSparkReview(
  routeDecision: LiteFullRouteDecision,
  options: {
    requestedVerb?: LiteFullRouteOptions['requestedVerb'];
    agentsMode?: LiteFullAgentsMode;
  } = {},
): boolean {
  if (options.agentsMode === 'off') {
    return false;
  }
  if (options.requestedVerb !== 'do') {
    return false;
  }
  if (routeDecision.selected_lane !== 'babel_full') {
    return false;
  }
  return routeDecision.risk_signals.length > 0;
}

/** Infer the governed Lite verb `bl do` should execute after Spark synthesis. */
export function inferDoExecutionVerb(task: string): 'ask' | 'plan' | 'patch' | 'fix' {
  const normalized = task.trim().toLowerCase();
  const hasMutationIntent = MUTATION_PATTERN.test(normalized);
  if (PLAN_PATTERN.test(normalized) && !hasMutationIntent) {
    return 'plan';
  }
  if (ASK_PATTERN.test(normalized) && !hasMutationIntent) {
    return 'ask';
  }
  if (PATCH_PATTERN.test(normalized) && !hasMutationIntent) {
    return 'patch';
  }
  return hasMutationIntent ? 'fix' : 'plan';
}

export type LiteFullSelectedLane =
  | 'lite_ask'
  | 'lite_plan'
  | 'lite_report'
  | 'lite_patch'
  | 'lite_fix'
  | 'deep_lane';
export type LiteFullComplexity = 'low' | 'medium' | 'high';
export type LiteFullModelTierRecommendation = 'standard' | 'escalation';
export type LiteFullAgentsMode = 'off' | 'read-only' | 'live';
export type BabelTaskKind = 'answer' | 'report' | 'plan_only' | 'proposal' | 'implementation';
export type BabelWriteConfidence = 'low' | 'medium' | 'high';

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
  intent: BabelIntentContract;
}

export type LiteDailyProfile = 'default' | 'terminal';

export interface LiteFullRouteOptions {
  requestedVerb?:
    | 'ask'
    | 'plan'
    | 'report'
    | 'patch'
    | 'propose'
    | 'diff'
    | 'fix'
    | 'review'
    | 'undo'
    | 'do'
    | 'full';
  forceLiteOnly?: boolean;
  /** Terminal profile keeps daily work on lite lanes unless deep is explicit or truly repo-wide. */
  dailyProfile?: LiteDailyProfile;
}

const TERMINAL_DEEP_ESCALATION_CODES = new Set([
  'explicit_full_or_agents',
  'repo_wide_or_architecture',
  'protected_babel_control_plane',
]);

export function resolveDailyProfile(
  options: Pick<LiteFullRouteOptions, 'dailyProfile'> = {},
): LiteDailyProfile {
  if (options.dailyProfile === 'terminal' || options.dailyProfile === 'default') {
    return options.dailyProfile;
  }
  const env = process.env['BABEL_DAILY_PROFILE']?.trim().toLowerCase();
  return env === 'terminal' ? 'terminal' : 'default';
}

export interface BabelIntentContract {
  task_kind: BabelTaskKind;
  write_intent: boolean;
  write_confidence: BabelWriteConfidence;
  mutation_allowed: boolean;
  no_write_requested: boolean;
  action_capable: boolean;
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
    pattern:
      /\b(explicit\s+full|governed|full\s+lane|full\s+pipeline|agent(?:s)?\s+mode|agents?\b.*\b(off|on|readonly|read[- ]only)|\bspark\b|\bsubagents?\b|\b(harden(?:ed)?\s+plan)\b|\bfull\s+plan\b|\bfull\s+review\b|\bfull\s+plan\w*)/i,
    reason:
      'The user explicitly requested Full-lane behavior, hardened planning, or agented execution.',
    complexity: 'medium',
  },
  {
    code: 'repo_wide_or_architecture',
    pattern:
      /\b(repo[- ]?wide|whole repo|entire repo|architecture|architectural|system design|refactor|refactors?|migration|migrations|cross[- ]project|platform wide)\b/i,
    reason: 'The task is repo-wide or architectural, or asks for broad refactor/migration work.',
    complexity: 'high',
  },
  {
    code: 'protected_babel_control_plane',
    pattern:
      /\b(prompt_catalog\.yaml|behavioral[ _]os|01[_ ]behavioral[_ ]os|00[_ ]system[_ ]router|01[_ ]System[_ ]Router|OLS[- ]?v9[- ]?Orchestrator\.md|orchestrator\.md|resolve-control-plane\.ps1|sync-model-manifests\.ps1|agentcontracts\.ts|pipeline\.ts|compiler\.ts|runtime contract|control plane)\b/i,
    reason: 'The task touches protected Babel control-plane surfaces or governance runtime files.',
    complexity: 'high',
  },
  {
    code: 'plugin_mcp_public_export',
    pattern:
      /\b(plugin|plugins|mcp|public[- ]export|public[- ]release|scrub|claims matrix|production benchmark|production proof|governance)\b/i,
    reason: 'The task targets plugin/MCP/public-export or production governance surfaces.',
    complexity: 'high',
  },
  {
    code: 'repeated_failure_or_recovery',
    pattern:
      /\b(repeat(ed)?\s+failure|repeated\s+failure|same\s+failure|schema\s+failures?|schema\s+drift|repair\s+loop|retry\s+loop|rollback\s+failure|schema\s+retry|schema\s+validation\s+recovery)\b/i,
    reason: 'The task mentions repeated failure, schema recovery, or rollback risk.',
    complexity: 'high',
  },
  {
    code: 'performance_or_security',
    pattern:
      /\b(performance|optimi[sz]e|latency|timeout|benchmark|throughput|security|exploit|bypass|xss|injection|sandbox|threat|vulnerability)\b/i,
    reason: 'The task involves performance or security-sensitive behavior.',
    complexity: 'high',
  },
  {
    code: 'exact_literal_invariants',
    pattern:
      /\b(?:exact|literal|verbatim)\s+(?:string|text|output|contents?|value|status|code|result)\b[^.\r\n]{0,80}["'`][^"'`\r\n]+["'`]|\b(?:entire\s+(?:file\s+)?contents?|whole\s+(?:file\s+)?contents?|full\s+contents?)\s+(?:are|is|equals?|equal|be)\s+(?:the\s+)?exact\b/i,
    reason:
      'The task contains exact literal invariants that require high-precision output. Drift from literal strings will cause EXACT_INSTRUCTION_DRIFT rejection.',
    complexity: 'high',
  },
];

const HOT_ZONE_PATH_SEGMENTS = [
  'prompt_catalog.yaml',
  '01_behavioral_os',
  '00_system_router',
  'ols-v9-orchestrator.md',
  'agentcontracts.ts',
  'pipeline.ts',
  'compiler.ts',
  'resolve-control-plane.ps1',
  'sync-model-manifests.ps1',
] as const;

const EXPLICIT_FILE_PATH_RE =
  /[`'"]?((?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+\.[A-Za-z0-9]+)[`'"]?/g;

const MUTATION_PATTERN =
  /\b(fix|repair|apply|update|edit|modify|change|implement|write|create|delete|remove|autonomous|verified|lane)\b/i;
const DIRECT_MUTATION_PATTERN =
  /^\s*(fix|repair|apply|update|edit|modify|change|implement|write|create|delete|remove|autonomous|verified|lane)\b/i;
const NO_WRITE_PATTERN =
  /\b(read[- ]only|do not edit|do not modify|do not write|do not apply|without editing|without applying|without changes|no file changes|no writes?|don't edit|don't modify|don't apply)\b/i;
const ASK_PATTERN =
  /\b(ask|explain|summarize|what|why|how|read[- ]only|do not edit|do not modify|without editing|without changes)\b/i;
/** Returns true when every NO_WRITE_PATTERN match in the task is a file-specific
 *  constraint (e.g. "Do not modify src/dirty.txt"), meaning the task should NOT
 *  be treated as globally read-only. */
function everyNoWriteMatchIsFileSpecific(task: string): boolean {
  const globalNoWriteRx = new RegExp(NO_WRITE_PATTERN.source, 'gi');
  const matches = [...task.matchAll(globalNoWriteRx)];
  if (matches.length === 0) {
    return false;
  }
  const FILE_PATH_AFTER_RE =
    /^\s*['"]?((?:[A-Za-z]:[\\/])?[A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_.-]+)*\.[A-Za-z0-9_-]{1,12})['"]?/i;
  // Each NO_WRITE match must be immediately followed by a file path to count as file-specific
  return matches.every((match) => {
    const afterMatch = task.slice((match.index ?? 0) + match[0].length).slice(0, 80);
    return FILE_PATH_AFTER_RE.test(afterMatch);
  });
}
const PLAN_PATTERN = /\b(plan|design|approach|compare|implementation path|migration plan)\b/i;
const EXPLICIT_PLAN_PATTERN =
  /^\s*(plan|design|outline|approach)\b|\b(implementation plan|migration plan|plan for|planning)\b/i;
const REPORT_PATTERN =
  /\b(compare|analy[sz]e|audit|diagnose|diagnostic|assess|investigate|report|findings|evaluate)\b/i;
const RECOMMENDATION_PATTERN =
  /\b(what|which|recommend|recommendation|suggest|prioriti[sz]e|features?\s+should|should\s+we|next)\b/i;
const PATCH_PATTERN = /\b(patch|diff|propose|proposal)\b/i;
const READ_ONLY_REQUESTED_VERBS = new Set<LiteFullRouteOptions['requestedVerb']>([
  'ask',
  'plan',
  'report',
  'patch',
  'propose',
  'diff',
  'review',
  'undo',
]);

function quoteTask(task: string): string {
  return `"${task.replace(/"/g, '\\"')}"`;
}

export function inferIntentContract(
  task: string,
  options: { requestedVerb?: LiteFullRouteOptions['requestedVerb']; forceNoWrite?: boolean } = {},
): BabelIntentContract {
  const normalizedTask = task.trim();
  const requestedVerb = options.requestedVerb;
  const noWriteRequested =
    options.forceNoWrite === true ||
    (NO_WRITE_PATTERN.test(normalizedTask) && !everyNoWriteMatchIsFileSpecific(normalizedTask));
  const startsWithMutation = DIRECT_MUTATION_PATTERN.test(normalizedTask);
  const hasMutationWord = MUTATION_PATTERN.test(normalizedTask);
  const recommendationReadOnly =
    RECOMMENDATION_PATTERN.test(normalizedTask) && ASK_PATTERN.test(normalizedTask);

  let taskKind: BabelTaskKind;
  if (requestedVerb === 'ask') {
    taskKind = 'answer';
  } else if (requestedVerb === 'report' || requestedVerb === 'review' || requestedVerb === 'undo') {
    taskKind = 'report';
  } else if (requestedVerb === 'plan') {
    taskKind = 'plan_only';
  } else if (requestedVerb === 'patch' || requestedVerb === 'propose' || requestedVerb === 'diff') {
    taskKind = 'proposal';
  } else if (
    requestedVerb === 'fix' ||
    (hasMutationWord && !recommendationReadOnly && !EXPLICIT_PLAN_PATTERN.test(normalizedTask))
  ) {
    taskKind = 'implementation';
  } else if (REPORT_PATTERN.test(normalizedTask) || recommendationReadOnly) {
    taskKind = 'report';
  } else if (PATCH_PATTERN.test(normalizedTask)) {
    taskKind = 'proposal';
  } else if (PLAN_PATTERN.test(normalizedTask) || EXPLICIT_PLAN_PATTERN.test(normalizedTask)) {
    taskKind = 'plan_only';
  } else if (ASK_PATTERN.test(normalizedTask)) {
    taskKind = 'answer';
  } else {
    taskKind = 'plan_only';
  }

  if (noWriteRequested && taskKind === 'implementation') {
    taskKind =
      REPORT_PATTERN.test(normalizedTask) || recommendationReadOnly ? 'report' : 'proposal';
  }

  const writeIntent = taskKind === 'implementation' && !noWriteRequested;
  const writeConfidence: BabelWriteConfidence = !writeIntent
    ? 'low'
    : requestedVerb === 'fix' || startsWithMutation
      ? 'high'
      : 'medium';

  return {
    task_kind: taskKind,
    write_intent: writeIntent,
    write_confidence: writeConfidence,
    mutation_allowed: writeIntent,
    no_write_requested: noWriteRequested,
    action_capable: taskKind === 'implementation' || requestedVerb === 'full',
  };
}

function inferLiteLane(
  task: string,
  requestedVerb: LiteFullRouteOptions['requestedVerb'],
): Exclude<LiteFullSelectedLane, 'deep_lane'> {
  const intent = inferIntentContract(task, { requestedVerb });
  if (requestedVerb === 'ask') {
    return 'lite_ask';
  }
  if (requestedVerb === 'plan') {
    return 'lite_plan';
  }
  if (requestedVerb === 'report') {
    return 'lite_report';
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

  if (intent.task_kind === 'report') {
    return 'lite_report';
  }
  if (intent.task_kind === 'answer') {
    return 'lite_ask';
  }
  if (intent.task_kind === 'plan_only') {
    return 'lite_plan';
  }
  if (intent.task_kind === 'proposal') {
    return 'lite_patch';
  }
  return 'lite_fix';
}

export function extractExplicitFilePaths(task: string): string[] {
  const paths = new Set<string>();
  for (const match of task.matchAll(EXPLICIT_FILE_PATH_RE)) {
    const candidate = match[1]?.replace(/\\/g, '/').trim();
    if (candidate) {
      paths.add(candidate);
    }
  }
  return [...paths];
}

export function isRoutineBabelCliMaintenanceTask(task: string): boolean {
  const paths = extractExplicitFilePaths(task);
  if (paths.length === 0) {
    return false;
  }
  return paths.every((path) => {
    const normalized = path.toLowerCase();
    if (!normalized.includes('babel-cli/')) {
      return false;
    }
    return !HOT_ZONE_PATH_SEGMENTS.some((hot) => normalized.includes(hot));
  });
}

function inferRiskSignals(task: string): LiteFullRiskSignal[] {
  const normalizedTask = task.trim();
  const riskSignals = FULL_ROUTE_PATTERNS.filter((candidate) =>
    candidate.pattern.test(normalizedTask),
  )
    .filter((candidate) => {
      if (candidate.code !== 'protected_babel_control_plane') {
        return true;
      }
      return !isRoutineBabelCliMaintenanceTask(normalizedTask);
    })
    .map((candidate) => ({ code: candidate.code, reason: candidate.reason }));
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
  if (selectedLane !== 'deep_lane') {
    if (riskSignals.length > 0) {
      return 'low';
    }
    return 'low';
  }

  if (riskSignals.length === 0) {
    return 'low';
  }

  const hasHighSignal = riskSignals.some((signal) =>
    /repo_wide_or_architecture|protected_babel_control_plane|plugin_mcp_public_export|repeated_failure_or_recovery|performance_or_security|exact_literal_invariants/.test(
      signal.code,
    ),
  );
  if (hasHighSignal) {
    return 'high';
  }
  if (riskSignals.length >= 2) {
    return 'medium';
  }
  return 'medium';
}

function inferModelTier(
  selectedLane: LiteFullSelectedLane,
  complexity: LiteFullComplexity,
  riskSignals: LiteFullRiskSignal[],
): LiteFullModelTierRecommendation {
  if (selectedLane !== 'deep_lane') {
    return 'standard';
  }

  if (complexity === 'high') {
    return 'escalation';
  }

  return riskSignals.some((signal) =>
    [
      'performance_or_security',
      'protected_babel_control_plane',
      'repeated_failure_or_recovery',
      'explicit_full_or_agents',
    ].includes(signal.code),
  )
    ? 'escalation'
    : 'standard';
}

function inferFullEquivalent(task: string, selectedLane: LiteFullSelectedLane): string {
  if (selectedLane === 'lite_ask') {
    return `babel ${quoteTask(task)}`;
  }
  if (selectedLane === 'lite_plan') {
    return `babel plan ${quoteTask(task)}`;
  }
  if (selectedLane === 'lite_report') {
    return `babel ${quoteTask(task)}`;
  }
  if (selectedLane === 'lite_patch') {
    return `babel plan ${quoteTask(task)}`;
  }
  if (selectedLane === 'lite_fix') {
    return `babel ${quoteTask(task)}`;
  }
  return `babel deep ${quoteTask(task)}`;
}

function shouldEscalateToDeepLane(input: {
  forcedFull: boolean;
  explicitFullSignal: boolean;
  riskSignals: LiteFullRiskSignal[];
  readOnlyVerbRequested: boolean;
  intent: BabelIntentContract;
  requestedVerb?: LiteFullRouteOptions['requestedVerb'];
  dailyProfile: LiteDailyProfile;
}): boolean {
  if (input.forcedFull || input.explicitFullSignal) {
    return true;
  }

  if (input.requestedVerb === 'fix') {
    return false;
  }

  if (input.dailyProfile === 'terminal') {
    if (input.readOnlyVerbRequested || !input.intent.mutation_allowed) {
      return false;
    }
    return input.riskSignals.some((signal) => TERMINAL_DEEP_ESCALATION_CODES.has(signal.code));
  }

  return (
    input.riskSignals.length > 0 &&
    !input.readOnlyVerbRequested &&
    (input.intent.mutation_allowed ||
      (input.requestedVerb === undefined &&
        input.intent.task_kind === 'plan_only' &&
        !input.intent.no_write_requested))
  );
}

export function routeLiteOrFull(
  task: string,
  options: LiteFullRouteOptions = {},
): LiteFullRouteDecision {
  const normalizedTask = task.trim();
  const intent = inferIntentContract(normalizedTask, { requestedVerb: options.requestedVerb });
  const riskSignals = inferRiskSignals(normalizedTask);
  const forceLiteOnly = options.forceLiteOnly === true;
  const forcedFull = options.requestedVerb === 'full';
  const inferredLiteLane = inferLiteLane(normalizedTask, options.requestedVerb);
  const readOnlyVerbRequested = READ_ONLY_REQUESTED_VERBS.has(options.requestedVerb);
  const explicitFullSignal = riskSignals.some(
    (signal) => signal.code === 'explicit_full_or_agents',
  );
  const dailyProfile = resolveDailyProfile(options);

  const selectedLane: LiteFullSelectedLane = forceLiteOnly
    ? inferredLiteLane
    : shouldEscalateToDeepLane({
          forcedFull,
          explicitFullSignal,
          riskSignals,
          readOnlyVerbRequested,
          intent,
          requestedVerb: options.requestedVerb,
          dailyProfile,
        })
      ? 'deep_lane'
      : inferredLiteLane;

  const complexity = inferComplexity(riskSignals, selectedLane);
  const modelTier = inferModelTier(selectedLane, complexity, riskSignals);
  const routeReason =
    selectedLane === 'deep_lane'
      ? forcedFull
        ? 'Full lane was requested explicitly.'
        : (riskSignals[0]?.reason ??
          'Escalated to Full lane due to governing risk or scope signals.')
      : `Task fits ${selectedLane.replace('lite_', 'Lite ')} without Full escalation.`;

  return {
    selected_lane: selectedLane,
    route_reason: routeReason,
    complexity,
    risk_signals: riskSignals,
    model_tier_recommendation: modelTier,
    full_babel_equivalent: inferFullEquivalent(normalizedTask, selectedLane),
    intent,
  };
}

export function liteVerbForSelectedLane(
  lane: LiteFullSelectedLane,
): 'ask' | 'plan' | 'report' | 'patch' | 'fix' {
  if (lane === 'lite_ask') return 'ask';
  if (lane === 'lite_report') return 'report';
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
  if (routeDecision.intent.task_kind === 'answer' || routeDecision.intent.task_kind === 'report') {
    return false;
  }
  return routeDecision.risk_signals.length > 0;
}

/** Infer the governed Lite verb `bl do` should execute after Spark synthesis. */
export function inferDoExecutionVerb(task: string): 'ask' | 'plan' | 'report' | 'patch' | 'fix' {
  const normalized = task.trim().toLowerCase();
  const intent = inferIntentContract(normalized, { requestedVerb: 'do' });
  if (intent.task_kind === 'report') {
    return 'report';
  }
  if (intent.task_kind === 'plan_only') {
    return 'plan';
  }
  if (intent.task_kind === 'answer') {
    return 'ask';
  }
  if (intent.task_kind === 'proposal') {
    return 'patch';
  }
  return 'fix';
}

/**
 * Lightweight routing for chat mode: determines whether the user's task is
 * a mutation/fix request or a question/ask. Replaces the 480-line
 * routeLiteOrFull() for the chat path — the heavy router stays for the `do`
 * verb and CLI commands.
 */
export function routeChatIntent(task: string): 'ask' | 'fix' {
  const normalized = task.toLowerCase();
  const MUTATION_KEYWORDS =
    /\b(fix|repair|apply|update|edit|modify|change|implement|write|create|delete|remove|patch|resolve)\b/;
  if (MUTATION_KEYWORDS.test(normalized)) {
    return 'fix';
  }
  return 'ask';
}

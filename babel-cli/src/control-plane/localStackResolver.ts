import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { filterCatalogEntries, parseCatalog } from './catalog.js';
import { previewInstructionStackResolution } from './stackResolver.js';
import type { CatalogEntry } from './catalog.js';
import type { PipelineMode, PurposeMode } from '../schemas/agentContracts.js';

export type LocalTaskCategory =
  | 'frontend'
  | 'backend'
  | 'compliance'
  | 'devops'
  | 'research'
  | 'mobile'
  | 'game';

export type LocalProject =
  | 'global'
  | 'example_saas_backend'
  | 'example_llm_router'
  | 'example_web_audit'
  | 'example_mobile_suite'
  | 'example_game_suite'
  | 'simlife'
  | 'example_game_suite'
  | 'ExampleFinanceForecast'
  | 'example_autonomous_agent'
  | 'example_mobile_finance'
  | 'AetherlynGameDraft'
  | 'aetherlyn';

export type LocalModel = 'codex' | 'claude' | 'gemini';

export type LocalPipelineMode = 'direct' | 'verified' | 'autonomous';

export type LocalCodexAdapter = 'auto' | 'balanced' | 'ultra';

export interface LocalStackResolveOptions {
  taskCategory: LocalTaskCategory;
  project?: LocalProject;
  projectPath?: string;
  model?: LocalModel;
  clientSurface?: string;
  pipelineMode?: LocalPipelineMode;
  codexAdapter?: LocalCodexAdapter;
  taskOverlayIds?: string[];
  taskPrompt?: string;
  purposeMode?: PurposeMode | '';
  disableRecommendedTaskOverlays?: boolean;
  loadAllSkills?: boolean;
  localLearningRoot?: string;
  babelRoot: string;
}

function normalizeModel(value: LocalModel | string | undefined): LocalModel {
  const normalized = String(value ?? 'codex').trim().toLowerCase();
  if (normalized === 'codex' || normalized === 'claude' || normalized === 'gemini') {
    return normalized;
  }
  throw new Error(`Invalid model "${value}". Expected "codex", "claude", or "gemini".`);
}

export interface LocalStackEntry {
  Id: string;
  Layer: string;
  LoadPosition: number | null;
  TokenBudget: number | null;
  RelativePath: string;
  FullPath: string;
  OrderIndex: number;
}

export interface LocalStackResolveResult {
  BabelRoot: string;
  LocalLearningRoot: string;
  Project: string;
  ProjectPath: string | null;
  TaskCategory: string;
  Model: string;
  ClientSurface: string;
  PipelineMode: string;
  PurposeResolutionMode: 'provisional';
  ProvisionalPurposeMode: string;
  ProvisionalPurposeSource: string;
  ProvisionalPurposeConfidence: number;
  PurposeModeCanonical: boolean;
  PurposeSeedSkillId: string | null;
  PurposeSuppressionReason: string;
  SelectedCodexAdapter: string | null;
  RecommendedTaskOverlayIds: string[];
  RecommendedSkillIds: string[];
  BabelEntrypoint: string;
  BabelReferenceFiles: string[];
  SelectedStack: LocalStackEntry[];
  RepoContextFiles: string[];
  RepoLocalSystemPresent: boolean;
  PrecedenceRules: string[];
  KickoffPrompt: string;
  ActivePolicyIds: string[];
  PolicyVersionApplied: string;
}

const DOMAIN_ID_MAP: Record<LocalTaskCategory, string> = {
  frontend: 'domain_swe_frontend',
  backend: 'domain_swe_backend',
  compliance: 'domain_compliance_gpc',
  devops: 'domain_devops',
  research: 'domain_research',
  mobile: 'domain_android_kotlin',
  game: 'domain_godot_game_dev',
};

const PROJECT_OVERLAY_ID_MAP: Partial<Record<LocalProject, string>> = {
  example_saas_backend: 'overlay_example_saas_backend',
  example_llm_router: 'overlay_example_llm_router',
  example_web_audit: 'overlay_example_web_audit',
  example_mobile_suite: 'overlay_example_mobile_suite',
  example_game_suite: 'overlay_example_game_workspace',
  simlife: 'overlay_example_game_workspace',
  example_game_suite: 'overlay_example_game_suite',
  ExampleFinanceForecast: 'overlay_example_finance_forecast',
  AetherlynGameDraft: 'overlay_example_game_workspace',
  aetherlyn: 'overlay_example_game_workspace',
  example_mobile_finance: 'overlay_example_finance_forecast',
};

const PROJECT_REPO_KEY_MAP: Partial<Record<LocalProject, string>> = {
  example_saas_backend: 'example_saas_backend',
  example_llm_router: 'example_llm_router',
  example_web_audit: 'example_web_audit',
  example_mobile_suite: 'example_mobile_suite',
  example_game_suite: 'example_game_suite',
  simlife: 'simlife',
  example_game_suite: 'example_game_suite',
  ExampleFinanceForecast: 'montecarlo_ledger',
  AetherlynGameDraft: 'aetherlyn',
  aetherlyn: 'aetherlyn',
  example_autonomous_agent: 'example_autonomous_agent',
  example_mobile_finance: 'example_mobile_finance',
};

const TASK_OVERLAY_ALIAS_MAP: Record<string, string> = {
  'frontend-professionalism': 'task_frontend_professionalism',
  'example_saas_backend-frontend-professionalism': 'task_example_saas_backend_frontend_professionalism',
};

const LEGACY_FAMILY_MAP: Partial<Record<LocalProject, string>> = {
  example_saas_backend: 'Project_SaaS',
  example_llm_router: 'Project_SaaS',
  example_web_audit: 'Project_SaaS',
  example_mobile_suite: '',
  example_game_suite: '',
  simlife: 'example_game_suite',
  example_game_suite: 'example_game_suite',
  ExampleFinanceForecast: 'example_mobile_suite',
  AetherlynGameDraft: 'example_game_suite',
  aetherlyn: 'example_game_suite',
  example_autonomous_agent: '',
  example_mobile_finance: '',
};

interface ActivePolicy {
  policy_id: string;
  policy_version?: string;
  state: string;
  target_surface: string;
  proposed_change: {
    preset_id?: string;
    preferred_stack_ids?: string[];
    checklist?: string[];
  };
}

interface PolicyContainer {
  policies?: ActivePolicy[];
}

interface ProvisionalPurpose {
  Mode: string;
  Source: string;
  Confidence: number;
  Canonical: boolean;
}

interface PurposeDiagnostics {
  PurposeSeedSkillId: string | null;
  PurposeSuppressionReason: string;
}

function normalizeStringArray(items: unknown[] | undefined): string[] {
  const normalized: string[] = [];
  for (const item of items ?? []) {
    if (item === null || item === undefined) {
      continue;
    }
    const text = String(item).trim();
    if (text.length > 0 && !normalized.includes(text)) {
      normalized.push(text);
    }
  }
  return normalized;
}

function normalizeTaskPrompt(prompt: string | undefined): string {
  return String(prompt ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
}

function testRegexAny(text: string, patterns: string[]): boolean {
  return patterns.some(pattern => new RegExp(pattern, 'i').test(text));
}

function resolveDefaultClientSurface(model: LocalModel): string {
  switch (model) {
    case 'codex':
      return 'codex_extension';
    case 'claude':
      return 'claude_code';
    case 'gemini':
      return 'gemini_cli';
  }
}

function getWorkspaceRoot(babelRoot: string): string {
  return dirname(babelRoot);
}

function getRepoMapPath(babelRoot: string): string {
  if (process.env['BABEL_REPO_MAP_PATH']) {
    return process.env['BABEL_REPO_MAP_PATH'];
  }
  return join(getWorkspaceRoot(babelRoot), 'config', 'repo-map.json');
}

function readJsonFile<T>(path: string): T | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function getRepoMapValue(repoMap: { repos?: Record<string, string> } | null, key: string): string | null {
  const value = repoMap?.repos?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function getAlwaysLoadBehavioralEntries(entries: CatalogEntry[]): CatalogEntry[] {
  return filterCatalogEntries(entries, {
    layer: 'behavioral_os',
    status: 'active',
    tags: ['always_load'],
  }).sort((left, right) =>
    (left.loadPosition ?? Number.MAX_SAFE_INTEGER) - (right.loadPosition ?? Number.MAX_SAFE_INTEGER) ||
    left.id.localeCompare(right.id),
  );
}

function testGuardShouldLoad(
  taskCategory: LocalTaskCategory,
  pipelineMode: LocalPipelineMode,
  taskPrompt: string,
): boolean {
  if (pipelineMode === 'verified' || pipelineMode === 'autonomous') {
    return true;
  }
  if (['frontend', 'backend', 'mobile', 'game', 'devops'].includes(taskCategory)) {
    return true;
  }
  const prompt = normalizeTaskPrompt(taskPrompt);
  if (!prompt) {
    return false;
  }
  return /\b(implement|edit|modify|fix|debug|refactor|deploy|migrate|migration|write\s+files?|run\s+tests?|execute|commit)\b/i.test(prompt);
}

function getConditionalGuardBehavioralEntries(
  entries: CatalogEntry[],
  taskCategory: LocalTaskCategory,
  pipelineMode: LocalPipelineMode,
  taskPrompt: string,
): CatalogEntry[] {
  if (!testGuardShouldLoad(taskCategory, pipelineMode, taskPrompt)) {
    return [];
  }
  return entries.filter(entry =>
    entry.layer === 'behavioral_os' &&
    entry.status === 'active' &&
    entry.id === 'behavioral_guard_v7' &&
    entry.tags.includes('conditional_load'),
  );
}

function getInferredPurposeModeFromPrompt(
  taskCategory: LocalTaskCategory,
  taskPrompt: string,
): PurposeMode | 'execution' {
  const normalizedPrompt = normalizeTaskPrompt(taskPrompt);
  if (!normalizedPrompt) {
    return 'execution';
  }

  const prompt = normalizedPrompt.toLowerCase();
  const adaptiveDepthPositivePatterns = [
    '\\bteach( me)?\\b',
    '\\bwalk me through\\b',
    '\\bwalk through\\b',
    '\\bhelp me understand\\b',
    '\\bdemystify\\b',
    '\\bbreak (this|it|that) down\\b',
    '\\bbreak down\\b',
    '\\bfrom first principles\\b',
    '\\bfirst principles\\b',
    '\\bnew to this\\b',
    '\\bbeginner\\b',
    "\\bnever touched (this|the) codebase\\b",
    "\\bi (am|'m) (pretty )?(lost|confused)\\b",
    '\\bi keep getting lost\\b',
    '\\bwhat matters first\\b',
    '\\bonboard me\\b',
  ];
  const adaptiveDepthShortFormPatterns = [
    '\\bone sentence\\b',
    '\\bkeep it brief\\b',
    '\\bbriefly\\b',
    '\\bbrief\\b',
    '\\bshort answer\\b',
    '\\bquick overview\\b',
  ];
  const epistemicPositivePatterns = [
    '\\bfact[- ]?check\\b',
    '\\bis this true\\b',
    '\\bverify (whether|if)\\b',
    '\\bsanity[- ]check\\b',
    '\\bis this right\\b',
    '\\bam i missing\\b',
    '\\bmissing something\\b',
    '\\bstill match\\b',
    '\\bstill line up\\b',
    '\\bhow sure\\b',
    '\\buncertain\\b',
    '\\buncertainty\\b',
    '\\bcurrent status\\b',
    '\\blatest status\\b',
    '\\bdoes .* still .* today\\b',
    '\\bis (this|that|the .+?) safe\\b',
    '\\bconfidence\\b.*\\b(evidence|uncertain|uncertainty|incomplete|verify|verification|truth)\\b',
    '\\b(evidence|uncertain|uncertainty|incomplete|verify|verification|truth)\\b.*\\bconfidence\\b',
  ];
  const epistemicNegativePatterns = [
    '\\bconfidence\\b.*\\b(color|colour|token|design token|css variable|theme|palette)\\b',
    '\\b(color|colour|token|design token|css variable|theme|palette)\\b.*\\bconfidence\\b',
  ];
  const explorationPositivePatterns = [
    '\\bbrainstorm\\b',
    '\\bwhat if\\b',
    '\\balternatives?\\b',
    '\\btrade[- ]offs?\\b',
    '\\bcompare\\b.*\\b(approach|approaches|option|options|path|paths|strategy|strategies|alternative|alternatives)\\b',
    '\\b(approach|approaches|option|options|path|paths|strategy|strategies|alternative|alternatives)\\b.*\\bcompare\\b',
    '\\bwhich path\\b',
    '\\bless risky\\b',
    '\\bneed a direction\\b',
    '\\bdirection for\\b',
    '\\bshould we\\b.*\\bor\\b',
    '\\bkeep\\b.*\\bor move\\b',
  ];
  const explorationNegativePatterns = [
    '\\bcompare\\b.*\\b(json|file|files|array|arrays|object|objects|schema|schemas|diff|changed keys|indexes)\\b',
    '\\buse the .* strategy\\b.*\\bapply\\b',
    '\\blearn the current schema\\b.*\\badd\\b',
  ];

  let shouldTriggerAdaptiveDepth = testRegexAny(prompt, adaptiveDepthPositivePatterns);
  if (shouldTriggerAdaptiveDepth && testRegexAny(prompt, adaptiveDepthShortFormPatterns)) {
    if (!testRegexAny(prompt, [
      '\\bnew to this\\b',
      '\\bbeginner\\b',
      "\\bnever touched (this|the) codebase\\b",
      "\\bi (am|'m) (pretty )?(lost|confused)\\b",
      '\\bi keep getting lost\\b',
    ])) {
      shouldTriggerAdaptiveDepth = false;
    }
  }

  const shouldTriggerEpistemic =
    testRegexAny(prompt, epistemicPositivePatterns) &&
    !testRegexAny(prompt, epistemicNegativePatterns);
  const shouldTriggerExploration =
    testRegexAny(prompt, explorationPositivePatterns) &&
    !testRegexAny(prompt, explorationNegativePatterns);

  if (shouldTriggerEpistemic) {
    return 'verification';
  }
  if (shouldTriggerExploration) {
    return 'exploration';
  }
  if (shouldTriggerAdaptiveDepth) {
    return 'learning';
  }
  return 'execution';
}

function getProvisionalPurposeSelection(
  explicitPurposeMode: string | undefined,
  inferredPurposeMode: string,
): ProvisionalPurpose {
  if (explicitPurposeMode && explicitPurposeMode.trim().length > 0) {
    return {
      Mode: explicitPurposeMode.trim(),
      Source: 'provisional_local_explicit',
      Confidence: 0.95,
      Canonical: false,
    };
  }
  if (inferredPurposeMode !== 'execution') {
    return {
      Mode: inferredPurposeMode,
      Source: 'provisional_local_inference',
      Confidence: 0.55,
      Canonical: false,
    };
  }
  return {
    Mode: 'execution',
    Source: 'provisional_local_default',
    Confidence: 0.3,
    Canonical: false,
  };
}

function getPurposeDiagnostics(
  purposeMode: string,
  domainId: string,
  pipelineMode: LocalPipelineMode,
  purposeModeSeedMap: Record<string, string | null>,
): PurposeDiagnostics {
  const seedSkillId = purposeModeSeedMap[purposeMode] ?? null;
  if (!seedSkillId) {
    return {
      PurposeSeedSkillId: null,
      PurposeSuppressionReason: purposeMode === 'audit' ? 'no_seed_audit' : 'no_seed_execution',
    };
  }
  if (pipelineMode === 'autonomous' && (purposeMode === 'learning' || purposeMode === 'exploration')) {
    return {
      PurposeSeedSkillId: null,
      PurposeSuppressionReason: 'suppressed_by_autonomous_context',
    };
  }
  if (domainId === 'domain_research') {
    return {
      PurposeSeedSkillId: null,
      PurposeSuppressionReason: 'suppressed_by_domain_research',
    };
  }
  if (domainId === 'domain_product_audit') {
    return {
      PurposeSeedSkillId: null,
      PurposeSuppressionReason: 'suppressed_by_domain_product_audit',
    };
  }
  return {
    PurposeSeedSkillId: seedSkillId,
    PurposeSuppressionReason: 'typed_seeded',
  };
}

function loadPurposeModeSeedMap(babelRoot: string): Record<string, string | null> {
  const mappingPath = join(babelRoot, 'config', 'purpose-mode-seeds.json');
  if (!existsSync(mappingPath)) {
    throw new Error(`Purpose mapping file not found: ${mappingPath}`);
  }
  const parsed = JSON.parse(readFileSync(mappingPath, 'utf-8')) as Record<string, unknown>;
  const seeds: Record<string, string | null> = {};
  for (const [purposeMode, seedValue] of Object.entries(parsed)) {
    seeds[purposeMode] = typeof seedValue === 'string' && seedValue.trim().length > 0
      ? seedValue.trim()
      : null;
  }
  return seeds;
}

function getActivePolicies(path: string): ActivePolicy[] {
  const container = readJsonFile<PolicyContainer>(path);
  if (!container?.policies) {
    return [];
  }
  return container.policies.filter(policy => String(policy.state) === 'active');
}

function getPolicySignature(policy: ActivePolicy): string {
  const policyVersion = String(policy.policy_version ?? '').trim();
  return policyVersion.length > 0 ? `${policy.policy_id}@${policyVersion}` : policy.policy_id;
}

function convertChecklistToHintText(checklist: string[] | undefined): string[] {
  const hints: string[] = [];
  for (const item of normalizeStringArray(checklist)) {
    switch (item) {
      case 'require_explicit_missing_evidence_statement':
        hints.push('State any missing evidence explicitly before acting.');
        break;
      case 'require_root_cause_line':
        hints.push('Include one explicit root-cause line before proposing the fix.');
        break;
      case 'require_test_plan':
        hints.push('Include a concrete test plan before or alongside the implementation.');
        break;
      case 'require_verification_summary':
        hints.push('End with a short verification summary tied to objective checks.');
        break;
    }
  }
  return hints;
}

function resolveProjectPath(
  babelRoot: string,
  project: LocalProject,
  projectPathArg: string | undefined,
): string | null {
  if (projectPathArg && projectPathArg.trim().length > 0) {
    if (!existsSync(projectPathArg)) {
      throw new Error(`Provided project path does not exist: ${projectPathArg}`);
    }
    return projectPathArg;
  }

  if (project === 'global') {
    return null;
  }

  const workspaceRoot = getWorkspaceRoot(babelRoot);
  const repoMap = readJsonFile<{ repos?: Record<string, string> }>(getRepoMapPath(babelRoot));
  const repoMapKey = PROJECT_REPO_KEY_MAP[project];
  const mappedProjectPath = repoMapKey ? getRepoMapValue(repoMap, repoMapKey) : null;
  if (mappedProjectPath && existsSync(mappedProjectPath)) {
    return mappedProjectPath;
  }

  const family = LEGACY_FAMILY_MAP[project] ?? '';
  let projectFolderCandidates: string[];
  if (project === 'simlife') {
    projectFolderCandidates = ['SimLife'];
  } else if (project === 'AetherlynGameDraft' || project === 'aetherlyn') {
    projectFolderCandidates = ['AetherlynGameDraft'];
  } else if (project === 'ExampleFinanceForecast') {
    projectFolderCandidates = ['ExampleFinanceForecast'];
  } else if (project === 'example_mobile_finance') {
    projectFolderCandidates = ['Example-Mobile-Finance', 'Example Finance Forecast-app'];
  } else if (project === 'example_autonomous_agent') {
    projectFolderCandidates = ['example_autonomous_agent', 'example_autonomous_agent'];
  } else {
    projectFolderCandidates = [project];
  }

  for (const projectFolderName of projectFolderCandidates) {
    const inferredProjectPath = family
      ? join(workspaceRoot, family, projectFolderName)
      : join(workspaceRoot, projectFolderName);
    if (existsSync(inferredProjectPath)) {
      return inferredProjectPath;
    }
  }

  return null;
}

function detectImplicitSkillIds(projectPath: string | null, entriesById: Map<string, CatalogEntry>): string[] {
  if (!projectPath) {
    return [];
  }

  const implicitSkillIds: string[] = [];
  if (existsSync(join(projectPath, 'supabase', 'config.toml'))) {
    implicitSkillIds.push('skill_supabase_pg');
  }
  if (existsSync(join(projectPath, 'vercel.json'))) {
    implicitSkillIds.push('skill_react_nextjs');
  }
  if (existsSync(join(projectPath, '.github', 'workflows'))) {
    implicitSkillIds.push('skill_github_release_batching');
  }

  return implicitSkillIds.filter(skillId => entriesById.has(skillId));
}

function buildKickoffPrompt(
  babelRoot: string,
  repoContextFiles: string[],
  repoLocalSystemPresent: boolean,
  kickoffPolicy: ActivePolicy | null,
  verificationHints: string[],
): string {
  const compactKickoffActive =
    kickoffPolicy?.proposed_change?.preset_id === 'compact';

  let kickoffPrompt: string;
  if (compactKickoffActive) {
    if (repoLocalSystemPresent) {
      kickoffPrompt =
        `Read ${join(babelRoot, 'BABEL_BIBLE.md')}, then this repo's PROJECT_CONTEXT.md and LLM_COLLABORATION_SYSTEM before planning or coding.`;
    } else if (repoContextFiles.length > 0) {
      kickoffPrompt =
        `Read ${join(babelRoot, 'BABEL_BIBLE.md')}, then this repo's PROJECT_CONTEXT.md before planning or coding.`;
    } else {
      kickoffPrompt = `Read ${join(babelRoot, 'BABEL_BIBLE.md')} before planning or coding.`;
    }
  } else if (repoLocalSystemPresent) {
    kickoffPrompt =
      `Read Babel's ${join(babelRoot, 'BABEL_BIBLE.md')} first, use Babel to select the right instruction stack for this task, then read this repo's PROJECT_CONTEXT.md and LLM_COLLABORATION_SYSTEM/README_FOR_HUMANS_AND_LLMS.md before planning or coding.`;
  } else if (repoContextFiles.length > 0) {
    kickoffPrompt =
      `Read Babel's ${join(babelRoot, 'BABEL_BIBLE.md')} first, use Babel to select the right instruction stack for this task, then read this repo's PROJECT_CONTEXT.md before planning or coding.`;
  } else {
    kickoffPrompt =
      `Read Babel's ${join(babelRoot, 'BABEL_BIBLE.md')} first and use Babel to select the right instruction stack for this task before planning or coding.`;
  }

  if (verificationHints.length > 0) {
    kickoffPrompt = `${kickoffPrompt} ${verificationHints.join(' ')}`;
  }

  return kickoffPrompt;
}

export function resolveLocalStack(options: LocalStackResolveOptions): LocalStackResolveResult {
  const babelRoot = options.babelRoot;
  const catalogPath = join(babelRoot, 'prompt_catalog.yaml');
  const catalogEntries = parseCatalog(catalogPath);
  const entriesById = new Map(catalogEntries.map(entry => [entry.id, entry]));

  const project = options.project ?? 'global';
  const model = normalizeModel(options.model);
  const pipelineMode = options.pipelineMode ?? 'direct';
  const localLearningRoot = options.localLearningRoot ?? join(babelRoot, 'runs', 'local-learning');
  const resolvedClientSurface = options.clientSurface?.trim() || resolveDefaultClientSurface(model);

  let selectedCodexAdapterName: 'balanced' | 'ultra' =
    options.codexAdapter === 'ultra' ? 'ultra' : 'balanced';
  let selectedAdapterId = model === 'codex'
    ? (selectedCodexAdapterName === 'ultra' ? 'adapter_codex' : 'adapter_codex_balanced')
    : model === 'claude'
      ? 'adapter_claude'
      : 'adapter_gemini';

  const activeRepoPolicies = project !== 'global'
    ? getActivePolicies(join(localLearningRoot, 'active', 'repos', `${project}.json`))
    : [];
  const activeLocalClientPolicies = getActivePolicies(
    join(localLearningRoot, 'active', 'local-clients', `${resolvedClientSurface}.${model}.json`),
  );
  const activeGlobalPolicies = getActivePolicies(join(localLearningRoot, 'active', 'global-policy.json'));

  const purposeModeSeedMap = loadPurposeModeSeedMap(babelRoot);
  const resolvedDomainId = DOMAIN_ID_MAP[options.taskCategory];
  const inferredPurposeMode = getInferredPurposeModeFromPrompt(options.taskCategory, options.taskPrompt ?? '');
  const provisionalPurpose = getProvisionalPurposeSelection(options.purposeMode, inferredPurposeMode);
  const purposeDiagnostics = getPurposeDiagnostics(
    provisionalPurpose.Mode,
    resolvedDomainId,
    pipelineMode,
    purposeModeSeedMap,
  );

  const appliedPoliciesBySurface = new Map<string, ActivePolicy>();
  const appliedPolicies: ActivePolicy[] = [];
  for (const policyGroup of [activeRepoPolicies, activeLocalClientPolicies, activeGlobalPolicies]) {
    for (const policy of policyGroup) {
      const surface = String(policy.target_surface ?? '').trim();
      if (surface.length > 0 && !appliedPoliciesBySurface.has(surface)) {
        appliedPoliciesBySurface.set(surface, policy);
        appliedPolicies.push(policy);
      }
    }
  }

  const activePolicyIds = appliedPolicies.map(getPolicySignature);
  const activeVerificationHints: string[] = [];
  for (const policy of appliedPolicies) {
    if (policy.target_surface === 'verification_loop_hints') {
      activeVerificationHints.push(...convertChecklistToHintText(policy.proposed_change.checklist));
    }
  }

  const resolverRankingPolicy = appliedPoliciesBySurface.get('resolver_ranking');
  if (resolverRankingPolicy && model === 'codex') {
    const preferredStackIds = normalizeStringArray(resolverRankingPolicy.proposed_change.preferred_stack_ids);
    if (preferredStackIds.includes('adapter_codex')) {
      selectedCodexAdapterName = 'ultra';
      selectedAdapterId = 'adapter_codex';
    } else if (preferredStackIds.includes('adapter_codex_balanced')) {
      selectedCodexAdapterName = 'balanced';
      selectedAdapterId = 'adapter_codex_balanced';
    }
  }

  const selectedTaskOverlayIds: string[] = [];
  if (!options.disableRecommendedTaskOverlays) {
    if (options.taskCategory === 'frontend') {
      selectedTaskOverlayIds.push('task_frontend_professionalism');
    }
    if (project === 'example_saas_backend' && options.taskCategory === 'frontend') {
      selectedTaskOverlayIds.push('task_example_saas_backend_frontend_professionalism');
    }
  }
  for (const overlayId of options.taskOverlayIds ?? []) {
    const normalized = TASK_OVERLAY_ALIAS_MAP[overlayId.trim()] ?? overlayId.trim();
    if (normalized.length > 0 && !selectedTaskOverlayIds.includes(normalized)) {
      selectedTaskOverlayIds.push(normalized);
    }
  }

  const selectedCognitionSkillIds: string[] = [];
  if (options.loadAllSkills) {
    for (const entry of catalogEntries) {
      if (entry.layer === 'skill' && entry.status === 'active' && !selectedCognitionSkillIds.includes(entry.id)) {
        selectedCognitionSkillIds.push(entry.id);
      }
    }
  }
  if (purposeDiagnostics.PurposeSeedSkillId) {
    selectedCognitionSkillIds.push(purposeDiagnostics.PurposeSeedSkillId);
  }

  const behavioralIds = [
    ...getAlwaysLoadBehavioralEntries(catalogEntries).map(entry => entry.id),
    ...getConditionalGuardBehavioralEntries(
      catalogEntries,
      options.taskCategory,
      pipelineMode,
      options.taskPrompt ?? '',
    ).map(entry => entry.id),
  ];

  const pipelineStageIds: string[] = [];
  if (pipelineMode === 'verified') {
    pipelineStageIds.push('pipeline_qa_reviewer');
  } else if (pipelineMode === 'autonomous') {
    pipelineStageIds.push('pipeline_qa_reviewer', 'pipeline_cli_executor');
  }

  const projectOverlayId = project !== 'global'
    ? PROJECT_OVERLAY_ID_MAP[project] ?? null
    : null;

  const resolvedProjectPath = resolveProjectPath(babelRoot, project, options.projectPath);
  const implicitSkillIds = detectImplicitSkillIds(resolvedProjectPath, entriesById);
  for (const skillId of implicitSkillIds) {
    if (!selectedCognitionSkillIds.includes(skillId)) {
      selectedCognitionSkillIds.push(skillId);
    }
  }

  const preview = previewInstructionStackResolution(
    {
      behavioral_ids: behavioralIds,
      domain_id: resolvedDomainId,
      skill_ids: selectedCognitionSkillIds,
      model_adapter_id: selectedAdapterId,
      project_overlay_id: projectOverlayId,
      task_overlay_ids: selectedTaskOverlayIds,
      pipeline_stage_ids: pipelineStageIds,
    },
    {
      apply_domain_default_skills: true,
      expand_skill_dependencies: true,
      strict_conflict_mode: options.loadAllSkills ? 'warn' : 'error',
      task_shape_profile: 'full',
    },
    babelRoot,
    catalogPath,
    project === 'global' ? null : project,
    {
      pipeline_mode: pipelineMode as PipelineMode,
      purpose_mode: provisionalPurpose.Mode as PurposeMode,
      purpose_source: provisionalPurpose.Source,
      purpose_confidence: provisionalPurpose.Confidence,
    },
  );

  const selectedStack: LocalStackEntry[] = preview.orderedEntries.map(entry => ({
    Id: entry.id,
    Layer: entry.layer,
    LoadPosition: entry.load_position,
    TokenBudget: entry.token_budget,
    RelativePath: entry.relative_path,
    FullPath: entry.absolute_path,
    OrderIndex: entry.order_index,
  }));

  const repoContextFiles: string[] = [];
  let repoLocalSystemPresent = false;
  if (resolvedProjectPath) {
    const projectContextPath = join(resolvedProjectPath, 'PROJECT_CONTEXT.md');
    if (existsSync(projectContextPath)) {
      repoContextFiles.push(projectContextPath);
    }
    const localSystemReadme = join(
      resolvedProjectPath,
      'LLM_COLLABORATION_SYSTEM',
      'README_FOR_HUMANS_AND_LLMS.md',
    );
    if (existsSync(localSystemReadme)) {
      repoContextFiles.push(localSystemReadme);
      repoLocalSystemPresent = true;
    }
  }

  const kickoffPrompt = buildKickoffPrompt(
    babelRoot,
    repoContextFiles,
    repoLocalSystemPresent,
    appliedPoliciesBySurface.get('kickoff_prompt_preset') ?? null,
    activeVerificationHints,
  );

  return {
    BabelRoot: babelRoot,
    LocalLearningRoot: localLearningRoot,
    Project: project,
    ProjectPath: resolvedProjectPath,
    TaskCategory: options.taskCategory,
    Model: model,
    ClientSurface: resolvedClientSurface,
    PipelineMode: pipelineMode,
    PurposeResolutionMode: 'provisional',
    ProvisionalPurposeMode: provisionalPurpose.Mode,
    ProvisionalPurposeSource: provisionalPurpose.Source,
    ProvisionalPurposeConfidence: provisionalPurpose.Confidence,
    PurposeModeCanonical: provisionalPurpose.Canonical,
    PurposeSeedSkillId: purposeDiagnostics.PurposeSeedSkillId,
    PurposeSuppressionReason: purposeDiagnostics.PurposeSuppressionReason,
    SelectedCodexAdapter: model === 'codex' ? selectedCodexAdapterName : null,
    RecommendedTaskOverlayIds: selectedTaskOverlayIds,
    RecommendedSkillIds: selectedCognitionSkillIds,
    BabelEntrypoint: join(babelRoot, 'BABEL_BIBLE.md'),
    BabelReferenceFiles: [
      join(babelRoot, 'PROJECT_CONTEXT.md'),
      join(babelRoot, 'prompt_catalog.yaml'),
    ],
    SelectedStack: selectedStack,
    RepoContextFiles: repoContextFiles,
    RepoLocalSystemPresent: repoLocalSystemPresent,
    PrecedenceRules: [
      'Babel chooses the cross-project stack and operating mode.',
      'The repo-local collaboration system defines repo-specific invariants and startup rules.',
      'Repo-local invariants win for repo-specific conflicts.',
    ],
    KickoffPrompt: kickoffPrompt,
    ActivePolicyIds: activePolicyIds,
    PolicyVersionApplied: activePolicyIds.join(';'),
  };
}

export function formatLocalStackResolveHuman(result: LocalStackResolveResult): string {
  const lines = [
    '',
    'Babel Local Stack Resolution',
    `Project: ${result.Project}`,
    `Task category: ${result.TaskCategory}`,
    `Model: ${result.Model}`,
    `Client surface: ${result.ClientSurface}`,
    `Pipeline mode: ${result.PipelineMode}`,
  ];
  if (result.SelectedCodexAdapter) {
    lines.push(`Codex adapter: ${result.SelectedCodexAdapter}`);
  }
  lines.push('', 'Babel entrypoint:', `  1. ${result.BabelEntrypoint}`, '', 'Babel reference files:');
  result.BabelReferenceFiles.forEach((path, index) => {
    lines.push(`  ${index + 2}. ${path}`);
  });
  lines.push('', 'Selected Babel stack:');
  result.SelectedStack.forEach((item, index) => {
    lines.push(`  ${index + 1}. [${item.Layer}] ${item.FullPath}`);
  });
  lines.push('', 'Repo-local context:');
  if (result.RepoContextFiles.length === 0) {
    lines.push('  None detected.');
  } else {
    result.RepoContextFiles.forEach((path, index) => {
      lines.push(`  ${index + 1}. ${path}`);
    });
  }
  lines.push('', 'Precedence:');
  for (const rule of result.PrecedenceRules) {
    lines.push(`  - ${rule}`);
  }
  lines.push('', 'Recommended kickoff prompt:', `  ${result.KickoffPrompt}`);
  return lines.join('\n');
}

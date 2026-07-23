import { dirname, join, resolve } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { compileContextSync } from '../compiler.js';
import { parseCatalog, type CatalogEntry } from '../control-plane/catalog.js';
import { previewInstructionStackResolution } from '../control-plane/stackResolver.js';
import type {
  BudgetPolicy,
  InstructionStack,
  ResolutionPolicy,
} from '../schemas/agentContracts.js';
import {
  TOKENIZER_ENCODING,
  buildPromptOnlyFromManifestPaths,
  countEntryTokens,
  countTextTokens,
  type EntryTokenMeasurement,
} from '../services/tokenCounter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const BABEL_ROOT = resolve(__dirname, '..', '..', '..');
const CATALOG_PATH = join(BABEL_ROOT, 'prompt_catalog.yaml');
const OUTPUT_ROOT = join(BABEL_ROOT, 'artifacts', 'token-audit');

const DEFAULT_BEHAVIORAL_IDS = [
  'behavioral_core_v7',
  'behavioral_cognitive_micro_v7',
  'behavioral_guard_v7',
] as const;
const DEFAULT_MODEL_ADAPTER_ID = 'adapter_codex_balanced';
const DEFAULT_PIPELINE_STAGE_IDS = ['pipeline_qa_reviewer'] as const;
const DEFAULT_RESOLUTION_POLICY: ResolutionPolicy = {
  apply_domain_default_skills: false,
  expand_skill_dependencies: true,
  strict_conflict_mode: 'error',
  task_shape_profile: 'full',
};

type BudgetSeverity = 'none' | 'warn' | 'severe';
type ScenarioKind = 'domain_default' | 'domain_minimal' | 'skill_explicit';

interface CatalogSupplement {
  defaultForDomains: string[];
}

interface TokenAuditScenario {
  id: string;
  label: string;
  kind: ScenarioKind;
  domainId: string;
  explicitSkillIds: string[];
  applyDomainDefaultSkills: boolean;
  taskPrompt: string;
}

interface ScenarioResult {
  id: string;
  label: string;
  kind: ScenarioKind;
  domainId: string;
  explicitSkillIds: string[];
  resolvedSkillIds: string[];
  selectedEntryIds: string[];
  promptManifestCount: number;
  declaredTokenBudgetTotal: number;
  actualPromptOnlyTokens: number;
  actualTotalTokens: number;
  taskSectionTokens: number;
  actualMinusDeclared: number;
  declaredBudgetSeverity: BudgetSeverity;
  actualBudgetSeverity: BudgetSeverity;
  budgetPolicyEnabled: boolean;
  budgetWarningCodes: string[];
  missingBudgetEntryIds: string[];
  warnings: string[];
}

interface ScenarioFailure {
  scenarioId: string;
  label: string;
  kind: ScenarioKind;
  domainId: string;
  explicitSkillIds: string[];
  error: string;
}

interface DomainBundleDelta {
  domainId: string;
  defaultScenarioId: string;
  minimalScenarioId: string;
  defaultDeclaredBudgetTotal: number;
  minimalDeclaredBudgetTotal: number;
  defaultActualPromptOnlyTokens: number;
  minimalActualPromptOnlyTokens: number;
  declaredDelta: number;
  actualDelta: number;
}

interface TokenAuditSummary {
  generatedAt: string;
  tokenizerEncoding: string;
  activeSkillCount: number;
  activeDomainCount: number;
  scenarioCount: number;
  successCount: number;
  failureCount: number;
  actualPolicyMissCount: number;
  missingBudgetScenarioCount: number;
}

export interface TokenUsageAuditResult {
  outputRoot: string;
  runDir: string;
  latestDir: string;
  jsonPath: string;
  markdownPath: string;
  latestJsonPath: string;
  latestMarkdownPath: string;
  summary: TokenAuditSummary;
  scenarioResults: ScenarioResult[];
  scenarioFailures: ScenarioFailure[];
  domainBundleDeltas: DomainBundleDelta[];
  heaviestScenarios: ScenarioResult[];
  largestDriftScenarios: ScenarioResult[];
  actualPolicyMisses: ScenarioResult[];
  entryMeasurements: EntryTokenMeasurement[];
}

export interface RunTokenUsageAuditOptions {
  writeArtifacts?: boolean;
  generatedAt?: string;
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function compareNumbersDescending(left: number, right: number): number {
  return right - left;
}

function severityRank(severity: BudgetSeverity): number {
  switch (severity) {
    case 'severe':
      return 2;
    case 'warn':
      return 1;
    default:
      return 0;
  }
}

function budgetSeverityFromPolicy(total: number, policy: BudgetPolicy | undefined): BudgetSeverity {
  if (!policy?.enabled) {
    return 'none';
  }
  if (total >= policy.severe_warn_threshold) {
    return 'severe';
  }
  if (total >= policy.warn_threshold) {
    return 'warn';
  }
  return 'none';
}

function safeFileSlug(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

function parseCatalogSupplements(catalogPath: string): Map<string, CatalogSupplement> {
  const lines = readFileSync(catalogPath, 'utf-8').split(/\r?\n/);
  const supplements = new Map<string, CatalogSupplement>();
  let currentId: string | null = null;
  let defaultForDomains: string[] = [];

  const flushCurrent = (): void => {
    if (!currentId) {
      return;
    }
    supplements.set(currentId, {
      defaultForDomains: [...defaultForDomains],
    });
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? '';
    const idMatch = /^\s*-\s+id:\s+(.+)$/.exec(line);
    if (idMatch) {
      flushCurrent();
      currentId = idMatch[1]!.trim();
      defaultForDomains = [];
      continue;
    }

    if (!currentId) {
      continue;
    }

    const defaultDomainsMatch = /^\s+default_for_domains:\s*(.*)$/.exec(line);
    if (!defaultDomainsMatch) {
      continue;
    }

    const rawValue = defaultDomainsMatch[1] ?? '';
    const trimmed = rawValue.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      const inner = trimmed.slice(1, -1).trim();
      defaultForDomains =
        inner.length === 0
          ? []
          : inner
              .split(',')
              .map((item) => item.trim().replace(/^"(.*)"$/, '$1'))
              .filter(Boolean);
      continue;
    }

    const collected: string[] = [];
    while (index + 1 < lines.length) {
      const nextLine = lines[index + 1] ?? '';
      const itemMatch = /^\s{6,}-\s+(.+)$/.exec(nextLine);
      if (!itemMatch) {
        break;
      }
      collected.push(itemMatch[1]!.trim());
      index++;
    }
    defaultForDomains = collected;
  }

  flushCurrent();
  return supplements;
}

function inferFallbackDomain(skill: CatalogEntry, availableDomainIds: Set<string>): string {
  const signal = [skill.id, skill.path ?? '', ...skill.tags].join(' ').toLowerCase();

  const candidates: string[] = [];

  if (
    signal.includes('android') ||
    signal.includes('mobile') ||
    signal.includes('billing') ||
    signal.includes('play-store') ||
    signal.includes('kotlin')
  ) {
    candidates.push('domain_android_kotlin');
  }
  if (
    signal.includes('router') ||
    signal.includes('llm') ||
    signal.includes('sse') ||
    signal.includes('stream') ||
    signal.includes('edge-functions')
  ) {
    candidates.push('domain_llm_router');
  }
  if (
    signal.includes('python') ||
    signal.includes('pytest') ||
    signal.includes('async') ||
    signal.includes('validator')
  ) {
    candidates.push('domain_python_backend');
  }
  if (
    signal.includes('audit') ||
    signal.includes('claims') ||
    signal.includes('marketing') ||
    signal.includes('compliance') ||
    signal.includes('competitive') ||
    signal.includes('research')
  ) {
    candidates.push('domain_product_audit');
  }
  if (
    signal.includes('devops') ||
    signal.includes('infra') ||
    signal.includes('docker') ||
    signal.includes('vercel') ||
    signal.includes('terraform')
  ) {
    candidates.push('domain_devops');
  }
  if (
    signal.includes('godot') ||
    signal.includes('gdscript') ||
    signal.includes('game-dev') ||
    signal.includes('game') ||
    signal.includes('hd2d') ||
    signal.includes('sprite') ||
    signal.includes('inputmap')
  ) {
    candidates.push('domain_godot_game_dev');
  }
  if (
    signal.includes('frontend') ||
    signal.includes('react') ||
    signal.includes('nextjs') ||
    signal.includes('vite') ||
    signal.includes('playwright') ||
    signal.includes('a11y') ||
    signal.includes('ui')
  ) {
    candidates.push('domain_swe_frontend');
  }

  candidates.push('domain_swe_backend');

  for (const candidate of candidates) {
    if (availableDomainIds.has(candidate)) {
      return candidate;
    }
  }

  return Array.from(availableDomainIds)[0] ?? 'domain_swe_backend';
}

function buildTaskPrompt(label: string): string {
  return `Token usage audit scenario: ${label}. Measure whether the compiled Babel stack is tight or overloaded for this use case.`;
}

function createDomainScenario(
  domainId: string,
  applyDomainDefaultSkills: boolean,
): TokenAuditScenario {
  const suffix = applyDomainDefaultSkills ? 'default' : 'minimal';
  return {
    id: `domain-${safeFileSlug(domainId)}-${suffix}`,
    label: `${domainId} ${applyDomainDefaultSkills ? 'default bundle' : 'minimal bundle'}`,
    kind: applyDomainDefaultSkills ? 'domain_default' : 'domain_minimal',
    domainId,
    explicitSkillIds: [],
    applyDomainDefaultSkills,
    taskPrompt: buildTaskPrompt(
      `${domainId} ${applyDomainDefaultSkills ? 'default bundle' : 'minimal bundle'}`,
    ),
  };
}

function createSkillScenario(skill: CatalogEntry, domainId: string): TokenAuditScenario {
  return {
    id: `skill-${safeFileSlug(skill.id)}-${safeFileSlug(domainId)}`,
    label: `${skill.id} on ${domainId}`,
    kind: 'skill_explicit',
    domainId,
    explicitSkillIds: [skill.id],
    applyDomainDefaultSkills: false,
    taskPrompt: buildTaskPrompt(`${skill.id} on ${domainId}`),
  };
}

function buildInstructionStack(scenario: TokenAuditScenario): InstructionStack {
  return {
    behavioral_ids: [...DEFAULT_BEHAVIORAL_IDS],
    domain_id: scenario.domainId,
    skill_ids: [...scenario.explicitSkillIds],
    model_adapter_id: DEFAULT_MODEL_ADAPTER_ID,
    project_overlay_id: null,
    task_overlay_ids: [],
    pipeline_stage_ids: [...DEFAULT_PIPELINE_STAGE_IDS],
  };
}

function analyzeScenario(scenario: TokenAuditScenario): ScenarioResult {
  const preview = previewInstructionStackResolution(
    buildInstructionStack(scenario),
    {
      ...DEFAULT_RESOLUTION_POLICY,
      apply_domain_default_skills: scenario.applyDomainDefaultSkills,
    },
    BABEL_ROOT,
    CATALOG_PATH,
    null,
    null,
    { countActualTokens: true, tokenCountSource: 'audit' },
  );

  const promptOnly = buildPromptOnlyFromManifestPaths(preview.compiledArtifacts.prompt_manifest);
  const fullContext = compileContextSync(
    preview.compiledArtifacts.prompt_manifest,
    scenario.taskPrompt,
  );
  const actualPromptOnlyTokens = countTextTokens(promptOnly);
  const actualTotalTokens = countTextTokens(fullContext);
  const taskSectionTokens = actualTotalTokens - actualPromptOnlyTokens;
  const declaredTokenBudgetTotal = preview.compiledArtifacts.token_budget_total;
  const resolvedSkillIds = preview.compiledArtifacts.selected_entry_ids.filter((entryId) =>
    entryId.startsWith('skill_'),
  );

  return {
    id: scenario.id,
    label: scenario.label,
    kind: scenario.kind,
    domainId: scenario.domainId,
    explicitSkillIds: [...scenario.explicitSkillIds],
    resolvedSkillIds,
    selectedEntryIds: [...preview.compiledArtifacts.selected_entry_ids],
    promptManifestCount: preview.compiledArtifacts.prompt_manifest.length,
    declaredTokenBudgetTotal,
    actualPromptOnlyTokens,
    actualTotalTokens,
    taskSectionTokens,
    actualMinusDeclared: actualPromptOnlyTokens - declaredTokenBudgetTotal,
    declaredBudgetSeverity: budgetSeverityFromPolicy(
      declaredTokenBudgetTotal,
      preview.compiledArtifacts.budget_policy,
    ),
    actualBudgetSeverity: budgetSeverityFromPolicy(
      actualPromptOnlyTokens,
      preview.compiledArtifacts.budget_policy,
    ),
    budgetPolicyEnabled: preview.compiledArtifacts.budget_policy.enabled,
    budgetWarningCodes: (preview.compiledArtifacts.budget_diagnostics ?? []).map(
      (diagnostic) => diagnostic.code,
    ),
    missingBudgetEntryIds: [...preview.compiledArtifacts.token_budget_missing],
    warnings: [...preview.compiledArtifacts.warnings],
  };
}

function createMarkdownReport(result: TokenUsageAuditResult): string {
  const lines: string[] = [];
  const topHeaviest = result.heaviestScenarios.slice(0, 15);
  const topDrift = result.largestDriftScenarios.slice(0, 20);
  const topEntryDrift = result.entryMeasurements
    .filter((entry) => entry.deltaFromDeclared !== null)
    .sort((left, right) =>
      compareNumbersDescending(left.deltaFromDeclared ?? 0, right.deltaFromDeclared ?? 0),
    )
    .slice(0, 20);
  const topEntryOverestimates = result.entryMeasurements
    .filter((entry) => entry.deltaFromDeclared !== null)
    .sort((left, right) => (left.deltaFromDeclared ?? 0) - (right.deltaFromDeclared ?? 0))
    .slice(0, 10);
  const topDomainDelta = [...result.domainBundleDeltas]
    .sort((left, right) => compareNumbersDescending(left.actualDelta, right.actualDelta))
    .slice(0, 12);

  lines.push('# Babel Token Usage Audit');
  lines.push('');
  lines.push(`Generated: ${result.summary.generatedAt}`);
  lines.push(`Tokenizer baseline: \`${result.summary.tokenizerEncoding}\` via \`js-tiktoken\``);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Active skills audited: ${result.summary.activeSkillCount}`);
  lines.push(`- Active domains audited: ${result.summary.activeDomainCount}`);
  lines.push(`- Scenarios attempted: ${result.summary.scenarioCount}`);
  lines.push(`- Successful scenarios: ${result.summary.successCount}`);
  lines.push(`- Failed scenarios: ${result.summary.failureCount}`);
  lines.push(
    `- Scenarios with missing token budgets: ${result.summary.missingBudgetScenarioCount}`,
  );
  lines.push(
    `- Scenarios where actual tokens crossed a stricter policy tier than declared budgets: ${result.summary.actualPolicyMissCount}`,
  );
  lines.push('');

  lines.push('## Findings');
  lines.push('');

  if (result.scenarioFailures.length === 0) {
    lines.push('- No resolver or compile failures were found in the audited scenarios.');
  } else {
    lines.push('### Resolver Or Compile Failures');
    lines.push('');
    for (const failure of result.scenarioFailures) {
      lines.push(`- \`${failure.scenarioId}\` (${failure.domainId}) failed: ${failure.error}`);
    }
    lines.push('');
  }

  if (result.actualPolicyMisses.length === 0) {
    lines.push(
      '- No scenario silently crossed a higher budget-policy tier after real tokenization.',
    );
  } else {
    lines.push('### Policy Misses');
    lines.push('');
    for (const miss of result.actualPolicyMisses) {
      lines.push(
        `- \`${miss.id}\` moved from declared \`${miss.declaredBudgetSeverity}\` to actual \`${miss.actualBudgetSeverity}\` ` +
          `(${miss.declaredTokenBudgetTotal} declared vs ${miss.actualPromptOnlyTokens} actual prompt-only tokens).`,
      );
    }
    lines.push('');
  }

  lines.push('### Heaviest Scenarios');
  lines.push('');
  for (const scenario of topHeaviest) {
    lines.push(
      `- \`${scenario.id}\`: ${scenario.actualPromptOnlyTokens} prompt-only tokens, ` +
        `${scenario.actualMinusDeclared >= 0 ? '+' : ''}${scenario.actualMinusDeclared} vs declared ` +
        `${scenario.declaredTokenBudgetTotal}.`,
    );
  }
  lines.push('');

  lines.push('### Largest Scenario Drift');
  lines.push('');
  for (const scenario of topDrift) {
    lines.push(
      `- \`${scenario.id}\`: actual prompt-only ${scenario.actualPromptOnlyTokens}, declared ${scenario.declaredTokenBudgetTotal}, ` +
        `drift ${scenario.actualMinusDeclared >= 0 ? '+' : ''}${scenario.actualMinusDeclared}.`,
    );
  }
  lines.push('');

  lines.push('### Default Bundle Overhead');
  lines.push('');
  for (const delta of topDomainDelta) {
    lines.push(
      `- \`${delta.domainId}\`: default bundle adds ${delta.actualDelta >= 0 ? '+' : ''}${delta.actualDelta} actual prompt-only tokens ` +
        `(${delta.minimalActualPromptOnlyTokens} -> ${delta.defaultActualPromptOnlyTokens}); declared delta ` +
        `${delta.declaredDelta >= 0 ? '+' : ''}${delta.declaredDelta}.`,
    );
  }
  lines.push('');

  lines.push('### Largest Per-Entry Underestimates');
  lines.push('');
  for (const entry of topEntryDrift) {
    lines.push(
      `- \`${entry.id}\`: actual ${entry.actualCompiledTokens}, declared ${entry.declaredTokenBudget}, ` +
        `drift ${entry.deltaFromDeclared !== null && entry.deltaFromDeclared >= 0 ? '+' : ''}${entry.deltaFromDeclared}.`,
    );
  }
  lines.push('');

  lines.push('### Largest Per-Entry Overestimates');
  lines.push('');
  for (const entry of topEntryOverestimates) {
    lines.push(
      `- \`${entry.id}\`: actual ${entry.actualCompiledTokens}, declared ${entry.declaredTokenBudget}, ` +
        `drift ${entry.deltaFromDeclared !== null && entry.deltaFromDeclared >= 0 ? '+' : ''}${entry.deltaFromDeclared}.`,
    );
  }
  lines.push('');

  const missingBudgetEntries = result.entryMeasurements
    .filter((entry) => entry.declaredTokenBudget === null)
    .sort((left, right) =>
      compareNumbersDescending(left.actualCompiledTokens, right.actualCompiledTokens),
    );
  if (missingBudgetEntries.length > 0) {
    lines.push('### Entries Missing Declared Token Budgets');
    lines.push('');
    for (const entry of missingBudgetEntries) {
      lines.push(
        `- \`${entry.id}\`: actual compiled contribution ${entry.actualCompiledTokens} tokens.`,
      );
    }
    lines.push('');
  }

  lines.push('## Rerun');
  lines.push('');
  lines.push('From `<BABEL_REPO_ROOT>`:');
  lines.push('');
  lines.push('```powershell');
  lines.push('npm --prefix .\\babel-cli run audit:token-usage');
  lines.push('```');
  lines.push('');
  lines.push('Raw JSON artifact:');
  lines.push('');
  lines.push(`- \`${result.latestJsonPath}\``);
  lines.push('');
  lines.push('Latest markdown artifact:');
  lines.push('');
  lines.push(`- \`${result.latestMarkdownPath}\``);
  lines.push('');

  return `${lines.join('\n')}\n`;
}

export function runTokenUsageAudit(options: RunTokenUsageAuditOptions = {}): TokenUsageAuditResult {
  const catalogEntries = parseCatalog(CATALOG_PATH);
  const supplements = parseCatalogSupplements(CATALOG_PATH);
  const activeSkills = catalogEntries.filter(
    (entry) => entry.layer === 'skill' && entry.status === 'active',
  );
  const activeDomains = catalogEntries.filter(
    (entry) => entry.layer === 'domain_architect' && entry.status === 'active',
  );
  const availableDomainIds = new Set(activeDomains.map((entry) => entry.id));

  const entryMeasurements = catalogEntries
    .filter((entry) => entry.status === 'active' && entry.path)
    .map((entry) => countEntryTokens(entry, BABEL_ROOT))
    .sort((left, right) =>
      compareNumbersDescending(left.actualCompiledTokens, right.actualCompiledTokens),
    );

  const scenarios: TokenAuditScenario[] = [];
  for (const domain of activeDomains) {
    scenarios.push(createDomainScenario(domain.id, false));
    if (domain.defaultSkillIds.length > 0) {
      scenarios.push(createDomainScenario(domain.id, true));
    }
  }

  for (const skill of activeSkills) {
    const supplement = supplements.get(skill.id);
    const preferredDomains = unique([
      ...(supplement?.defaultForDomains ?? []).filter((domainId) =>
        availableDomainIds.has(domainId),
      ),
      inferFallbackDomain(skill, availableDomainIds),
    ]);

    for (const domainId of preferredDomains) {
      scenarios.push(createSkillScenario(skill, domainId));
    }
  }

  const scenarioResults: ScenarioResult[] = [];
  const scenarioFailures: ScenarioFailure[] = [];
  for (const scenario of scenarios) {
    try {
      scenarioResults.push(analyzeScenario(scenario));
    } catch (error: unknown) {
      scenarioFailures.push({
        scenarioId: scenario.id,
        label: scenario.label,
        kind: scenario.kind,
        domainId: scenario.domainId,
        explicitSkillIds: [...scenario.explicitSkillIds],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const resultsById = new Map(scenarioResults.map((result) => [result.id, result]));
  const domainBundleDeltas: DomainBundleDelta[] = activeDomains
    .map((domain) => {
      const minimal = resultsById.get(`domain-${safeFileSlug(domain.id)}-minimal`);
      const defaults = resultsById.get(`domain-${safeFileSlug(domain.id)}-default`);
      if (!minimal || !defaults) {
        return null;
      }
      return {
        domainId: domain.id,
        defaultScenarioId: defaults.id,
        minimalScenarioId: minimal.id,
        defaultDeclaredBudgetTotal: defaults.declaredTokenBudgetTotal,
        minimalDeclaredBudgetTotal: minimal.declaredTokenBudgetTotal,
        defaultActualPromptOnlyTokens: defaults.actualPromptOnlyTokens,
        minimalActualPromptOnlyTokens: minimal.actualPromptOnlyTokens,
        declaredDelta: defaults.declaredTokenBudgetTotal - minimal.declaredTokenBudgetTotal,
        actualDelta: defaults.actualPromptOnlyTokens - minimal.actualPromptOnlyTokens,
      };
    })
    .filter((value): value is DomainBundleDelta => value !== null);

  const heaviestScenarios = [...scenarioResults].sort((left, right) =>
    compareNumbersDescending(left.actualPromptOnlyTokens, right.actualPromptOnlyTokens),
  );
  const largestDriftScenarios = [...scenarioResults].sort((left, right) =>
    compareNumbersDescending(left.actualMinusDeclared, right.actualMinusDeclared),
  );
  const actualPolicyMisses = scenarioResults.filter(
    (result) =>
      severityRank(result.actualBudgetSeverity) > severityRank(result.declaredBudgetSeverity),
  );

  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const summary: TokenAuditSummary = {
    generatedAt,
    tokenizerEncoding: TOKENIZER_ENCODING,
    activeSkillCount: activeSkills.length,
    activeDomainCount: activeDomains.length,
    scenarioCount: scenarios.length,
    successCount: scenarioResults.length,
    failureCount: scenarioFailures.length,
    actualPolicyMissCount: actualPolicyMisses.length,
    missingBudgetScenarioCount: scenarioResults.filter(
      (result) => result.missingBudgetEntryIds.length > 0,
    ).length,
  };

  const timestampSlug = generatedAt.replace(/[:.]/g, '-');
  const runDir = join(OUTPUT_ROOT, timestampSlug);
  const latestDir = join(OUTPUT_ROOT, 'latest');

  const jsonPath = join(runDir, 'token-usage-audit.json');
  const markdownPath = join(runDir, 'token-usage-audit.md');
  const latestJsonPath = join(latestDir, 'token-usage-audit.json');
  const latestMarkdownPath = join(latestDir, 'token-usage-audit.md');

  const result: TokenUsageAuditResult = {
    outputRoot: OUTPUT_ROOT,
    runDir,
    latestDir,
    jsonPath,
    markdownPath,
    latestJsonPath,
    latestMarkdownPath,
    summary,
    scenarioResults,
    scenarioFailures,
    domainBundleDeltas,
    heaviestScenarios,
    largestDriftScenarios,
    actualPolicyMisses,
    entryMeasurements,
  };

  if (options.writeArtifacts !== false) {
    mkdirSync(OUTPUT_ROOT, { recursive: true });
    mkdirSync(runDir, { recursive: true });
    mkdirSync(latestDir, { recursive: true });

    const jsonText = `${JSON.stringify(result, null, 2)}\n`;
    const markdownText = createMarkdownReport(result);

    writeFileSync(jsonPath, jsonText, 'utf-8');
    writeFileSync(markdownPath, markdownText, 'utf-8');
    writeFileSync(latestJsonPath, jsonText, 'utf-8');
    writeFileSync(latestMarkdownPath, markdownText, 'utf-8');
  }

  return result;
}

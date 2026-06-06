import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ACTIVE_V9_BUDGET_POLICY,
  buildBudgetDiagnostics,
  budgetPolicyAppliesToInstructionStack,
} from '../budgetPolicy.js';
import {
  TOKENIZER_ENCODING,
  countSelectedEntryTokens,
  type TokenCountSource,
} from '../services/tokenCounter.js';
import {
  filterCatalogEntries,
  parseCatalog,
} from './catalog.js';
import type {
  CatalogEntry,
  CatalogInspectionFilters,
  CatalogLayer,
} from './catalog.js';
import type {
  BudgetDiagnostic,
  BudgetPolicy,
  CompilationState,
  CompiledArtifacts,
  InstructionStack,
  OrchestratorManifest,
  PipelineMode,
  PurposeMode,
  ResolutionPolicy,
} from '../schemas/agentContracts.js';

export interface RuntimeCompiledArtifacts extends CompiledArtifacts {
  purpose_resolution_mode: 'none' | 'typed' | 'provisional';
  purpose_seed_skill_id: string | null;
  purpose_suppression_reason: string | null;
  token_budget_total: number;
  token_budget_missing: string[];
  token_budget_by_entry: Record<string, number>;
  actual_prompt_tokens: number | null;
  actual_token_by_entry: Record<string, number>;
  actual_minus_declared: number | null;
  tokenizer_encoding: typeof TOKENIZER_ENCODING;
  token_count_source: TokenCountSource;
  token_count_warnings: string[];
  budget_policy: BudgetPolicy;
  budget_diagnostics: BudgetDiagnostic[];
  warnings: string[];
}

export interface StackResolutionPreviewOptions {
  countActualTokens?: boolean;
  tokenCountSource?: TokenCountSource;
  driftWarningTolerance?: number;
}

interface PurposeAnalysisInput {
  pipeline_mode?: PipelineMode | string;
  purpose_mode?: PurposeMode | string;
  purpose_source?: string;
  purpose_confidence?: number;
}

interface PurposeDiagnostics {
  purpose_resolution_mode: 'none' | 'typed';
  purpose_seed_skill_id: string | null;
  purpose_suppression_reason: string | null;
}

export interface PreviewEntry {
  id: string;
  layer: string;
  relative_path: string;
  absolute_path: string;
  load_position: number | null;
  token_budget: number | null;
  order_index: number;
  status: string | null;
  tags: string[];
  project: string | null;
}

export interface ResolvedStackPreview {
  compiledArtifacts: RuntimeCompiledArtifacts;
  orderedEntries: PreviewEntry[];
}

const LAYER_ORDER: Record<Extract<CatalogLayer,
  'behavioral_os' | 'domain_architect' | 'skill' | 'model_adapter' | 'project_overlay' | 'task_overlay' | 'pipeline_stage'
>, number> = {
  behavioral_os: 1,
  domain_architect: 2,
  skill: 3,
  project_overlay: 4,
  task_overlay: 5,
  model_adapter: 6,
  pipeline_stage: 7,
};

const CATALOG_ID_ALIASES: Record<string, string> = {
  skill_gradle: 'skill_gradle_wrapper',
  skill_gradle_bootstrap: 'skill_gradle_wrapper',
  skill_bash_scripting: 'skill_unix_shell',
  skill_shell_scripting: 'skill_unix_shell',
  skill_git: 'skill_unix_shell',
  skill_git_operations: 'skill_unix_shell',
  skill_file_operations: 'skill_exact_output_schema',
  skill_cli_tooling: 'skill_nodejs_cli',
  skill_python: 'skill_python_backend',
  skill_python_scripting: 'skill_python_backend',
  skill_python_validation: 'skill_python_backend',
  skill_python_verification: 'skill_python_backend',
  skill_python_testing: 'skill_python_backend',
  skill_csv_writer: 'skill_exact_output_schema',
  skill_csv_output: 'skill_exact_output_schema',
  domain_android: 'domain_android_kotlin',
  domain_mobile: 'domain_android_kotlin',
  domain_mobile_suite: 'domain_android_kotlin',
  domain_game: 'domain_godot_game_dev',
  domain_game_dev: 'domain_godot_game_dev',
  domain_godot: 'domain_godot_game_dev',
  domain_godot_game: 'domain_godot_game_dev',
  skill_godot_ui: 'skill_godot_ui_runtime',
  skill_hd2d_rpg_ui: 'skill_godot_hd2d_rpg_ui',
  skill_octopath_ui: 'skill_godot_hd2d_rpg_ui',
  skill_godot_android: 'skill_godot_android_export',
  skill_godot_performance: 'skill_godot_performance_mobile',
  skill_android_tv_game: 'skill_android_tv_game_ux',
  overlay_terminal_bench_2: 'overlay_terminal_bench',
};

interface NormalizedInstructionStackResult {
  instructionStack: InstructionStack;
  warnings: string[];
}

function normalizeCatalogId(entryId: string): string {
  return CATALOG_ID_ALIASES[entryId] ?? entryId;
}

function getCatalogEntry(
  entriesById: Map<string, CatalogEntry>,
  entryId: string,
): CatalogEntry | null {
  const normalizedId = normalizeCatalogId(entryId);
  return entriesById.get(normalizedId) ?? null;
}

function appendUnique(values: string[], nextValue: string): void {
  if (!values.includes(nextValue)) {
    values.push(nextValue);
  }
}

let purposeSeedMapCache: { babelRoot: string; seeds: Record<string, string | null> } | null = null;

function isPurposeAnalysisInput(value: unknown): value is PurposeAnalysisInput {
  return value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (
      'purpose_mode' in value ||
      'pipeline_mode' in value ||
      'purpose_source' in value ||
      'purpose_confidence' in value
    );
}

function loadPurposeSeedMap(babelRoot: string): Record<string, string | null> {
  if (purposeSeedMapCache?.babelRoot === babelRoot) {
    return purposeSeedMapCache.seeds;
  }

  const mapPath = join(babelRoot, 'config', 'purpose-mode-seeds.json');
  if (!existsSync(mapPath)) {
    const seeds: Record<string, string | null> = {};
    purposeSeedMapCache = { babelRoot, seeds };
    return seeds;
  }

  const parsed = JSON.parse(readFileSync(mapPath, 'utf-8')) as Record<string, unknown>;
  const seeds: Record<string, string | null> = {};
  for (const [purposeMode, seedValue] of Object.entries(parsed)) {
    seeds[purposeMode] = typeof seedValue === 'string' && seedValue.trim().length > 0
      ? seedValue.trim()
      : null;
  }
  purposeSeedMapCache = { babelRoot, seeds };
  return seeds;
}

function normalizePurposeMode(value: unknown): PurposeMode | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (
    normalized === 'execution' ||
    normalized === 'verification' ||
    normalized === 'learning' ||
    normalized === 'exploration' ||
    normalized === 'audit'
  ) {
    return normalized;
  }
  return null;
}

function getPurposeDiagnostics(
  analysis: PurposeAnalysisInput | null,
  domainId: string,
  pipelineStageIds: string[],
  babelRoot: string,
): PurposeDiagnostics {
  const purposeMode = normalizePurposeMode(analysis?.purpose_mode);
  if (!purposeMode) {
    return {
      purpose_resolution_mode: 'none',
      purpose_seed_skill_id: null,
      purpose_suppression_reason: null,
    };
  }

  const purposeSeedSkillId = loadPurposeSeedMap(babelRoot)[purposeMode] ?? null;
  if (purposeSeedSkillId === null) {
    return {
      purpose_resolution_mode: 'typed',
      purpose_seed_skill_id: null,
      purpose_suppression_reason: purposeMode === 'audit' ? 'no_seed_audit' : 'no_seed_execution',
    };
  }

  const pipelineMode = typeof analysis?.pipeline_mode === 'string' ? analysis.pipeline_mode : null;
  const autonomousContext =
    pipelineMode === 'autonomous' ||
    pipelineStageIds.includes('pipeline_cli_executor');
  if (autonomousContext && (purposeMode === 'learning' || purposeMode === 'exploration')) {
    return {
      purpose_resolution_mode: 'typed',
      purpose_seed_skill_id: null,
      purpose_suppression_reason: 'suppressed_by_autonomous_context',
    };
  }

  if (domainId === 'domain_research') {
    return {
      purpose_resolution_mode: 'typed',
      purpose_seed_skill_id: null,
      purpose_suppression_reason: 'suppressed_by_domain_research',
    };
  }

  if (domainId === 'domain_product_audit') {
    return {
      purpose_resolution_mode: 'typed',
      purpose_seed_skill_id: null,
      purpose_suppression_reason: 'suppressed_by_domain_product_audit',
    };
  }

  return {
    purpose_resolution_mode: 'typed',
    purpose_seed_skill_id: purposeSeedSkillId,
    purpose_suppression_reason: 'typed_seeded',
  };
}

function normalizeProjectName(value: string | null | undefined): string | null {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function findProjectOverlayIdByProjectName(
  entriesById: Map<string, CatalogEntry>,
  projectName: string | null | undefined,
): string | null {
  const normalizedProject = normalizeProjectName(projectName);
  if (!normalizedProject) {
    return null;
  }

  for (const entry of entriesById.values()) {
    if (
      entry.layer === 'project_overlay' &&
      normalizeProjectName(entry.project) === normalizedProject
    ) {
      return entry.id;
    }
  }

  return null;
}

function resolveGenericTaskOverlayFallback(
  entriesById: Map<string, CatalogEntry>,
  taskOverlayEntry: CatalogEntry,
): CatalogEntry | null {
  const scopedProject = normalizeProjectName(taskOverlayEntry.project);
  if (!scopedProject || !taskOverlayEntry.id.startsWith(`task_${scopedProject}_`)) {
    return null;
  }

  const genericCandidateId = `task_${taskOverlayEntry.id.slice(`task_${scopedProject}_`.length)}`;
  const genericEntry = getCatalogEntry(entriesById, genericCandidateId);
  if (!genericEntry || genericEntry.layer !== 'task_overlay' || genericEntry.project) {
    return null;
  }

  return genericEntry;
}

function resolveFrontendProfessionalismTaskAlias(
  entriesById: Map<string, CatalogEntry>,
  entryId: string,
): string | null {
  const match = /^task_([a-z0-9_]+)_frontend_professionalism$/i.exec(entryId.trim());
  if (!match) {
    return null;
  }
  const genericEntry = getCatalogEntry(entriesById, 'task_frontend_professionalism');
  if (!genericEntry || genericEntry.layer !== 'task_overlay') {
    return null;
  }
  return genericEntry.id;
}

function resolveFrontendProfessionalismCompositeAlias(
  entriesById: Map<string, CatalogEntry>,
  entryId: string,
  targetProject?: string | null,
): {
  projectOverlayId: string;
  taskOverlayId: string;
  warning: string;
} | null {
  const match = /^overlay_([a-z0-9_]+)_frontend_professionalism$/i.exec(entryId.trim());
  if (!match) {
    return null;
  }

  const projectSlug = match[1]!.toLowerCase();
  const targetProjectOverlayId = findProjectOverlayIdByProjectName(entriesById, targetProject);
  const projectOverlayEntry =
    getCatalogEntry(entriesById, `overlay_${projectSlug}`) ??
    (targetProjectOverlayId ? getCatalogEntry(entriesById, targetProjectOverlayId) : null);
  if (!projectOverlayEntry || projectOverlayEntry.layer !== 'project_overlay') {
    return null;
  }

  const taskOverlayEntry =
    getCatalogEntry(entriesById, `task_${projectSlug}_frontend_professionalism`) ??
    getCatalogEntry(entriesById, 'task_frontend_professionalism');
  if (!taskOverlayEntry || taskOverlayEntry.layer !== 'task_overlay') {
    return null;
  }

  return {
    projectOverlayId: projectOverlayEntry.id,
    taskOverlayId: taskOverlayEntry.id,
    warning:
      `[resolver] Normalized hallucinated frontend professionalism overlay "${entryId}" ` +
      `to project overlay "${projectOverlayEntry.id}" plus task overlay "${taskOverlayEntry.id}".`,
  };
}

function normalizeInstructionStackOverlays(
  instructionStack: InstructionStack,
  entriesById: Map<string, CatalogEntry>,
  targetProject?: string | null,
): NormalizedInstructionStackResult {
  const warnings: string[] = [];
  let projectOverlayId = instructionStack.project_overlay_id
    ? normalizeCatalogId(instructionStack.project_overlay_id)
    : null;
  const taskOverlayIds: string[] = [];
  const unresolvedTaskOverlayIds: string[] = [];

  if (projectOverlayId) {
    const projectSlotEntry = getCatalogEntry(entriesById, projectOverlayId);
    if (projectSlotEntry?.layer === 'task_overlay') {
      appendUnique(taskOverlayIds, projectSlotEntry.id);
      warnings.push(
        `[resolver] Moved task overlay "${projectSlotEntry.id}" from project_overlay_id ` +
        'into task_overlay_ids because task overlays cannot occupy the project overlay slot.',
      );
      projectOverlayId = null;
    } else if (!projectSlotEntry) {
      const compositeRepair = resolveFrontendProfessionalismCompositeAlias(
        entriesById,
        projectOverlayId,
        targetProject,
      );
      if (compositeRepair) {
        projectOverlayId = compositeRepair.projectOverlayId;
        appendUnique(taskOverlayIds, compositeRepair.taskOverlayId);
        warnings.push(compositeRepair.warning);
      }
    } else if (projectSlotEntry.layer === 'project_overlay') {
      projectOverlayId = projectSlotEntry.id;
    }
  }

  for (const rawTaskOverlayId of instructionStack.task_overlay_ids) {
    const normalizedTaskOverlayId = normalizeCatalogId(rawTaskOverlayId);
    const taskSlotEntry = getCatalogEntry(entriesById, normalizedTaskOverlayId);

    if (taskSlotEntry?.layer === 'task_overlay') {
      appendUnique(taskOverlayIds, taskSlotEntry.id);
      continue;
    }

    if (taskSlotEntry?.layer === 'project_overlay') {
      if (!projectOverlayId) {
        projectOverlayId = taskSlotEntry.id;
      }
      warnings.push(
        `[resolver] Moved project overlay "${taskSlotEntry.id}" from task_overlay_ids ` +
        'into project_overlay_id because project overlays cannot occupy task overlay slots.',
      );
      continue;
    }

    if (!taskSlotEntry) {
      const compositeRepair = resolveFrontendProfessionalismCompositeAlias(
        entriesById,
        normalizedTaskOverlayId,
        targetProject,
      );
      if (compositeRepair) {
        if (!projectOverlayId) {
          projectOverlayId = compositeRepair.projectOverlayId;
        }
        appendUnique(taskOverlayIds, compositeRepair.taskOverlayId);
        warnings.push(compositeRepair.warning);
        continue;
      }

      const taskAliasRepair = resolveFrontendProfessionalismTaskAlias(
        entriesById,
        normalizedTaskOverlayId,
      );
      if (taskAliasRepair) {
        appendUnique(taskOverlayIds, taskAliasRepair);
        warnings.push(
          `[resolver] Normalized hallucinated task overlay "${normalizedTaskOverlayId}" ` +
          `to generic task overlay "${taskAliasRepair}".`,
        );
        continue;
      }
    }

    appendUnique(unresolvedTaskOverlayIds, normalizedTaskOverlayId);
  }

  const desiredProject = normalizeProjectName(targetProject);
  const effectiveProject = desiredProject ?? normalizeProjectName(
    projectOverlayId
      ? getCatalogEntry(entriesById, projectOverlayId)?.project
      : null,
  );

  if (effectiveProject) {
    if (!projectOverlayId) {
      const inferredProjectOverlayId = findProjectOverlayIdByProjectName(entriesById, effectiveProject);
      if (inferredProjectOverlayId) {
        projectOverlayId = inferredProjectOverlayId;
        warnings.push(
          `[resolver] Inferred missing project overlay "${inferredProjectOverlayId}" from target project "${effectiveProject}".`,
        );
      }
    } else {
      const currentProjectOverlay = getCatalogEntry(entriesById, projectOverlayId);
      if (!currentProjectOverlay) {
        const correctedProjectOverlayId = findProjectOverlayIdByProjectName(entriesById, effectiveProject);
        if (correctedProjectOverlayId) {
          warnings.push(
            `[resolver] Replaced unknown project overlay "${projectOverlayId}" with ` +
            `"${correctedProjectOverlayId}" to match target project "${effectiveProject}".`,
          );
          projectOverlayId = correctedProjectOverlayId;
        } else {
          warnings.push(
            `[resolver] Dropped unknown project overlay "${projectOverlayId}" because no project overlay ` +
            `matched target project "${effectiveProject}".`,
          );
          projectOverlayId = null;
        }
      }
      const currentProjectName = normalizeProjectName(currentProjectOverlay?.project);
      if (currentProjectName && currentProjectName !== effectiveProject) {
        const correctedProjectOverlayId = findProjectOverlayIdByProjectName(entriesById, effectiveProject);
        if (correctedProjectOverlayId) {
          warnings.push(
            `[resolver] Replaced project overlay "${projectOverlayId}" with "${correctedProjectOverlayId}" ` +
            `to match target project "${effectiveProject}".`,
          );
          projectOverlayId = correctedProjectOverlayId;
        }
      }
    }
  }

  const projectConsistentTaskOverlayIds: string[] = [];
  for (const taskOverlayId of taskOverlayIds) {
    const taskOverlayEntry = getCatalogEntry(entriesById, taskOverlayId);
    if (!taskOverlayEntry || taskOverlayEntry.layer !== 'task_overlay') {
      appendUnique(projectConsistentTaskOverlayIds, taskOverlayId);
      continue;
    }

    const taskOverlayProject = normalizeProjectName(taskOverlayEntry.project);
    if (!taskOverlayProject || !effectiveProject || taskOverlayProject === effectiveProject) {
      appendUnique(projectConsistentTaskOverlayIds, taskOverlayId);
      continue;
    }

    const genericFallback = resolveGenericTaskOverlayFallback(entriesById, taskOverlayEntry);
    if (genericFallback) {
      appendUnique(projectConsistentTaskOverlayIds, genericFallback.id);
      warnings.push(
        `[resolver] Replaced project-specific task overlay "${taskOverlayEntry.id}" with generic overlay ` +
        `"${genericFallback.id}" because the active project is "${effectiveProject}", not "${taskOverlayProject}".`,
      );
      continue;
    }

    warnings.push(
      `[resolver] Dropped project-specific task overlay "${taskOverlayEntry.id}" because it targets ` +
      `"${taskOverlayProject}" while the active project is "${effectiveProject}".`,
    );
  }

  return {
    instructionStack: {
      ...instructionStack,
      behavioral_ids: instructionStack.behavioral_ids.map(normalizeCatalogId),
      domain_id: normalizeCatalogId(instructionStack.domain_id),
      skill_ids: instructionStack.skill_ids.map(normalizeCatalogId),
      model_adapter_id: normalizeCatalogId(instructionStack.model_adapter_id),
      project_overlay_id: projectOverlayId,
      task_overlay_ids: [...projectConsistentTaskOverlayIds, ...unresolvedTaskOverlayIds],
      pipeline_stage_ids: instructionStack.pipeline_stage_ids.map(normalizeCatalogId),
    },
    warnings,
  };
}

function requireEntry(
  entriesById: Map<string, CatalogEntry>,
  entryId: string,
  expectedLayer?: string,
): CatalogEntry {
  const normalizedId = normalizeCatalogId(entryId);
  const compatibilityId = normalizedId === 'behavioral_core_v7' && entriesById.has('behavioral_core_v10')
    ? 'behavioral_core_v10'
    : normalizedId;
  const entry = entriesById.get(compatibilityId);
  if (!entry) {
    throw new Error(`[resolver] Unknown catalog id: ${entryId}`);
  }
  if (entry.status && entry.status !== 'active') {
    throw new Error(`[resolver] Catalog entry is not active: ${normalizedId}`);
  }
  if (expectedLayer && entry.layer !== expectedLayer) {
    throw new Error(
      `[resolver] Catalog id ${normalizedId} has layer "${entry.layer}" but "${expectedLayer}" was required.`,
    );
  }
  if (!entry.path) {
    throw new Error(`[resolver] Catalog entry is missing a path: ${normalizedId}`);
  }
  return entry;
}

function expandSkillIds(
  seeds: string[],
  resolutionPolicy: ResolutionPolicy,
  entriesById: Map<string, CatalogEntry>,
): string[] {
  const resolved: string[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (skillId: string): void => {
    const entry = requireEntry(entriesById, skillId, 'skill');
    const resolvedSkillId = entry.id;

    if (visited.has(resolvedSkillId)) {
      return;
    }
    if (visiting.has(resolvedSkillId)) {
      throw new Error(`[resolver] Skill dependency cycle detected at ${resolvedSkillId}`);
    }

    visiting.add(resolvedSkillId);

    if (resolutionPolicy.expand_skill_dependencies) {
      for (const dependencyId of entry.dependencies) {
        visit(dependencyId);
      }
    }

    visiting.delete(resolvedSkillId);
    visited.add(resolvedSkillId);
    resolved.push(resolvedSkillId);
  };

  for (const skillId of seeds) {
    visit(skillId);
  }

  return resolved;
}

function resolveDomainDefaultSkillIds(
  domainId: string,
  domainDefaultSkillIds: string[],
  resolutionPolicy: ResolutionPolicy,
): string[] {
  const profile = resolutionPolicy.task_shape_profile ?? 'full';

  if (profile === 'full' || profile === 'audit_verification') {
    return [...domainDefaultSkillIds];
  }

  if (
    profile === 'greenfield_file_creation' &&
    (domainId === 'domain_swe_backend' ||
      domainId === 'domain_swe_frontend' ||
      domainId === 'domain_research')
  ) {
    return [];
  }

  if (profile === 'synthesis_write' && domainId === 'domain_research') {
    return [];
  }

  if (profile === 'android_utility_file' && domainId === 'domain_android_kotlin') {
    return [];
  }

  if (profile === 'compliance_artifact_write' && domainId === 'domain_compliance_gpc') {
    return [];
  }

  return [...domainDefaultSkillIds];
}

function assertNoConflicts(
  selectedIds: string[],
  entriesById: Map<string, CatalogEntry>,
  strictConflictMode: ResolutionPolicy['strict_conflict_mode'] = 'error',
): string[] {
  const selectedSet = new Set(selectedIds);
  const warnings: string[] = [];

  for (const entryId of selectedIds) {
    const entry = requireEntry(entriesById, entryId);
    for (const conflictingId of entry.conflicts) {
      if (selectedSet.has(conflictingId)) {
        const message = `[resolver] Conflicting catalog ids selected together: ${entryId} vs ${conflictingId}`;
        if (strictConflictMode === 'warn') {
          warnings.push(message);
        } else {
          throw new Error(message);
        }
      }
    }
  }

  return [...new Set(warnings)];
}

export function inspectCatalog(
  catalogPath: string,
  filters: CatalogInspectionFilters = {},
): CatalogEntry[] {
  return filterCatalogEntries(parseCatalog(catalogPath), filters);
}

export function previewInstructionStackResolution(
  instructionStack: InstructionStack,
  resolutionPolicy: ResolutionPolicy,
  babelRoot: string,
  catalogPath: string,
  targetProjectOrAnalysis?: string | null | PurposeAnalysisInput,
  analysisOverride?: PurposeAnalysisInput | null,
  options: StackResolutionPreviewOptions = {},
): ResolvedStackPreview {
  const catalogEntries = parseCatalog(catalogPath);
  const entriesById = new Map(catalogEntries.map(entry => [entry.id, entry]));
  const analysis = analysisOverride ?? (isPurposeAnalysisInput(targetProjectOrAnalysis) ? targetProjectOrAnalysis : null);
  const targetProject = isPurposeAnalysisInput(targetProjectOrAnalysis) ? null : targetProjectOrAnalysis;
  const normalizedStackResult = normalizeInstructionStackOverlays(instructionStack, entriesById, targetProject);
  const normalizedInstructionStack = normalizedStackResult.instructionStack;

  const behavioralIds = normalizedInstructionStack.behavioral_ids.map(entryId => {
    requireEntry(entriesById, entryId, 'behavioral_os');
    return entryId;
  });

  const domainEntry = requireEntry(entriesById, normalizedInstructionStack.domain_id, 'domain_architect');
  const modelAdapterId = requireEntry(entriesById, normalizedInstructionStack.model_adapter_id, 'model_adapter').id;
  const projectOverlayId = normalizedInstructionStack.project_overlay_id
    ? requireEntry(entriesById, normalizedInstructionStack.project_overlay_id, 'project_overlay').id
    : null;
  const taskOverlayIds = normalizedInstructionStack.task_overlay_ids.map(entryId => {
    requireEntry(entriesById, entryId, 'task_overlay');
    return entryId;
  });
  const pipelineStageIds = normalizedInstructionStack.pipeline_stage_ids.map(entryId => {
    requireEntry(entriesById, entryId, 'pipeline_stage');
    return entryId;
  });

  const purposeDiagnostics = getPurposeDiagnostics(
    analysis,
    domainEntry.id,
    pipelineStageIds,
    babelRoot,
  );
  const seedSkills: string[] = [...normalizedInstructionStack.skill_ids];
  if (
    purposeDiagnostics.purpose_seed_skill_id &&
    !seedSkills.includes(purposeDiagnostics.purpose_seed_skill_id)
  ) {
    seedSkills.push(purposeDiagnostics.purpose_seed_skill_id);
  }
  if (resolutionPolicy.apply_domain_default_skills) {
    for (const defaultSkillId of resolveDomainDefaultSkillIds(
      domainEntry.id,
      domainEntry.defaultSkillIds,
      resolutionPolicy,
    )) {
      if (!seedSkills.includes(defaultSkillId)) {
        seedSkills.push(defaultSkillId);
      }
    }
  }

  const skillIds = expandSkillIds(seedSkills, resolutionPolicy, entriesById);
  const selectedIdsRaw = [
    ...behavioralIds,
    domainEntry.id,
    ...skillIds,
    modelAdapterId,
    ...(projectOverlayId ? [projectOverlayId] : []),
    ...taskOverlayIds,
    ...pipelineStageIds,
  ];

  const selectedIds: string[] = [];
  const seenSelectedIds = new Set<string>();
  for (const entryId of selectedIdsRaw) {
    if (!seenSelectedIds.has(entryId)) {
      seenSelectedIds.add(entryId);
      selectedIds.push(entryId);
    }
  }

  const conflictWarnings = assertNoConflicts(
    selectedIds,
    entriesById,
    resolutionPolicy.strict_conflict_mode,
  );

  const selectedEntries = selectedIds.map((entryId, index) => {
    const entry = requireEntry(entriesById, entryId);
    const absolutePath = join(babelRoot, entry.path!);
    if (!existsSync(absolutePath)) {
      throw new Error(`[resolver] Resolved path does not exist for ${entryId}: ${absolutePath}`);
    }

    const layerRank = LAYER_ORDER[entry.layer as keyof typeof LAYER_ORDER];
    if (!layerRank) {
      throw new Error(`[resolver] Unsupported layer ordering for ${entryId}: ${entry.layer}`);
    }

    return {
      entry,
      absolutePath,
      layerRank,
      sourceOrder: index,
    };
  });

  selectedEntries.sort((left, right) =>
    left.layerRank - right.layerRank ||
    (left.entry.loadPosition ?? Number.MAX_SAFE_INTEGER) - (right.entry.loadPosition ?? Number.MAX_SAFE_INTEGER) ||
    left.sourceOrder - right.sourceOrder,
  );

  let tokenBudgetTotal = 0;
  const tokenBudgetMissing: string[] = [];
  const tokenBudgetByEntry: Record<string, number> = {};

  for (const selectedEntry of selectedEntries) {
    if (selectedEntry.entry.tokenBudget === null) {
      tokenBudgetMissing.push(selectedEntry.entry.id);
      continue;
    }

    tokenBudgetTotal += selectedEntry.entry.tokenBudget;
    tokenBudgetByEntry[selectedEntry.entry.id] = selectedEntry.entry.tokenBudget;
  }

  const policyApplies = budgetPolicyAppliesToInstructionStack(
    instructionStack,
    ACTIVE_V9_BUDGET_POLICY,
  );
  const budgetPolicy: BudgetPolicy = {
    ...ACTIVE_V9_BUDGET_POLICY,
    enabled: policyApplies,
  };

  const tokenMeasurement = options.countActualTokens
    ? countSelectedEntryTokens(
        selectedEntries.map(selectedEntry => ({
          id: selectedEntry.entry.id,
          absolutePath: selectedEntry.absolutePath,
        })),
        options.tokenCountSource ?? 'runtime',
      )
    : {
        actualPromptTokens: null,
        actualTokenByEntry: {},
        tokenizerEncoding: TOKENIZER_ENCODING,
        tokenCountSource: 'unavailable' as const,
        warnings: [],
      };
  const actualMinusDeclared =
    typeof tokenMeasurement.actualPromptTokens === 'number'
      ? tokenMeasurement.actualPromptTokens - tokenBudgetTotal
      : null;
  const budgetDiagnostics = buildBudgetDiagnostics({
    declaredTokenBudgetTotal: tokenBudgetTotal,
    tokenBudgetMissing,
    policyApplies,
    budgetPolicy,
    actualPromptTokens: tokenMeasurement.actualPromptTokens,
    actualMinusDeclared,
    tokenCountWarnings: tokenMeasurement.warnings,
    driftWarningTolerance: options.driftWarningTolerance,
  });

  const compiledArtifacts: RuntimeCompiledArtifacts = {
    selected_entry_ids: selectedEntries.map(selectedEntry => selectedEntry.entry.id),
    prompt_manifest: selectedEntries.map(selectedEntry => selectedEntry.absolutePath),
    purpose_resolution_mode: purposeDiagnostics.purpose_resolution_mode,
    purpose_seed_skill_id: purposeDiagnostics.purpose_seed_skill_id,
    purpose_suppression_reason: purposeDiagnostics.purpose_suppression_reason,
    token_budget_total: tokenBudgetTotal,
    token_budget_missing: tokenBudgetMissing,
    token_budget_by_entry: tokenBudgetByEntry,
    actual_prompt_tokens: tokenMeasurement.actualPromptTokens,
    actual_token_by_entry: tokenMeasurement.actualTokenByEntry,
    actual_minus_declared: actualMinusDeclared,
    tokenizer_encoding: tokenMeasurement.tokenizerEncoding,
    token_count_source: tokenMeasurement.tokenCountSource,
    token_count_warnings: tokenMeasurement.warnings,
    budget_policy: budgetPolicy,
    budget_diagnostics: budgetDiagnostics,
    warnings: [
      ...normalizedStackResult.warnings,
      ...conflictWarnings,
      `Total token budget: ${tokenBudgetTotal}`,
      ...budgetDiagnostics.map(diagnostic => diagnostic.message),
    ],
  };

  return {
    compiledArtifacts,
    orderedEntries: selectedEntries.map((selectedEntry, index) => ({
      id: selectedEntry.entry.id,
      layer: selectedEntry.entry.layer,
      relative_path: selectedEntry.entry.path!,
      absolute_path: selectedEntry.absolutePath,
      load_position: selectedEntry.entry.loadPosition,
      token_budget: selectedEntry.entry.tokenBudget,
      order_index: index + 1,
      status: selectedEntry.entry.status,
      tags: [...selectedEntry.entry.tags],
      project: selectedEntry.entry.project,
    })),
  };
}

export function resolveInstructionStackManifest(
  manifest: OrchestratorManifest,
  babelRoot: string,
): OrchestratorManifest {
  if (!manifest.instruction_stack || !manifest.resolution_policy) {
    return manifest;
  }

  if (manifest.compilation_state === 'compiled') {
    return manifest;
  }

  const { compiledArtifacts } = previewInstructionStackResolution(
    manifest.instruction_stack,
    manifest.resolution_policy,
    babelRoot,
    join(babelRoot, 'prompt_catalog.yaml'),
    manifest.target_project,
    manifest.analysis,
    { countActualTokens: true, tokenCountSource: 'runtime' },
  );
  const catalogEntries = parseCatalog(join(babelRoot, 'prompt_catalog.yaml'));
  const entriesById = new Map(catalogEntries.map(entry => [entry.id, entry]));
  const normalizedStackResult = normalizeInstructionStackOverlays(
    manifest.instruction_stack,
    entriesById,
    manifest.target_project,
  );

  return {
    ...manifest,
    compilation_state: 'compiled' as CompilationState,
    instruction_stack: normalizedStackResult.instructionStack,
    compiled_artifacts: compiledArtifacts as CompiledArtifacts,
    prompt_manifest: [...compiledArtifacts.prompt_manifest],
  };
}

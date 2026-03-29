import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  ACTIVE_V9_BUDGET_POLICY,
  budgetPolicyAppliesToInstructionStack,
} from '../budgetPolicy.js';
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
  ResolutionPolicy,
} from '../schemas/agentContracts.js';

export interface RuntimeCompiledArtifacts extends CompiledArtifacts {
  token_budget_total: number;
  token_budget_missing: string[];
  token_budget_by_entry: Record<string, number>;
  budget_policy: BudgetPolicy;
  budget_diagnostics: BudgetDiagnostic[];
  warnings: string[];
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
  model_adapter: 4,
  project_overlay: 5,
  task_overlay: 6,
  pipeline_stage: 7,
};

function requireEntry(
  entriesById: Map<string, CatalogEntry>,
  entryId: string,
  expectedLayer?: string,
): CatalogEntry {
  const entry = entriesById.get(entryId);
  if (!entry) {
    throw new Error(`[resolver] Unknown catalog id: ${entryId}`);
  }
  if (entry.status && entry.status !== 'active') {
    throw new Error(`[resolver] Catalog entry is not active: ${entryId}`);
  }
  if (expectedLayer && entry.layer !== expectedLayer) {
    throw new Error(
      `[resolver] Catalog id ${entryId} has layer "${entry.layer}" but "${expectedLayer}" was required.`,
    );
  }
  if (!entry.path) {
    throw new Error(`[resolver] Catalog entry is missing a path: ${entryId}`);
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

    if (visited.has(skillId)) {
      return;
    }
    if (visiting.has(skillId)) {
      throw new Error(`[resolver] Skill dependency cycle detected at ${skillId}`);
    }

    visiting.add(skillId);

    if (resolutionPolicy.expand_skill_dependencies) {
      for (const dependencyId of entry.dependencies) {
        visit(dependencyId);
      }
    }

    visiting.delete(skillId);
    visited.add(skillId);
    resolved.push(skillId);
  };

  for (const skillId of seeds) {
    visit(skillId);
  }

  return resolved;
}

function assertNoConflicts(
  selectedIds: string[],
  entriesById: Map<string, CatalogEntry>,
): void {
  const selectedSet = new Set(selectedIds);

  for (const entryId of selectedIds) {
    const entry = requireEntry(entriesById, entryId);
    for (const conflictingId of entry.conflicts) {
      if (selectedSet.has(conflictingId)) {
        throw new Error(`[resolver] Conflicting catalog ids selected together: ${entryId} vs ${conflictingId}`);
      }
    }
  }
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
): ResolvedStackPreview {
  const catalogEntries = parseCatalog(catalogPath);
  const entriesById = new Map(catalogEntries.map(entry => [entry.id, entry]));

  const behavioralIds = instructionStack.behavioral_ids.map(entryId => {
    requireEntry(entriesById, entryId, 'behavioral_os');
    return entryId;
  });

  const domainEntry = requireEntry(entriesById, instructionStack.domain_id, 'domain_architect');
  const modelAdapterId = requireEntry(entriesById, instructionStack.model_adapter_id, 'model_adapter').id;
  const projectOverlayId = instructionStack.project_overlay_id
    ? requireEntry(entriesById, instructionStack.project_overlay_id, 'project_overlay').id
    : null;
  const taskOverlayIds = instructionStack.task_overlay_ids.map(entryId => {
    requireEntry(entriesById, entryId, 'task_overlay');
    return entryId;
  });
  const pipelineStageIds = instructionStack.pipeline_stage_ids.map(entryId => {
    requireEntry(entriesById, entryId, 'pipeline_stage');
    return entryId;
  });

  const seedSkills: string[] = [...instructionStack.skill_ids];
  if (resolutionPolicy.apply_domain_default_skills) {
    for (const defaultSkillId of domainEntry.defaultSkillIds) {
      if (!seedSkills.includes(defaultSkillId)) {
        seedSkills.push(defaultSkillId);
      }
    }
  }

  const skillIds = expandSkillIds(seedSkills, resolutionPolicy, entriesById);
  const selectedIds = [
    ...behavioralIds,
    domainEntry.id,
    ...skillIds,
    modelAdapterId,
    ...(projectOverlayId ? [projectOverlayId] : []),
    ...taskOverlayIds,
    ...pipelineStageIds,
  ];

  assertNoConflicts(selectedIds, entriesById);

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
  const budgetDiagnostics: BudgetDiagnostic[] = [];

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

  budgetDiagnostics.push({
    severity: 'info',
    code: 'total_token_budget',
    message: `Total token budget: ${tokenBudgetTotal}`,
  });

  if (tokenBudgetMissing.length > 0) {
    budgetDiagnostics.push({
      severity: policyApplies && budgetPolicy.missing_budget_mode === 'severe' ? 'severe' : 'warn',
      code: 'missing_token_budget',
      message: `Missing token_budget for: ${tokenBudgetMissing.join(', ')}`,
      entry_ids: [...tokenBudgetMissing],
    });
  }

  if (policyApplies && tokenBudgetTotal >= budgetPolicy.severe_warn_threshold) {
    budgetDiagnostics.push({
      severity: 'severe',
      code: 'budget_threshold_severe',
      message:
        `Compiled stack token budget ${tokenBudgetTotal} reached the severe threshold ` +
        `${budgetPolicy.severe_warn_threshold}.`,
    });
  } else if (policyApplies && tokenBudgetTotal >= budgetPolicy.warn_threshold) {
    budgetDiagnostics.push({
      severity: 'warn',
      code: 'budget_threshold_warning',
      message:
        `Compiled stack token budget ${tokenBudgetTotal} reached the warning threshold ` +
        `${budgetPolicy.warn_threshold}.`,
    });
  }

  const compiledArtifacts: RuntimeCompiledArtifacts = {
    selected_entry_ids: selectedEntries.map(selectedEntry => selectedEntry.entry.id),
    prompt_manifest: selectedEntries.map(selectedEntry => selectedEntry.absolutePath),
    token_budget_total: tokenBudgetTotal,
    token_budget_missing: tokenBudgetMissing,
    token_budget_by_entry: tokenBudgetByEntry,
    budget_policy: budgetPolicy,
    budget_diagnostics: budgetDiagnostics,
    warnings: budgetDiagnostics.map(diagnostic => diagnostic.message),
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
  );

  return {
    ...manifest,
    compilation_state: 'compiled' as CompilationState,
    compiled_artifacts: compiledArtifacts as CompiledArtifacts,
    prompt_manifest: [...compiledArtifacts.prompt_manifest],
  };
}

import { existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { Command } from 'commander';

import { previewInstructionStackResolution } from '../src/control-plane/stackResolver.js';
import type {
  InstructionStack,
  PipelineMode,
  ResolutionPolicy,
} from '../src/schemas/agentContracts.js';

const VALID_TASK_CATEGORIES = [
  'frontend',
  'backend',
  'mobile',
  'compliance',
  'devops',
  'research',
] as const;
type ValidTaskCategory = typeof VALID_TASK_CATEGORIES[number];

const VALID_PROJECTS = [
  'global',
  'example_saas_backend',
  'example_llm_router',
  'example_web_audit',
  'example_mobile_suite',
] as const;
type ValidProject = typeof VALID_PROJECTS[number];

const VALID_MODELS = ['codex', 'claude', 'gemini'] as const;
type ValidModel = typeof VALID_MODELS[number];

const VALID_PIPELINE_MODES = ['direct', 'verified', 'autonomous', 'manual'] as const;
type ValidPipelineMode = typeof VALID_PIPELINE_MODES[number];

const VALID_CODEX_ADAPTERS = ['balanced', 'ultra'] as const;
type ValidCodexAdapter = typeof VALID_CODEX_ADAPTERS[number];

const DOMAIN_ID_BY_CATEGORY: Record<ValidTaskCategory, string> = {
  frontend: 'domain_swe_frontend',
  backend: 'domain_swe_backend',
  mobile: 'domain_android_kotlin',
  compliance: 'domain_compliance_gpc',
  devops: 'domain_devops',
  research: 'domain_research',
};

const PROJECT_OVERLAY_ID_BY_PROJECT: Record<Exclude<ValidProject, 'global'>, string> = {
  example_saas_backend: 'overlay_example_saas_backend',
  example_llm_router: 'overlay_example_llm_router',
  example_web_audit: 'overlay_example_web_audit',
  example_mobile_suite: 'overlay_example_mobile_suite',
};

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function toPosixPath(value: string): string {
  return value.replace(/\\/g, '/');
}

function normalizeUnique(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

function getBabelRoot(rootOverride?: string): string {
  const candidate = rootOverride?.trim() || process.env['BABEL_ROOT'] || resolve(import.meta.dirname, '..', '..');
  return resolve(candidate);
}

function getSelectedModelAdapterId(
  model: ValidModel,
  codexAdapter: ValidCodexAdapter,
): string {
  if (model === 'claude') {
    return 'adapter_claude';
  }
  if (model === 'gemini') {
    return 'adapter_gemini';
  }
  return codexAdapter === 'ultra' ? 'adapter_codex' : 'adapter_codex_balanced';
}

function getPipelineStageIds(mode: ValidPipelineMode): string[] {
  if (mode === 'verified') {
    return ['pipeline_qa_reviewer'];
  }
  if (mode === 'autonomous') {
    return ['pipeline_qa_reviewer', 'pipeline_cli_executor'];
  }
  return [];
}

function getRecommendedTaskOverlayIds(
  taskCategory: ValidTaskCategory,
  project: ValidProject,
  disabled: boolean,
): string[] {
  if (disabled) {
    return [];
  }

  const overlays: string[] = [];
  if (taskCategory === 'frontend') {
    overlays.push('task_frontend_professionalism');
  }
  if (taskCategory === 'frontend' && project === 'example_saas_backend') {
    overlays.push('task_example_saas_backend_frontend_professionalism');
  }

  return normalizeUnique(overlays);
}

function buildInstructionStack(options: {
  taskCategory: ValidTaskCategory;
  project: ValidProject;
  model: ValidModel;
  pipelineMode: ValidPipelineMode;
  codexAdapter: ValidCodexAdapter;
  requestedSkillIds: string[];
  requestedTaskOverlayIds: string[];
  disableRecommendedTaskOverlays: boolean;
}): {
  instructionStack: InstructionStack;
  recommendedTaskOverlayIds: string[];
  appliedTaskOverlayIds: string[];
} {
  const recommendedTaskOverlayIds = getRecommendedTaskOverlayIds(
    options.taskCategory,
    options.project,
    options.disableRecommendedTaskOverlays,
  );
  const appliedTaskOverlayIds = normalizeUnique([
    ...recommendedTaskOverlayIds,
    ...options.requestedTaskOverlayIds,
  ]);

  const instructionStack: InstructionStack = {
    behavioral_ids: ['behavioral_core_v7', 'behavioral_guard_v7'],
    domain_id: DOMAIN_ID_BY_CATEGORY[options.taskCategory],
    skill_ids: normalizeUnique(options.requestedSkillIds),
    model_adapter_id: getSelectedModelAdapterId(options.model, options.codexAdapter),
    project_overlay_id: options.project === 'global'
      ? null
      : PROJECT_OVERLAY_ID_BY_PROJECT[options.project],
    task_overlay_ids: appliedTaskOverlayIds,
    pipeline_stage_ids: getPipelineStageIds(options.pipelineMode),
  };

  return {
    instructionStack,
    recommendedTaskOverlayIds,
    appliedTaskOverlayIds,
  };
}

function buildResolutionPolicy(): ResolutionPolicy {
  return {
    apply_domain_default_skills: true,
    expand_skill_dependencies: true,
    strict_conflict_mode: 'error',
  };
}

const program = new Command();

program
  .requiredOption('--task-category <category>', 'frontend | backend | mobile | compliance | devops | research')
  .requiredOption('--model <model>', 'codex | claude | gemini')
  .option('--project <project>', 'global | example_saas_backend | example_llm_router | example_web_audit | example_mobile_suite', 'global')
  .option('--pipeline-mode <mode>', 'direct | verified | autonomous | manual', 'direct')
  .option('--codex-adapter <adapter>', 'balanced | ultra', 'balanced')
  .option('--skill-id <id>', 'requested skill id (repeatable)', collect, [])
  .option('--task-overlay-id <id>', 'requested task overlay id (repeatable)', collect, [])
  .option('--disable-recommended-task-overlays', 'disable built-in recommended task overlays', false)
  .option('--absolute-paths', 'emit prompt_manifest paths as repo-absolute paths instead of repo-relative paths', false)
  .option('--root <path>', 'override the Babel root directory');

program.parse(process.argv);

const options = program.opts<{
  taskCategory: string;
  model: string;
  project: string;
  pipelineMode: string;
  codexAdapter: string;
  skillId: string[];
  taskOverlayId: string[];
  disableRecommendedTaskOverlays: boolean;
  absolutePaths: boolean;
  root?: string;
}>();

const taskCategory = options.taskCategory as ValidTaskCategory;
const model = options.model as ValidModel;
const project = options.project as ValidProject;
const pipelineMode = options.pipelineMode as ValidPipelineMode;
const codexAdapter = options.codexAdapter as ValidCodexAdapter;

if (!VALID_TASK_CATEGORIES.includes(taskCategory)) {
  throw new Error(`Invalid task category "${options.taskCategory}". Valid values: ${VALID_TASK_CATEGORIES.join(', ')}`);
}
if (!VALID_MODELS.includes(model)) {
  throw new Error(`Invalid model "${options.model}". Valid values: ${VALID_MODELS.join(', ')}`);
}
if (!VALID_PROJECTS.includes(project)) {
  throw new Error(`Invalid project "${options.project}". Valid values: ${VALID_PROJECTS.join(', ')}`);
}
if (!VALID_PIPELINE_MODES.includes(pipelineMode)) {
  throw new Error(`Invalid pipeline mode "${options.pipelineMode}". Valid values: ${VALID_PIPELINE_MODES.join(', ')}`);
}
if (!VALID_CODEX_ADAPTERS.includes(codexAdapter)) {
  throw new Error(`Invalid codex adapter "${options.codexAdapter}". Valid values: ${VALID_CODEX_ADAPTERS.join(', ')}`);
}

const babelRoot = getBabelRoot(options.root);
const catalogPath = resolve(babelRoot, 'prompt_catalog.yaml');
if (!existsSync(catalogPath)) {
  throw new Error(`prompt_catalog.yaml not found at ${catalogPath}`);
}

const { instructionStack, recommendedTaskOverlayIds, appliedTaskOverlayIds } = buildInstructionStack({
  taskCategory,
  project,
  model,
  pipelineMode,
  codexAdapter,
  requestedSkillIds: options.skillId ?? [],
  requestedTaskOverlayIds: options.taskOverlayId ?? [],
  disableRecommendedTaskOverlays: options.disableRecommendedTaskOverlays,
});
const resolutionPolicy = buildResolutionPolicy();
const preview = previewInstructionStackResolution(
  instructionStack,
  resolutionPolicy,
  babelRoot,
  catalogPath,
);

const promptManifest = (options.absolutePaths
  ? preview.compiledArtifacts.prompt_manifest
  : preview.compiledArtifacts.prompt_manifest.map(filePath => relative(babelRoot, filePath))
).map(toPosixPath);

const orderedEntries = preview.orderedEntries.map(entry => ({
  id: entry.id,
  layer: entry.layer,
  relative_path: toPosixPath(entry.relative_path),
  load_position: entry.load_position,
  token_budget: entry.token_budget,
  order_index: entry.order_index,
  status: entry.status,
  tags: [...entry.tags],
  project: entry.project,
  ...(options.absolutePaths ? { absolute_path: toPosixPath(entry.absolute_path) } : {}),
}));

const output = {
  schema_version: 1,
  selection: {
    task_category: taskCategory,
    project,
    model,
    pipeline_mode: pipelineMode as PipelineMode,
    selected_codex_adapter: model === 'codex' ? codexAdapter : null,
    requested_skill_ids: normalizeUnique(options.skillId ?? []),
    requested_task_overlay_ids: normalizeUnique(options.taskOverlayId ?? []),
    recommended_task_overlay_ids: recommendedTaskOverlayIds,
    applied_task_overlay_ids: appliedTaskOverlayIds,
  },
  instruction_stack: instructionStack,
  resolution_policy: resolutionPolicy,
  compiled_artifacts: {
    ...preview.compiledArtifacts,
    prompt_manifest: promptManifest,
  },
  ordered_entries: orderedEntries,
};

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);


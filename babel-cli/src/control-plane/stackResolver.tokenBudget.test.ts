import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';

import { previewInstructionStackResolution } from './stackResolver.js';
import type { InstructionStack, ResolutionPolicy } from '../schemas/agentContracts.js';

const BABEL_ROOT = join(process.cwd(), '..');
const CATALOG_PATH = join(BABEL_ROOT, 'prompt_catalog.yaml');

const instructionStack: InstructionStack = {
  behavioral_ids: [
    'behavioral_core_v10',
    'behavioral_cognitive_micro_v7',
    'behavioral_guard_v7',
  ],
  domain_id: 'domain_swe_backend',
  skill_ids: [],
  model_adapter_id: 'adapter_codex_balanced',
  project_overlay_id: null,
  task_overlay_ids: [],
  pipeline_stage_ids: ['pipeline_qa_reviewer'],
};

const resolutionPolicy: ResolutionPolicy = {
  apply_domain_default_skills: false,
  expand_skill_dependencies: true,
  strict_conflict_mode: 'error',
  task_shape_profile: 'full',
};

function previewDefaultDomain(domainId: string) {
  return previewInstructionStackResolution(
    {
      ...instructionStack,
      domain_id: domainId,
      skill_ids: [],
    },
    {
      ...resolutionPolicy,
      apply_domain_default_skills: true,
    },
    BABEL_ROOT,
    CATALOG_PATH,
    null,
    null,
    { countActualTokens: true, tokenCountSource: 'runtime' },
  ).compiledArtifacts;
}

function previewExplicitSkill(domainId: string, skillId: string) {
  return previewInstructionStackResolution(
    {
      ...instructionStack,
      domain_id: domainId,
      skill_ids: [skillId],
    },
    {
      ...resolutionPolicy,
      apply_domain_default_skills: false,
    },
    BABEL_ROOT,
    CATALOG_PATH,
    null,
    null,
    { countActualTokens: true, tokenCountSource: 'runtime' },
  ).compiledArtifacts;
}

test('compiled_artifacts include actual token fields when preview counting is enabled', () => {
  const preview = previewInstructionStackResolution(
    instructionStack,
    resolutionPolicy,
    BABEL_ROOT,
    CATALOG_PATH,
    null,
    null,
    { countActualTokens: true, tokenCountSource: 'runtime', driftWarningTolerance: 100 },
  );

  const artifacts = preview.compiledArtifacts;
  assert.equal(typeof artifacts.actual_prompt_tokens, 'number');
  assert.equal(artifacts.actual_prompt_tokens! > 0, true);
  assert.equal(artifacts.token_budget_total >= artifacts.actual_prompt_tokens!, true);
  assert.equal(artifacts.actual_minus_declared, artifacts.actual_prompt_tokens! - artifacts.token_budget_total);
  assert.equal(artifacts.tokenizer_encoding, 'o200k_base');
  assert.equal(artifacts.token_count_source, 'runtime');
  assert.equal(Object.keys(artifacts.actual_token_by_entry).length, artifacts.selected_entry_ids.length);
  assert.equal(artifacts.budget_diagnostics.some(diagnostic => diagnostic.code === 'budget_threshold_severe'), true);
  assert.equal(artifacts.budget_diagnostics.some(diagnostic => /policy source: actual/.test(diagnostic.message)), true);
});

test('compiled_artifacts preserve declared-token fallback when preview counting is disabled', () => {
  const preview = previewInstructionStackResolution(
    instructionStack,
    resolutionPolicy,
    BABEL_ROOT,
    CATALOG_PATH,
  );

  const artifacts = preview.compiledArtifacts;
  assert.equal(artifacts.actual_prompt_tokens, null);
  assert.deepEqual(artifacts.actual_token_by_entry, {});
  assert.equal(artifacts.actual_minus_declared, null);
  assert.equal(artifacts.token_count_source, 'unavailable');
  assert.equal(artifacts.budget_diagnostics.some(diagnostic => /policy source: declared/.test(diagnostic.message)), true);
});

test('heavy specialized skills are no longer loaded by default for trimmed domains', () => {
  const android = previewDefaultDomain('domain_android_kotlin');
  assert.equal(android.selected_entry_ids.includes('skill_jetpack_compose'), true);
  assert.equal(android.selected_entry_ids.includes('skill_android_testing_obligation'), true);
  assert.equal(android.selected_entry_ids.includes('skill_android_test_enforcement_deep'), false);
  assert.equal(android.selected_entry_ids.includes('skill_android_testing_strategy'), false);
  assert.equal(android.selected_entry_ids.includes('skill_android_unit_testing'), false);
  assert.equal(android.selected_entry_ids.includes('skill_android_screenshot_testing'), false);
  assert.equal(android.selected_entry_ids.includes('skill_android_instrumented_testing'), false);
  assert.equal(android.selected_entry_ids.includes('skill_android_accessibility_semantics'), false);
  assert.equal(android.selected_entry_ids.includes('skill_android_adaptive_layouts'), false);
  assert.equal(android.selected_entry_ids.includes('skill_android_form_ux_date_input'), false);

  const llmRouter = previewDefaultDomain('domain_llm_router');
  assert.equal(llmRouter.selected_entry_ids.includes('skill_sse_streaming'), false);
  assert.equal(llmRouter.selected_entry_ids.includes('skill_deno_edge_functions'), false);

  const research = previewDefaultDomain('domain_research');
  assert.equal(research.selected_entry_ids.includes('skill_claim_extraction_ledger'), true);
  assert.equal(research.selected_entry_ids.includes('skill_product_reality_audit'), false);

  const python = previewDefaultDomain('domain_python_backend');
  assert.equal(python.selected_entry_ids.includes('skill_ops_observability'), false);

  const godot = previewDefaultDomain('domain_godot_game_dev');
  assert.equal(godot.selected_entry_ids.includes('skill_godot_gdscript_arch'), true);
  assert.equal(godot.selected_entry_ids.includes('skill_godot_ui_theme'), false);
  assert.equal(godot.selected_entry_ids.includes('skill_godot_data_resources'), false);
});

test('trimmed heavy skills still work when selected explicitly and dependencies expand', () => {
  const androidDeepTestEnforcement = previewExplicitSkill('domain_android_kotlin', 'skill_android_test_enforcement_deep');
  assert.equal(androidDeepTestEnforcement.selected_entry_ids.includes('skill_android_testing_obligation'), true);
  assert.equal(androidDeepTestEnforcement.selected_entry_ids.includes('skill_android_testing_strategy'), true);
  assert.equal(androidDeepTestEnforcement.selected_entry_ids.includes('skill_android_unit_testing'), true);
  assert.equal(androidDeepTestEnforcement.selected_entry_ids.includes('skill_android_screenshot_testing'), true);
  assert.equal(androidDeepTestEnforcement.selected_entry_ids.includes('skill_android_instrumented_testing'), true);
  assert.equal(androidDeepTestEnforcement.selected_entry_ids.includes('skill_android_test_enforcement_deep'), true);

  const androidAccessibility = previewExplicitSkill('domain_android_kotlin', 'skill_android_accessibility_semantics');
  assert.equal(androidAccessibility.selected_entry_ids.includes('skill_android_accessibility_semantics'), true);
  assert.equal(androidAccessibility.selected_entry_ids.includes('skill_jetpack_compose'), true);

  const llmSse = previewExplicitSkill('domain_llm_router', 'skill_sse_streaming');
  assert.equal(llmSse.selected_entry_ids.includes('skill_sse_streaming'), true);
  assert.equal(llmSse.selected_entry_ids.includes('skill_deno_edge_functions'), true);
  assert.equal(llmSse.selected_entry_ids.includes('skill_supabase_pg'), true);
  assert.equal(llmSse.selected_entry_ids.includes('skill_ts_zod'), true);

  const researchReality = previewExplicitSkill('domain_research', 'skill_product_reality_audit');
  assert.equal(researchReality.selected_entry_ids.includes('skill_product_reality_audit'), true);
  assert.equal(researchReality.selected_entry_ids.includes('skill_claim_extraction_ledger'), true);

  const pythonOps = previewExplicitSkill('domain_python_backend', 'skill_ops_observability');
  assert.equal(pythonOps.selected_entry_ids.includes('skill_ops_observability'), true);

  const godotTheme = previewExplicitSkill('domain_godot_game_dev', 'skill_godot_ui_theme');
  assert.equal(godotTheme.selected_entry_ids.includes('skill_godot_ui_theme'), true);
});

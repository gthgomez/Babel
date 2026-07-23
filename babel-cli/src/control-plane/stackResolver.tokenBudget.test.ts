import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';

import { previewInstructionStackResolution } from './stackResolver.js';
import type { InstructionStack, ResolutionPolicy } from '../schemas/agentContracts.js';

const BABEL_ROOT = join(process.cwd(), '..');
const CATALOG_PATH = join(BABEL_ROOT, 'prompt_catalog.yaml');

const instructionStack: InstructionStack = {
  behavioral_ids: ['behavioral_core_v10', 'behavioral_cognitive_micro_v7', 'behavioral_guard_v7'],
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
  // NOTE: token_budget_total may be less than actual_prompt_tokens when catalog
  // token_budget values are outdated relative to file sizes. The declared budgets
  // in prompt_catalog.yaml need independent reconciliation.
  assert.equal(
    artifacts.actual_minus_declared,
    artifacts.actual_prompt_tokens! - artifacts.token_budget_total,
  );
  assert.equal(artifacts.tokenizer_encoding, 'o200k_base');
  assert.equal(artifacts.token_count_source, 'runtime');
  assert.equal(
    Object.keys(artifacts.actual_token_by_entry).length,
    artifacts.selected_entry_ids.length,
  );
  assert.equal(
    artifacts.budget_diagnostics.some(
      (diagnostic) => diagnostic.code === 'budget_threshold_severe',
    ),
    true,
  );
  assert.equal(
    artifacts.budget_diagnostics.some((diagnostic) =>
      /policy source: actual/.test(diagnostic.message),
    ),
    true,
  );
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
  assert.equal(
    artifacts.budget_diagnostics.some((diagnostic) =>
      /policy source: declared/.test(diagnostic.message),
    ),
    true,
  );
});

test('heavy specialized skills are no longer loaded by default for trimmed domains', () => {
  const android = previewDefaultDomain('domain_android_kotlin');
  // Only non-Android-gated skills survive: evidence_gathering and bcdp_contracts
  // have no file_extension_gate, so they load. All .kt-gated skills are filtered
  // because the test runs from babel-cli/ which has no .kt files.
  assert.equal(android.selected_entry_ids.includes('skill_evidence_gathering'), true);
  assert.equal(android.selected_entry_ids.includes('skill_bcdp_contracts'), true);
  assert.equal(android.selected_entry_ids.includes('skill_android_app_classification'), false);
  assert.equal(android.selected_entry_ids.includes('skill_jetpack_compose'), false);
  assert.equal(android.selected_entry_ids.includes('skill_android_test_enforcement'), false);
  assert.equal(android.selected_entry_ids.includes('skill_android_testing_strategy'), false);
  assert.equal(android.selected_entry_ids.includes('skill_android_unit_testing'), false);
  assert.equal(android.selected_entry_ids.includes('skill_android_screenshot_testing'), false);
  assert.equal(android.selected_entry_ids.includes('skill_android_instrumented_testing'), false);
  assert.equal(android.selected_entry_ids.includes('skill_android_accessibility_semantics'), false);
  assert.equal(android.selected_entry_ids.includes('skill_android_adaptive_layouts'), false);
  assert.equal(android.selected_entry_ids.includes('skill_android_form_ux_date_input'), false);

  const llmRouter = previewDefaultDomain('domain_llm_router');
  // skill_sse_streaming is in defaults but gets pruned by budget-aware manifest pruning
  // when the total declared budget (3565) exceeds the default hard limit (3200).
  // skill_deno_edge_functions survives pruning because it is loaded as a dependency
  // of skill_sse_streaming before SSE itself is pruned.
  assert.equal(llmRouter.selected_entry_ids.includes('skill_sse_streaming'), false);
  assert.equal(llmRouter.selected_entry_ids.includes('skill_deno_edge_functions'), true);

  const research = previewDefaultDomain('domain_research');
  assert.equal(research.selected_entry_ids.includes('skill_claim_extraction_ledger'), true);
  assert.equal(research.selected_entry_ids.includes('skill_product_reality_audit'), true);

  const python = previewDefaultDomain('domain_python_backend');
  assert.equal(python.selected_entry_ids.includes('skill_ops_observability'), true);

  const godot = previewDefaultDomain('domain_godot_game_dev');
  // Godot skills have .gd file_extension_gate — filtered because babel-cli has no .gd files
  assert.equal(godot.selected_entry_ids.includes('skill_godot_gdscript_arch'), false);
  assert.equal(godot.selected_entry_ids.includes('skill_godot_ui_theme'), false);
  assert.equal(godot.selected_entry_ids.includes('skill_godot_data_resources'), false);
});

test('trimmed heavy skills still work when selected explicitly and dependencies expand', () => {
  // Skills with file_extension_gate are filtered out when the current project
  // (babel-cli/) has no matching file extensions. Tests here use skills without
  // file extension gates to verify dependency expansion works.

  // Single-level dependency: skill_product_reality_audit -> skill_claim_extraction_ledger
  const researchReality = previewExplicitSkill('domain_research', 'skill_product_reality_audit');
  assert.equal(researchReality.selected_entry_ids.includes('skill_product_reality_audit'), true);
  assert.equal(researchReality.selected_entry_ids.includes('skill_claim_extraction_ledger'), true);

  // Simple explicit selection, no dependencies
  const pythonOps = previewExplicitSkill('domain_python_backend', 'skill_ops_observability');
  assert.equal(pythonOps.selected_entry_ids.includes('skill_ops_observability'), true);

  // Multi-level dependency chain: skill_deno_edge_functions -> skill_supabase_pg -> skill_ts_zod
  const llmDeno = previewExplicitSkill('domain_llm_router', 'skill_deno_edge_functions');
  assert.equal(llmDeno.selected_entry_ids.includes('skill_deno_edge_functions'), true);
  assert.equal(llmDeno.selected_entry_ids.includes('skill_supabase_pg'), true);
  assert.equal(llmDeno.selected_entry_ids.includes('skill_ts_zod'), true);
});

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveInstructionStackManifest } from '../src/compiler.js';
import { OrchestratorManifestSchema } from '../src/schemas/agentContracts.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function makeBasePlatformProfile() {
  return {
    profile_source: 'not_required_for_routing' as const,
    client_surface: 'unspecified' as const,
    container_model: null,
    ingestion_mode: 'none' as const,
    repo_write_mode: null,
    output_surface: [],
    platform_modes: [],
    execution_trust: null,
    data_trust: null,
    freshness_trust: null,
    action_trust: null,
    approval_mode: 'none' as const,
  };
}

function makeTypedManifest(overrides: Partial<ReturnType<typeof OrchestratorManifestSchema.parse>> = {}) {
  return OrchestratorManifestSchema.parse({
    orchestrator_version: '9.0',
    target_project: 'global',
    analysis: {
      task_summary: 'resolver test',
      task_category: 'Backend',
      secondary_category: null,
      task_overlay_ids: [],
      complexity_estimate: 'Medium',
      pipeline_mode: 'verified',
      ambiguity_note: null,
    },
    platform_profile: makeBasePlatformProfile(),
    worker_configuration: {
      assigned_model: 'Codex',
      rationale: 'resolver test',
    },
    compilation_state: 'uncompiled',
    instruction_stack: {
      behavioral_ids: ['behavioral_core_v7', 'behavioral_guard_v7'],
      domain_id: 'domain_swe_backend',
      skill_ids: [],
      model_adapter_id: 'adapter_codex_balanced',
      project_overlay_id: null,
      task_overlay_ids: [],
      pipeline_stage_ids: ['pipeline_qa_reviewer'],
    },
    resolution_policy: {
      apply_domain_default_skills: true,
      expand_skill_dependencies: true,
      strict_conflict_mode: 'error',
    },
    prompt_manifest: [],
    handoff_payload: {
      user_request: 'resolver test',
      system_directive: 'resolver test',
    },
    ...overrides,
  });
}

function writePromptFile(root: string, relativePath: string): void {
  const fullPath = join(root, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, `# ${relativePath}\n`, 'utf-8');
}

function withTempCatalog(
  catalogBody: string,
  run: (root: string) => void,
): void {
  const tempRoot = mkdtempSync(join(tmpdir(), 'babel-resolver-test-'));
  try {
    writeFileSync(join(tempRoot, 'prompt_catalog.yaml'), catalogBody, 'utf-8');
    run(tempRoot);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function expectResolverFailure(
  label: string,
  manifest: ReturnType<typeof makeTypedManifest>,
  babelRoot: string,
  expectedFragment: string,
): void {
  let errorMessage = '';
  try {
    resolveInstructionStackManifest(manifest, babelRoot);
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
  }

  assert(errorMessage.length > 0, `${label}: expected resolver to throw`);
  assert(
    errorMessage.includes(expectedFragment),
    `${label}: expected error to include "${expectedFragment}", got "${errorMessage}"`,
  );
}

function runConflictTest(): void {
  withTempCatalog(`
version: 3
catalog_scope: babel_prompt_library
maintainer: control_plane
root: "TEMP"
entries:
  - id: behavioral_core_v7
    layer: behavioral_os
    path: 01_Behavioral_OS/OLS-v7-Core-Universal.md
    status: active
    load_position: 1
  - id: behavioral_guard_v7
    layer: behavioral_os
    path: 01_Behavioral_OS/OLS-v7-Guard-Auto.md
    status: active
    load_position: 2
  - id: domain_swe_backend
    layer: domain_architect
    path: 02_Domain_Architects/Clean_SWE_Backend-v7.md
    status: active
    load_position: 3
    dependencies: []
    conflicts: []
    token_budget: 250
    default_skill_ids:
      - skill_primary
  - id: skill_primary
    layer: skill
    path: 02_Skills/Lang/Primary.md
    status: active
    dependencies: []
    conflicts:
      - skill_conflicting
    token_budget: 200
  - id: skill_conflicting
    layer: skill
    path: 02_Skills/Lang/Conflicting.md
    status: active
    dependencies: []
    conflicts:
      - skill_primary
    token_budget: 200
  - id: adapter_codex_balanced
    layer: model_adapter
    path: 03_Model_Adapters/Codex_Balanced.md
    status: active
    load_position: 4
  - id: pipeline_qa_reviewer
    layer: pipeline_stage
    path: 02_Domain_Architects/QA_Adversarial_Reviewer-v1.0.md
    status: active
    load_position: 7
`, root => {
    for (const path of [
      '01_Behavioral_OS/OLS-v7-Core-Universal.md',
      '01_Behavioral_OS/OLS-v7-Guard-Auto.md',
      '02_Domain_Architects/Clean_SWE_Backend-v7.md',
      '02_Skills/Lang/Primary.md',
      '02_Skills/Lang/Conflicting.md',
      '03_Model_Adapters/Codex_Balanced.md',
      '02_Domain_Architects/QA_Adversarial_Reviewer-v1.0.md',
    ]) {
      writePromptFile(root, path);
    }

    const manifest = makeTypedManifest({
      instruction_stack: {
        behavioral_ids: ['behavioral_core_v7', 'behavioral_guard_v7'],
        domain_id: 'domain_swe_backend',
        skill_ids: ['skill_conflicting'],
        model_adapter_id: 'adapter_codex_balanced',
        project_overlay_id: null,
        task_overlay_ids: [],
        pipeline_stage_ids: ['pipeline_qa_reviewer'],
      },
    });

    expectResolverFailure(
      'conflict test',
      manifest,
      root,
      'Conflicting catalog ids selected together',
    );
  });
}

function runMissingIdAndWrongLayerTests(): void {
  withTempCatalog(`
version: 3
catalog_scope: babel_prompt_library
maintainer: control_plane
root: "TEMP"
entries:
  - id: behavioral_core_v7
    layer: behavioral_os
    path: 01_Behavioral_OS/OLS-v7-Core-Universal.md
    status: active
    load_position: 1
  - id: behavioral_guard_v7
    layer: behavioral_os
    path: 01_Behavioral_OS/OLS-v7-Guard-Auto.md
    status: active
    load_position: 2
  - id: domain_swe_backend
    layer: domain_architect
    path: 02_Domain_Architects/Clean_SWE_Backend-v7.md
    status: active
    load_position: 3
    dependencies: []
    conflicts: []
    token_budget: 250
    default_skill_ids: []
  - id: adapter_codex_balanced
    layer: model_adapter
    path: 03_Model_Adapters/Codex_Balanced.md
    status: active
    load_position: 4
  - id: pipeline_qa_reviewer
    layer: pipeline_stage
    path: 02_Domain_Architects/QA_Adversarial_Reviewer-v1.0.md
    status: active
    load_position: 7
`, root => {
    for (const path of [
      '01_Behavioral_OS/OLS-v7-Core-Universal.md',
      '01_Behavioral_OS/OLS-v7-Guard-Auto.md',
      '02_Domain_Architects/Clean_SWE_Backend-v7.md',
      '03_Model_Adapters/Codex_Balanced.md',
      '02_Domain_Architects/QA_Adversarial_Reviewer-v1.0.md',
    ]) {
      writePromptFile(root, path);
    }

    expectResolverFailure(
      'missing id test',
      makeTypedManifest({
        instruction_stack: {
          behavioral_ids: ['behavioral_core_v7', 'behavioral_guard_v7'],
          domain_id: 'domain_swe_backend',
          skill_ids: ['skill_missing'],
          model_adapter_id: 'adapter_codex_balanced',
          project_overlay_id: null,
          task_overlay_ids: [],
          pipeline_stage_ids: ['pipeline_qa_reviewer'],
        },
      }),
      root,
      'Unknown catalog id: skill_missing',
    );

    expectResolverFailure(
      'wrong layer test',
      makeTypedManifest({
        instruction_stack: {
          behavioral_ids: ['behavioral_core_v7', 'behavioral_guard_v7'],
          domain_id: 'adapter_codex_balanced',
          skill_ids: [],
          model_adapter_id: 'adapter_codex_balanced',
          project_overlay_id: null,
          task_overlay_ids: [],
          pipeline_stage_ids: ['pipeline_qa_reviewer'],
        },
      }),
      root,
      'has layer "model_adapter" but "domain_architect" was required',
    );
  });
}

function runTokenBudgetFoundationTest(): void {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const babelRoot = resolve(scriptDir, '..', '..');
  const compiled = OrchestratorManifestSchema.parse(
    resolveInstructionStackManifest(makeTypedManifest({
      target_project: 'example_saas_backend',
      target_project_path: process.env['BABEL_PROJECT_ROOT'] ?? process.cwd(),
      instruction_stack: {
        behavioral_ids: ['behavioral_core_v7', 'behavioral_guard_v7'],
        domain_id: 'domain_swe_backend',
        skill_ids: [],
        model_adapter_id: 'adapter_codex_balanced',
        project_overlay_id: 'overlay_example_saas_backend',
        task_overlay_ids: [],
        pipeline_stage_ids: ['pipeline_qa_reviewer'],
      },
    }), babelRoot),
  );

  const catalogText = readFileSync(join(babelRoot, 'prompt_catalog.yaml'), 'utf-8');
  const requiredBudgetIds = [
    'domain_swe_backend',
    'skill_ts_zod',
    'skill_supabase_pg',
  ];

  for (const id of requiredBudgetIds) {
    const pattern = new RegExp(`- id:\\s+${id}[\\s\\S]*?token_budget:\\s+\\d+`, 'm');
    assert(
      pattern.test(catalogText),
      `token budget foundation test: expected token_budget metadata for ${id}`,
    );
  }

  assert(
    compiled.compiled_artifacts?.selected_entry_ids.includes('skill_ts_zod') &&
    compiled.compiled_artifacts?.selected_entry_ids.includes('skill_supabase_pg'),
    'token budget foundation test: expected backend skill bundle to resolve before future budget enforcement',
  );
}

function main(): void {
  runConflictTest();
  runMissingIdAndWrongLayerTests();
  runTokenBudgetFoundationTest();
  console.log('resolver regression tests passed');
}

main();

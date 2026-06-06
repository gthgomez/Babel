import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveInstructionStackManifest } from '../src/compiler.js';
import { EXECUTOR_PATHS, getOrchestratorPaths, QA_PATHS } from '../src/pipeline/paths.js';
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
  const { analysis: analysisOverrides, ...manifestOverrides } = overrides;

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
      purpose_mode: 'execution',
      purpose_source: 'fallback_default',
      purpose_confidence: 0.7,
      ambiguity_note: null,
      ...(analysisOverrides ?? {}),
    },
    platform_profile: makeBasePlatformProfile(),
    worker_configuration: {
      assigned_model: 'qwen3',
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
    ...manifestOverrides,
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

function runCatalogAliasTests(): void {
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
  - id: domain_android_kotlin
    layer: domain_architect
    path: 02_Domain_Architects/Android_Kotlin-v1.md
    status: active
    load_position: 3
    dependencies: []
    conflicts: []
    token_budget: 250
    default_skill_ids: []
  - id: skill_unix_shell
    layer: skill
    path: 02_Skills/Framework/Unix-Shell-v1.md
    status: active
    token_budget: 100
  - id: skill_nodejs_cli
    layer: skill
    path: 02_Skills/Framework/NodeJS-CLI-v1.md
    status: active
    token_budget: 100
  - id: skill_python_backend
    layer: skill
    path: 02_Skills/Lang/Python-Backend-v1.md
    status: active
    token_budget: 100
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
      '02_Domain_Architects/Android_Kotlin-v1.md',
      '02_Skills/Framework/Unix-Shell-v1.md',
      '02_Skills/Framework/NodeJS-CLI-v1.md',
      '02_Skills/Lang/Python-Backend-v1.md',
      '03_Model_Adapters/Codex_Balanced.md',
      '02_Domain_Architects/QA_Adversarial_Reviewer-v1.0.md',
    ]) {
      writePromptFile(root, path);
    }

    const manifest = resolveInstructionStackManifest(makeTypedManifest({
      instruction_stack: {
        behavioral_ids: ['behavioral_core_v7', 'behavioral_guard_v7'],
        domain_id: 'domain_mobile_suite',
        skill_ids: ['skill_git_operations', 'skill_cli_tooling', 'skill_python_scripting'],
        model_adapter_id: 'adapter_codex_balanced',
        project_overlay_id: null,
        task_overlay_ids: [],
        pipeline_stage_ids: ['pipeline_qa_reviewer'],
      },
    }), root);

    assert(
      manifest.instruction_stack?.domain_id === 'domain_android_kotlin',
      'catalog alias test: expected domain_mobile_suite to normalize to domain_android_kotlin',
    );
    for (const expectedSkill of ['skill_unix_shell', 'skill_nodejs_cli', 'skill_python_backend']) {
      assert(
        manifest.compiled_artifacts?.selected_entry_ids.includes(expectedSkill),
        `catalog alias test: expected ${expectedSkill} to compile through aliases`,
      );
    }
  });
}

function runOverlayNormalizationTests(): void {
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
  - id: domain_swe_frontend
    layer: domain_architect
    path: 02_Domain_Architects/Clean_SWE_Frontend-v6.md
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
  - id: overlay_example_web_audit
    layer: project_overlay
    path: 05_Project_Overlays/Example-Web-Audit-Context.md
    status: active
    load_position: 5
  - id: overlay_example_mobile_finance
    layer: project_overlay
    path: 05_Project_Overlays/Example-Mobile-Finance-Context.md
    project: example_mobile_finance
    status: active
    load_position: 5
  - id: task_frontend_professionalism
    layer: task_overlay
    path: 06_Task_Overlays/Frontend-Professionalism-v1.0.md
    status: active
    load_position: 6
  - id: pipeline_qa_reviewer
    layer: pipeline_stage
    path: 02_Domain_Architects/QA_Adversarial_Reviewer-v1.0.md
    status: active
    load_position: 7
`, root => {
    for (const path of [
      '01_Behavioral_OS/OLS-v7-Core-Universal.md',
      '01_Behavioral_OS/OLS-v7-Guard-Auto.md',
      '02_Domain_Architects/Clean_SWE_Frontend-v6.md',
      '03_Model_Adapters/Codex_Balanced.md',
      '05_Project_Overlays/Example-Web-Audit-Context.md',
      '05_Project_Overlays/Example-Mobile-Finance-Context.md',
      '06_Task_Overlays/Frontend-Professionalism-v1.0.md',
      '02_Domain_Architects/QA_Adversarial_Reviewer-v1.0.md',
    ]) {
      writePromptFile(root, path);
    }

    const wrongSlotManifest = resolveInstructionStackManifest(makeTypedManifest({
      instruction_stack: {
        behavioral_ids: ['behavioral_core_v7', 'behavioral_guard_v7'],
        domain_id: 'domain_swe_frontend',
        skill_ids: [],
        model_adapter_id: 'adapter_codex_balanced',
        project_overlay_id: 'task_frontend_professionalism',
        task_overlay_ids: [],
        pipeline_stage_ids: ['pipeline_qa_reviewer'],
      },
    }), root);

    assert(
      wrongSlotManifest.instruction_stack?.project_overlay_id === null,
      'wrong-slot overlay test: expected project_overlay_id to be cleared',
    );
    assert(
      wrongSlotManifest.instruction_stack?.task_overlay_ids.includes('task_frontend_professionalism'),
      'wrong-slot overlay test: expected task overlay to be moved into task_overlay_ids',
    );
    assert(
      wrongSlotManifest.compiled_artifacts?.selected_entry_ids.includes('task_frontend_professionalism'),
      'wrong-slot overlay test: expected moved task overlay to compile successfully',
    );

    const hallucinatedCompositeManifest = resolveInstructionStackManifest(makeTypedManifest({
      instruction_stack: {
        behavioral_ids: ['behavioral_core_v7', 'behavioral_guard_v7'],
        domain_id: 'domain_swe_frontend',
        skill_ids: [],
        model_adapter_id: 'adapter_codex_balanced',
        project_overlay_id: 'overlay_example_web_audit_frontend_professionalism',
        task_overlay_ids: [],
        pipeline_stage_ids: ['pipeline_qa_reviewer'],
      },
    }), root);

    assert(
      hallucinatedCompositeManifest.instruction_stack?.project_overlay_id === 'overlay_example_web_audit',
      'hallucinated composite overlay test: expected project overlay to normalize to overlay_example_web_audit',
    );
    assert(
      hallucinatedCompositeManifest.instruction_stack?.task_overlay_ids.includes('task_frontend_professionalism'),
      'hallucinated composite overlay test: expected frontend professionalism task overlay to be injected',
    );
    assert(
      hallucinatedCompositeManifest.compiled_artifacts?.selected_entry_ids.includes('overlay_example_web_audit') &&
      hallucinatedCompositeManifest.compiled_artifacts?.selected_entry_ids.includes('task_frontend_professionalism'),
      'hallucinated composite overlay test: expected normalized project/task overlays to compile successfully',
    );

    const unknownProjectOverlayManifest = resolveInstructionStackManifest(makeTypedManifest({
      target_project: 'example_mobile_finance',
      instruction_stack: {
        behavioral_ids: ['behavioral_core_v7', 'behavioral_guard_v7'],
        domain_id: 'domain_swe_frontend',
        skill_ids: [],
        model_adapter_id: 'adapter_codex_balanced',
        project_overlay_id: 'global',
        task_overlay_ids: [],
        pipeline_stage_ids: ['pipeline_qa_reviewer'],
      },
    }), root);

    assert(
      unknownProjectOverlayManifest.instruction_stack?.project_overlay_id === 'overlay_example_mobile_finance',
      'unknown project overlay test: expected target project overlay to replace unknown project_overlay_id',
    );
    assert(
      unknownProjectOverlayManifest.compiled_artifacts?.selected_entry_ids.includes('overlay_example_mobile_finance'),
      'unknown project overlay test: expected corrected project overlay to compile successfully',
    );
  });
}

function runProjectScopedOverlayConsistencyTests(): void {
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
  - id: domain_swe_frontend
    layer: domain_architect
    path: 02_Domain_Architects/Clean_SWE_Frontend-v6.md
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
  - id: overlay_example_web_audit
    layer: project_overlay
    path: 05_Project_Overlays/Example-Web-Audit-Context.md
    status: active
    load_position: 5
    project: example_web_audit
  - id: overlay_example_saas_backend
    layer: project_overlay
    path: 05_Project_Overlays/Example-SaaS-Backend-Context.md
    status: active
    load_position: 5
    project: example_saas_backend
  - id: task_frontend_professionalism
    layer: task_overlay
    path: 06_Task_Overlays/Frontend-Professionalism-v1.0.md
    status: active
    load_position: 6
  - id: task_example_saas_backend_frontend_professionalism
    layer: task_overlay
    path: 06_Task_Overlays/Example-SaaS-Backend-Frontend-Professionalism-v1.0.md
    status: active
    load_position: 6
    project: example_saas_backend
  - id: pipeline_qa_reviewer
    layer: pipeline_stage
    path: 02_Domain_Architects/QA_Adversarial_Reviewer-v1.0.md
    status: active
    load_position: 7
`, root => {
    for (const path of [
      '01_Behavioral_OS/OLS-v7-Core-Universal.md',
      '01_Behavioral_OS/OLS-v7-Guard-Auto.md',
      '02_Domain_Architects/Clean_SWE_Frontend-v6.md',
      '03_Model_Adapters/Codex_Balanced.md',
      '05_Project_Overlays/Example-Web-Audit-Context.md',
      '05_Project_Overlays/Example-SaaS-Backend-Context.md',
      '06_Task_Overlays/Frontend-Professionalism-v1.0.md',
      '06_Task_Overlays/Example-SaaS-Backend-Frontend-Professionalism-v1.0.md',
      '02_Domain_Architects/QA_Adversarial_Reviewer-v1.0.md',
    ]) {
      writePromptFile(root, path);
    }

    const mismatchedProjectTaskOverlayManifest = resolveInstructionStackManifest(makeTypedManifest({
      target_project: 'example_web_audit',
      instruction_stack: {
        behavioral_ids: ['behavioral_core_v7', 'behavioral_guard_v7'],
        domain_id: 'domain_swe_frontend',
        skill_ids: [],
        model_adapter_id: 'adapter_codex_balanced',
        project_overlay_id: null,
        task_overlay_ids: ['task_example_saas_backend_frontend_professionalism'],
        pipeline_stage_ids: ['pipeline_qa_reviewer'],
      },
    }), root);

    assert(
      mismatchedProjectTaskOverlayManifest.instruction_stack?.project_overlay_id === 'overlay_example_web_audit',
      'project-scoped overlay test: expected missing project overlay to be inferred from target_project',
    );
    assert(
      JSON.stringify(mismatchedProjectTaskOverlayManifest.instruction_stack?.task_overlay_ids ?? []) ===
      JSON.stringify(['task_frontend_professionalism']),
      'project-scoped overlay test: expected example_saas_backend-specific frontend overlay to fall back to generic frontend overlay for example_web_audit',
    );
    assert(
      mismatchedProjectTaskOverlayManifest.compiled_artifacts?.selected_entry_ids.includes('overlay_example_web_audit') &&
      mismatchedProjectTaskOverlayManifest.compiled_artifacts?.selected_entry_ids.includes('task_frontend_professionalism') &&
      !mismatchedProjectTaskOverlayManifest.compiled_artifacts?.selected_entry_ids.includes('task_example_saas_backend_frontend_professionalism'),
      'project-scoped overlay test: expected compiled stack to exclude the mismatched example_saas_backend-specific overlay',
    );
  });
}

function runHallucinatedProjectSlugFallbackTests(): void {
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
  - id: domain_swe_frontend
    layer: domain_architect
    path: 02_Domain_Architects/Clean_SWE_Frontend-v6.md
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
  - id: overlay_example_web_audit
    layer: project_overlay
    path: 05_Project_Overlays/Example-Web-Audit-Context.md
    status: active
    load_position: 5
    project: example_web_audit
  - id: task_frontend_professionalism
    layer: task_overlay
    path: 06_Task_Overlays/Frontend-Professionalism-v1.0.md
    status: active
    load_position: 6
  - id: pipeline_qa_reviewer
    layer: pipeline_stage
    path: 02_Domain_Architects/QA_Adversarial_Reviewer-v1.0.md
    status: active
    load_position: 7
`, root => {
    for (const path of [
      '01_Behavioral_OS/OLS-v7-Core-Universal.md',
      '01_Behavioral_OS/OLS-v7-Guard-Auto.md',
      '02_Domain_Architects/Clean_SWE_Frontend-v6.md',
      '03_Model_Adapters/Codex_Balanced.md',
      '05_Project_Overlays/Example-Web-Audit-Context.md',
      '06_Task_Overlays/Frontend-Professionalism-v1.0.md',
      '02_Domain_Architects/QA_Adversarial_Reviewer-v1.0.md',
    ]) {
      writePromptFile(root, path);
    }

    const hallucinatedSlugManifest = resolveInstructionStackManifest(makeTypedManifest({
      target_project: 'example_web_audit',
      instruction_stack: {
        behavioral_ids: ['behavioral_core_v7', 'behavioral_guard_v7'],
        domain_id: 'domain_swe_frontend',
        skill_ids: [],
        model_adapter_id: 'adapter_codex_balanced',
        project_overlay_id: null,
        task_overlay_ids: ['overlay_audiguard_frontend_professionalism'],
        pipeline_stage_ids: ['pipeline_qa_reviewer'],
      },
    }), root);

    assert(
      hallucinatedSlugManifest.instruction_stack?.project_overlay_id === 'overlay_example_web_audit',
      'hallucinated project slug fallback test: expected target project overlay to be recovered from target_project',
    );
    assert(
      JSON.stringify(hallucinatedSlugManifest.instruction_stack?.task_overlay_ids ?? []) ===
      JSON.stringify(['task_frontend_professionalism']),
      'hallucinated project slug fallback test: expected generic frontend professionalism overlay to be injected',
    );
    assert(
      hallucinatedSlugManifest.compiled_artifacts?.selected_entry_ids.includes('overlay_example_web_audit') &&
      hallucinatedSlugManifest.compiled_artifacts?.selected_entry_ids.includes('task_frontend_professionalism'),
      'hallucinated project slug fallback test: expected normalized overlays to compile successfully',
    );
  });
}

function runTokenBudgetFoundationTest(): void {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const babelRoot = resolve(scriptDir, '..', '..');
  const compiled = OrchestratorManifestSchema.parse(
    resolveInstructionStackManifest(makeTypedManifest({
      target_project: 'global',
      target_project_path: process.env['BABEL_PROJECT_ROOT'] ?? process.cwd(),
      instruction_stack: {
        behavioral_ids: ['behavioral_core_v7', 'behavioral_guard_v7'],
        domain_id: 'domain_swe_backend',
        skill_ids: [],
        model_adapter_id: 'adapter_codex_balanced',
        project_overlay_id: null,
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

function entryBlock(catalogText: string, id: string): string {
  const lines = catalogText.split(/\r?\n/);
  const start = lines.findIndex(line => line.trim() === `- id: ${id}`);
  assert(start >= 0, `catalog alignment test: expected catalog entry ${id}`);

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index++) {
    const trimmed = lines[index]!.trim();
    if (trimmed.startsWith('- id: ') || trimmed.startsWith('#')) {
      end = index;
      break;
    }
  }

  return lines.slice(start, end).join('\n');
}

function assertEntryField(catalogText: string, id: string, field: string, expected: string): void {
  const block = entryBlock(catalogText, id);
  const expectedLine = `${field}: ${expected}`;
  assert(
    block.split('\n').some(line => line.trim() === expectedLine),
    `catalog alignment test: expected ${id}.${field} = ${expected}`,
  );
}

function runCanonicalLoadOrderTest(): void {
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
    load_position: 3
  - id: domain_swe_frontend
    layer: domain_architect
    path: 02_Domain_Architects/Clean_SWE_Frontend-v6.md
    status: active
    load_position: 4
    dependencies: []
    conflicts: []
    default_skill_ids: []
  - id: skill_ui
    layer: skill
    path: 02_Skills/UI/A11y-Design-v1.md
    status: active
    load_position: 5
    dependencies: []
    conflicts: []
  - id: overlay_example_web_audit
    layer: project_overlay
    path: 05_Project_Overlays/Example-Web-Audit-Context.md
    status: active
    load_position: 6
  - id: task_frontend_professionalism
    layer: task_overlay
    path: 06_Task_Overlays/Frontend-Professionalism-v1.0.md
    status: active
    load_position: 7
  - id: adapter_codex_balanced
    layer: model_adapter
    path: 03_Model_Adapters/Codex_Balanced.md
    status: active
    load_position: 8
  - id: pipeline_qa_reviewer
    layer: pipeline_stage
    path: 02_Domain_Architects/QA_Adversarial_Reviewer-v1.0.md
    status: active
    load_position: 9
`, root => {
    for (const path of [
      '01_Behavioral_OS/OLS-v7-Core-Universal.md',
      '01_Behavioral_OS/OLS-v7-Guard-Auto.md',
      '02_Domain_Architects/Clean_SWE_Frontend-v6.md',
      '02_Skills/UI/A11y-Design-v1.md',
      '05_Project_Overlays/Example-Web-Audit-Context.md',
      '06_Task_Overlays/Frontend-Professionalism-v1.0.md',
      '03_Model_Adapters/Codex_Balanced.md',
      '02_Domain_Architects/QA_Adversarial_Reviewer-v1.0.md',
    ]) {
      writePromptFile(root, path);
    }

    const manifest = resolveInstructionStackManifest(makeTypedManifest({
      instruction_stack: {
        behavioral_ids: ['behavioral_core_v7', 'behavioral_guard_v7'],
        domain_id: 'domain_swe_frontend',
        skill_ids: ['skill_ui'],
        model_adapter_id: 'adapter_codex_balanced',
        project_overlay_id: 'overlay_example_web_audit',
        task_overlay_ids: ['task_frontend_professionalism'],
        pipeline_stage_ids: ['pipeline_qa_reviewer'],
      },
    }), root);

    assert(
      JSON.stringify(manifest.compiled_artifacts?.selected_entry_ids ?? []) === JSON.stringify([
        'behavioral_core_v7',
        'behavioral_guard_v7',
        'domain_swe_frontend',
        'skill_ui',
        'overlay_example_web_audit',
        'task_frontend_professionalism',
        'adapter_codex_balanced',
        'pipeline_qa_reviewer',
      ]),
      'canonical load order test: expected model adapter after project/task overlays and before pipeline stages',
    );
  });
}

function runCatalogRuntimeAlignmentTest(): void {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const babelRoot = resolve(scriptDir, '..', '..');
  const catalogText = readFileSync(join(babelRoot, 'prompt_catalog.yaml'), 'utf-8');

  for (const [constantName, runtimePaths] of [
    ['ORCHESTRATOR_PATHS_V9', getOrchestratorPaths('v9')],
    ['QA_PATHS', QA_PATHS],
    ['EXECUTOR_PATHS', EXECUTOR_PATHS],
  ] as const) {
    assert(
      runtimePaths.includes('01_Behavioral_OS/OLS-v7-Cognitive-Micro.md'),
      `catalog/runtime alignment test: expected ${constantName} to load cognitive micro`,
    );
  }

  for (const id of ['pipeline_qa_reviewer', 'pipeline_cli_executor']) {
    assertEntryField(catalogText, id, 'selection_scope', 'stage_only');
  }

  for (const [id, position] of [
    ['domain_swe_backend', '4'],
    ['skill_adaptive_depth', '5'],
    ['overlay_example_web_audit', '6'],
    ['task_frontend_professionalism', '7'],
    ['adapter_codex_balanced', '8'],
    ['pipeline_qa_reviewer', '9'],
    ['pipeline_cli_executor', '10'],
  ] as const) {
    assertEntryField(catalogText, id, 'load_position', position);
  }

  for (const id of ['adapter_codex', 'adapter_codex_balanced']) {
    const tagsLine = /tags:\s+\[(.+)\]/.exec(entryBlock(catalogText, id))?.[1] ?? '';
    assert(
      !/\b(openai|codex)\b/i.test(tagsLine),
      `catalog/runtime alignment test: ${id} tags must not imply OpenAI Codex behavior`,
    );
  }

  for (const path of [
    '01_Behavioral_OS/OLS-v9-Parity-Audit-Overlay.md',
    '04_Meta_Tools/Babel-Standards-Review-Prompt-v1.md',
    '06_Task_Overlays/README.md',
  ]) {
    assert(
      catalogText.includes(`path: ${path}`),
      `catalog/runtime alignment test: expected formerly uncatalogued file ${path}`,
    );
  }
}

function main(): void {
  runConflictTest();
  runMissingIdAndWrongLayerTests();
  runCatalogAliasTests();
  runOverlayNormalizationTests();
  runProjectScopedOverlayConsistencyTests();
  runHallucinatedProjectSlugFallbackTests();
  runTokenBudgetFoundationTest();
  runCanonicalLoadOrderTest();
  runCatalogRuntimeAlignmentTest();
  console.log('resolver regression tests passed');
}

main();

import { OrchestratorManifestSchema, SwePlanSchema } from '../src/schemas/agentContracts.js';
import { collectAndroidVerificationCoverageViolations } from '../src/pipeline.js';
import { maybeApplyManifestTaskShapeProfile } from '../src/stages/taskShape.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function buildManifest() {
  return OrchestratorManifestSchema.parse({
    orchestrator_version: '9.0',
    target_project: 'example_mobile_finance',
    analysis: {
      task_summary: 'warning cleanup regression',
      task_category: 'Mobile',
      secondary_category: null,
      task_overlay_ids: [],
      complexity_estimate: 'Medium',
      pipeline_mode: 'autonomous',
      purpose_mode: 'execution',
      purpose_source: 'fallback_default',
      purpose_confidence: 0.7,
      ambiguity_note: null,
    },
    platform_profile: {
      profile_source: 'explicit_user_request',
      client_surface: 'unspecified',
      container_model: null,
      ingestion_mode: 'repo_live_query',
      repo_write_mode: 'limited_write_surfaces',
      output_surface: ['project_share'],
      platform_modes: [],
      execution_trust: 'high',
      data_trust: 'high',
      freshness_trust: 'high',
      action_trust: 'high',
      approval_mode: 'takeover_or_confirmation',
    },
    worker_configuration: {
      assigned_model: 'qwen3',
      rationale: 'warning cleanup regression',
    },
    compilation_state: 'compiled',
    instruction_stack: {
      behavioral_ids: ['behavioral_core_v7', 'behavioral_guard_v7'],
      domain_id: 'domain_android_kotlin',
      skill_ids: ['skill_android_app_bundle', 'skill_android_release_build'],
      model_adapter_id: 'adapter_codex_balanced',
      project_overlay_id: 'overlay_example_mobile_finance',
      task_overlay_ids: [],
      pipeline_stage_ids: ['pipeline_qa_reviewer', 'pipeline_cli_executor'],
    },
    resolution_policy: {
      apply_domain_default_skills: true,
      expand_skill_dependencies: true,
      strict_conflict_mode: 'error',
      task_shape_profile: 'full',
    },
    prompt_manifest: ['C:\\Workspace\\private source repo\\BABEL_BIBLE.md'],
    compiled_artifacts: {
      selected_entry_ids: ['behavioral_core_v7'],
      prompt_manifest: ['C:\\Workspace\\private source repo\\BABEL_BIBLE.md'],
      token_budget_total: 1,
      token_budget_missing: [],
      token_budget_by_entry: { behavioral_core_v7: 1 },
      warnings: [],
    },
    handoff_payload: {
      user_request: [
        'Warning cleanup only for the Example Finance Forecast Android port in C:\\Workspace\\Example-Mobile-Finance.',
        'Fix these compiler warnings without changing behavior, using the exact files and exact paths:',
        'C:\\Workspace\\Example-Mobile-Finance\\app\\src\\main\\java\\com\\example\\app\\MainActivity.kt,',
        'C:\\Workspace\\Example-Mobile-Finance\\app\\src\\main\\java\\com\\example\\app\\data\\AppDatabase.kt,',
        'C:\\Workspace\\Example-Mobile-Finance\\app\\src\\main\\java\\com\\example\\app\\domain\\DomainRules.kt,',
        'and C:\\Workspace\\Example-Mobile-Finance\\app\\src\\main\\java\\com\\example\\app\\ui\\AddTransactionScreen.kt.',
      ].join(' '),
      system_directive: 'Resolve instruction_stack against prompt_catalog.yaml, expand dependencies, compile prompt_manifest, then load the compiled files in order.',
    },
  });
}

async function main(): Promise<void> {
  const manifest = buildManifest();
  const task = manifest.handoff_payload.user_request;
  const profileResult = maybeApplyManifestTaskShapeProfile(manifest, task);

  assert(profileResult.applied, 'expected warning-cleanup task shape to apply');
  assert(
    profileResult.manifest.resolution_policy.task_shape_profile === 'android_warning_cleanup',
    'expected warning-cleanup task shape profile',
  );

  const plan = SwePlanSchema.parse({
    plan_version: '1.0',
    plan_type: 'IMPLEMENTATION_PLAN',
    task_summary: 'OBJECTIVE: Clean up Android compiler warnings.',
    thinking: 'Bounded Android warning-cleanup task with explicit compile and test verification.',
    known_facts: ['The requested Android files exist.'],
    assumptions: ['The cleanup will preserve behavior.'],
    risks: [],
    minimal_action_set: [
      { step: 1, description: 'Update MainActivity.', tool: 'file_write', target: 'app/src/main/java/com/example/app/MainActivity.kt', rationale: 'Fix the icon deprecation.', reversible: true, verification: 'The file compiles.' },
      { step: 2, description: 'Update AppDatabase.', tool: 'file_write', target: 'app/src/main/java/com/example/app/data/AppDatabase.kt', rationale: 'Rename the migration parameter.', reversible: true, verification: 'The file compiles.' },
      { step: 3, description: 'Update DomainRules.', tool: 'file_write', target: 'app/src/main/java/com/example/app/domain/DomainRules.kt', rationale: 'Silence the unused parameter warning.', reversible: true, verification: 'The file compiles.' },
      { step: 4, description: 'Update AddTransactionScreen.', tool: 'file_write', target: 'app/src/main/java/com/example/app/ui/AddTransactionScreen.kt', rationale: 'Use the newer anchor API.', reversible: true, verification: 'The file compiles.' },
      { step: 9, description: 'Verify debug build.', tool: 'shell_exec', target: 'gradlew assembleDebug', rationale: 'Confirm the cleanup compiles.', reversible: true, verification: 'Build succeeds.' },
      { step: 10, description: 'Verify tests.', tool: 'test_run', target: 'gradlew test', rationale: 'Confirm the cleanup keeps tests green.', reversible: true, verification: 'Tests succeed.' },
    ],
    root_cause: 'N/A — warning cleanup',
    out_of_scope: [],
  });

  const acceptReject = collectAndroidVerificationCoverageViolations(
    plan,
    profileResult.manifest,
  );
  assert(acceptReject === null, 'expected warning-cleanup profile to allow later verification steps');

  const strictReject = collectAndroidVerificationCoverageViolations(
    plan,
    {
      ...profileResult.manifest,
      resolution_policy: {
        ...profileResult.manifest.resolution_policy,
        task_shape_profile: 'full',
      },
    },
  );
  assert(strictReject !== null, 'expected the same plan to be rejected without the warning-cleanup profile');

  console.log('android warning cleanup regression test passed');
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

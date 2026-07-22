import { collectKnownScriptVerificationViolations } from '../src/pipeline.js';
import { OrchestratorManifestSchema, SwePlanSchema } from '../src/schemas/agentContracts.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function makeManifest() {
  return OrchestratorManifestSchema.parse({
    orchestrator_version: '9.0',
    target_project: 'example_web_audit',
    target_project_path: 'C:\\Repos\\project_family\\example_web_audit',
    analysis: {
      task_summary: 'known script verification regression',
      task_category: 'Frontend',
      secondary_category: null,
      task_overlay_ids: [],
      complexity_estimate: 'Medium',
      pipeline_mode: 'autonomous',
      ambiguity_note: null,
    },
    platform_profile: {
      profile_source: 'not_required_for_routing',
      client_surface: 'unspecified',
      container_model: null,
      ingestion_mode: 'none',
      repo_write_mode: null,
      output_surface: [],
      platform_modes: [],
      execution_trust: null,
      data_trust: null,
      freshness_trust: null,
      action_trust: null,
      approval_mode: 'none',
    },
    worker_configuration: {
      assigned_model: 'Codex',
      rationale: 'known script verification regression',
    },
    compilation_state: 'uncompiled',
    instruction_stack: {
      behavioral_ids: ['behavioral_core_v7', 'behavioral_guard_v7'],
      domain_id: 'domain_swe_frontend',
      skill_ids: [],
      model_adapter_id: 'adapter_codex_balanced',
      project_overlay_id: 'overlay_example_web_audit',
      task_overlay_ids: ['task_frontend_professionalism'],
      pipeline_stage_ids: ['pipeline_qa_reviewer', 'pipeline_cli_executor'],
    },
    resolution_policy: {
      apply_domain_default_skills: true,
      expand_skill_dependencies: true,
      strict_conflict_mode: 'error',
    },
    prompt_manifest: [],
    handoff_payload: {
      user_request: 'known script verification regression',
      system_directive: 'known script verification regression',
    },
  });
}

async function main(): Promise<void> {
  const manifest = makeManifest();

  const invalidPlan = SwePlanSchema.parse({
    plan_version: '1.0',
    plan_type: 'IMPLEMENTATION_PLAN',
    task_summary: 'OBJECTIVE: Verify scripts.',
    known_facts: ['example_web_audit frontend package.json exposes the available npm scripts.'],
    assumptions: [],
    risks: [],
    minimal_action_set: [
      {
        step: 1,
        description: 'Run accessibility verification.',
        tool: 'test_run',
        target: 'npm run test:accessibility',
        rationale: 'Verify accessibility.',
        reversible: false,
        verification: 'Script passes.',
      },
    ],
    root_cause: 'N/A',
    out_of_scope: [],
  });

  const invalidReject = collectKnownScriptVerificationViolations(invalidPlan, manifest);
  assert(invalidReject !== null, 'expected rejection for nonexistent npm run script');
  assert(
    invalidReject.failures[0]?.condition.includes('test:accessibility'),
    'expected rejection to mention the nonexistent script name',
  );

  const validPlan = SwePlanSchema.parse({
    plan_version: '1.0',
    plan_type: 'IMPLEMENTATION_PLAN',
    task_summary: 'OBJECTIVE: Verify scripts.',
    known_facts: ['example_web_audit frontend package.json exposes the available npm scripts.'],
    assumptions: [],
    risks: [],
    minimal_action_set: [
      {
        step: 1,
        description: 'Run lint verification.',
        tool: 'test_run',
        target: 'npm run lint',
        rationale: 'Verify frontend code quality.',
        reversible: false,
        verification: 'Lint passes.',
      },
    ],
    root_cause: 'N/A',
    out_of_scope: [],
  });

  const validReject = collectKnownScriptVerificationViolations(validPlan, manifest);
  assert(validReject === null, 'expected no rejection for grounded npm script');

  const longRunningPlan = SwePlanSchema.parse({
    plan_version: '1.0',
    plan_type: 'IMPLEMENTATION_PLAN',
    task_summary: 'OBJECTIVE: Verify scripts.',
    known_facts: ['example_web_audit frontend package.json exposes the available npm scripts.'],
    assumptions: [],
    risks: [],
    minimal_action_set: [
      {
        step: 1,
        description: 'Run the dev server.',
        tool: 'shell_exec',
        target: 'npm run dev',
        rationale: 'Inspect the current UI manually.',
        reversible: true,
        verification: 'The dev server starts.',
      },
    ],
    root_cause: 'N/A',
    out_of_scope: [],
  });

  const longRunningReject = collectKnownScriptVerificationViolations(longRunningPlan, manifest);
  assert(longRunningReject !== null, 'expected rejection for long-running npm verification script');
  assert(
    longRunningReject.failures[0]?.condition.includes('long-running'),
    'expected rejection to explain that the npm script is long-running',
  );

  console.log('known script verification regression test passed');
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

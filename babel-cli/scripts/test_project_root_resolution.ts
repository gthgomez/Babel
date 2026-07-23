import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  inferProjectRoot,
  normalizeManifestProjectRoot,
  readSessionStartProjectPath,
  resolveConcreteProjectRoot,
} from '../src/pipeline.js';
import { OrchestratorManifestSchema } from '../src/schemas/agentContracts.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function makeManifest(targetProjectPath?: string) {
  return OrchestratorManifestSchema.parse({
    orchestrator_version: '9.0',
    target_project: 'AuditGuard',
    ...(targetProjectPath !== undefined ? { target_project_path: targetProjectPath } : {}),
    analysis: {
      task_summary: 'project root normalization regression',
      task_category: 'Frontend',
      secondary_category: null,
      task_overlay_ids: [],
      complexity_estimate: 'Medium',
      pipeline_mode: 'deep',
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
      rationale: 'project root normalization regression',
    },
    compilation_state: 'uncompiled',
    instruction_stack: {
      behavioral_ids: ['behavioral_core_v7', 'behavioral_guard_v7'],
      domain_id: 'domain_swe_frontend',
      skill_ids: [],
      model_adapter_id: 'adapter_codex_balanced',
      project_overlay_id: 'overlay_auditguard',
      task_overlay_ids: ['task_frontend_professionalism'],
      pipeline_stage_ids: ['pipeline_qa_reviewer'],
    },
    resolution_policy: {
      apply_domain_default_skills: true,
      expand_skill_dependencies: true,
      strict_conflict_mode: 'error',
    },
    prompt_manifest: [],
    handoff_payload: {
      user_request: 'project root normalization regression',
      system_directive: 'Resolve instruction_stack against prompt_catalog.yaml, expand dependencies, compile prompt_manifest, then load the compiled files in order.',
    },
  });
}

async function main(): Promise<void> {
  const tempDir = mkdtempSync(join(tmpdir(), 'babel-project-root-test-'));
  const tempProjectRoot = join(tempDir, 'AuditGuard');
  const sessionStartPath = join(tempDir, 'session-start.json');

  mkdirSync(tempProjectRoot, { recursive: true });
  writeFileSync(join(tempProjectRoot, 'package.json'), '{ "name": "auditguard-test" }\n', 'utf-8');
  writeFileSync(
    sessionStartPath,
    `${JSON.stringify({
      SchemaVersion: 1,
      SessionId: 'test-session',
      Project: 'AuditGuard',
      ProjectPath: tempProjectRoot,
    }, null, 2)}\n`,
    'utf-8',
  );

  const originalProjectRootEnv = process.env['BABEL_PROJECT_ROOT'];
  delete process.env['BABEL_PROJECT_ROOT'];

  try {
    const manifestWithPlaceholder = makeManifest('<YOUR_PROJECT_ROOT>/AuditGuard');

    const sessionRoot = readSessionStartProjectPath(sessionStartPath);
    assert(sessionRoot === tempProjectRoot, `expected session root ${tempProjectRoot}, got ${sessionRoot}`);

    const resolvedRoot = resolveConcreteProjectRoot(manifestWithPlaceholder, sessionStartPath);
    assert(resolvedRoot === tempProjectRoot, `expected resolved root ${tempProjectRoot}, got ${resolvedRoot}`);

    const normalizedManifest = normalizeManifestProjectRoot(manifestWithPlaceholder, sessionStartPath);
    assert(
      normalizedManifest.target_project_path === tempProjectRoot,
      `expected normalized manifest path ${tempProjectRoot}, got ${normalizedManifest.target_project_path}`,
    );
    assert(
      inferProjectRoot(normalizedManifest) === tempProjectRoot,
      `expected inferProjectRoot to return ${tempProjectRoot}, got ${inferProjectRoot(normalizedManifest)}`,
    );

    const manifestWithoutExplicitPath = makeManifest();
    const normalizedMissingPathManifest = normalizeManifestProjectRoot(manifestWithoutExplicitPath, sessionStartPath);
    assert(
      normalizedMissingPathManifest.target_project_path === tempProjectRoot,
      `expected missing-path manifest to pick up session root ${tempProjectRoot}, got ${normalizedMissingPathManifest.target_project_path}`,
    );

    const manifestWithRealPath = makeManifest('C:\\already\\real');
    const preservedManifest = normalizeManifestProjectRoot(manifestWithRealPath, sessionStartPath);
    assert(
      preservedManifest.target_project_path === 'C:\\already\\real',
      `expected existing concrete path to be preserved, got ${preservedManifest.target_project_path}`,
    );

    const manifestWithBroadProjectRoot = makeManifest(tempDir);
    const narrowedManifest = normalizeManifestProjectRoot(manifestWithBroadProjectRoot, sessionStartPath);
    assert(
      narrowedManifest.target_project_path === tempProjectRoot,
      `expected broad project root to narrow to session root ${tempProjectRoot}, got ${narrowedManifest.target_project_path}`,
    );

    console.log('project root normalization regression test passed');
  } finally {
    if (originalProjectRootEnv === undefined) {
      delete process.env['BABEL_PROJECT_ROOT'];
    } else {
      process.env['BABEL_PROJECT_ROOT'] = originalProjectRootEnv;
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

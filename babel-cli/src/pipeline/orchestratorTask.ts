import {
  buildExecutionProfilePromptLines,
  resolveExecutionProfile,
  type ExecutionProfileName,
} from '../config/executionProfiles.js';
import { readSessionStartProjectPath } from './manifestContext.js';
import type { OrchestratorRuntimeVersion } from './paths.js';

export interface OrchestratorTaskOptions {
  project?: string;
  mode?: 'direct' | 'verified' | 'autonomous' | 'manual' | 'parallel_swarm';
  executionProfile?: ExecutionProfileName;
  sessionStartPath?: string;
}

export function buildV9OrchestratorTask(task: string, options: OrchestratorTaskOptions): string {
  const executionProfile = resolveExecutionProfile(options.executionProfile ?? process.env['BABEL_EXECUTION_PROFILE']);
  const lines = [
    'Analyze the task below and output the orchestration manifest as a single raw JSON object.',
    'Respond with ONLY valid JSON — no markdown fences, no explanation, no tool calls.',
    '',
    'Required JSON shape (follow the schema defined in OLS-v9-Orchestrator.md exactly):',
    '{',
    '  "orchestrator_version": "9.0",',
    '  "target_project": "example_saas_backend|example_llm_router|example_web_audit|example_mobile_suite|example_game_workspace|example_game_suite|global",',
    '  "target_project_path": "<absolute path or omit>",',
    '  "analysis": {',
    '    "task_summary": "...",',
    '    "task_category": "Backend|Frontend|Mobile|Game|Compliance|DevOps|Research",',
    '    "secondary_category": null,',
    '    "complexity_estimate": "Low|Medium|High",',
    '    "pipeline_mode": "direct|verified|autonomous|manual",',
    '    "ambiguity_note": null,',
    '    "routing_confidence": 0.95',
    '  },',
    '  "compilation_state": "uncompiled",',
    '  "instruction_stack": {',
    '    "behavioral_ids": ["behavioral_core_v10", "behavioral_cognitive_micro_v7", "behavioral_guard_v7"],',
    '    "domain_id": "...",',
    '    "skill_ids": [],',
    '    "model_adapter_id": "...",',
    '    "project_overlay_id": null,',
    '    "task_overlay_ids": [],',
    '    "pipeline_stage_ids": []',
    '  },',
    '  "resolution_policy": {',
    '    "apply_domain_default_skills": true,',
    '    "expand_skill_dependencies": true,',
    '    "strict_conflict_mode": "error"',
    '  },',
    '  "platform_profile": {',
    '    "profile_source": "explicit_user_request|inferred_from_product_feature|not_required_for_routing",',
    '    "client_surface": "chatgpt_web|claude_web|gemini_web|grok_web|unspecified",',
    '    "container_model": "chat|project|gem|canvas|artifact|null",',
    '    "ingestion_mode": "none|file_upload|repo_snapshot|repo_selective_sync|repo_live_query|full_repo_integration",',
    '    "repo_write_mode": "no_repo_writeback|limited_write_surfaces|repo_writeback|null",',
    '    "output_surface": ["none|canvas|artifact|project_share|chat_share"],',
    '    "platform_modes": [],',
    '    "execution_trust": "high|medium|low|null",',
    '    "data_trust": "high|medium|low|null",',
    '    "freshness_trust": "high|medium|low|null",',
    '    "action_trust": "high|medium|low|null",',
    '    "approval_mode": "none|explicit_confirmation|takeover_or_confirmation|implicit_permissions|unknown"',
    '  },',
    '  "worker_configuration": { "assigned_model": "qwen3|deepseek|step-flash|scout|nemotron|qwen3-32b", "rationale": "..." },',
    '  "prompt_manifest": [],',
    '  "handoff_payload": { "user_request": "...", "system_directive": "Resolve instruction_stack against prompt_catalog.yaml, expand dependencies, compile prompt_manifest, then load the compiled files in order." }',
    '}',
    '',
    'routing_confidence guidance (0.0–1.0):',
    '  0.8–1.0 (high)   — task category, target project, and pipeline_mode are unambiguous.',
    '  0.6–0.79 (medium) — category or pipeline_mode has multiple plausible options.',
    '  <0.6 (low)        — task is genuinely unclear, cross-project, or domain fit is uncertain.',
    '',
    'pipeline_stage_ids rule: for pipeline_mode verified, always include ["pipeline_qa_reviewer"]; for autonomous, include pipeline_qa_reviewer and pipeline_cli_executor.',
    '',
    `Task: ${task}`,
  ];
  if (options.project) lines.push(`Preferred project: ${options.project}`);
  if (options.mode) lines.push(`Preferred pipeline mode: ${options.mode}`);
  lines.push(`Preferred execution profile: ${executionProfile.name}`);
  lines.push(...buildExecutionProfilePromptLines(executionProfile.name, 'orchestrator'));
  const sessionProjectRoot = readSessionStartProjectPath(options.sessionStartPath);
  const envProjectRoot = process.env['BABEL_PROJECT_ROOT']?.trim();
  const preferredProjectRoot = sessionProjectRoot ?? (envProjectRoot && envProjectRoot.length > 0 ? envProjectRoot : null);
  if (preferredProjectRoot) {
    lines.push(`Preferred target project path: ${preferredProjectRoot}`);
    lines.push('When a Preferred target project path is provided, preserve it exactly in target_project_path.');
  }
  return lines.join('\n');
}

export function buildOrchestratorTask(
  task: string,
  options: OrchestratorTaskOptions,
  _version: OrchestratorRuntimeVersion,
): string {
  return buildV9OrchestratorTask(task, options);
}

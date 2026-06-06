import assert from 'node:assert/strict';
import test from 'node:test';

import { AskAnswerSchema, ExecutorTurnSchema, OrchestratorManifestSchema, SwePlanSchema } from './agentContracts.js';

test('executor turn schema normalizes near-miss file_write payloads', () => {
  const parsed = ExecutorTurnSchema.parse({
    tool: 'file_write',
    filepath: 'src/example.ts',
    body: 'export const ok = true;\n',
  });

  assert.equal(parsed.type, 'tool_call');
  assert.equal(parsed.tool, 'file_write');
  assert.equal(parsed.path, 'src/example.ts');
  assert.equal(parsed.content, 'export const ok = true;\n');
  assert.equal(parsed.thinking, '');
});

test('SWE plan schema normalizes array thinking into a string', () => {
  const parsed = SwePlanSchema.parse({
    plan_version: '1.0',
    thinking: ['inspect target', 'write bounded file'],
    plan_type: 'IMPLEMENTATION_PLAN',
    task_summary: 'Create a file',
    known_facts: ['target path is requested'],
    assumptions: [],
    risks: [],
    minimal_action_set: [
      {
        step: 1,
        description: 'Create file',
        tool: 'file_write',
        target: 'README.md',
        rationale: 'requested',
        reversible: true,
        verification: 'file exists',
      },
    ],
    root_cause: 'N/A',
    out_of_scope: [],
  });

  assert.equal(parsed.thinking, 'inspect target\nwrite bounded file');
});

test('SWE plan schema tolerates missing thinking field from otherwise valid plans', () => {
  const parsed = SwePlanSchema.parse({
    plan_version: '1.0',
    plan_type: 'IMPLEMENTATION_PLAN',
    task_summary: 'Repair a file',
    known_facts: ['target path is requested'],
    assumptions: [],
    risks: [],
    minimal_action_set: [
      {
        step: 1,
        description: 'Repair file',
        tool: 'file_write',
        target: 'src/example.ts',
        rationale: 'requested',
        reversible: true,
        verification: 'file contains repair',
      },
    ],
    root_cause: 'N/A',
    out_of_scope: [],
  });

  assert.equal(parsed.thinking, '');
});

test('SWE plan schema tolerates empty known facts for inspection-first tasks', () => {
  const parsed = SwePlanSchema.parse({
    plan_version: '1.0',
    plan_type: 'IMPLEMENTATION_PLAN',
    task_summary: 'Inspect a file before drawing conclusions',
    known_facts: [],
    assumptions: [],
    risks: [],
    minimal_action_set: [
      {
        step: 1,
        description: 'Read target file',
        tool: 'file_read',
        target: 'src/info.txt',
        rationale: 'Need evidence before answering',
        reversible: true,
        verification: 'file content was read',
      },
    ],
    root_cause: 'N/A',
    out_of_scope: [],
  });

  assert.deepEqual(parsed.known_facts, []);
});

test('SWE plan schema defaults missing known facts to an empty list', () => {
  const parsed = SwePlanSchema.parse({
    plan_version: '1.0',
    plan_type: 'IMPLEMENTATION_PLAN',
    task_summary: 'Inspect a file before drawing conclusions',
    assumptions: [],
    risks: [],
    minimal_action_set: [
      {
        step: 1,
        description: 'Read target file',
        tool: 'file_read',
        target: 'src/info.txt',
        rationale: 'Need evidence before answering',
        reversible: true,
        verification: 'file content was read',
      },
    ],
    root_cause: 'N/A',
    out_of_scope: [],
  });

  assert.deepEqual(parsed.known_facts, []);
});

test('Ask answer schema accepts lightweight read-only answers without SWE plan fields', () => {
  const parsed = AskAnswerSchema.parse({
    schema_version: 1,
    status: 'ANSWER_READY',
    summary: 'Babel Lite should answer directly.',
    answer: 'Use bl ask for read-only explanations and bl fix for edits.',
    facts: ['Ask mode is read-only.'],
    assumptions: [],
    evidence: [{ source: 'CLI help', summary: 'User-shaped commands are available.' }],
    next: ['Run bl plan if you want an implementation path.'],
  });

  assert.equal(parsed.status, 'ANSWER_READY');
  assert.equal(parsed.answer, 'Use bl ask for read-only explanations and bl fix for edits.');
  assert.deepEqual(parsed.facts, ['Ask mode is read-only.']);
});

test('Ask answer schema normalizes string evidence from live providers', () => {
  const parsed = AskAnswerSchema.parse({
    schema_version: 1,
    status: 'ANSWER_READY',
    summary: 'Babel can answer from summary files.',
    answer: 'This repo exposes Babel CLI commands and project metadata.',
    evidence: ['README.md was available in the provided context.', 'package.json was available in the provided context.'],
  });

  assert.deepEqual(parsed.evidence, [
    { source: 'model_evidence', summary: 'README.md was available in the provided context.' },
    { source: 'model_evidence', summary: 'package.json was available in the provided context.' },
  ]);
});

test('Ask answer schema rejects missing answer text', () => {
  assert.throws(() => AskAnswerSchema.parse({
    schema_version: 1,
    status: 'ANSWER_READY',
    summary: 'Missing answer.',
  }));
});

test('orchestrator manifest schema normalizes GPT-5 worker aliases', () => {
  const parsed = OrchestratorManifestSchema.parse({
    orchestrator_version: '9.0',
    target_project: 'global',
    analysis: {
      task_summary: 'test',
      task_category: 'Backend',
      secondary_category: null,
      complexity_estimate: 'Low',
      pipeline_mode: 'autonomous',
      ambiguity_note: null,
    },
    worker_configuration: {
      assigned_model: 'GPT-5 Pro',
      rationale: 'model family alias',
    },
    compilation_state: 'uncompiled',
    instruction_stack: {
      behavioral_ids: ['behavioral_core_v7', 'behavioral_guard_v7'],
      domain_id: 'domain_swe_backend',
      skill_ids: [],
      model_adapter_id: 'adapter_codex_balanced',
      project_overlay_id: null,
      task_overlay_ids: [],
      pipeline_stage_ids: [],
    },
    resolution_policy: {
      apply_domain_default_skills: true,
      expand_skill_dependencies: true,
      strict_conflict_mode: 'error',
    },
    platform_profile: {},
    prompt_manifest: [],
    handoff_payload: {
      user_request: 'test',
      system_directive: 'test',
    },
  });

  assert.equal(parsed.worker_configuration.assigned_model, 'qwen3');
});

test('orchestrator manifest schema treats null swarm as no swarm', () => {
  const parsed = OrchestratorManifestSchema.parse({
    orchestrator_version: '9.0',
    target_project: 'global',
    analysis: {
      task_summary: 'test',
      task_category: 'Backend',
      secondary_category: null,
      complexity_estimate: 'Low',
      pipeline_mode: 'verified',
      ambiguity_note: null,
    },
    worker_configuration: {
      assigned_model: 'qwen3',
      rationale: 'test',
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
    platform_profile: {},
    prompt_manifest: [],
    handoff_payload: {
      user_request: 'test',
      system_directive: 'test',
    },
    swarm: null,
  });

  assert.equal(parsed.swarm, undefined);
});

test('orchestrator manifest schema treats empty swarm as absent', () => {
  const parsed = OrchestratorManifestSchema.parse({
    orchestrator_version: '9.0',
    target_project: 'global',
    analysis: {
      task_summary: 'test',
      task_category: 'Backend',
      secondary_category: null,
      complexity_estimate: 'Low',
      pipeline_mode: 'verified',
      ambiguity_note: null,
    },
    worker_configuration: {
      assigned_model: 'qwen3',
      rationale: 'test',
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
    platform_profile: {},
    prompt_manifest: [],
    handoff_payload: {
      user_request: 'test',
      system_directive: 'test',
    },
    swarm: {
      parent_run_id: 'run-empty-swarm',
      sub_tasks: [],
    },
  });

  assert.equal(parsed.swarm, undefined);
});

test('orchestrator manifest schema validates a real non-empty swarm', () => {
  const parsed = OrchestratorManifestSchema.parse({
    orchestrator_version: '9.0',
    target_project: 'global',
    analysis: {
      task_summary: 'test',
      task_category: 'Backend',
      secondary_category: null,
      complexity_estimate: 'Low',
      pipeline_mode: 'verified',
      ambiguity_note: null,
    },
    worker_configuration: {
      assigned_model: 'qwen3',
      rationale: 'test',
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
    platform_profile: {},
    prompt_manifest: [],
    handoff_payload: {
      user_request: 'test',
      system_directive: 'test',
    },
    swarm: {
      parent_run_id: 'run-empty-swarm',
      sub_tasks: [
        {
          sub_task_id: 'sub-1',
          instruction_stack: {
            behavioral_ids: ['behavioral_core_v7', 'behavioral_guard_v7'],
            domain_id: 'domain_swe_backend',
            skill_ids: [],
            model_adapter_id: 'adapter_codex_balanced',
            project_overlay_id: null,
            task_overlay_ids: [],
            pipeline_stage_ids: ['pipeline_qa_reviewer'],
          },
          handoff_payload: {
            user_request: 'test subtask',
            system_directive: 'run subtask',
          },
        },
      ],
    },
  });

  assert.equal(parsed.swarm?.parent_run_id, 'run-empty-swarm');
  assert.equal(parsed.swarm?.sub_tasks.length, 1);
  assert.equal(parsed.swarm?.sub_tasks[0]?.sub_task_id, 'sub-1');
});

test('executor turn schema normalizes command and MCP argument aliases', () => {
  const parsed = ExecutorTurnSchema.parse({
    type: 'tool_call',
    tool_name: 'mcp_prompt_get',
    server: 'local',
    name: 'prompt',
    params: { id: 'abc' },
  });

  assert.equal(parsed.type, 'tool_call');
  assert.equal(parsed.tool, 'mcp_prompt_get');
  assert.deepEqual(parsed.arguments, { id: 'abc' });

  const shell = ExecutorTurnSchema.parse({
    type: 'tool_call',
    tool: 'shell_exec',
    cmd: 'npm test',
    working_directory: '.',
  });

  assert.equal(shell.type, 'tool_call');
  assert.equal(shell.command, 'npm test');
});

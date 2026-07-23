import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildSubagentIsolationContract,
  inspectAgentRun,
  listAgentRuns,
  mergeAgentRun,
  restoreAgentMerge,
  runAgentTeam,
  type AgentTeamSpec,
} from './agentTeams.js';

function tempRoot(name: string): string {
  const root = join(
    tmpdir(),
    `babel-agent-teams-${name}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(root, { recursive: true });
  return root;
}

test('subagent isolation contract keeps live workers gated behind evidence requirements', () => {
  const contract = buildSubagentIsolationContract();

  assert.equal(contract.contract_id, 'babel.subagents.isolation');
  assert.equal(contract.live_subagents_enabled, true);
  assert.equal(contract.write_scope_policy.declared_scope_required, true);
  assert.equal(contract.write_scope_policy.overlapping_write_scopes_rejected, true);
  assert.equal(contract.write_scope_policy.review_only_agents_cannot_write, true);
  assert.equal(contract.merge_policy.evidence_required, true);
  assert.equal(contract.merge_policy.auto_merge_requires_disjoint_scopes, true);
  // Live subagents are now supported with an empty requirements list
  assert.deepEqual(contract.required_before_live_subagents, []);
});

test('live subagent state is explicitly opt-in with isolation/evidence/restore requirements', () => {
  const root = tempRoot('contract-state');
  const projectRoot = join(root, 'project');
  const runsRoot = join(root, 'runs', 'agents');
  mkdirSync(projectRoot, { recursive: true });

  const run = runAgentTeam(
    {
      schema_version: 1,
      id: 'team-live-gate',
      project_root: projectRoot,
      isolation: 'copy',
      agents: [
        {
          id: 'reviewer',
          role: 'reviewer',
          task: 'Record note only.',
          allowed_tools: ['file_read'],
          disallowed_tools: ['file_write'],
          write_scope: [],
          merge_strategy: 'review_only',
          operations: [{ type: 'note', note: 'No write needed.' }],
        },
      ],
    },
    { babelRoot: root, runsRoot },
  );

  assert.equal(run.live_subagents.enabled, true);
  assert.equal(run.live_subagents.required_opt_in, 'enabled_via_buildSubagentIsolationContract');
  assert.equal(run.live_subagents.isolation_required_for_mutation, true);
  assert.equal(run.live_subagents.evidence_required_for_merge, true);
  assert.equal(run.live_subagents.restore_path_required_before_merge, true);
  assert.deepEqual(
    run.live_subagents.required_before_live_subagents,
    buildSubagentIsolationContract().required_before_live_subagents,
  );
  assert.equal(
    run.lead_synthesis.live_subagents.required_before_live_subagents.length,
    buildSubagentIsolationContract().required_before_live_subagents.length,
  );
});

test('two subagents can write disjoint scoped files and merge with evidence', () => {
  const root = tempRoot('disjoint');
  const projectRoot = join(root, 'project');
  const runsRoot = join(root, 'runs', 'agents');
  mkdirSync(projectRoot, { recursive: true });

  const spec: AgentTeamSpec = {
    schema_version: 1,
    id: 'team-disjoint',
    name: 'Disjoint Writers',
    project_root: projectRoot,
    isolation: 'copy',
    lead_synthesis: true,
    agents: [
      {
        id: 'worker-a',
        role: 'worker',
        task: 'Write A.',
        allowed_tools: ['file_read', 'file_write'],
        disallowed_tools: ['shell_exec'],
        write_scope: ['a.txt'],
        merge_strategy: 'auto_disjoint',
        operations: [
          {
            type: 'write_file',
            path: 'a.txt',
            content: 'alpha\n',
            rationale: 'Worker A owns a.txt.',
          },
        ],
      },
      {
        id: 'worker-b',
        role: 'worker',
        task: 'Write B.',
        allowed_tools: ['file_read', 'file_write'],
        disallowed_tools: ['shell_exec'],
        write_scope: ['b.txt'],
        merge_strategy: 'auto_disjoint',
        operations: [
          {
            type: 'write_file',
            path: 'b.txt',
            content: 'bravo\n',
            rationale: 'Worker B owns b.txt.',
          },
        ],
      },
    ],
  };

  const run = runAgentTeam(spec, { babelRoot: root, runsRoot });
  assert.equal(run.status, 'ready_to_merge');
  assert.equal(run.execution_model, 'spec_contract_harness');
  assert.equal(run.live_subagents.enabled, true);
  assert.equal(run.lead_synthesis.live_subagents.enabled, true);
  assert.equal(run.agents.length, 2);
  assert.deepEqual(
    run.diagnostics.filter((diagnostic) => diagnostic.severity === 'fail'),
    [],
  );
  assert.equal(existsSync(join(run.run_dir, 'lead_synthesis.json')), true);
  assert.equal(existsSync(run.agents[0]!.evidence_path), true);
  assert.equal(existsSync(join(projectRoot, 'a.txt')), false);

  const report = mergeAgentRun('team-disjoint', { babelRoot: root, runsRoot });
  assert.equal(report.status, 'merged');
  assert.deepEqual(report.merged_files.sort(), ['a.txt', 'b.txt']);
  assert.equal(report.restore.available, true);
  assert.equal(report.restore.restore_command, 'babel agents restore team-disjoint');
  assert.equal(readFileSync(join(projectRoot, 'a.txt'), 'utf-8'), 'alpha\n');
  assert.equal(readFileSync(join(projectRoot, 'b.txt'), 'utf-8'), 'bravo\n');

  const inspected = inspectAgentRun('team-disjoint', { babelRoot: root, runsRoot });
  assert.equal(inspected.status, 'merged');
  assert.equal(existsSync(join(inspected.run_dir, 'merge_report.json')), true);
});

test('agent merge restore recovers pre-merge project files and removes created files', () => {
  const root = tempRoot('restore');
  const projectRoot = join(root, 'project');
  const runsRoot = join(root, 'runs', 'agents');
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(join(projectRoot, 'existing.txt'), 'before\n', 'utf-8');

  runAgentTeam(
    {
      schema_version: 1,
      id: 'team-restore',
      project_root: projectRoot,
      isolation: 'copy',
      agents: [
        {
          id: 'worker',
          role: 'worker',
          task: 'Update one file and create another.',
          allowed_tools: ['file_write'],
          disallowed_tools: [],
          write_scope: ['existing.txt', 'created.txt'],
          merge_strategy: 'auto_disjoint',
          operations: [
            {
              type: 'write_file',
              path: 'existing.txt',
              content: 'after\n',
              rationale: 'Update existing file.',
            },
            {
              type: 'write_file',
              path: 'created.txt',
              content: 'new\n',
              rationale: 'Create new file.',
            },
          ],
        },
      ],
    },
    { babelRoot: root, runsRoot },
  );

  const merge = mergeAgentRun('team-restore', { babelRoot: root, runsRoot });
  assert.equal(merge.status, 'merged');
  assert.equal(readFileSync(join(projectRoot, 'existing.txt'), 'utf-8'), 'after\n');
  assert.equal(readFileSync(join(projectRoot, 'created.txt'), 'utf-8'), 'new\n');

  const restore = restoreAgentMerge('team-restore', { babelRoot: root, runsRoot });
  assert.equal(restore.status, 'restored');
  assert.deepEqual(restore.restored_files, ['existing.txt']);
  assert.deepEqual(restore.removed_created_files, ['created.txt']);
  assert.equal(readFileSync(join(projectRoot, 'existing.txt'), 'utf-8'), 'before\n');
  assert.equal(existsSync(join(projectRoot, 'created.txt')), false);
});

test('agent merge restore refuses when merged files changed after merge', () => {
  const root = tempRoot('restore-drift');
  const projectRoot = join(root, 'project');
  const runsRoot = join(root, 'runs', 'agents');
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(join(projectRoot, 'existing.txt'), 'before\n', 'utf-8');

  runAgentTeam(
    {
      schema_version: 1,
      id: 'team-restore-drift',
      project_root: projectRoot,
      isolation: 'copy',
      agents: [
        {
          id: 'worker',
          role: 'worker',
          task: 'Update one file and create another.',
          allowed_tools: ['file_write'],
          disallowed_tools: [],
          write_scope: ['existing.txt', 'created.txt'],
          merge_strategy: 'auto_disjoint',
          operations: [
            {
              type: 'write_file',
              path: 'existing.txt',
              content: 'after\n',
              rationale: 'Update existing file.',
            },
            {
              type: 'write_file',
              path: 'created.txt',
              content: 'new\n',
              rationale: 'Create new file.',
            },
          ],
        },
      ],
    },
    { babelRoot: root, runsRoot },
  );

  mergeAgentRun('team-restore-drift', { babelRoot: root, runsRoot });
  writeFileSync(join(projectRoot, 'existing.txt'), 'user edit\n', 'utf-8');

  const restore = restoreAgentMerge('team-restore-drift', { babelRoot: root, runsRoot });
  assert.equal(restore.status, 'failed');
  assert.equal(
    restore.diagnostics.some((diagnostic) => diagnostic.code === 'merge_restore_target_modified'),
    true,
  );
  assert.deepEqual(restore.restored_files, []);
  assert.deepEqual(restore.removed_created_files, []);
  assert.equal(readFileSync(join(projectRoot, 'existing.txt'), 'utf-8'), 'user edit\n');
  assert.equal(readFileSync(join(projectRoot, 'created.txt'), 'utf-8'), 'new\n');
});

test('reviewer subagent read-only restrictions block writes with structured diagnostics', () => {
  const root = tempRoot('reviewer');
  const projectRoot = join(root, 'project');
  const runsRoot = join(root, 'runs', 'agents');
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(join(projectRoot, 'target.txt'), 'original\n', 'utf-8');

  const run = runAgentTeam(
    {
      schema_version: 1,
      id: 'team-reviewer',
      project_root: projectRoot,
      isolation: 'copy',
      agents: [
        {
          id: 'reviewer',
          role: 'reviewer',
          task: 'Review only.',
          allowed_tools: ['file_read'],
          disallowed_tools: ['file_write'],
          write_scope: [],
          merge_strategy: 'review_only',
          operations: [
            {
              type: 'write_file',
              path: 'target.txt',
              content: 'changed\n',
              rationale: 'This should be blocked.',
            },
          ],
        },
      ],
    },
    { babelRoot: root, runsRoot },
  );

  assert.equal(run.status, 'failed');
  const codes = run.diagnostics.map((diagnostic) => diagnostic.code);
  assert.equal(codes.includes('tool_not_allowed'), true);
  assert.equal(codes.includes('tool_disallowed'), true);
  assert.equal(codes.includes('review_only_write_blocked'), true);
  assert.equal(codes.includes('write_scope_violation'), true);
  assert.equal(readFileSync(join(projectRoot, 'target.txt'), 'utf-8'), 'original\n');
});

test('overlapping write scopes are rejected before merge', () => {
  const root = tempRoot('conflict');
  const projectRoot = join(root, 'project');
  const runsRoot = join(root, 'runs', 'agents');
  mkdirSync(projectRoot, { recursive: true });

  const run = runAgentTeam(
    {
      schema_version: 1,
      id: 'team-conflict',
      project_root: projectRoot,
      isolation: 'copy',
      agents: [
        {
          id: 'worker-a',
          role: 'worker',
          task: 'Write shared file.',
          allowed_tools: ['file_write'],
          disallowed_tools: [],
          write_scope: ['src'],
          merge_strategy: 'auto_disjoint',
          operations: [
            { type: 'write_file', path: 'src/a.txt', content: 'a\n', rationale: 'A writes src.' },
          ],
        },
        {
          id: 'worker-b',
          role: 'worker',
          task: 'Write overlapping file.',
          allowed_tools: ['file_write'],
          disallowed_tools: [],
          write_scope: ['src/a.txt'],
          merge_strategy: 'auto_disjoint',
          operations: [
            { type: 'write_file', path: 'src/a.txt', content: 'b\n', rationale: 'B overlaps A.' },
          ],
        },
      ],
    },
    { babelRoot: root, runsRoot },
  );

  assert.equal(run.status, 'failed');
  assert.equal(
    run.diagnostics.some((diagnostic) => diagnostic.code === 'write_scope_conflict'),
    true,
  );
  const report = mergeAgentRun('team-conflict', { babelRoot: root, runsRoot });
  assert.equal(report.status, 'failed');
  assert.equal(
    report.diagnostics.some((diagnostic) => diagnostic.code === 'run_failed'),
    true,
  );
});

test('agent run index lists completed team runs', () => {
  const root = tempRoot('index');
  const projectRoot = join(root, 'project');
  const runsRoot = join(root, 'runs', 'agents');
  mkdirSync(projectRoot, { recursive: true });

  runAgentTeam(
    {
      schema_version: 1,
      id: 'team-index',
      project_root: projectRoot,
      agents: [
        {
          id: 'reviewer',
          role: 'reviewer',
          task: 'Record a note.',
          allowed_tools: ['file_read'],
          disallowed_tools: ['file_write'],
          write_scope: [],
          merge_strategy: 'review_only',
          operations: [{ type: 'note', note: 'No changes needed.' }],
        },
      ],
    },
    { babelRoot: root, runsRoot },
  );

  const index = listAgentRuns({ babelRoot: root, runsRoot });
  assert.equal(index.runs.length, 1);
  assert.equal(index.runs[0]?.id, 'team-index');
  assert.equal(index.runs[0]?.status, 'no_changes');
});

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import type { SwePlan } from '../schemas/agentContracts.js';
import {
  extractRequestedOutputArtifacts,
  normalizePlanTargetsAgainstRequestedOutputs,
  verifyBoundedTaskArtifacts,
  verifyRequestedOutputArtifacts,
  verifySuccessfulTextWriteTarget,
} from './verification.js';

test('exported symbol verification accepts named CommonJS function assignment', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-verification-'));
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(
      join(root, 'src', 'renderStatusCard.js'),
      [
        'module.exports = function renderStatusCard(title, status) {',
        '  return `<div>${title}: ${status}</div>`;',
        '};',
        '',
      ].join('\n'),
      'utf-8',
    );

    const failure = verifySuccessfulTextWriteTarget(
      'src/renderStatusCard.js',
      root,
      'Create src/renderStatusCard.js that exports a renderStatusCard(title, status) function returning an HTML string.',
    );

    assert.equal(failure, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('plan target normalization does not rewrite file_read placeholders to requested outputs', () => {
  const rawTask =
    'Update existing src/toggleWidget.js and src/toggleWidget.css so renderToggle(label, enabled) returns an accessible button string. Also update WRITE_REPORT.md.';
  const plan = {
    plan_version: '1.0',
    thinking: '',
    task_summary: 'Repair toggle widget outputs.',
    known_facts: ['The task names bounded output files.'],
    assumptions: [],
    risks: [
      {
        risk: 'Placeholder reads can be invalid.',
        likelihood: 'medium',
        mitigation: 'Leave read targets untouched so executor validation handles them.',
      },
    ],
    minimal_action_set: [
      {
        step: 1,
        description: 'Inspect current implementation.',
        tool: 'file_read',
        target: '<path>',
        rationale: 'Need current code before editing.',
        reversible: true,
        verification: 'File read succeeds.',
      },
      {
        step: 2,
        description: 'Write the toggle implementation.',
        tool: 'file_write',
        target: 'toggleWidget.js',
        rationale: 'Implement requested behavior.',
        reversible: true,
        verification: 'File contains renderToggle.',
      },
      {
        step: 3,
        description: 'Write report.',
        tool: 'file_write',
        target: 'summary.md',
        rationale: 'Document the change.',
        reversible: true,
        verification: 'Report exists.',
      },
    ],
    root_cause: 'N/A',
    out_of_scope: [],
  } satisfies SwePlan;

  const { plan: normalized } = normalizePlanTargetsAgainstRequestedOutputs(rawTask, plan);

  assert.equal(normalized.minimal_action_set[0]?.target, '<path>');
  assert.equal(normalized.minimal_action_set[1]?.target, 'src/toggleWidget.js');
  assert.equal(normalized.minimal_action_set[2]?.target, 'WRITE_REPORT.md');
});

test('bounded artifact verification accepts a unique successful write when a model drops the directory in prose', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-verification-target-'));
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(
      join(root, 'src', 'user.ts'),
      [
        'import { formatDisplayName } from "./formatDisplayName";',
        '',
        'export interface User { firstName: string; lastName: string; email: string; }',
        'export function userDisplayName(user: User): string {',
        '  return formatDisplayName(user.firstName, user.lastName, user.email);',
        '}',
        '',
      ].join('\n'),
      'utf-8',
    );
    writeFileSync(
      join(root, 'src', 'formatDisplayName.ts'),
      [
        'export function formatDisplayName(firstName: string, lastName: string, email: string): string {',
        '  const name = [firstName.trim(), lastName.trim()].filter(Boolean).join(" ");',
        '  return name.length > 0 ? name : email;',
        '}',
        '',
      ].join('\n'),
      'utf-8',
    );
    writeFileSync(join(root, 'WRITE_REPORT.md'), '# Report\n', 'utf-8');

    const failure = verifyBoundedTaskArtifacts(
      'Add src/formatDisplayName.ts exporting formatDisplayName(firstName: string, lastName: string, email: string): string. Then update existing user.ts so userDisplayName(user) imports and uses formatDisplayName. Also update WRITE_REPORT.md.',
      [
        { step: 1, tool: 'file_write', target: 'src/formatDisplayName.ts', exit_code: 0, stdout: '', stderr: '', verified: true },
        { step: 2, tool: 'file_write', target: 'src/user.ts', exit_code: 0, stdout: '', stderr: '', verified: true },
        { step: 3, tool: 'file_write', target: 'WRITE_REPORT.md', exit_code: 0, stdout: '', stderr: '', verified: true },
      ],
      root,
    );

    assert.equal(failure, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('requested output artifact extraction includes benchmark executables and output files', () => {
  const task = [
    'The tool should be called with "./cli_tool weights.json image.png".',
    'Your final output should be a binary executable called "cli_tool",',
    'the "weights.json" file, and a file called "prediction.txt".',
  ].join(' ');

  assert.deepEqual(
    extractRequestedOutputArtifacts(task).sort(),
    ['cli_tool', 'prediction.txt', 'weights.json'].sort(),
  );
});

test('external benchmark helper writes are allowed outside final artifact targets', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-benchmark-helper-'));
  try {
    writeFileSync(join(root, 'make_comp.py'), 'print("helper")\n', 'utf-8');

    const failure = verifySuccessfulTextWriteTarget(
      'make_comp.py',
      root,
      'Terminal-Bench 2 task: write-compressor\nWrite me data.comp that is compressed such that it reproduces data.txt.',
    );

    assert.equal(failure, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('post-write verification resolves /project targets through the project root mount', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-project-mount-'));
  try {
    writeFileSync(join(root, 'compress.py'), 'print("ok")\n', 'utf-8');

    const failure = verifySuccessfulTextWriteTarget(
      '/project/compress.py',
      root,
      'Terminal-Bench 2 task: write-compressor\nWrite me data.comp that is compressed such that it reproduces data.txt.',
    );

    assert.equal(failure, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('post-write verification resolves /app targets in benchmark container profile', () => {
  const previousProfile = process.env['BABEL_EXECUTION_PROFILE'];
  const root = mkdtempSync(join(tmpdir(), 'babel-app-mount-'));
  try {
    process.env['BABEL_EXECUTION_PROFILE'] = 'benchmark_container';
    writeFileSync(join(root, 'log_analyzer.py'), 'print("ok")\n', 'utf-8');

    const failure = verifySuccessfulTextWriteTarget(
      '/app/log_analyzer.py',
      root,
      'Terminal-Bench 2 task: log-summary-date-ranges\nCreate log_analyzer.py.',
    );

    assert.equal(failure, null);
  } finally {
    if (previousProfile === undefined) {
      delete process.env['BABEL_EXECUTION_PROFILE'];
    } else {
      process.env['BABEL_EXECUTION_PROFILE'] = previousProfile;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('requested output artifact verification rejects missing requested files', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-requested-artifacts-'));
  try {
    const task = 'Write a CSV file summary.csv with the requested rows.';
    assert.match(
      verifyRequestedOutputArtifacts(task, root) ?? '',
      /summary\.csv.*does not exist/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('requested output artifact verification accepts present non-empty files', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-requested-artifacts-'));
  try {
    writeFileSync(join(root, 'summary.csv'), 'period,severity,count\n', 'utf-8');
    const task = 'Write a CSV file summary.csv with the requested rows.';
    assert.equal(verifyRequestedOutputArtifacts(task, root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

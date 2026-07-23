import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { evaluatePreCompleteGuards } from './preCompleteGuards.js';
import type { ToolCallLog } from '../schemas/agentContracts.js';

function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

function successfulCommand(target: string): ToolCallLog {
  return {
    step: 1,
    tool: 'shell_exec',
    target,
    exit_code: 0,
    stdout: '',
    stderr: '',
    verified: true,
  };
}

function successfulWrite(step: number, target: string): ToolCallLog {
  return {
    step,
    tool: 'file_write',
    target,
    exit_code: 0,
    stdout: `Written: ${target}`,
    stderr: '',
    verified: true,
  };
}

test('pre-complete guards combine requested artifact and benchmark hook failures', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-pre-complete-'));
  try {
    const result = evaluatePreCompleteGuards({
      rawTask: 'Terminal-Bench 2 task: not-yet-cataloged\nWrite output.txt.',
      toolCallLog: [],
      projectRoot: root,
    });

    assert.match(result.semanticFailure ?? '', /Requested artifact postcondition failed/);
    assert.equal(result.benchmarkVerification?.passed, false);
  } finally {
    cleanup(root);
  }
});

test('pre-complete guards pass when requested artifact and generic verifier evidence exist', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-pre-complete-'));
  try {
    writeFileSync(join(root, 'output.txt'), 'ok\n', 'utf-8');
    const result = evaluatePreCompleteGuards({
      rawTask: 'Terminal-Bench 2 task: not-yet-cataloged\nWrite output.txt.',
      toolCallLog: [successfulCommand('python verify_output.py')],
      projectRoot: root,
    });

    assert.equal(result.semanticFailure, null);
    assert.equal(result.benchmarkVerification?.passed, true);
  } finally {
    cleanup(root);
  }
});

test('pre-complete guards block COMPLETE on exact instruction drift', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-pre-complete-exact-'));
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(
      join(root, 'src', 'verifiedMode.js'),
      'export function getStatus() { return "System operating in verified mode"; }\n',
      'utf-8',
    );
    const result = evaluatePreCompleteGuards({
      rawTask: 'Return the exact string verified live ok from the verified mode helper.',
      toolCallLog: [successfulWrite(1, 'src/verifiedMode.js')],
      projectRoot: root,
      exactInvariantFailure:
        '[EXACT_INSTRUCTION_DRIFT] literal_string "verified live ok": literal invariant missing',
    });

    assert.match(result.semanticFailure ?? '', /EXACT_INSTRUCTION_DRIFT/);
  } finally {
    cleanup(root);
  }
});

test('pre-complete guards reject uncited ROI market metrics', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-pre-complete-roi-'));
  try {
    writeFileSync(
      join(root, 'roi_research.md'),
      'Hyper-casual wins because top games hit 30% retention and $2-$5 ARPDAU.\n',
      'utf-8',
    );

    const result = evaluatePreCompleteGuards({
      rawTask: 'Create a concise ROI research note in the project root.',
      toolCallLog: [successfulWrite(1, 'roi_research.md')],
      projectRoot: root,
    });

    assert.match(result.semanticFailure ?? '', /market metrics require citations/);
  } finally {
    cleanup(root);
  }
});

test('pre-complete guards accept sourced or explicitly unverified ROI metrics', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-pre-complete-roi-'));
  try {
    writeFileSync(
      join(root, 'roi_research.md'),
      'Model-prior / unverified: puzzle games may have stronger retention than pure hyper-casual.\n',
      'utf-8',
    );

    const result = evaluatePreCompleteGuards({
      rawTask: 'Create a concise ROI research note in the project root.',
      toolCallLog: [successfulWrite(1, 'roi_research.md')],
      projectRoot: root,
    });

    assert.equal(result.semanticFailure, null);
  } finally {
    cleanup(root);
  }
});

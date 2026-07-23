import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpawnSyncReturns } from 'node:child_process';
import test from 'node:test';

import {
  detectRuntimeVerificationTargetType,
  runRuntimeVerification,
} from './runtimeVerificationRunner.js';

function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

function makeWorkspace(): { workspace: string; babelRoot: string; projectRoot: string } {
  const workspace = mkdtempSync(join(tmpdir(), 'babel-runtime-verification-'));
  const babelRoot = join(workspace, 'Babel');
  const projectRoot = join(workspace, 'example_game_suite', 'Game');
  mkdirSync(join(workspace, 'tools', 'Godot'), { recursive: true });
  mkdirSync(babelRoot, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(join(workspace, 'tools', 'Godot', 'godot.ps1'), '# test wrapper\n', 'utf-8');
  return { workspace, babelRoot, projectRoot };
}

function spawnResult(stdout: string, stderr = '', status = 0): SpawnSyncReturns<string> {
  return {
    pid: 123,
    output: [null, stdout, stderr],
    stdout,
    stderr,
    status,
    signal: null,
  };
}

const GODOT_TASK = 'Build a playable Godot 4 Android-targeted mobile game prototype.';

test('Godot runtime runner creates PASS evidence for valid command output', () => {
  const fixture = makeWorkspace();
  try {
    const result = runRuntimeVerification({
      rawTask: GODOT_TASK,
      projectRoot: fixture.projectRoot,
      toolCallLog: [],
      babelRoot: fixture.babelRoot,
      now: () => new Date('2026-04-30T19:30:00.000Z'),
      commandRunner: (command, args, options) => {
        assert.equal(command, 'powershell');
        assert.deepEqual(args.slice(0, 4), [
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          join(fixture.workspace, 'tools', 'Godot', 'godot.ps1'),
        ]);
        assert.equal(options.cwd, fixture.projectRoot);
        return spawnResult('Godot Engine v4.6.2.stable\n');
      },
    });

    assert.equal(result.status, 'PASS');
    assert.equal(result.targetType, 'godot');
    assert.equal(result.exitCode, 0);
    assert.match(result.command ?? '', /--headless/);
    assert.equal(result.detectedErrors.length, 0);
    assert.equal(result.timestamp, '2026-04-30T19:30:00.000Z');
  } finally {
    cleanup(fixture.workspace);
  }
});

test('Godot runtime runner detects parse error output as FAIL', () => {
  const fixture = makeWorkspace();
  try {
    const result = runRuntimeVerification({
      rawTask: GODOT_TASK,
      projectRoot: fixture.projectRoot,
      toolCallLog: [],
      babelRoot: fixture.babelRoot,
      commandRunner: () =>
        spawnResult(
          'Godot Engine v4.6.2.stable\n',
          "ERROR: Error parsing 'project.godot' at line 1: Unexpected identifier 'res' File might be corrupted.\n",
        ),
    });

    assert.equal(result.status, 'FAIL');
    assert.match(result.detectedErrors.join('\n'), /Error parsing/);
    assert.match(result.reason, /failure indicators/);
  } finally {
    cleanup(fixture.workspace);
  }
});

test('Godot runtime runner detects missing Main.tscn output as FAIL', () => {
  const fixture = makeWorkspace();
  try {
    const result = runRuntimeVerification({
      rawTask: GODOT_TASK,
      projectRoot: fixture.projectRoot,
      toolCallLog: [],
      babelRoot: fixture.babelRoot,
      commandRunner: () =>
        spawnResult(
          '',
          'ERROR: Failed loading resource: res://scenes/Main.tscn. Resource not found.\n',
          1,
        ),
    });

    assert.equal(result.status, 'FAIL');
    assert.match(result.detectedErrors.join('\n'), /Main\.tscn/);
    assert.equal(result.exitCode, 1);
  } finally {
    cleanup(fixture.workspace);
  }
});

test('Godot runtime runner reports tool unavailable when wrapper is missing', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'babel-runtime-verification-no-tool-'));
  const babelRoot = join(workspace, 'Babel');
  const projectRoot = join(workspace, 'example_game_suite', 'Game');
  mkdirSync(babelRoot, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  try {
    const result = runRuntimeVerification({
      rawTask: GODOT_TASK,
      projectRoot,
      toolCallLog: [],
      babelRoot,
    });

    assert.equal(result.status, 'TOOL_UNAVAILABLE');
    assert.match(result.reason, /Godot wrapper unavailable/);
  } finally {
    cleanup(workspace);
  }
});

test('runtime verification runner skips unknown target type with reason', () => {
  const result = runRuntimeVerification({
    rawTask: 'Write docs/readme-notes.md',
    projectRoot: null,
    toolCallLog: [],
    now: () => new Date('2026-04-30T19:40:00.000Z'),
  });

  assert.equal(result.status, 'SKIPPED_WITH_REASON');
  assert.equal(result.targetType, 'unknown');
  assert.match(result.reason, /No known runtime verification target type/);
});

test('runtime verification target detection treats Godot file writes as known', () => {
  const targetType = detectRuntimeVerificationTargetType({
    rawTask: 'Create a mobile game prototype.',
    projectRoot: null,
    toolCallLog: [
      {
        step: 1,
        tool: 'file_write',
        target: 'project.godot',
        exit_code: 0,
        stdout: '',
        stderr: '',
        verified: true,
      },
    ],
  });

  assert.equal(targetType, 'godot');
});

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { ToolCallLog } from '../schemas/agentContracts.js';
import type { RuntimeVerificationResult } from './runtimeVerificationRunner.js';
import {
  evaluateRunnableArtifactGate,
  runnableArtifactGateBlocksCompletion,
  runnableArtifactGateHaltDecision,
} from './runnableArtifactGate.js';

function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

function writeProject(
  root: string,
  content = 'config_version=5\n\n[application]\nconfig/name="GateTest"\nrun/main_scene="res://scenes/Main.tscn"\n',
): void {
  writeFileSync(join(root, 'project.godot'), content, 'utf-8');
}

function writeMainScene(root: string): void {
  mkdirSync(join(root, 'scenes'), { recursive: true });
  writeFileSync(
    join(root, 'scenes', 'Main.tscn'),
    '[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://scripts/main.gd" id="1"]\n[node name="Main" type="Node2D"]\nscript = ExtResource("1")\n',
    'utf-8',
  );
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

function godotVerification(
  stdout = 'Godot Engine v4.6.2.stable\n',
  stderr = '',
  exitCode = 0,
): ToolCallLog {
  return {
    step: 99,
    tool: 'shell_exec',
    target: 'godot --headless --path . --quit',
    exit_code: exitCode,
    stdout,
    stderr,
    verified: exitCode === 0,
  };
}

function runtimeVerification(
  status: RuntimeVerificationResult['status'],
  detectedErrors: string[] = [],
): RuntimeVerificationResult {
  return {
    stage: 'runtime_verification',
    targetType: 'godot',
    projectPath: '/tmp/example_game_suite/Game',
    command:
      'powershell -ExecutionPolicy Bypass -File /tmp/tools/Godot/godot.ps1 --headless --path /tmp/example_game_suite/Game --quit',
    cwd: '/tmp/example_game_suite/Game',
    exitCode: status === 'PASS' ? 0 : status === 'TOOL_UNAVAILABLE' ? null : 1,
    stdoutExcerpt: status === 'PASS' ? 'Godot Engine v4.6.2.stable\n' : '',
    stderrExcerpt: detectedErrors.join('\n'),
    durationMs: 42,
    detectedErrors,
    status,
    reason:
      status === 'PASS' ? 'Godot headless verification passed.' : 'Godot verification failed.',
    timestamp: '2026-04-30T19:30:00.000Z',
  };
}

const GODOT_TASK = 'Build a playable Godot 4 Android-targeted mobile game prototype.';

test('runnable artifact gate fails Godot project missing project.godot', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-runnable-godot-'));
  try {
    writeMainScene(root);
    const result = evaluateRunnableArtifactGate({
      rawTask: GODOT_TASK,
      projectRoot: root,
      toolCallLog: [successfulWrite(1, 'scenes/Main.tscn'), godotVerification()],
    });

    assert.equal(result.status, 'FAIL_REPAIRABLE');
    assert.equal(
      result.failed_artifact_checks.some((check) => check.id === 'GODOT_PROJECT_MISSING'),
      true,
    );
  } finally {
    cleanup(root);
  }
});

test('runnable artifact gate fails Godot project missing scenes/Main.tscn', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-runnable-godot-'));
  try {
    writeProject(root);
    const result = evaluateRunnableArtifactGate({
      rawTask: GODOT_TASK,
      projectRoot: root,
      toolCallLog: [successfulWrite(1, 'project.godot'), godotVerification()],
    });

    assert.equal(result.status, 'FAIL_REPAIRABLE');
    assert.equal(
      result.failed_artifact_checks.some((check) => check.id === 'GODOT_MOBILE_MAIN_SCENE_EXISTS'),
      true,
    );
  } finally {
    cleanup(root);
  }
});

test('runnable artifact gate fails on project.godot parse error evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-runnable-godot-'));
  try {
    writeProject(root, '[general]\nmain_scene = res://Main.tscn\n');
    writeMainScene(root);
    const result = evaluateRunnableArtifactGate({
      rawTask: GODOT_TASK,
      projectRoot: root,
      toolCallLog: [
        successfulWrite(1, 'project.godot'),
        successfulWrite(2, 'scenes/Main.tscn'),
        godotVerification(
          'Godot Engine v4.6.2.stable\n',
          "ERROR: Error parsing 'project.godot' at line 1: Unexpected identifier 'res' File might be corrupted.\nERROR: Couldn't load file 'project.godot', error code 43.\n",
        ),
      ],
    });

    assert.equal(result.status, 'FAIL_REPAIRABLE');
    assert.equal(
      result.failed_artifact_checks.some((check) => check.id === 'GODOT_PROJECT_WELL_FORMED'),
      true,
    );
    assert.equal(
      result.failed_artifact_checks.some(
        (check) => check.id === 'GODOT_HEADLESS_VERIFICATION_FAILED',
      ),
      true,
    );
    assert.match(result.evidence_lines.join('\n'), /Error parsing/);
  } finally {
    cleanup(root);
  }
});

test('runnable artifact gate passes valid minimal Godot scaffold', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-runnable-godot-'));
  try {
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeProject(root);
    writeMainScene(root);
    writeFileSync(
      join(root, 'scripts', 'main.gd'),
      'extends Node2D\nfunc _ready() -> void:\n\tpass\n',
      'utf-8',
    );

    const result = evaluateRunnableArtifactGate({
      rawTask: GODOT_TASK,
      projectRoot: root,
      toolCallLog: [
        successfulWrite(1, 'project.godot'),
        successfulWrite(2, 'scenes/Main.tscn'),
        successfulWrite(3, 'scripts/main.gd'),
        godotVerification(),
      ],
    });

    assert.equal(result.status, 'PASS');
    assert.equal(result.failed_artifact_checks.length, 0);
  } finally {
    cleanup(root);
  }
});

test('runnable artifact gate consumes Babel-owned runtime verification evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-runnable-godot-'));
  try {
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeProject(root);
    writeMainScene(root);
    writeFileSync(
      join(root, 'scripts', 'main.gd'),
      'extends Node2D\nfunc _ready() -> void:\n\tpass\n',
      'utf-8',
    );

    const result = evaluateRunnableArtifactGate({
      rawTask: GODOT_TASK,
      projectRoot: root,
      toolCallLog: [
        successfulWrite(1, 'project.godot'),
        successfulWrite(2, 'scenes/Main.tscn'),
        successfulWrite(3, 'scripts/main.gd'),
      ],
      runtimeVerification: runtimeVerification('PASS'),
    });

    assert.equal(result.status, 'PASS');
    assert.equal(
      result.checks.some((check) => check.id === 'GODOT_HEADLESS_VERIFICATION_PASSED'),
      true,
    );
  } finally {
    cleanup(root);
  }
});

test('runnable artifact gate blocks completion when Godot tool is unavailable', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-runnable-godot-'));
  try {
    writeProject(root);
    writeMainScene(root);
    const result = evaluateRunnableArtifactGate({
      rawTask: GODOT_TASK,
      projectRoot: root,
      toolCallLog: [successfulWrite(1, 'project.godot'), successfulWrite(2, 'scenes/Main.tscn')],
      runtimeVerification: runtimeVerification('TOOL_UNAVAILABLE'),
    });
    const halt = runnableArtifactGateHaltDecision(result);

    assert.equal(runnableArtifactGateBlocksCompletion(result), true);
    assert.equal(halt.haltTag, 'VERIFICATION_TOOL_UNAVAILABLE');
    assert.match(halt.condition, /EXECUTION_HALTED_VERIFICATION_TOOL_UNAVAILABLE/);
  } finally {
    cleanup(root);
  }
});

test('failed runnable artifact gate prevents COMPLETE', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-runnable-godot-'));
  try {
    writeProject(root);
    const result = evaluateRunnableArtifactGate({
      rawTask: GODOT_TASK,
      projectRoot: root,
      toolCallLog: [successfulWrite(1, 'project.godot')],
    });
    const halt = runnableArtifactGateHaltDecision(result);

    assert.equal(runnableArtifactGateBlocksCompletion(result), true);
    assert.equal(halt.haltTag, 'REPAIR_REQUIRED_ARTIFACT_INVALID');
    assert.match(halt.condition, /EXECUTION_HALTED_ARTIFACT_INVALID/);
    assert.match(halt.condition, /NO_RUNTIME_VERIFICATION/);
  } finally {
    cleanup(root);
  }
});

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { ToolCallLog } from '../schemas/agentContracts.js';
import { evaluateRunnableArtifactGate, type RunnableArtifactGateResult } from './runnableArtifactGate.js';
import type { RuntimeVerificationResult } from './runtimeVerificationRunner.js';
import {
  repairGodotBootstrapArtifacts,
  runGodotArtifactRepairLoop,
} from './godotArtifactRepair.js';

const GODOT_TASK = 'Build a playable Godot 4 Android-targeted mobile game prototype.';

function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

function writeTemplate(babelRoot: string): string {
  const template = join(babelRoot, 'templates', 'godot-mobile-2d');
  mkdirSync(join(template, 'scenes'), { recursive: true });
  mkdirSync(join(template, 'scripts'), { recursive: true });
  writeFileSync(join(template, 'project.godot'), 'config_version=5\n\n[application]\nrun/main_scene="res://scenes/Main.tscn"\n', 'utf-8');
  writeFileSync(join(template, 'scenes', 'Main.tscn'), '[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://scripts/Main.gd" id="1_main"]\n[node name="Main" type="Node2D"]\nscript = ExtResource("1_main")\n', 'utf-8');
  writeFileSync(join(template, 'scripts', 'Main.gd'), 'extends Node2D\n', 'utf-8');
  writeFileSync(join(template, 'export_presets.cfg'), '[preset.0]\nplatform="Android"\n', 'utf-8');
  writeFileSync(join(template, 'README.md'), '# Scaffold\n', 'utf-8');
  return template;
}

function writeProject(root: string, content = 'config_version=5\n\n[application]\nrun/main_scene="res://scenes/Main.tscn"\n'): void {
  writeFileSync(join(root, 'project.godot'), content, 'utf-8');
}

function writeMainScene(root: string): void {
  mkdirSync(join(root, 'scenes'), { recursive: true });
  writeFileSync(join(root, 'scenes', 'Main.tscn'), '[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://scripts/Main.gd" id="1_main"]\n[node name="Main" type="Node2D"]\nscript = ExtResource("1_main")\n', 'utf-8');
}

function toolLog(): ToolCallLog[] {
  return [{
    step: 1,
    tool: 'file_write',
    target: 'project.godot',
    exit_code: 0,
    stdout: 'written',
    stderr: '',
    verified: true,
  }];
}

function runtime(status: RuntimeVerificationResult['status']): RuntimeVerificationResult {
  return {
    stage: 'runtime_verification',
    targetType: 'godot',
    projectPath: '/workspace-root/example_game_suite/Game',
    command: 'powershell -ExecutionPolicy Bypass -File /workspace-root/tools/Godot/godot.ps1 --headless --path /workspace-root/example_game_suite/Game --quit',
    cwd: '/workspace-root/example_game_suite/Game',
    exitCode: status === 'PASS' ? 0 : 1,
    stdoutExcerpt: '',
    stderrExcerpt: status === 'PASS' ? '' : 'Parse Error',
    durationMs: 1,
    detectedErrors: status === 'PASS' ? [] : ['Parse Error'],
    status,
    reason: status === 'PASS' ? 'Godot headless verification passed.' : 'Godot failed.',
    timestamp: '2026-04-30T20:00:00.000Z',
  };
}

function gate(root: string, verification: RuntimeVerificationResult = runtime('FAIL')): RunnableArtifactGateResult {
  return evaluateRunnableArtifactGate({
    rawTask: GODOT_TASK,
    projectRoot: root,
    toolCallLog: toolLog(),
    runtimeVerification: verification,
  });
}

test('missing Main.tscn is repaired from scaffold', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-godot-repair-'));
  try {
    const babelRoot = join(root, 'babel');
    const projectRoot = join(root, 'game');
    writeTemplate(babelRoot);
    mkdirSync(projectRoot, { recursive: true });
    writeProject(projectRoot);

    const result = repairGodotBootstrapArtifacts({
      gate: gate(projectRoot),
      projectRoot,
      babelRoot,
      attempt: 1,
    });

    assert.equal(result.status, 'REPAIRED');
    assert.equal(result.filesCopied.includes('scenes/Main.tscn'), true);
    assert.equal(existsSync(join(projectRoot, 'scenes', 'Main.tscn')), true);
  } finally {
    cleanup(root);
  }
});

test('missing main scene config is repaired', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-godot-repair-'));
  try {
    const babelRoot = join(root, 'babel');
    const projectRoot = join(root, 'game');
    writeTemplate(babelRoot);
    mkdirSync(projectRoot, { recursive: true });
    writeProject(projectRoot, 'config_version=5\n\n[application]\nconfig/name="Existing"\n');
    writeMainScene(projectRoot);

    const result = repairGodotBootstrapArtifacts({
      gate: gate(projectRoot),
      projectRoot,
      babelRoot,
      attempt: 1,
    });

    assert.equal(result.status, 'REPAIRED');
    assert.equal(result.filesModified.includes('project.godot'), true);
    assert.match(readFileSync(join(projectRoot, 'project.godot'), 'utf-8'), /run\/main_scene="res:\/\/scenes\/Main\.tscn"/);
  } finally {
    cleanup(root);
  }
});

test('malformed project.godot is repaired only when safe', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-godot-repair-'));
  try {
    const babelRoot = join(root, 'babel');
    const projectRoot = join(root, 'game');
    writeTemplate(babelRoot);
    mkdirSync(projectRoot, { recursive: true });
    writeProject(projectRoot, 'main_scene = res://Main.tscn\n');
    writeMainScene(projectRoot);

    const result = repairGodotBootstrapArtifacts({
      gate: gate(projectRoot),
      projectRoot,
      babelRoot,
      attempt: 1,
    });

    assert.equal(result.status, 'REPAIRED');
    assert.equal(result.filesModified.includes('project.godot'), true);
    assert.match(readFileSync(join(projectRoot, 'project.godot'), 'utf-8'), /config_version=5/);
    assert.match(readFileSync(join(projectRoot, 'project.godot'), 'utf-8'), /run\/main_scene="res:\/\/scenes\/Main\.tscn"/);
  } finally {
    cleanup(root);
  }
});

test('runtime verification reruns after repair', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-godot-repair-'));
  try {
    const babelRoot = join(root, 'babel');
    const projectRoot = join(root, 'game');
    writeTemplate(babelRoot);
    mkdirSync(projectRoot, { recursive: true });
    writeProject(projectRoot);
    let verificationRuns = 0;

    const result = runGodotArtifactRepairLoop({
      rawTask: GODOT_TASK,
      projectRoot,
      toolCallLog: toolLog(),
      initialGate: gate(projectRoot),
      babelRoot,
      runVerification: () => {
        verificationRuns += 1;
        return runtime('PASS');
      },
    });

    assert.equal(verificationRuns, 1);
    assert.equal(result.status, 'REPAIRED_AND_COMPLETE');
    assert.equal(result.attempts.length, 1);
  } finally {
    cleanup(root);
  }
});

test('completion is allowed only after fresh post-repair PASS evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-godot-repair-'));
  try {
    const babelRoot = join(root, 'babel');
    const projectRoot = join(root, 'game');
    writeTemplate(babelRoot);
    mkdirSync(projectRoot, { recursive: true });
    writeProject(projectRoot);
    const passGate = gate(projectRoot, runtime('PASS'));

    const result = runGodotArtifactRepairLoop({
      rawTask: GODOT_TASK,
      projectRoot,
      toolCallLog: toolLog(),
      initialGate: gate(projectRoot),
      babelRoot,
      runVerification: () => runtime('FAIL'),
      evaluateGate: () => passGate,
    });

    assert.notEqual(result.status, 'REPAIRED_AND_COMPLETE');
    assert.equal(result.finalRuntimeVerification?.status, 'FAIL');
  } finally {
    cleanup(root);
  }
});

test('repair budget exceeded blocks completion', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-godot-repair-'));
  try {
    const babelRoot = join(root, 'babel');
    const projectRoot = join(root, 'game');
    writeTemplate(babelRoot);
    mkdirSync(projectRoot, { recursive: true });
    writeProject(projectRoot);

    const result = runGodotArtifactRepairLoop({
      rawTask: GODOT_TASK,
      projectRoot,
      toolCallLog: toolLog(),
      initialGate: gate(projectRoot),
      babelRoot,
      maxRepairAttempts: 1,
      runVerification: () => runtime('FAIL'),
    });

    assert.equal(result.status, 'EXECUTION_HALTED_REPAIR_BUDGET_EXCEEDED');
    assert.equal(result.attempts.length, 1);
  } finally {
    cleanup(root);
  }
});

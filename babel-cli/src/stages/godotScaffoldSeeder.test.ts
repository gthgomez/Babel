import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { seedGodotMobileScaffold } from './godotScaffoldSeeder.js';

const GODOT_TASK = 'Build a playable Godot 4 Android-targeted mobile game prototype.';

function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

function writeTemplate(babelRoot: string): string {
  const template = join(babelRoot, 'templates', 'godot-mobile-2d');
  mkdirSync(join(template, 'scenes'), { recursive: true });
  mkdirSync(join(template, 'scripts'), { recursive: true });
  writeFileSync(join(template, 'project.godot'), 'config_version=5\n\n[application]\nrun/main_scene="res://scenes/Main.tscn"\n', 'utf-8');
  writeFileSync(join(template, 'scenes', 'Main.tscn'), '[gd_scene load_steps=2 format=3]\n[node name="Main" type="Node2D"]\n', 'utf-8');
  writeFileSync(join(template, 'scripts', 'Main.gd'), 'extends Node2D\n', 'utf-8');
  writeFileSync(join(template, 'export_presets.cfg'), '[preset.0]\nplatform="Android"\n', 'utf-8');
  writeFileSync(join(template, 'README.md'), '# Scaffold\n', 'utf-8');
  return template;
}

test('empty Godot target root receives scaffold files', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-godot-seed-'));
  try {
    const babelRoot = join(root, 'babel');
    const targetRoot = join(root, 'game');
    writeTemplate(babelRoot);

    const result = seedGodotMobileScaffold({
      rawTask: GODOT_TASK,
      projectRoot: targetRoot,
      babelRoot,
      now: () => new Date('2026-04-30T20:00:00.000Z'),
    });

    assert.equal(result.status, 'SEEDED');
    assert.deepEqual(result.filesCopied.sort(), [
      'README.md',
      'export_presets.cfg',
      'project.godot',
      'scenes/Main.tscn',
      'scripts/Main.gd',
    ].sort());
    assert.equal(existsSync(join(targetRoot, 'project.godot')), true);
    assert.equal(existsSync(join(targetRoot, 'scenes', 'Main.tscn')), true);
    assert.equal(existsSync(join(targetRoot, 'scripts', 'Main.gd')), true);
  } finally {
    cleanup(root);
  }
});

test('existing files are not overwritten by scaffold seeding', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-godot-seed-'));
  try {
    const babelRoot = join(root, 'babel');
    const targetRoot = join(root, 'game');
    writeTemplate(babelRoot);
    mkdirSync(targetRoot, { recursive: true });
    writeFileSync(join(targetRoot, 'project.godot'), 'custom project file\n', 'utf-8');

    const result = seedGodotMobileScaffold({
      rawTask: GODOT_TASK,
      projectRoot: targetRoot,
      babelRoot,
    });

    assert.equal(result.status, 'SEEDED');
    assert.equal(result.filesSkipped.includes('project.godot'), true);
    assert.equal(readFileSync(join(targetRoot, 'project.godot'), 'utf-8'), 'custom project file\n');
    assert.equal(existsSync(join(targetRoot, 'scenes', 'Main.tscn')), true);
  } finally {
    cleanup(root);
  }
});

test('scaffold evidence artifact records copied and skipped files', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-godot-seed-'));
  try {
    const babelRoot = join(root, 'babel');
    const targetRoot = join(root, 'game');
    writeTemplate(babelRoot);
    mkdirSync(join(targetRoot, 'scripts'), { recursive: true });
    writeFileSync(join(targetRoot, 'scripts', 'Main.gd'), 'extends Node2D\n# existing\n', 'utf-8');

    const result = seedGodotMobileScaffold({
      rawTask: GODOT_TASK,
      projectRoot: targetRoot,
      babelRoot,
      now: () => new Date('2026-04-30T20:00:00.000Z'),
    });

    assert.equal(result.stage, 'godot_scaffold_seed');
    assert.equal(result.targetType, 'godot');
    assert.equal(result.filesCopied.includes('project.godot'), true);
    assert.equal(result.filesSkipped.includes('scripts/Main.gd'), true);
    assert.equal(result.timestamp, '2026-04-30T20:00:00.000Z');
  } finally {
    cleanup(root);
  }
});

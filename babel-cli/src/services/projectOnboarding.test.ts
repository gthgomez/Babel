import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { analyzeProjectRoot } from './projectOnboarding.js';

function makeTempProject(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'babel-onboard-test-'));
  return {
    root,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('analyzeProjectRoot detects Node and TypeScript commands', () => {
  const fixture = makeTempProject();
  try {
    writeFileSync(
      join(fixture.root, 'package.json'),
      JSON.stringify({
        scripts: {
          build: 'tsc',
          test: 'node --test',
          lint: 'eslint .',
        },
      }),
      'utf-8',
    );
    writeFileSync(join(fixture.root, 'tsconfig.json'), '{}\n', 'utf-8');

    const report = analyzeProjectRoot(fixture.root, new Date('2026-04-26T00:00:00.000Z'));

    assert.equal(report.recommended_execution_profile, 'dev_local');
    assert.deepEqual(report.detected_stacks, ['node', 'typescript']);
    assert.ok(report.recommended_commands.install.includes('npm install'));
    assert.ok(report.recommended_commands.build.includes('npm run build'));
    assert.ok(report.recommended_commands.test.includes('npm run test'));
    assert.match(report.context_draft, /Recommended execution profile: `dev_local`/);
  } finally {
    fixture.cleanup();
  }
});

test('analyzeProjectRoot recommends scaffold for an empty directory', () => {
  const fixture = makeTempProject();
  try {
    const report = analyzeProjectRoot(fixture.root, new Date('2026-04-26T00:00:00.000Z'));
    assert.equal(report.recommended_execution_profile, 'scaffold');
    assert.deepEqual(report.detected_stacks, []);
  } finally {
    fixture.cleanup();
  }
});

test('analyzeProjectRoot detects Python pytest projects', () => {
  const fixture = makeTempProject();
  try {
    writeFileSync(join(fixture.root, 'pyproject.toml'), '[tool.pytest.ini_options]\n', 'utf-8');
    mkdirSync(join(fixture.root, 'tests'));

    const report = analyzeProjectRoot(fixture.root, new Date('2026-04-26T00:00:00.000Z'));

    assert.ok(report.detected_stacks.includes('python'));
    assert.ok(report.recommended_commands.test.includes('pytest'));
  } finally {
    fixture.cleanup();
  }
});

test('analyzeProjectRoot detects Godot projects and verification commands', () => {
  const fixture = makeTempProject();
  try {
    writeFileSync(
      join(fixture.root, 'project.godot'),
      '[application]\nrun/main_scene="res://Main.tscn"\n',
      'utf-8',
    );
    writeFileSync(join(fixture.root, 'Main.tscn'), '[gd_scene]\n', 'utf-8');
    writeFileSync(
      join(fixture.root, 'export_presets.cfg'),
      '[preset.0]\nplatform="Android"\n',
      'utf-8',
    );

    const report = analyzeProjectRoot(fixture.root, new Date('2026-04-26T00:00:00.000Z'));

    assert.ok(report.detected_stacks.includes('godot'));
    assert.ok(report.markers.includes('project.godot'));
    assert.ok(report.markers.includes('*.tscn'));
    assert.ok(report.recommended_commands.test.includes('godot --headless --path . --quit'));
  } finally {
    fixture.cleanup();
  }
});

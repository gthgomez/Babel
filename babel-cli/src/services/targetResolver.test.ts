import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { normalizeManifestProjectRoot } from '../pipeline/manifestContext.js';
import { validatePlanTargetsWithinEffectiveRoots } from '../pipeline/targetConsistency.js';
import { resolveAgentTarget } from './targetResolver.js';

function makeWorkspaceFixture(): { root: string; workspace: string; child: string; outside: string } {
  const root = mkdtempSync(join(tmpdir(), 'babel-target-resolver-'));
  const workspace = join(root, 'example_game_suite');
  const child = join(workspace, 'relicRun');
  const outside = join(root, 'OtherProject');
  mkdirSync(child, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(workspace, 'README.md'), '# Project Games\n\nWorkspace for game projects.\n', 'utf-8');
  writeFileSync(join(child, 'package.json'), '{"name":"relic-run"}\n', 'utf-8');
  writeFileSync(join(outside, 'README.md'), '# Other\n', 'utf-8');
  return { root, workspace, child, outside };
}

test('target resolver prefers active child repo over named parent workspace', () => {
  const fixture = makeWorkspaceFixture();
  try {
    const target = resolveAgentTarget({
      project: 'example_game_suite',
      namedProjectRoot: fixture.workspace,
      cwd: fixture.child,
    });

    assert.equal(target.targetRoot, fixture.child);
    assert.equal(target.workspaceRoot, fixture.workspace);
    assert.equal(target.source, 'current_repo');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('target resolver lets explicit project roots win over cwd and named projects', () => {
  const fixture = makeWorkspaceFixture();
  try {
    const target = resolveAgentTarget({
      project: 'example_game_suite',
      projectRoot: fixture.workspace,
      namedProjectRoot: fixture.child,
      cwd: fixture.outside,
    });

    assert.equal(target.targetRoot, fixture.workspace);
    assert.equal(target.source, 'explicit_project_root');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('target resolver still supports named parent projects outside their workspace', () => {
  const fixture = makeWorkspaceFixture();
  try {
    const target = resolveAgentTarget({
      project: 'example_game_suite',
      namedProjectRoot: fixture.workspace,
      cwd: fixture.outside,
    });

    assert.equal(target.targetRoot, fixture.workspace);
    assert.equal(target.workspaceRoot, fixture.workspace);
    assert.equal(target.source, 'named_project');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('manifest target path is clamped to authoritative project root', () => {
  const fixture = makeWorkspaceFixture();
  try {
    const manifest = normalizeManifestProjectRoot({
      target_project: 'example_game_suite',
      target_project_path: '/user-home/example_game_suite',
    } as any, undefined, {
      authoritativeProjectRoot: fixture.child,
    });

    assert.equal(manifest.target_project_path, fixture.child);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('target consistency blocks absolute planned tool targets outside effective root', () => {
  const fixture = makeWorkspaceFixture();
  try {
    const result = validatePlanTargetsWithinEffectiveRoots({
      effectiveTargetRoot: fixture.child,
      approvedRoots: [fixture.workspace],
      targets: [
        join(fixture.child, 'package.json'),
        join(fixture.root, 'outside.txt'),
      ],
    });

    assert.equal(result.ok, false);
    assert.match(result.violations[0] ?? '', /outside the resolved target root/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

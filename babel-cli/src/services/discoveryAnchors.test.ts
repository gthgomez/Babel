import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  buildDiscoveryAnchorWarmupActions,
  MAX_DISCOVERY_ANCHOR_PATHS,
  resolveDiscoveryAnchorPaths,
} from './discoveryAnchors.js';

describe('resolveDiscoveryAnchorPaths', () => {
  it('prioritizes caller seed paths before default anchors', () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-discovery-anchors-'));
    writeFileSync(join(root, 'PROJECT_CONTEXT.md'), '# Context\n', 'utf-8');
    writeFileSync(join(root, 'package.json'), '{}\n', 'utf-8');
    writeFileSync(join(root, 'README.md'), '# Demo\n', 'utf-8');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'focus.ts'), 'export const focus = 1;\n', 'utf-8');

    const anchors = resolveDiscoveryAnchorPaths(root, ['src/focus.ts']);

    assert.deepEqual(anchors[0], 'src/focus.ts');
    assert.ok(anchors.includes('PROJECT_CONTEXT.md'));
  });

  it('detects Godot and Android module anchors', () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-discovery-godot-'));
    writeFileSync(join(root, 'PROJECT_CONTEXT.md'), '# Godot\n', 'utf-8');
    writeFileSync(join(root, 'project.godot'), '[application]\n', 'utf-8');
    mkdirSync(join(root, 'app'), { recursive: true });
    writeFileSync(join(root, 'app', 'build.gradle.kts'), 'plugins { }\n', 'utf-8');

    const anchors = resolveDiscoveryAnchorPaths(root);

    assert.ok(anchors.includes('PROJECT_CONTEXT.md'));
    assert.ok(anchors.includes('project.godot'));
    assert.ok(anchors.includes('app/build.gradle.kts'));
  });

  it('caps anchor paths at the configured maximum', () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-discovery-cap-'));
    const seedPaths = Array.from({ length: 8 }, (_, index) => {
      const relativePath = `src/file-${index}.ts`;
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, relativePath), `export const v${index} = ${index};\n`, 'utf-8');
      return relativePath;
    });

    const anchors = resolveDiscoveryAnchorPaths(root, seedPaths);

    assert.equal(anchors.length, MAX_DISCOVERY_ANCHOR_PATHS);
    assert.deepEqual(anchors, seedPaths.slice(0, MAX_DISCOVERY_ANCHOR_PATHS));
  });
});

describe('buildDiscoveryAnchorWarmupActions', () => {
  it('starts with list_dir and reads each anchor path', () => {
    const actions = buildDiscoveryAnchorWarmupActions(['PROJECT_CONTEXT.md', 'package.json']);

    assert.deepEqual(actions, [
      { type: 'list_dir', path: '.' },
      { type: 'read_file', path: 'PROJECT_CONTEXT.md' },
      { type: 'read_file', path: 'package.json' },
    ]);
  });
});

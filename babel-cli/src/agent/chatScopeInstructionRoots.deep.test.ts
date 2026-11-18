/**
 * TF-24 / Q11 — instruction discovery must reach the enclosing repository root
 * even when the selected project is more than eight directories deep.
 *
 * `instructionIntakeRoots` stopped after eight parents. A deeply nested project
 * therefore never saw `.git` (or the repository-root AGENTS.md) and fell back
 * to the legacy project/parent set, silently dropping repository instructions.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { compileChatStack, instructionIntakeRoots } from './chatStackCompile.js';

function deepPath(root: string, depth: number): string {
  const parts: string[] = [];
  for (let i = 0; i < depth; i++) parts.push(`level-${i}`);
  const full = join(root, ...parts);
  mkdirSync(full, { recursive: true });
  return full;
}

test('twelve levels below a git root still resolves the repository root AGENTS.md', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'babel-deep-instructions-'));
  try {
    mkdirSync(join(fixture, '.git'));
    writeFileSync(join(fixture, 'AGENTS.md'), '# Root rules\nROOT_REPOSITORY_INSTRUCTION_SENTINEL\n');

    const project = deepPath(fixture, 12);
    writeFileSync(join(project, 'AGENTS.md'), '# Local rules\nLEAF_PACKAGE_INSTRUCTION_SENTINEL\n');

    const roots = instructionIntakeRoots(project, fixture);
    assert.ok(roots.includes(fixture), 'repository root must be in the intake roots');
    assert.equal(roots[0], project, 'nearest root stays first');

    const stack = compileChatStack({
      projectRoot: project,
      executionScope: { kind: 'project', projectRoot: project },
      task: 'Inspect the nested package',
    });

    assert.match(stack.system_context, /ROOT_REPOSITORY_INSTRUCTION_SENTINEL/);
    assert.match(stack.system_context, /LEAF_PACKAGE_INSTRUCTION_SENTINEL/);
    const rootIndex = stack.system_context.indexOf('ROOT_REPOSITORY_INSTRUCTION_SENTINEL');
    const leafIndex = stack.system_context.indexOf('LEAF_PACKAGE_INSTRUCTION_SENTINEL');
    assert.ok(rootIndex < leafIndex, 'repository-root instructions must precede the nearer override');
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('intermediate nested AGENTS.md files are accumulated once each', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'babel-deep-instructions-mid-'));
  try {
    mkdirSync(join(fixture, '.git'));
    writeFileSync(join(fixture, 'AGENTS.md'), 'ROOT_LEVEL_SENTINEL\n');
    const middle = deepPath(fixture, 9);
    writeFileSync(join(middle, 'AGENTS.md'), 'MIDDLE_LEVEL_SENTINEL\n');
    const leaf = join(middle, 'leaf');
    mkdirSync(leaf, { recursive: true });
    writeFileSync(join(leaf, 'AGENTS.md'), 'LEAF_LEVEL_SENTINEL\n');

    const stack = compileChatStack({
      projectRoot: leaf,
      executionScope: { kind: 'project', projectRoot: leaf },
      task: 'Inspect the nested package',
    });

    for (const sentinel of ['ROOT_LEVEL_SENTINEL', 'MIDDLE_LEVEL_SENTINEL', 'LEAF_LEVEL_SENTINEL']) {
      assert.equal(
        stack.system_context.split(sentinel).length - 1,
        1,
        `${sentinel} must be delivered exactly once`,
      );
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('discovery stops at the git root and never reads an enclosing project', () => {
  const outer = mkdtempSync(join(tmpdir(), 'babel-deep-instructions-outer-'));
  try {
    writeFileSync(join(outer, 'AGENTS.md'), 'OUTER_PROJECT_MUST_NOT_LOAD\n');
    const repository = join(outer, 'repository');
    mkdirSync(join(repository, '.git'), { recursive: true });
    writeFileSync(join(repository, 'AGENTS.md'), 'REPOSITORY_MUST_LOAD\n');
    const project = deepPath(repository, 10);

    const stack = compileChatStack({
      projectRoot: project,
      executionScope: { kind: 'project', projectRoot: project },
      task: 'Inspect the nested package',
    });

    assert.match(stack.system_context, /REPOSITORY_MUST_LOAD/);
    assert.doesNotMatch(stack.system_context, /OUTER_PROJECT_MUST_NOT_LOAD/);
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
});

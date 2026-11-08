import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { resolveDeclaredTestCommand } from './declaredTestCommand.js';

const roots: string[] = [];

function fixture(scripts: Record<string, string> | undefined): string {
  const root = mkdtempSync(join(tmpdir(), 'babel-declared-test-'));
  roots.push(root);
  if (scripts) writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts }));
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('resolveDeclaredTestCommand', () => {
  it('resolves npm test to the declared script', () => {
    const root = fixture({ test: 'node --test test.mjs' });
    assert.equal(resolveDeclaredTestCommand(root, 'npm test'), 'node --test test.mjs');
    assert.equal(resolveDeclaredTestCommand(root, 'npm run test'), 'node --test test.mjs');
    assert.equal(resolveDeclaredTestCommand(root, 'pnpm test'), 'node --test test.mjs');
    assert.equal(resolveDeclaredTestCommand(root, 'yarn run test'), 'node --test test.mjs');
  });

  it('does not resolve unrelated scripts or non-test invocations', () => {
    const root = fixture({ test: 'node --test', build: 'tsc' });
    assert.equal(resolveDeclaredTestCommand(root, 'npm run build'), undefined);
    assert.equal(resolveDeclaredTestCommand(root, 'npm run test:unit'), undefined);
    assert.equal(resolveDeclaredTestCommand(root, 'node --test'), undefined);
  });

  it('returns undefined when the manifest or script is absent', () => {
    const root = fixture(undefined);
    assert.equal(resolveDeclaredTestCommand(root, 'npm test'), undefined);
    const empty = fixture({ test: '   ' });
    assert.equal(resolveDeclaredTestCommand(empty, 'npm test'), undefined);
  });
});

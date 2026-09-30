/**
 * #216(#4) — reused-engine delivered-instruction manifest refresh.
 *
 * `applyTurnPreparation` replaces projectRoot/instructionRoot/systemContext on a
 * reused TUI engine after construction. The manifest built at construction then
 * misreports what the later turn delivered. These tests assert the refreshed
 * manifest reflects the current turn's root.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, afterEach } from 'node:test';

import { ChatEngine } from './chatEngine.js';

const created: string[] = [];
const previousRunsDir = process.env['BABEL_RUNS_DIR'];

function makeRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  created.push(root);
  return root;
}

function writeAgents(root: string, nonce: string): void {
  writeFileSync(join(root, 'AGENTS.md'), `# Agent Instructions\n${nonce}\n`, 'utf-8');
}

afterEach(() => {
  if (previousRunsDir === undefined) delete process.env['BABEL_RUNS_DIR'];
  else process.env['BABEL_RUNS_DIR'] = previousRunsDir;
  while (created.length > 0) rmSync(created.pop()!, { recursive: true, force: true });
});

describe('#216(#4) reused-engine manifest refresh', () => {
  it('reports the new root after applyTurnPreparation changes projectRoot', () => {
    process.env['BABEL_RUNS_DIR'] = makeRoot('babel-refresh-runs-');
    const rootA = makeRoot('babel-refresh-a-');
    const rootB = makeRoot('babel-refresh-b-');
    writeAgents(rootA, 'NONCE_A_ONLY');
    writeAgents(rootB, 'NONCE_B_ONLY');

    const engine = new ChatEngine({ task: 'first task', projectRoot: rootA });
    const first = engine.getInstructionManifest();
    assert.ok(first, 'engine must expose an instruction manifest after construction');
    const firstAgents = first!.fragments.find((f) => f.rule_id === 'session:agents');
    assert.ok(firstAgents, 'construction manifest must include the delivered AGENTS.md');
    assert.ok(firstAgents!.source.startsWith(rootA));
    assert.match(firstAgents!.content_preview ?? '', /NONCE_A_ONLY/);

    engine.applyTurnPreparation({ task: 'second task', projectRoot: rootB });

    const refreshed = engine.getInstructionManifest();
    assert.ok(refreshed, 'refresh must preserve the manifest');
    const refreshedAgents = refreshed!.fragments.find((f) => f.rule_id === 'session:agents');
    assert.ok(refreshedAgents, 'refreshed manifest must include the new AGENTS.md');
    assert.ok(
      refreshedAgents!.source.startsWith(rootB),
      `refreshed source must be under the new root, got ${refreshedAgents!.source}`,
    );
    assert.match(refreshedAgents!.content_preview ?? '', /NONCE_B_ONLY/);
    assert.equal(
      refreshed!.fragments.some((f) => f.source.startsWith(rootA)),
      false,
      'the stale root must not remain in the refreshed manifest',
    );
  });

  it('leaves a fresh engine manifest intact when no preparation changes are made', () => {
    process.env['BABEL_RUNS_DIR'] = makeRoot('babel-refresh-runs-');
    const root = makeRoot('babel-refresh-same-');
    writeAgents(root, 'NONCE_SAME');
    const engine = new ChatEngine({ task: 'same root', projectRoot: root });
    const before = engine.getInstructionManifest();
    engine.applyTurnPreparation({ task: 'same root again', projectRoot: root });
    const after = engine.getInstructionManifest();
    assert.ok(before && after);
    assert.equal(
      after!.fragments.find((f) => f.rule_id === 'session:agents')?.delivered_content_digest,
      before!.fragments.find((f) => f.rule_id === 'session:agents')?.delivered_content_digest,
      'same root must refresh to the same delivered digest',
    );
  });
});

/**
 * W2.2 tests — explore feeder agent + evidence pack schema.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'node:test';
import {
  absorbExploreToolCalls,
  createEmptyEvidencePack,
  evaluateExploreFeederBudget,
  evaluateExploreWriteAttempt,
  formatEvidencePackForImplementHandoff,
  runExploreFeederAgent,
  runExploreFeederAgentLive,
  suggestWriteScopeFromEvidencePack,
  synthesizeEvidencePackFromSeeds,
  validateEvidencePack,
} from './exploreFeederAgent.js';

const liveTempRoots: string[] = [];
afterEach(() => {
  for (const root of liveTempRoots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

describe('exploreFeederAgent write gate', () => {
  it('blocks str_replace, write_file, apply_patch, and sub_agent', () => {
    for (const tool of ['str_replace', 'write_file', 'apply_patch', 'sub_agent']) {
      const r = evaluateExploreWriteAttempt(tool);
      assert.equal(r.blocked, true, tool);
      assert.ok(r.observation?.includes('read-only'));
    }
  });

  it('allows read/grep/glob', () => {
    for (const tool of ['read_file', 'grep', 'glob', 'list_dir']) {
      assert.equal(evaluateExploreWriteAttempt(tool).blocked, false, tool);
    }
  });
});

describe('exploreFeederAgent budget', () => {
  it('exhausts on max rounds or max tools', () => {
    assert.equal(
      evaluateExploreFeederBudget({
        roundsUsed: 6,
        toolsUsed: 3,
        maxRounds: 6,
        maxTools: 12,
      }).exhausted,
      true,
    );
    assert.equal(
      evaluateExploreFeederBudget({
        roundsUsed: 1,
        toolsUsed: 12,
        maxRounds: 6,
        maxTools: 12,
      }).exhausted,
      true,
    );
    assert.equal(
      evaluateExploreFeederBudget({
        roundsUsed: 2,
        toolsUsed: 4,
        maxRounds: 6,
        maxTools: 12,
      }).exhausted,
      false,
    );
  });
});

describe('evidence pack schema', () => {
  it('validates empty pack with agent + task', () => {
    const pack = createEmptyEvidencePack({
      agentId: 'exp-1',
      task: 'Find where X is defined',
      now: new Date('2026-07-15T15:00:00.000Z'),
    });
    const v = validateEvidencePack(pack);
    assert.equal(v.ok, true, v.diagnostics.map((d) => d.message).join('; '));
    assert.equal(pack.write_count, 0);
    assert.equal(pack.schema_version, 1);
  });

  it('rejects write_count > 0', () => {
    const pack = createEmptyEvidencePack({ agentId: 'e', task: 't' });
    pack.write_count = 1;
    const v = validateEvidencePack(pack);
    assert.equal(v.ok, false);
    assert.ok(v.diagnostics.some((d) => d.code === 'explore_must_not_write'));
  });
});

describe('absorbExploreToolCalls', () => {
  it('collects paths and blocks writes without incrementing write_count', () => {
    const pack = createEmptyEvidencePack({ agentId: 'e', task: 't' });
    const next = absorbExploreToolCalls(pack, [
      { tool: 'read_file', target: 'src/foo.ts' },
      { tool: 'str_replace', target: 'src/foo.ts', error: 'blocked' },
      { tool: 'grep', target: 'bar @ src/bar.ts' },
    ]);
    assert.equal(next.write_count, 0);
    assert.equal(next.write_attempts_blocked, 1);
    assert.ok(next.paths.includes('src/foo.ts'));
    assert.ok(next.paths.includes('src/bar.ts'));
  });
});

describe('runExploreFeederAgent', () => {
  it('produces valid pack + optional implement handoff', () => {
    const result = runExploreFeederAgent(
      {
        id: 'explore-w22',
        task: 'Fix off-by-one in src/parser.ts',
        seedPaths: ['src/parser.ts', 'src/parser.test.ts'],
        seedSymbols: [{ name: 'parseLine', path: 'src/parser.ts', kind: 'function' }],
        maxRounds: 4,
        maxTools: 8,
      },
      {
        now: new Date('2026-07-15T15:00:00.000Z'),
        toolCalls: [
          { tool: 'read_file', target: 'src/parser.ts' },
          { tool: 'write_file', target: 'src/parser.ts' },
        ],
        withImplementHandoff: true,
      },
    );
    assert.equal(result.success, true, result.error ?? '');
    assert.equal(result.evidencePack.write_count, 0);
    assert.equal(result.evidencePack.write_attempts_blocked, 1);
    assert.ok(result.evidencePack.paths.includes('src/parser.ts'));
    assert.ok(result.evidencePack.hypothesized_edits.length >= 1);
    assert.ok(result.implementHandoff?.includes('Explore → Implement'));
    assert.ok(result.implementHandoff?.includes('src/parser.ts'));
    assert.ok(result.implementHandoff?.includes('Suggested write_scope'));
  });

  it('rejects empty task', () => {
    const result = runExploreFeederAgent({ id: 'e', task: '' });
    assert.equal(result.success, false);
    assert.ok(result.diagnostics.some((d) => d.code === 'task_required'));
  });

  it('suggestWriteScopeFromEvidencePack prefers hypothesized edits', () => {
    const pack = synthesizeEvidencePackFromSeeds(
      {
        id: 'e',
        task: 'fix',
        seedPaths: ['src/a.ts', 'docs'],
      },
      {
        hypothesizedEdits: [{ path: 'src/a.ts', summary: 'fix bug' }],
      },
    );
    const scope = suggestWriteScopeFromEvidencePack(pack);
    assert.ok(scope.includes('src/a.ts'));
  });

  it('formatEvidencePackForImplementHandoff is implement-ready text', () => {
    const pack = synthesizeEvidencePackFromSeeds({
      id: 'exp',
      task: 'Add logging',
      seedPaths: ['src/log.ts'],
    });
    const text = formatEvidencePackForImplementHandoff(pack);
    assert.ok(text.includes('IMPLEMENT agent'));
    assert.ok(text.includes('Add logging'));
  });
});

describe('runExploreFeederAgentLive (W2.2 read-only loop)', () => {
  it('runs deterministic read-only discovery with write_count=0', async () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-explore-live-'));
    liveTempRoots.push(root);
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'parser.ts'), 'export const x = 1;\n', 'utf-8');

    const result = await runExploreFeederAgentLive(
      {
        id: 'explore-live',
        task: 'Locate parser entrypoints',
        seedPaths: ['src/parser.ts'],
        maxRounds: 3,
        maxTools: 10,
      },
      {
        projectRoot: root,
        useDeterministicMock: true,
        withImplementHandoff: true,
      },
    );

    assert.equal(result.success, true, result.error ?? result.summary);
    assert.equal(result.evidencePack.write_count, 0);
    assert.ok(result.readOnly);
    assert.ok((result.readOnly?.toolCallCount ?? 0) >= 1);
    assert.ok(result.evidencePack.paths.includes('src/parser.ts'));
    assert.ok(result.implementHandoff?.includes('Explore → Implement'));
  });
});

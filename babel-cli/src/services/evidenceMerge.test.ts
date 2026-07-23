/**
 * evidenceMerge.test.ts — Tests for evidence-aware merge (P1.1)
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { scoreEvidenceQuality, mergeWithEvidence, mergeArenaFindings } from './evidenceMerge.js';
import type { MergeableFinding, EvidenceMergeInput, EvidenceWeight } from './evidenceMerge.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeFinding(
  agentId: string,
  category: string,
  content: string,
  priority: 'critical' | 'high' | 'medium' | 'low' = 'medium',
): MergeableFinding {
  return { agentId, category, content, priority };
}

function makeWeight(agentId: string, quality: number): EvidenceWeight {
  return {
    agentId,
    quality,
    dimensions: {
      completeness: quality,
      verifiability: quality,
      consistency: quality,
    },
  };
}

// ── scoreEvidenceQuality Tests ─────────────────────────────────────────────────

describe('scoreEvidenceQuality', () => {
  it('scores an agent with diverse findings higher', () => {
    const findings = [
      makeFinding('agent-1', 'risk', 'Security risk in auth module'),
      makeFinding('agent-1', 'scope', 'Scope covers 3 files'),
      makeFinding('agent-1', 'verification', 'Verify with npm test'),
    ];
    const weight = scoreEvidenceQuality('agent-1', findings);
    assert.ok(weight.quality >= 5, `Expected quality >= 5, got ${weight.quality}`);
    assert.ok(weight.dimensions.completeness >= 6);
    assert.ok(weight.dimensions.verifiability >= 5);
  });

  it('scores an agent with sparse findings lower', () => {
    const findings = [makeFinding('agent-2', 'risk', 'ok')];
    const weight = scoreEvidenceQuality('agent-2', findings);
    assert.ok(weight.quality <= 7, `Expected quality <= 7, got ${weight.quality}`);
    assert.ok(weight.dimensions.completeness <= 7);
    assert.ok(weight.dimensions.verifiability <= 6);
  });

  it('rewards verifiable claims', () => {
    const findings = [
      makeFinding('agent-v', 'risk', 'The file src/auth.ts line 42 has an unsafe assert'),
      makeFinding('agent-v', 'scope', 'Check function validateToken in module auth'),
    ];
    const weight = scoreEvidenceQuality('agent-v', findings);
    assert.ok(
      weight.dimensions.verifiability >= 6,
      `Expected verifiability >= 6, got ${weight.dimensions.verifiability}`,
    );
  });

  it('only scores findings from the specified agent', () => {
    const findings = [
      makeFinding('agent-x', 'risk', 'Finding from X'),
      makeFinding('agent-y', 'scope', 'Finding from Y'),
    ];
    const weight = scoreEvidenceQuality('agent-x', findings);
    // Only one finding for agent-x
    assert.ok(weight.dimensions.completeness <= 6);
  });
});

// ── mergeWithEvidence Tests ────────────────────────────────────────────────────

describe('mergeWithEvidence', () => {
  it('auto-accepts non-critical findings from high-evidence agents, reviews critical ones', () => {
    const input: EvidenceMergeInput = {
      findings: [
        makeFinding('trusted', 'scope', 'Plan covers auth.ts and auth.test.ts'),
        makeFinding('trusted', 'verification', 'Verify with npm test'),
      ],
      weights: [makeWeight('trusted', 9)],
      autoAcceptThreshold: 5,
    };

    const report = mergeWithEvidence(input);
    assert.equal(report.acceptedCount, 2);
    assert.equal(report.reviewCount, 0);
    assert.equal(report.discardedCount, 0);
    assert.ok(report.findings.every((f) => f.disposition === 'accept'));
  });

  it('flags findings from low-evidence solo agents for review', () => {
    const input: EvidenceMergeInput = {
      findings: [makeFinding('untrusted', 'risk', 'Possible issue?', 'medium')],
      weights: [makeWeight('untrusted', 3)],
      autoAcceptThreshold: 5,
    };

    const report = mergeWithEvidence(input);
    assert.equal(report.reviewCount + report.discardedCount, 1);
    assert.ok(report.findings[0]!.disposition !== 'accept');
  });

  it('deduplicates identical findings from multiple agents', () => {
    const input: EvidenceMergeInput = {
      findings: [
        makeFinding('agent-a', 'risk', 'Missing input validation in auth.ts'),
        makeFinding('agent-b', 'risk', 'Missing input validation in auth.ts'),
      ],
      weights: [makeWeight('agent-a', 8), makeWeight('agent-b', 7)],
    };

    const report = mergeWithEvidence(input);
    // Should be deduplicated to one finding with both agents
    assert.equal(report.findings.length, 1);
    assert.deepEqual(report.findings[0]!.agents.sort(), ['agent-a', 'agent-b']);
  });

  it('prioritizes critical findings for review even from high-evidence agents', () => {
    const input: EvidenceMergeInput = {
      findings: [makeFinding('good-agent', 'risk', 'Critical security vulnerability', 'critical')],
      weights: [makeWeight('good-agent', 9)],
      autoAcceptThreshold: 5,
    };

    const report = mergeWithEvidence(input);
    // Critical findings always go to review (safety-first)
    assert.equal(report.findings[0]!.disposition, 'review');
    assert.ok(report.findings[0]!.reviewReason?.includes('Critical'));
  });

  it('handles mixed evidence quality gracefully', () => {
    const input: EvidenceMergeInput = {
      findings: [makeFinding('strong', 'risk', 'Risk A'), makeFinding('weak', 'risk', 'Risk B')],
      weights: [makeWeight('strong', 8), makeWeight('weak', 3)],
    };

    const report = mergeWithEvidence(input);
    assert.equal(report.findings.length, 2);
    const strongFinding = report.findings.find((f) => f.agents.includes('strong'));
    const weakFinding = report.findings.find((f) => f.agents.includes('weak'));
    assert.ok(strongFinding);
    assert.ok(weakFinding);
    // Strong agent's finding should be accepted, weak agent's reviewed/discarded
    assert.equal(strongFinding!.disposition, 'accept');
    assert.ok(weakFinding!.disposition !== 'accept');
  });

  it('sorts findings: accepted first, then review, then discarded', () => {
    const input: EvidenceMergeInput = {
      findings: [
        makeFinding('low', 'scope', 'Discardable finding'),
        makeFinding('high', 'risk', 'Auto-accepted finding'),
        makeFinding('mid', 'verification', 'Reviewable finding'),
      ],
      weights: [makeWeight('high', 9), makeWeight('mid', 5), makeWeight('low', 2)],
      autoAcceptThreshold: 5,
    };

    const report = mergeWithEvidence(input);
    const dispositions = report.findings.map((f) => f.disposition);
    // accept before review before discard
    const acceptIdx = dispositions.indexOf('accept');
    const reviewIdx = dispositions.indexOf('review');
    const discardIdx = dispositions.indexOf('discard');
    if (acceptIdx >= 0 && reviewIdx >= 0) assert.ok(acceptIdx < reviewIdx);
    if (reviewIdx >= 0 && discardIdx >= 0) assert.ok(reviewIdx < discardIdx);
  });

  it('writes evidence report when runDir is provided', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'babel-evidence-merge-'));
    try {
      const input: EvidenceMergeInput = {
        findings: [makeFinding('agent', 'risk', 'Test finding')],
        weights: [makeWeight('agent', 7)],
        runDir: tmpDir,
      };

      mergeWithEvidence(input);
      assert.ok(existsSync(join(tmpDir, 'evidence_merge_report.json')));
      const report = JSON.parse(readFileSync(join(tmpDir, 'evidence_merge_report.json'), 'utf-8'));
      assert.equal(report.findings.length, 1);
      assert.equal(report.acceptedCount + report.reviewCount + report.discardedCount, 1);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── mergeArenaFindings Tests ───────────────────────────────────────────────────

describe('mergeArenaFindings', () => {
  it('merges findings from arena entries weighted by scores', () => {
    const entries = [
      {
        agentId: 'winner',
        score: { total: 9, completeness: 9, riskAwareness: 8, scopeControl: 9, verifiability: 8 },
        strengths: ['Well-scoped plan', 'Good verification'],
        weaknesses: ['Minor scope detail missing'],
      },
      {
        agentId: 'runner-up',
        score: { total: 6, completeness: 6, riskAwareness: 5, scopeControl: 7, verifiability: 6 },
        strengths: ['Conservative approach'],
        weaknesses: ['Incomplete risk analysis', 'Missing test coverage'],
      },
    ];

    const report = mergeArenaFindings(entries);
    assert.ok(report.findings.length >= 2);
    assert.ok(report.agentWeights.length === 2);
    assert.equal(report.agentWeights[0]!.quality, 9);
    assert.equal(report.agentWeights[1]!.quality, 6);

    // Winner's strengths should be accepted, runner-up's weaknesses reviewed
    const winnerStrengths = report.findings.filter(
      (f) => f.agents.includes('winner') && f.category === 'strength',
    );
    const runnerUpWeaknesses = report.findings.filter(
      (f) => f.agents.includes('runner-up') && f.category === 'weakness',
    );
    assert.ok(winnerStrengths.length > 0);
    assert.ok(runnerUpWeaknesses.length > 0);
  });

  it('flags critical weaknesses even from high-scoring entries', () => {
    const entries = [
      {
        agentId: 'top',
        score: { total: 9, completeness: 9, riskAwareness: 9, scopeControl: 9, verifiability: 9 },
        strengths: ['Excellent plan'],
        weaknesses: ['Critical security oversight in auth flow'],
      },
    ];

    const report = mergeArenaFindings(entries);
    const criticalFinding = report.findings.find((f) => f.priority === 'critical');
    assert.ok(criticalFinding);
    assert.equal(criticalFinding!.disposition, 'review');
  });
});

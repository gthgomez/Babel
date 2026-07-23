/**
 * evidenceMerge.ts — Evidence-Aware Agent Merge (P1.1)
 *
 * Weighs subagent results by evidence quality when merging outputs.
 * Higher-evidence agents' findings carry more weight; lower-evidence
 * agents' findings are flagged for human review.
 *
 * Works with arena entries, plan reviews, Spark agents, and agent team
 * results — any subagent that produces scorable output.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ── Types ────────────────────────────────────────────────────────────────────────

export interface EvidenceWeight {
  /** Agent identifier */
  agentId: string;
  /** Evidence quality score (1-10, higher = more trustworthy) */
  quality: number;
  /** Dimension scores for transparency */
  dimensions: {
    /** How complete is the agent's evidence? */
    completeness: number;
    /** How verifiable are the agent's claims? */
    verifiability: number;
    /** How consistent is the agent with known ground truth? */
    consistency: number;
  };
}

export interface MergeableFinding {
  /** Agent that produced this finding */
  agentId: string;
  /** Category: risk, scope, implementation, verification, etc. */
  category: string;
  /** The finding content */
  content: string;
  /** Priority: critical, high, medium, low */
  priority: 'critical' | 'high' | 'medium' | 'low';
}

export interface EvidenceMergeInput {
  /** Findings from all subagents */
  findings: MergeableFinding[];
  /** Evidence weights for each agent */
  weights: EvidenceWeight[];
  /** Minimum quality threshold for auto-accept (default 5) */
  autoAcceptThreshold?: number;
  /** Merge run directory for writing evidence artifacts */
  runDir?: string;
}

export interface EvidenceMergeFinding {
  content: string;
  agents: string[];
  category: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  /** Weighted score: sum of (agent quality × relevance) */
  weightedScore: number;
  /** Auto-accept, review, or discard */
  disposition: 'accept' | 'review' | 'discard';
  /** If review: reason this needs human attention */
  reviewReason?: string;
}

export interface EvidenceMergeReport {
  findings: EvidenceMergeFinding[];
  acceptedCount: number;
  reviewCount: number;
  discardedCount: number;
  agentWeights: EvidenceWeight[];
  summary: string;
  recommendation: string;
}

// ── Evidence Quality Scoring ───────────────────────────────────────────────────

/**
 * Score an agent's evidence quality based on the structured output it produced.
 * Higher scores indicate more trustworthy findings.
 */
export function scoreEvidenceQuality(
  agentId: string,
  findings: MergeableFinding[],
): EvidenceWeight {
  const agentFindings = findings.filter((f) => f.agentId === agentId);

  // Completeness: does the agent have findings across multiple categories?
  const categories = new Set(agentFindings.map((f) => f.category));
  const completeness = Math.min(10, 3 + categories.size * 2);

  // Verifiability: do findings contain specific, checkable claims?
  const verifiableCount = agentFindings.filter((f) =>
    /\b(?:file|path|line|function|class|module|import|export|test|assert|verify|check)\b/i.test(
      f.content,
    ),
  ).length;
  const verifiability = Math.min(10, 2 + verifiableCount * 2);

  // Consistency: do findings avoid internal contradictions?
  let consistency = 7;
  for (let i = 0; i < agentFindings.length; i++) {
    for (let j = i + 1; j < agentFindings.length; j++) {
      if (agentFindings[i]!.priority === 'critical' && agentFindings[j]!.priority === 'low') {
        // Mixed priorities without clear distinction — slight penalty
        consistency = Math.max(1, consistency - 1);
      }
    }
  }

  const quality = Math.round((completeness + verifiability + consistency) / 3);

  return {
    agentId,
    quality,
    dimensions: { completeness, verifiability, consistency },
  };
}

// ── Merge Logic ────────────────────────────────────────────────────────────────

interface DedupKey {
  category: string;
  normalized: string;
}

function normalize(content: string): string {
  return content
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function dedupKey(finding: MergeableFinding): DedupKey {
  return {
    category: finding.category,
    normalized: normalize(finding.content),
  };
}

/**
 * Merge subagent findings with evidence-aware weighting.
 *
 * Algorithm:
 * 1. Group findings by category and deduplicate
 * 2. Weight each finding by the quality of its source agent(s)
 * 3. Auto-accept findings above the quality threshold from high-evidence agents
 * 4. Flag findings from low-evidence agents for human review
 * 5. Discard duplicate findings from lower-evidence agents
 */
export function mergeWithEvidence(input: EvidenceMergeInput): EvidenceMergeReport {
  const threshold = input.autoAcceptThreshold ?? 5;
  const weightMap = new Map(input.weights.map((w) => [w.agentId, w]));

  // Group by dedup key, tracking all agents that found each
  const grouped = new Map<string, { findings: MergeableFinding[]; agents: Set<string> }>();
  for (const finding of input.findings) {
    const key = JSON.stringify(dedupKey(finding));
    const existing = grouped.get(key);
    if (existing) {
      existing.findings.push(finding);
      existing.agents.add(finding.agentId);
    } else {
      grouped.set(key, {
        findings: [finding],
        agents: new Set([finding.agentId]),
      });
    }
  }

  const merged: EvidenceMergeFinding[] = [];

  for (const [, group] of grouped) {
    const primary = group.findings[0]!;
    const agents = [...group.agents];

    // Weighted score: average of contributing agent qualities
    const agentQualities = agents.map((id) => weightMap.get(id)?.quality ?? 5).filter((q) => q > 0);
    const weightedScore =
      agentQualities.length > 0
        ? Math.round(agentQualities.reduce((a, b) => a + b, 0) / agentQualities.length)
        : 5;

    // Determine disposition
    let disposition: EvidenceMergeFinding['disposition'];
    let reviewReason: string | undefined;

    const allHighQuality = agentQualities.every((q) => q >= threshold);
    const anyCritical = group.findings.some((f) => f.priority === 'critical');

    if (anyCritical) {
      disposition = 'review';
      reviewReason = 'Critical finding requires human confirmation.';
    } else if (allHighQuality && weightedScore >= 7) {
      disposition = 'accept';
    } else if (weightedScore >= threshold) {
      disposition = 'review';
      if (!allHighQuality) {
        reviewReason = `Mixed evidence quality (avg: ${weightedScore}/10). Agents: ${agents.join(', ')}.`;
      }
    } else if (agents.length === 1 && weightedScore < 4) {
      disposition = 'discard';
      reviewReason = `Single low-evidence agent (quality: ${weightedScore}/10).`;
    } else {
      disposition = 'review';
      reviewReason = `Below auto-accept threshold (${weightedScore}/10 < ${threshold}). Confirm manually.`;
    }

    merged.push({
      content: primary.content,
      agents,
      category: primary.category,
      priority: primary.priority,
      weightedScore,
      disposition,
      ...(reviewReason !== undefined ? { reviewReason } : {}),
    });
  }

  // Sort: accepted first, then review, then discarded; within each, by priority
  const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  merged.sort((a, b) => {
    const dispOrder = { accept: 0, review: 1, discard: 2 };
    const dispDiff = dispOrder[a.disposition] - dispOrder[b.disposition];
    if (dispDiff !== 0) return dispDiff;
    return priorityOrder[a.priority] - priorityOrder[b.priority];
  });

  const acceptedCount = merged.filter((f) => f.disposition === 'accept').length;
  const reviewCount = merged.filter((f) => f.disposition === 'review').length;
  const discardedCount = merged.filter((f) => f.disposition === 'discard').length;

  const summary = [
    `Evidence-aware merge: ${merged.length} unique findings from ${input.weights.length} agent(s).`,
    `Auto-accepted: ${acceptedCount}, Review: ${reviewCount}, Discarded: ${discardedCount}.`,
    `Agent quality: ${input.weights.map((w) => `${w.agentId}=${w.quality}/10`).join(', ')}.`,
  ].join(' ');

  const recommendation =
    reviewCount > 0
      ? `${reviewCount} finding(s) flagged for review. Focus on critical and high-priority items first.`
      : `All ${acceptedCount} findings accepted. Evidence quality is sufficient for automatic merge.`;

  // Write evidence if runDir provided
  if (input.runDir) {
    try {
      mkdirSync(input.runDir, { recursive: true });
      writeFileSync(
        join(input.runDir, 'evidence_merge_report.json'),
        JSON.stringify(
          {
            schema_version: 1,
            summary,
            recommendation,
            acceptedCount,
            reviewCount,
            discardedCount,
            findings: merged,
            agentWeights: input.weights,
          },
          null,
          2,
        ),
        'utf-8',
      );
    } catch {
      /* best effort */
    }
  }

  return {
    findings: merged,
    acceptedCount,
    reviewCount,
    discardedCount,
    agentWeights: input.weights,
    summary,
    recommendation,
  };
}

/**
 * Merge findings from an arena comparison, weighting by entry scores.
 */
export function mergeArenaFindings(
  arenaEntries: Array<{
    agentId: string;
    score: {
      total: number;
      completeness: number;
      riskAwareness: number;
      scopeControl: number;
      verifiability: number;
    };
    strengths: string[];
    weaknesses: string[];
  }>,
  runDir?: string,
): EvidenceMergeReport {
  const weights: EvidenceWeight[] = arenaEntries.map((entry) => ({
    agentId: entry.agentId,
    quality: entry.score.total,
    dimensions: {
      completeness: entry.score.completeness,
      verifiability: entry.score.verifiability,
      consistency: entry.score.scopeControl, // reuse scope as consistency proxy
    },
  }));

  const findings: MergeableFinding[] = [];
  for (const entry of arenaEntries) {
    for (const strength of entry.strengths) {
      findings.push({
        agentId: entry.agentId,
        category: 'strength',
        content: strength,
        priority: 'medium',
      });
    }
    for (const weakness of entry.weaknesses) {
      const priority = /\b(?:critical|security|breaking|missing|unsafe)\b/i.test(weakness)
        ? ('critical' as const)
        : ('high' as const);
      findings.push({
        agentId: entry.agentId,
        category: 'weakness',
        content: weakness,
        priority,
      });
    }
  }

  return mergeWithEvidence({
    findings,
    weights,
    ...(runDir !== undefined ? { runDir } : {}),
  });
}

/**
 * daemon/resourceOptimizer.ts — Multi-model routing (Phase 11)
 *
 * Routes daemon jobs to the most appropriate model based on task
 * characteristics. Tracks per-model usage statistics for cost optimization.
 * Babel differentiator: no competitor daemon routes background jobs
 * across a multi-model fleet.
 */

import type { AgentJob } from '../services/agentJobs.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ModelRecommendation {
  model: string;
  tier: string;
  reason: string;
}

export interface ModelStats {
  model: string;
  jobCount: number;
  successCount: number;
  failureCount: number;
  totalCostUsd: number;
  avgDurationMs: number;
}

export interface OptimizerStats {
  recommendations: number;
  models: ModelStats[];
}

// ── Heuristics ───────────────────────────────────────────────────────────────

/**
 * Recommend the best model for a job based on task characteristics.
 * Heuristics ordered by specificity (most specific first).
 */
export function recommendModel(job: AgentJob): ModelRecommendation {
  const task = job.task;
  const tags = job.tags ?? [];
  const taskLen = task.length;

  // Tags are the strongest signal
  if (tags.includes('reasoning') || tags.includes('deep')) {
    return { model: 'deepseek-v4', tier: 'expensive', reason: 'tag: reasoning/deep' };
  }
  if (tags.includes('fast') || tags.includes('quick')) {
    return { model: 'qwen3-32b', tier: 'cheap', reason: 'tag: fast/quick' };
  }
  if (tags.includes('large-context') || tags.includes('long-context')) {
    return { model: 'gemini', tier: 'expensive', reason: 'tag: large-context' };
  }

  // Task length heuristics
  if (taskLen < 100) {
    return { model: 'qwen3-32b', tier: 'cheap', reason: 'short task (< 100 chars)' };
  }
  if (taskLen > 500) {
    return { model: 'deepseek-v4', tier: 'expensive', reason: 'long task (> 500 chars)' };
  }

  // Content-based heuristics
  if (/\b(refactor|migrate|restructure|architect)\b/i.test(task)) {
    return {
      model: 'deepseek-v4',
      tier: 'expensive',
      reason: 'complex: refactor/migrate/architect',
    };
  }
  if (/\b(fix|repair|bug|test)\b/i.test(task)) {
    return { model: 'deepseek-v4', tier: 'expensive', reason: 'precision: fix/repair/bug/test' };
  }
  if (/\b(read|report|analyze|review|audit|check)\b/i.test(task)) {
    return { model: 'qwen3-32b', tier: 'cheap', reason: 'read-only: read/report/analyze' };
  }

  // Default: cheap model for simple tasks
  return { model: 'qwen3-32b', tier: 'cheap', reason: 'default (simple task)' };
}

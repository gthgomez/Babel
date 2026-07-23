/**
 * modelSuccessTracker.ts — Track model success/failure per task type
 *
 * Phase 4E: Records outcomes per model and task complexity to
 * enable cost-aware routing decisions. Persists to .babel/model-tracking.json.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ModelRunRecord {
  model: string;
  provider: string;
  stage: string;
  taskComplexity: 'low' | 'medium' | 'high';
  success: boolean;
  tokensUsed: number;
  costUsd: number;
  latencyMs: number;
  timestamp: string;
}

export interface ModelStats {
  model: string;
  totalRuns: number;
  successRate: number;
  avgTokens: number;
  avgCostUsd: number;
  avgLatencyMs: number;
  lastUsed: string;
}

export interface ModelTrackingData {
  schemaVersion: 1;
  updatedAt: string;
  records: ModelRunRecord[];
}

const MAX_RECORDS = 200;

function loadTrackingData(projectRoot?: string): ModelTrackingData {
  const root = projectRoot ?? process.cwd();
  const trackingDir = join(root, '.babel');
  const trackingPath = join(trackingDir, 'model-tracking.json');

  if (!existsSync(trackingPath)) {
    return { schemaVersion: 1, updatedAt: new Date().toISOString(), records: [] };
  }

  try {
    return JSON.parse(readFileSync(trackingPath, 'utf-8')) as ModelTrackingData;
  } catch {
    return { schemaVersion: 1, updatedAt: new Date().toISOString(), records: [] };
  }
}

function saveTrackingData(data: ModelTrackingData, projectRoot?: string): void {
  const root = projectRoot ?? process.cwd();
  const trackingDir = join(root, '.babel');
  if (!existsSync(trackingDir)) {
    mkdirSync(trackingDir, { recursive: true });
  }
  data.updatedAt = new Date().toISOString();
  writeFileSync(join(trackingDir, 'model-tracking.json'), JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * Call this in pipeline finalization (_runBabelPipelineInternal) after run completion:
 *   import { recordModelRun } from './services/modelSuccessTracker.js';
 *   recordModelRun({
 *     model: resolvedModel,
 *     provider: resolvedProvider,
 *     stage: 'execution',
 *     taskComplexity: taskComplexity as 'low' | 'medium' | 'high',
 *     success: result.status === 'COMPLETE',
 *     tokensUsed: metadata.totalTokens,
 *     costUsd: metadata.costUsd,
 *     latencyMs: metadata.latencyMs,
 *     timestamp: new Date().toISOString(),
 *   });
 */
export function recordModelRun(record: ModelRunRecord, projectRoot?: string): void {
  const data = loadTrackingData(projectRoot);
  data.records.push(record);

  // Keep only the most recent records
  if (data.records.length > MAX_RECORDS) {
    data.records = data.records.slice(-MAX_RECORDS);
  }

  saveTrackingData(data, projectRoot);
}

export function getModelStats(projectRoot?: string): ModelStats[] {
  const data = loadTrackingData(projectRoot);
  const modelMap = new Map<string, ModelRunRecord[]>();

  for (const record of data.records) {
    const key = record.model;
    const list = modelMap.get(key) ?? [];
    list.push(record);
    modelMap.set(key, list);
  }

  return Array.from(modelMap.entries()).map(([model, records]) => ({
    model,
    totalRuns: records.length,
    successRate: records.filter((r) => r.success).length / Math.max(1, records.length),
    avgTokens: Math.round(records.reduce((s, r) => s + r.tokensUsed, 0) / records.length),
    avgCostUsd: records.reduce((s, r) => s + r.costUsd, 0) / records.length,
    avgLatencyMs: Math.round(records.reduce((s, r) => s + r.latencyMs, 0) / records.length),
    lastUsed: records.reduce((latest, r) => (r.timestamp > latest ? r.timestamp : latest), ''),
  }));
}

/**
 * Rank models by cost-effectiveness (success rate / cost) for a given complexity level.
 * Returns models sorted best-first.
 */
export function rankModelsByCostEffectiveness(
  complexity?: 'low' | 'medium' | 'high',
  projectRoot?: string,
): ModelStats[] {
  const data = loadTrackingData(projectRoot);
  const filteredRecords = complexity
    ? data.records.filter((r) => r.taskComplexity === complexity)
    : data.records;

  // Group filtered records by model and compute stats
  const modelMap = new Map<string, ModelRunRecord[]>();
  for (const record of filteredRecords) {
    const key = record.model;
    const list = modelMap.get(key) ?? [];
    list.push(record);
    modelMap.set(key, list);
  }

  const stats: ModelStats[] = Array.from(modelMap.entries()).map(([model, records]) => ({
    model,
    totalRuns: records.length,
    successRate: records.filter((r) => r.success).length / Math.max(1, records.length),
    avgTokens: Math.round(records.reduce((s, r) => s + r.tokensUsed, 0) / records.length),
    avgCostUsd: records.reduce((s, r) => s + r.costUsd, 0) / records.length,
    avgLatencyMs: Math.round(records.reduce((s, r) => s + r.latencyMs, 0) / records.length),
    lastUsed: records.reduce((latest, r) => (r.timestamp > latest ? r.timestamp : latest), ''),
  }));

  return stats.sort((a, b) => {
    const aScore = a.successRate / Math.max(0.0001, a.avgCostUsd);
    const bScore = b.successRate / Math.max(0.0001, b.avgCostUsd);
    return bScore - aScore;
  });
}

/**
 * Pick the best model for a given task complexity and budget constraint.
 * Returns the model key or null if no data available.
 */
export function pickBestModel(
  complexity: 'low' | 'medium' | 'high',
  maxCostUsd?: number,
  projectRoot?: string,
): string | null {
  const ranked = rankModelsByCostEffectiveness(complexity, projectRoot);
  for (const model of ranked) {
    if (model.totalRuns < 3) continue; // Not enough data
    if (maxCostUsd !== undefined && model.avgCostUsd > maxCostUsd) continue;
    return model.model;
  }
  return null;
}

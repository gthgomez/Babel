import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

interface WaterfallEntry {
  stage?: string;
  tier_succeeded?: string;
  total_latency_ms?: number | null;
  total_prompt_tokens?: number | null;
  total_completion_tokens?: number | null;
  total_tokens?: number | null;
  total_estimated_cost_usd?: number | null;
  attempts_detail?: Array<{
    latency_ms?: number | null;
    succeeded?: boolean;
  }>;
}

interface CostLedgerFile {
  totals?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    estimated_cost_usd?: number;
    by_precision?: Record<string, number>;
  };
}

interface ToolLogEntry {
  tool?: string;
  stdout?: string;
  exit_code?: number;
  verified?: boolean;
  checkpoint_ids?: string[];
}

export interface RunStatsSummary {
  schema_version: 1;
  run_dir: string;
  status: string | null;
  waterfall: {
    call_count: number;
    total_latency_ms: number;
    stages: Array<{
      stage: string;
      call_count: number;
      total_latency_ms: number;
      winning_tiers: string[];
    }>;
  };
  tools: {
    tool_call_count: number;
    successful_tool_calls: number;
    failed_tool_calls: number;
    verified_tool_calls: number;
    by_tool: Record<string, number>;
    checkpoint_count: number;
  };
  cache: {
    web_cache_hits: number;
    web_cache_misses: number;
    file_read_cache_entries: number;
  };
  tokens: {
    prompt: number;
    completion: number;
    total: number;
    estimated_cost_usd: number;
    source: 'cost_ledger' | 'waterfall_telemetry';
    cost_ledger_path: string | null;
    by_precision: Record<string, number>;
  };
  session: {
    context_available: boolean;
    steps_complete: number;
    context_fingerprint: string | null;
    approval_state: unknown | null;
  };
}

function readJson(path: string): unknown | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function collectToolLogs(executionReport: unknown): ToolLogEntry[] {
  return asArray(asRecord(executionReport)['tool_call_log']).map(
    (entry) => asRecord(entry) as ToolLogEntry,
  );
}

function parseCacheFlag(stdout: string | undefined): boolean | null {
  if (!stdout) {
    return null;
  }
  try {
    const parsed = asRecord(JSON.parse(stdout) as unknown);
    const cache = asRecord(parsed['cache']);
    return typeof cache['from_cache'] === 'boolean' ? cache['from_cache'] : null;
  } catch {
    return null;
  }
}

export function buildRunStats(runDir: string): RunStatsSummary {
  const costLedgerPath = join(runDir, 'cost_ledger.json');
  const costLedgerExists = existsSync(costLedgerPath);
  const costLedger = asRecord(readJson(costLedgerPath)) as CostLedgerFile;
  const costLedgerTotals = asRecord(costLedger.totals);
  const hasCostLedgerTotals = Object.keys(costLedgerTotals).length > 0;
  const waterfallEntries = asArray(
    readJson(join(runDir, '05_waterfall_telemetry.json')),
  ) as WaterfallEntry[];
  const executionReport = readJson(join(runDir, '04_execution_report.json'));
  const sessionContext = asRecord(readJson(join(runDir, '10_session_context.json')));
  const toolLogs = collectToolLogs(executionReport);
  const stageMap = new Map<
    string,
    {
      stage: string;
      call_count: number;
      total_latency_ms: number;
      winning_tiers: Set<string>;
    }
  >();

  let totalLatency = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let estimatedCost = 0;

  for (const entry of waterfallEntries) {
    const stage = entry.stage ?? 'unknown';
    const latency = numberValue(entry.total_latency_ms);
    totalLatency += latency;
    promptTokens += numberValue(entry.total_prompt_tokens);
    completionTokens += numberValue(entry.total_completion_tokens);
    totalTokens += numberValue(entry.total_tokens);
    estimatedCost += numberValue(entry.total_estimated_cost_usd);
    const current = stageMap.get(stage) ?? {
      stage,
      call_count: 0,
      total_latency_ms: 0,
      winning_tiers: new Set<string>(),
    };
    current.call_count += 1;
    current.total_latency_ms += latency;
    if (entry.tier_succeeded) {
      current.winning_tiers.add(entry.tier_succeeded);
    }
    stageMap.set(stage, current);
  }

  const byTool: Record<string, number> = {};
  let successfulToolCalls = 0;
  let verifiedToolCalls = 0;
  let checkpointCount = 0;
  let webCacheHits = 0;
  let webCacheMisses = 0;
  for (const toolLog of toolLogs) {
    const tool = toolLog.tool ?? 'unknown';
    byTool[tool] = (byTool[tool] ?? 0) + 1;
    if (toolLog.exit_code === 0) successfulToolCalls += 1;
    if (toolLog.verified === true) verifiedToolCalls += 1;
    checkpointCount += toolLog.checkpoint_ids?.length ?? 0;
    if (tool === 'web_search' || tool === 'web_fetch') {
      const fromCache = parseCacheFlag(toolLog.stdout);
      if (fromCache === true) webCacheHits += 1;
      if (fromCache === false) webCacheMisses += 1;
    }
  }

  const modelContext = asRecord(sessionContext['model_context']);
  const fileReadCache = asArray(modelContext['file_read_cache']);
  const terminalStatus = asRecord(executionReport)['status'];

  return {
    schema_version: 1,
    run_dir: runDir,
    status: typeof terminalStatus === 'string' ? terminalStatus : null,
    waterfall: {
      call_count: waterfallEntries.length,
      total_latency_ms: totalLatency,
      stages: [...stageMap.values()].map((stage) => ({
        stage: stage.stage,
        call_count: stage.call_count,
        total_latency_ms: stage.total_latency_ms,
        winning_tiers: [...stage.winning_tiers],
      })),
    },
    tools: {
      tool_call_count: toolLogs.length,
      successful_tool_calls: successfulToolCalls,
      failed_tool_calls: toolLogs.length - successfulToolCalls,
      verified_tool_calls: verifiedToolCalls,
      by_tool: byTool,
      checkpoint_count: checkpointCount,
    },
    cache: {
      web_cache_hits: webCacheHits,
      web_cache_misses: webCacheMisses,
      file_read_cache_entries: fileReadCache.length,
    },
    tokens: {
      prompt: hasCostLedgerTotals ? numberValue(costLedgerTotals['prompt_tokens']) : promptTokens,
      completion: hasCostLedgerTotals
        ? numberValue(costLedgerTotals['completion_tokens'])
        : completionTokens,
      total: hasCostLedgerTotals ? numberValue(costLedgerTotals['total_tokens']) : totalTokens,
      estimated_cost_usd: Number(
        (hasCostLedgerTotals
          ? numberValue(costLedgerTotals['estimated_cost_usd'])
          : estimatedCost
        ).toFixed(8),
      ),
      source: hasCostLedgerTotals ? 'cost_ledger' : 'waterfall_telemetry',
      cost_ledger_path: costLedgerExists ? costLedgerPath : null,
      by_precision: asRecord(costLedgerTotals['by_precision']) as Record<string, number>,
    },
    session: {
      context_available: Object.keys(sessionContext).length > 0,
      steps_complete: numberValue(sessionContext['steps_complete']),
      context_fingerprint:
        typeof sessionContext['context_fingerprint'] === 'string'
          ? sessionContext['context_fingerprint']
          : null,
      approval_state: sessionContext['approval_state'] ?? null,
    },
  };
}

export function formatRunStatsHuman(stats: RunStatsSummary): string {
  const lines = [
    'Babel Run Stats',
    `Run: ${stats.run_dir}`,
    `Status: ${stats.status ?? 'unknown'}`,
    '',
    `Waterfall calls: ${stats.waterfall.call_count}`,
    `Waterfall latency: ${stats.waterfall.total_latency_ms} ms`,
    `Tool calls: ${stats.tools.tool_call_count} (${stats.tools.successful_tool_calls} ok, ${stats.tools.failed_tool_calls} failed)`,
    `Verified tools: ${stats.tools.verified_tool_calls}`,
    `Checkpoints: ${stats.tools.checkpoint_count}`,
    `Web cache: ${stats.cache.web_cache_hits} hit(s), ${stats.cache.web_cache_misses} miss(es)`,
    `File-read cache entries: ${stats.cache.file_read_cache_entries}`,
    `Tokens: ${stats.tokens.total} total (${stats.tokens.prompt} prompt, ${stats.tokens.completion} completion)`,
    `Estimated cost: $${stats.tokens.estimated_cost_usd.toFixed(8)}`,
    `Cost source: ${stats.tokens.source}${stats.tokens.cost_ledger_path ? ` (${stats.tokens.cost_ledger_path})` : ''}`,
  ];
  if (stats.waterfall.stages.length > 0) {
    lines.push('', 'Stages:');
    for (const stage of stats.waterfall.stages) {
      lines.push(
        `  ${stage.stage}: ${stage.call_count} call(s), ${stage.total_latency_ms} ms, tiers ${stage.winning_tiers.join(', ') || '(none)'}`,
      );
    }
  }
  return lines.join('\n');
}

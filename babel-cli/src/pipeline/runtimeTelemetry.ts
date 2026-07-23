import { getHighestBudgetSeverity } from '../budgetPolicy.js';
import { EvidenceBundle } from '../evidence.js';
import type {
  BudgetDiagnostic,
  HaltTag,
  OrchestratorManifest,
  PipelineMode,
  QaVerdictReject,
  RuntimeTelemetry,
  ToolCallLog,
} from '../schemas/agentContracts.js';

import type { ExecutorLoopResult } from './executorLoopTypes.js';

export interface RuntimeCompiledArtifacts {
  selected_entry_ids: string[];
  prompt_manifest: string[];
  token_budget_total?: number;
  actual_prompt_tokens?: number | null;
  actual_minus_declared?: number | null;
  token_count_source?: 'runtime' | 'audit' | 'unavailable';
  token_budget_missing?: string[];
  token_budget_by_entry?: Record<string, number>;
  budget_policy?: {
    enabled: boolean;
  };
  budget_diagnostics?: BudgetDiagnostic[];
  warnings?: string[];
  dropped_entry_ids?: string[];
}

export function buildV9StackTelemetry(
  manifest: OrchestratorManifest,
  compiledArtifacts: RuntimeCompiledArtifacts,
): RuntimeTelemetry | null {
  if (!manifest.instruction_stack) {
    return null;
  }

  return {
    orchestrator_version: manifest.orchestrator_version,
    domain_id: manifest.instruction_stack.domain_id,
    skill_ids: compiledArtifacts.selected_entry_ids.filter((entryId) =>
      entryId.startsWith('skill_'),
    ),
    model_adapter_id: manifest.instruction_stack.model_adapter_id,
    selected_entry_ids: [...compiledArtifacts.selected_entry_ids],
    token_budget_total:
      typeof compiledArtifacts.token_budget_total === 'number'
        ? compiledArtifacts.token_budget_total
        : null,
    actual_prompt_tokens:
      typeof compiledArtifacts.actual_prompt_tokens === 'number'
        ? compiledArtifacts.actual_prompt_tokens
        : null,
    actual_minus_declared:
      typeof compiledArtifacts.actual_minus_declared === 'number'
        ? compiledArtifacts.actual_minus_declared
        : null,
    token_count_source: compiledArtifacts.token_count_source ?? 'unavailable',
    token_budget_missing_count: compiledArtifacts.token_budget_missing?.length ?? 0,
    budget_warning_severity: getHighestBudgetSeverity(compiledArtifacts.budget_diagnostics ?? []),
    budget_policy_enabled: compiledArtifacts.budget_policy?.enabled ?? false,
    pipeline_mode: manifest.analysis.pipeline_mode,
    qa_verdict: null,
    qa_failure_tags: [],
    final_outcome: null,
  };
}

export function writeRuntimeTelemetrySnapshot(
  evidence: EvidenceBundle,
  telemetry: RuntimeTelemetry | null,
): void {
  if (!telemetry) {
    return;
  }
  evidence.writeRuntimeTelemetry(telemetry);
}

export function markRuntimeTelemetryQaPass(
  telemetry: RuntimeTelemetry | null,
): RuntimeTelemetry | null {
  if (!telemetry) {
    return null;
  }
  return {
    ...telemetry,
    qa_verdict: 'PASS',
    qa_failure_tags: [],
  };
}

export function markRuntimeTelemetryQaReject(
  telemetry: RuntimeTelemetry | null,
  verdict: QaVerdictReject,
): RuntimeTelemetry | null {
  if (!telemetry) {
    return null;
  }
  return {
    ...telemetry,
    qa_verdict: 'REJECT',
    qa_failure_tags: verdict.failures.map((failure) => failure.tag),
  };
}

export function markRuntimeTelemetryOutcome(
  telemetry: RuntimeTelemetry | null,
  finalOutcome: string,
  pipelineMode: PipelineMode,
): RuntimeTelemetry | null {
  if (!telemetry) {
    return null;
  }
  return {
    ...telemetry,
    final_outcome: finalOutcome,
    pipeline_mode: pipelineMode,
  };
}

/**
 * Merges JIT/streaming telemetry from an ExecutorLoopResult into the runtime
 * telemetry snapshot. Only non-zero values are written to avoid polluting the
 * schema with zeros from runs that never entered the JIT streaming path.
 */
export function mergeExecutorJitTelemetry(
  telemetry: RuntimeTelemetry | null,
  result: ExecutorLoopResult,
): RuntimeTelemetry | null {
  if (!telemetry) {
    return null;
  }
  const patch: Partial<RuntimeTelemetry> = {};
  if (result.jitLatencyMs !== undefined && result.jitLatencyMs > 0) {
    patch.jit_latency_ms = result.jitLatencyMs;
  }
  if (result.streamPauseDurationMs !== undefined && result.streamPauseDurationMs > 0) {
    patch.stream_pause_duration_ms = result.streamPauseDurationMs;
  }
  if (result.lockWaitMs !== undefined && result.lockWaitMs > 0) {
    patch.lock_wait_ms = result.lockWaitMs;
  }
  if (result.bufferPeakBytes !== undefined && result.bufferPeakBytes > 0) {
    patch.buffer_peak_bytes = result.bufferPeakBytes;
  }
  return { ...telemetry, ...patch };
}

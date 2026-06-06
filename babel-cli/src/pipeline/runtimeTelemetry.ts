import { getHighestBudgetSeverity } from '../budgetPolicy.js';
import { EvidenceBundle } from '../evidence.js';
import type {
  BudgetDiagnostic,
  OrchestratorManifest,
  PipelineMode,
  QaVerdictReject,
  RuntimeTelemetry,
} from '../schemas/agentContracts.js';

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
    skill_ids: compiledArtifacts.selected_entry_ids.filter(entryId => entryId.startsWith('skill_')),
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
    budget_warning_severity:
      getHighestBudgetSeverity(compiledArtifacts.budget_diagnostics ?? []),
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
    qa_failure_tags: verdict.failures.map(failure => failure.tag),
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

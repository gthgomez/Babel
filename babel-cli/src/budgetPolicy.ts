import type { BudgetDiagnostic, BudgetDiagnosticSeverity, BudgetPolicy, InstructionStack } from './schemas/agentContracts.js';

export const ACTIVE_V9_BUDGET_POLICY: BudgetPolicy = {
  enabled: true,
  scope: {
    domain_ids: ['domain_swe_backend', 'domain_swe_frontend'],
    required_pipeline_stage_ids: ['pipeline_qa_reviewer'],
    orchestrator_versions: ['9.0'],
  },
  warn_threshold: 2400,
  severe_warn_threshold: 2600,
  count_layers: 'all_compiled_layers',
  missing_budget_mode: 'severe',
};

export function budgetPolicyAppliesToInstructionStack(
  instructionStack: InstructionStack,
  policy: BudgetPolicy = ACTIVE_V9_BUDGET_POLICY,
): boolean {
  if (!policy.enabled) {
    return false;
  }

  if (!policy.scope.domain_ids.includes(instructionStack.domain_id)) {
    return false;
  }

  for (const requiredStageId of policy.scope.required_pipeline_stage_ids) {
    if (!instructionStack.pipeline_stage_ids.includes(requiredStageId)) {
      return false;
    }
  }

  return true;
}

export function getHighestBudgetSeverity(
  diagnostics: BudgetDiagnostic[],
): BudgetDiagnosticSeverity | null {
  if (diagnostics.some(diagnostic => diagnostic.severity === 'severe')) {
    return 'severe';
  }
  if (diagnostics.some(diagnostic => diagnostic.severity === 'warn')) {
    return 'warn';
  }
  if (diagnostics.some(diagnostic => diagnostic.severity === 'info')) {
    return 'info';
  }
  return null;
}

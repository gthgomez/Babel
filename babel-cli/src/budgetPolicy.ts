import type {
  BudgetDiagnostic,
  BudgetDiagnosticSeverity,
  BudgetPolicy,
  InstructionStack,
} from './schemas/agentContracts.js';

export const DEFAULT_TOKEN_DRIFT_WARNING_TOLERANCE = 500;

export const ACTIVE_V9_BUDGET_POLICY: BudgetPolicy = {
  enabled: true,
  scope: {
    domain_ids: ['domain_swe_backend', 'domain_swe_frontend'],
    required_pipeline_stage_ids: ['pipeline_qa_reviewer'],
    orchestrator_versions: ['9.0'],
  },
  warn_threshold: 2400,
  severe_warn_threshold: 2600,
  hard_limit: 3200,
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
  if (diagnostics.some((diagnostic) => diagnostic.severity === 'severe')) {
    return 'severe';
  }
  if (diagnostics.some((diagnostic) => diagnostic.severity === 'warn')) {
    return 'warn';
  }
  if (diagnostics.some((diagnostic) => diagnostic.severity === 'info')) {
    return 'info';
  }
  return null;
}

export function resolveBudgetEvaluationTokens(input: {
  declaredTokenBudgetTotal: number;
  actualPromptTokens?: number | null | undefined;
}): { tokenTotal: number; source: 'actual' | 'declared' } {
  if (typeof input.actualPromptTokens === 'number' && Number.isFinite(input.actualPromptTokens)) {
    return {
      tokenTotal: input.actualPromptTokens,
      source: 'actual',
    };
  }

  return {
    tokenTotal: input.declaredTokenBudgetTotal,
    source: 'declared',
  };
}

/**
 * Resolve the effective token budget hard limit from, in priority order:
 *   1. CLI override (`--budget` flag)
 *   2. BABEL_TOKEN_BUDGET environment variable
 *   3. Default (3200, matching ACTIVE_V9_BUDGET_POLICY.hard_limit)
 *
 * @param env         - Environment variable source (defaults to `process.env`).
 * @param cliOverride - Explicit numeric override from the `--budget` CLI flag.
 * @returns The effective hard limit in tokens.
 */
export function getEffectiveBudgetLimit(
  env?: Record<string, string | undefined>,
  cliOverride?: number,
): number {
  if (cliOverride !== undefined && cliOverride > 0) {
    return cliOverride;
  }
  const envValue = (env ?? process.env)['BABEL_TOKEN_BUDGET'];
  if (envValue) {
    const parsed = parseInt(envValue, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return 3200;
}

export function buildBudgetDiagnostics(input: {
  declaredTokenBudgetTotal: number;
  tokenBudgetMissing: string[];
  policyApplies: boolean;
  budgetPolicy: BudgetPolicy;
  actualPromptTokens?: number | null | undefined;
  actualMinusDeclared?: number | null | undefined;
  tokenCountWarnings?: string[] | undefined;
  driftWarningTolerance?: number | undefined;
}): BudgetDiagnostic[] {
  const diagnostics: BudgetDiagnostic[] = [];
  const evaluated = resolveBudgetEvaluationTokens({
    declaredTokenBudgetTotal: input.declaredTokenBudgetTotal,
    actualPromptTokens: input.actualPromptTokens,
  });

  diagnostics.push({
    severity: 'info',
    code: 'total_token_budget',
    message:
      evaluated.source === 'actual'
        ? `Total token budget: ${input.declaredTokenBudgetTotal}; actual prompt tokens: ${evaluated.tokenTotal}; policy source: actual.`
        : `Total token budget: ${input.declaredTokenBudgetTotal}; policy source: declared.`,
  });

  if (input.tokenBudgetMissing.length > 0) {
    diagnostics.push({
      severity:
        input.policyApplies && input.budgetPolicy.missing_budget_mode === 'severe'
          ? 'severe'
          : 'warn',
      code: 'missing_token_budget',
      message: `Missing token_budget for: ${input.tokenBudgetMissing.join(', ')}`,
      entry_ids: [...input.tokenBudgetMissing],
    });
  }

  if (input.tokenCountWarnings && input.tokenCountWarnings.length > 0) {
    diagnostics.push({
      severity: 'warn',
      code: 'token_count_unavailable',
      message: `Actual token count unavailable: ${input.tokenCountWarnings.join('; ')}`,
    });
  }

  const driftTolerance = input.driftWarningTolerance ?? DEFAULT_TOKEN_DRIFT_WARNING_TOLERANCE;
  if (
    typeof input.actualMinusDeclared === 'number' &&
    Number.isFinite(input.actualMinusDeclared) &&
    Math.abs(input.actualMinusDeclared) > driftTolerance
  ) {
    diagnostics.push({
      severity: 'warn',
      code: 'actual_declared_token_drift',
      message:
        `Actual prompt tokens differ from declared token budget by ` +
        `${input.actualMinusDeclared >= 0 ? '+' : ''}${input.actualMinusDeclared}, exceeding tolerance ${driftTolerance}.`,
    });
  }

  if (input.policyApplies && evaluated.tokenTotal >= input.budgetPolicy.severe_warn_threshold) {
    diagnostics.push({
      severity: 'severe',
      code: 'budget_threshold_severe',
      message:
        `Compiled stack ${evaluated.source} tokens ${evaluated.tokenTotal} reached the severe threshold ` +
        `${input.budgetPolicy.severe_warn_threshold}.`,
    });
  } else if (input.policyApplies && evaluated.tokenTotal >= input.budgetPolicy.warn_threshold) {
    diagnostics.push({
      severity: 'warn',
      code: 'budget_threshold_warning',
      message:
        `Compiled stack ${evaluated.source} tokens ${evaluated.tokenTotal} reached the warning threshold ` +
        `${input.budgetPolicy.warn_threshold}.`,
    });
  }

  return diagnostics;
}

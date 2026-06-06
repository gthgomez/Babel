import { z } from 'zod';

import type { SwePlan } from '../schemas/agentContracts.js';
import { OBJECTIVE_PREFIX } from './paths.js';

export type NormalizedSwePlan = SwePlan & {
  plan_type: 'EVIDENCE_REQUEST' | 'IMPLEMENTATION_PLAN';
  task_summary: string;
};

export function normalizeSwePlan(swePlan: SwePlan): {
  plan: NormalizedSwePlan;
  warnings: string[];
} {
  const warnings: string[] = [];

  const taskSummary = swePlan.task_summary.startsWith(OBJECTIVE_PREFIX)
    ? swePlan.task_summary
    : `${OBJECTIVE_PREFIX}${swePlan.task_summary}`;

  let planType = swePlan.plan_type;
  if (planType === undefined) {
    const inferred = taskSummary.includes('EVIDENCE_REQUEST')
      ? 'EVIDENCE_REQUEST'
      : 'IMPLEMENTATION_PLAN';
    planType = inferred;
    warnings.push(
      `[PLAN_TYPE_INFERRED] Missing plan_type; inferred "${inferred}" from task_summary.`,
    );
  }

  return {
    plan: {
      ...swePlan,
      task_summary: taskSummary,
      plan_type: planType,
    },
    warnings,
  };
}

export function formatZodErrors(err: z.ZodError): string[] {
  return err.issues.map(issue => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${path}: ${issue.message}`;
  });
}

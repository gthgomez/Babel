import type { SwePlan, ToolCallLog } from '../schemas/agentContracts.js';
import { normalize } from 'node:path';

function normalizeEvidenceStepTarget(tool: string, target: unknown): string {
  const raw = String(target ?? '');
  if (['file_read', 'file_write', 'directory_list'].includes(tool)) {
    return normalize(raw);
  }
  return raw;
}

/** Match controller-recorded verified results to every approved action. */
export function arePlannedActionsSatisfied(
  approvedPlan: SwePlan,
  toolCallLog: readonly ToolCallLog[],
): boolean {
  if (approvedPlan.minimal_action_set.length === 0) {
    return false;
  }

  return approvedPlan.minimal_action_set.every((step) => {
    const expectedTarget = normalizeEvidenceStepTarget(step.tool, step.target);
    return toolCallLog.some(
      (entry) =>
        entry.verified === true &&
        entry.tool === step.tool &&
        normalizeEvidenceStepTarget(entry.tool, entry.target) === expectedTarget,
    );
  });
}

export function isEvidenceRequestPlanSatisfied(
  approvedPlan: SwePlan,
  toolCallLog: readonly ToolCallLog[],
): boolean {
  return approvedPlan.plan_type === 'EVIDENCE_REQUEST' && arePlannedActionsSatisfied(approvedPlan, toolCallLog);
}

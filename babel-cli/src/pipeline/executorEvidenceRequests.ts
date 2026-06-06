import type { SwePlan, ToolCallLog } from '../schemas/agentContracts.js';
import { normalizePathForComparison } from '../stages/taskShape.js';

function normalizeEvidenceStepTarget(tool: string, target: unknown): string {
  const raw = String(target ?? '').trim();
  if (['file_read', 'file_write', 'directory_list'].includes(tool)) {
    return normalizePathForComparison(raw).toLowerCase();
  }
  return raw.replace(/\s+/g, ' ').toLowerCase();
}

export function isEvidenceRequestPlanSatisfied(
  approvedPlan: SwePlan,
  toolCallLog: readonly ToolCallLog[],
): boolean {
  if (approvedPlan.plan_type !== 'EVIDENCE_REQUEST') {
    return false;
  }
  if (approvedPlan.minimal_action_set.length === 0) {
    return false;
  }

  return approvedPlan.minimal_action_set.every(step => {
    const expectedTarget = normalizeEvidenceStepTarget(step.tool, step.target);
    return toolCallLog.some(entry =>
      entry.verified === true &&
      entry.tool === step.tool &&
      normalizeEvidenceStepTarget(entry.tool, entry.target) === expectedTarget,
    );
  });
}

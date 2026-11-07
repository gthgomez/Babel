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

/** Auto-completion waits for host-attested directory pages, never display prose. */
export function areDirectoryPagesComplete(toolCallLog: readonly ToolCallLog[]): boolean {
  const states = new Map<string, { revision: string; next: string | null } | null>();
  for (const entry of toolCallLog) {
    if (entry.tool !== 'directory_list' || !entry.verified) continue;
    const target = normalizeEvidenceStepTarget(entry.tool, entry.target);
    const page = entry.directory_page;
    if (!page) { states.set(target, null); continue; }
    if (page.after === null) { states.set(target, { revision: page.revision, next: page.next_after }); continue; }
    const previous = states.get(target);
    if (!previous || previous.revision !== page.revision || previous.next !== page.after) { states.set(target, null); continue; }
    states.set(target, { revision: page.revision, next: page.next_after });
  }
  return [...states.values()].every(state => state !== null && state.next === null);
}

type Row = Record<string, unknown>;
export function summarizeBabelReviews(artifacts: Row[]) {
  const reviews = artifacts.filter(a => a['harness'] === 'babel' && a['mode'] === 'chat');
  const models: Record<string, { runs: number; completed: number; failed: number; approvals: number; blocks: number; calls: number; input_tokens_observed: number; output_tokens_observed: number; calls_with_unknown_usage: number; model_ms: number; format_repairs: number }> = {};
  const failures: Record<string, number> = {};
  for (const artifact of reviews) {
    const model = String(artifact['model'] ?? 'unknown');
    const item = models[model] ??= { runs: 0, completed: 0, failed: 0, approvals: 0, blocks: 0, calls: 0, input_tokens_observed: 0, output_tokens_observed: 0, calls_with_unknown_usage: 0, model_ms: 0, format_repairs: 0 };
    item.runs++;
    const verdict = artifact['verdict'] as Row | undefined;
    if (artifact['status'] === 'review_completed' || artifact['status'] === 'repair_proposal_completed') item.completed++;
    else { item.failed++; const failure = String(artifact['failure_code'] ?? artifact['status'] ?? 'unknown'); failures[failure] = (failures[failure] ?? 0) + 1; }
    if (verdict?.['verdict'] === 'APPROVE') item.approvals++;
    if (verdict?.['verdict'] === 'BLOCK') item.blocks++;
    item.format_repairs += Math.max(0, Array.isArray(artifact['attempts']) ? artifact['attempts'].length - 1 : 0);
    for (const call of Array.isArray(artifact['calls']) ? artifact['calls'] as Row[] : []) {
      item.calls++;
      const usage = call['metadata'] as Row | null;
      const input = usage?.['prompt_tokens']; const output = usage?.['completion_tokens'];
      if (typeof input === 'number' && Number.isFinite(input) && input >= 0) item.input_tokens_observed += input;
      if (typeof output === 'number' && Number.isFinite(output) && output >= 0) item.output_tokens_observed += output;
      if (typeof input !== 'number' || !Number.isFinite(input) || typeof output !== 'number' || !Number.isFinite(output)) item.calls_with_unknown_usage++;
      if (typeof call['elapsed_ms'] === 'number') item.model_ms += call['elapsed_ms'];
    }
  }
  return { schema_version: 1, run_count: reviews.length, models, failures, quality_note: 'Approval counts are not accuracy. Adjudicate each finding with reproductions/tests and retain false-positive and missed-defect evidence. Token sums include observed usage only; provider billing is not inferred.' };
}

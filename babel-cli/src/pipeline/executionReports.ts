import { EvidenceBundle } from '../evidence.js';
import {
  ExecutorReportSchema,
  PipelineErrorSchema,
  type ToolCallLog,
} from '../schemas/agentContracts.js';

export function writeValidatedExecutionReport(
  evidence: EvidenceBundle,
  report: unknown,
  toolCallLog: ToolCallLog[],
  warnings: string[] = [],
): void {
  const uniqueWarnings = [...new Set(warnings)];
  const checkpointIds = [...new Set(toolCallLog.flatMap((entry) => entry.checkpoint_ids ?? []))];
  const reportWithWarnings =
    typeof report === 'object' && report !== null
      ? {
          ...(report as Record<string, unknown>),
          ...(checkpointIds.length > 0 ? { checkpoint_ids: checkpointIds } : {}),
          ...(uniqueWarnings.length > 0 ? { warnings: uniqueWarnings } : {}),
        }
      : report;

  try {
    const parsed = ExecutorReportSchema.parse(reportWithWarnings);
    evidence.writeExecutionLog(parsed);
    return;
  } catch (err) {
    const schemaError = err instanceof Error ? err.message : String(err);
    const condition = `[PIPELINE_ERROR] ExecutorReportSchema validation failed: ${schemaError}`;

    const pipelineError = PipelineErrorSchema.parse({
      halt_tag: 'TOOL_CALL_ERROR',
      halted_at_step: Math.max(1, toolCallLog.length),
      condition,
      ...(toolCallLog.length > 0 ? { last_tool_output: toolCallLog[toolCallLog.length - 1] } : {}),
    });

    const fallback = ExecutorReportSchema.parse({
      status: 'EXECUTION_HALTED',
      steps_executed: toolCallLog.length,
      tool_call_log: toolCallLog,
      pipeline_error: pipelineError,
      ...(checkpointIds.length > 0 ? { checkpoint_ids: checkpointIds } : {}),
      ...(uniqueWarnings.length > 0 ? { warnings: [...uniqueWarnings, condition] } : {}),
    });

    evidence.writeExecutionLog(fallback);
  }
}

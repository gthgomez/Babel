import {
  extractLiteSessionActivity,
  formatSessionLoopStepLine,
  formatToolCallLine,
} from '../ui/liteSessionActivity.js';

export interface LiteSessionHandoff {
  sessionRunDir: string;
  summary: string;
  toolCallCount: number;
}

export function buildLiteSessionHandoff(sessionRunDir: string): LiteSessionHandoff | null {
  const normalized = sessionRunDir.trim();
  if (!normalized) {
    return null;
  }

  const activity = extractLiteSessionActivity({}, normalized);
  if (activity.sessionLoopSteps.length === 0 && activity.toolCallLog.length === 0) {
    return {
      sessionRunDir: normalized,
      summary: '',
      toolCallCount: 0,
    };
  }

  const lines: string[] = [];
  if (activity.sessionLoopSteps.length > 0) {
    lines.push(`Prior session loop (${activity.sessionLoopSteps.length} steps):`);
    for (const step of activity.sessionLoopSteps.slice(-6)) {
      lines.push(`- ${formatSessionLoopStepLine(step)}`);
    }
  }
  if (activity.toolCallLog.length > 0) {
    lines.push(`Prior tool calls (${activity.toolCallLog.length}):`);
    for (const tool of activity.toolCallLog.slice(-8)) {
      lines.push(`- ${formatToolCallLine(tool)}`);
    }
  }

  return {
    sessionRunDir: normalized,
    summary: lines.join('\n'),
    toolCallCount: activity.toolCallLog.length,
  };
}

import type { NormalizedTrajectoryEvent } from './contracts.js';

const EVENT_MAP: Readonly<Record<string, NormalizedTrajectoryEvent['event']>> = {
  task_started: 'task_started', model_request: 'model_request', model_response: 'model_response',
  repository_search: 'repository_search', search: 'repository_search', file_read: 'file_read', read: 'file_read',
  tool_proposed: 'tool_proposed', tool_started: 'tool_started', tool_completed: 'tool_completed', tool_failed: 'tool_failed',
  mutation_started: 'mutation_started', mutation_completed: 'mutation_completed', edit: 'mutation_completed',
  test_started: 'test_started', test_completed: 'test_completed', repair_started: 'repair_started',
  context_compaction: 'context_compaction', completion_claimed: 'completion_claimed', completion_verified: 'completion_verified',
  completion_rejected: 'completion_rejected', run_completed: 'run_completed', run_failed: 'run_failed', run_cancelled: 'run_cancelled',
};

function parseLine(line: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // A raw non-JSON line is preserved as untrusted data below.
  }
  return { raw: line };
}

export function normalizeTrajectory(raw: string): string {
  const events: NormalizedTrajectoryEvent[] = raw.split(/\r?\n/).filter((line) => line.length > 0).map((line, index) => {
    const source = parseLine(line);
    const sourceType = typeof source.event === 'string' ? source.event : typeof source.type === 'string' ? source.type : undefined;
    const normalized = sourceType ? EVENT_MAP[sourceType.toLowerCase()] ?? 'unknown' : 'unknown';
    return {
      sequence: index,
      ...(typeof source.timestamp === 'string' ? { timestamp: source.timestamp } : {}),
      event: normalized,
      data: source,
      ...(normalized === 'unknown' && sourceType ? { sourceType } : {}),
    };
  });
  return events.map((event) => JSON.stringify(event)).join('\n') + (events.length > 0 ? '\n' : '');
}

export function parseNormalizedTrajectory(value: string): NormalizedTrajectoryEvent[] {
  return value.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as NormalizedTrajectoryEvent);
}

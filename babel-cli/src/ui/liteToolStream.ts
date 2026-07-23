import type { BabelEventBus } from '../pipeline/logging.js';

export type LiteToolStreamStatus = 'running' | 'pass' | 'fail' | 'blocked';

export interface LiteToolStreamDiff {
  path: string;
  additions: number;
  deletions: number;
  content?: string; // optional unified diff text for inline display
}

export interface LiteToolStreamEvent {
  tool: string;
  target: string;
  status: LiteToolStreamStatus;
  phase?: string;
  /** Human-readable detail: line count, exit code, error summary */
  detail?: string;
  /** Structured diff info for write operations */
  diff?: LiteToolStreamDiff[];
}

export interface LiteToolStreamConsumer {
  reportToolCall?(event: LiteToolStreamEvent): void;
}

export interface LiteToolStreamSink {
  emit(event: LiteToolStreamEvent): void;
}

function formatToolStreamLine(event: LiteToolStreamEvent): string {
  const statusLabel =
    event.status === 'running'
      ? '…'
      : event.status === 'pass'
        ? 'ok'
        : event.status === 'blocked'
          ? 'blocked'
          : 'fail';
  const target = event.target.length > 72 ? `${event.target.slice(0, 69)}…` : event.target;
  const detail = event.detail ? ` (${event.detail})` : '';
  return `${event.tool} ${target} (${statusLabel})${detail}`;
}

export function createLiteToolStreamSink(input: {
  progress?: LiteToolStreamConsumer;
  eventBus?: BabelEventBus;
}): LiteToolStreamSink {
  return {
    emit(event: LiteToolStreamEvent) {
      const line = formatToolStreamLine(event);
      if (input.progress?.reportToolCall) {
        input.progress.reportToolCall(event);
      } else if (input.progress && 'report' in input.progress) {
        const reporter = input.progress as { report?: (stage: string, detail?: string) => void };
        reporter.report?.('discover', line);
      }
      input.eventBus?.logLine(`[tool] ${line}`);
      const runtimeEventType = event.status === 'running' ? 'tool.requested' : 'tool.completed';
      input.eventBus?.runtimeEvent(runtimeEventType, {
        tool: event.tool,
        target: event.target,
        status: event.status,
        ...(event.phase !== undefined ? { phase: event.phase } : {}),
        ...(event.detail !== undefined ? { detail: event.detail } : {}),
        ...(event.diff !== undefined ? { diff: event.diff } : {}),
      });
    },
  };
}

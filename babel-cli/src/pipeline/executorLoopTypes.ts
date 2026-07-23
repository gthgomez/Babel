import type { HaltTag, ToolCallLog } from '../schemas/agentContracts.js';

export type ExecutorTerminalStatus =
  | 'EXECUTION_COMPLETE'
  | 'EXECUTION_HALTED'
  | 'ACTIVATION_REFUSED'
  | 'PARTIAL';

export interface ExecutorLoopResult {
  toolCallLog: ToolCallLog[];
  terminalStatus: ExecutorTerminalStatus;
  haltTag?: HaltTag;
  condition?: string;
  /** Accumulated JIT/streaming performance telemetry for this executor run. */
  jitLatencyMs?: number;
  streamPauseDurationMs?: number;
  lockWaitMs?: number;
  bufferPeakBytes?: number;
}

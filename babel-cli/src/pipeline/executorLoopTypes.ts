import type { HaltTag, ToolCallLog } from '../schemas/agentContracts.js';

export type ExecutorTerminalStatus = 'EXECUTION_COMPLETE' | 'EXECUTION_HALTED' | 'ACTIVATION_REFUSED';

export interface ExecutorLoopResult {
  toolCallLog: ToolCallLog[];
  terminalStatus: ExecutorTerminalStatus;
  haltTag?: HaltTag;
  condition?: string;
}

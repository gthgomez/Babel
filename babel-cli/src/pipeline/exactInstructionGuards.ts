import type { ToolCallLog } from '../schemas/agentContracts.js';
import {
  summarizeExactInvariantFailure,
  verifyExactInvariants,
  type ExactInvariantRegistry,
} from '../stages/exactInvariants.js';

export function evaluateExactInstructionInvariants(
  registry: ExactInvariantRegistry,
  projectRoot: string | null,
  toolCallLog: readonly ToolCallLog[] = [],
): string | null {
  return summarizeExactInvariantFailure(
    verifyExactInvariants({
      registry,
      projectRoot,
      toolCallLog,
    }),
  );
}

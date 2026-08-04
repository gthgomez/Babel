import {
  ContractEvaluator,
  type AcceptanceContract,
} from "./acceptanceContracts.js";
import { EvidenceGraph } from "./evidenceGraph.js";

/** Result of evaluating claim coverage and revision-bound evidence. */
export interface CompletionEvidenceEvaluation {
  compliant: boolean;
  missing: string[];
  errors: string[];
}

/** Sync evaluate for Chat finalize; same authority as the async kernel path. */
export function evaluateCompletionEvidenceSync(input: {
  contract: AcceptanceContract;
  graph: EvidenceGraph;
  projectRoot: string;
}): CompletionEvidenceEvaluation {
  const contractResult = ContractEvaluator.evaluateContract(
    input.contract,
    input.graph,
  );
  const graphResult = input.graph.evaluateGraphSync(input.projectRoot);
  return {
    compliant: contractResult.compliant && graphResult.valid,
    missing: [...contractResult.missing],
    errors: [...graphResult.errors],
  };
}

/** Evaluate the production completion contract against the canonical evidence graph. */
export async function evaluateCompletionEvidence(input: {
  contract: AcceptanceContract;
  graph: EvidenceGraph;
  projectRoot: string;
}): Promise<CompletionEvidenceEvaluation> {
  return evaluateCompletionEvidenceSync(input);
}

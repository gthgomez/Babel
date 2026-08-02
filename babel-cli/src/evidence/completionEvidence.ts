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

/** Evaluate the production completion contract against the canonical evidence graph. */
export async function evaluateCompletionEvidence(input: {
  contract: AcceptanceContract;
  graph: EvidenceGraph;
  projectRoot: string;
}): Promise<CompletionEvidenceEvaluation> {
  const contractResult = ContractEvaluator.evaluateContract(
    input.contract,
    input.graph,
  );
  const graphResult = await input.graph.evaluateGraph(input.projectRoot);
  return {
    compliant: contractResult.compliant && graphResult.valid,
    missing: [...contractResult.missing],
    errors: [...graphResult.errors],
  };
}

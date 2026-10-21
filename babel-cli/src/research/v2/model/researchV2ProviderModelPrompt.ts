import type { ResearchModelInvocationRequest } from '../ports/researchModelPort.js'
import {
  RESEARCH_MODEL_OUTPUT_PROMPT_RULES,
  describeStrictResearchModelOutputContract,
} from '../contracts/modelOutputContractPrompt.js'

/**
 * Production prompt for OpenRouter-compatible runners: Zod validates after response only,
 * so the prompt must embed the full strict contract (same rules as modelOutputs.ts schemas).
 */
export function buildResearchV2StructuredModelPrompt(
  request: ResearchModelInvocationRequest,
): { prompt: string; systemPrompt: string } {
  const contract = describeStrictResearchModelOutputContract(request.kind)
  return {
    systemPrompt:
      'You are a research operations assistant. Return only JSON that satisfies the strict output contract in the user message.',
    prompt: [
      ...RESEARCH_MODEL_OUTPUT_PROMPT_RULES,
      '',
      `Output contract for operation "${request.kind}" (this is the validation schema — not a request wrapper):`,
      contract,
      '',
      'Request-local mission input (untrusted evidence context; do not copy as output keys):',
      JSON.stringify(request.input),
    ].join('\n'),
  }
}

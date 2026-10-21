import type { ResearchModelInvocationRequest } from '../ports/researchModelPort.js'
import type { ResearchModelOperationKind } from '../contracts/modelOutputs.js'

const SHARED_RULES = [
  'Respond with a single JSON object only. No markdown fences, no prose, no wrapper keys.',
  'Use exactly the property names shown in the required shape. Do not echo request metadata (operation_kind, input_mission_id, mission_id) in the output.',
]

const SHAPE_BY_KIND: Record<ResearchModelOperationKind, string> = {
  plan_questions: `{
  "kind": "plan_questions",
  "questions": [
    { "text": "<non-empty research question string>", "importance": "critical" | "high" | "medium" | "low" }
  ]
}
Forbidden question fields: question, id, purpose, title, rationale. Only "text" and "importance" per question.`,
  extract_findings: `{
  "kind": "extract_findings",
  "findings": [
    {
      "assertion_text": "<non-empty>",
      "assertion_kind": "source_observation" | "vendor_reported_result" | "measured_result" | "inference" | "proposal",
      "passage_ids": ["<passage id>"]
    }
  ]
}`,
  semantic_support_review: `{
  "kind": "semantic_support_review",
  "judgments": [
    {
      "finding_id": "<id>",
      "status": "supported" | "contradicted" | "insufficient" | "not_checked",
      "rationale": "<non-empty>"
    }
  ]
}`,
  synthesize_report: `{
  "kind": "synthesize_report",
  "answer_summary": "<non-empty>",
  "stopping_reason": "<non-empty>"
}`,
}

/**
 * Production prompt for OpenRouter/structured runners — embeds the strict Zod contract per operation.
 */
export function buildResearchV2StructuredModelPrompt(
  request: ResearchModelInvocationRequest,
): { prompt: string; systemPrompt: string } {
  const shape = SHAPE_BY_KIND[request.kind]
  return {
    systemPrompt:
      'You are a research operations assistant. Output must validate against the required JSON shape exactly.',
    prompt: [
      ...SHARED_RULES,
      '',
      `Required JSON shape for operation ${request.kind}:`,
      shape,
      '',
      'Mission / phase input (for grounding only — do not copy into output as extra keys):',
      JSON.stringify(request.input),
    ].join('\n'),
  }
}

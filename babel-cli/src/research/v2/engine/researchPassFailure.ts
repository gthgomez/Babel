export type ResearchPassStoppingReason =
  | 'structured_output_validation_failed'
  | 'provider_invoke_failed'
  | 'source_retrieval_failed'
  | 'pass_aborted'

export class ResearchPassFailedError extends Error {
  readonly stoppingReason: ResearchPassStoppingReason
  readonly failurePhase: string

  constructor(
    message: string,
    params: { stoppingReason: ResearchPassStoppingReason; failurePhase: string },
  ) {
    super(message)
    this.name = 'ResearchPassFailedError'
    this.stoppingReason = params.stoppingReason
    this.failurePhase = params.failurePhase
  }
}

function modelFailureStoppingReason(failureCategory: string): ResearchPassStoppingReason {
  if (failureCategory === 'structured_output_validation_failed') {
    return 'structured_output_validation_failed'
  }
  return 'provider_invoke_failed'
}

export function researchPassFailedFromModelResult(
  message: string,
  failureCategory: string,
  failurePhase: string,
): ResearchPassFailedError {
  return new ResearchPassFailedError(message, {
    stoppingReason: modelFailureStoppingReason(failureCategory),
    failurePhase,
  })
}

export function resolveFailedPassStoppingReason(
  err: unknown,
  failurePhase: string,
): ResearchPassStoppingReason {
  if (err instanceof ResearchPassFailedError) {
    return err.stoppingReason
  }
  const message = err instanceof Error ? err.message : String(err)
  if (
    /not a mission retrieval slot|PlanCoverageObligationValidationError|coverage obligation/i.test(
      message,
    )
  ) {
    return 'structured_output_validation_failed'
  }
  if (
    failurePhase.includes('plan') &&
    /Unrecognized key|invalid_type|expected|Zod|strict|structured_output_validation/i.test(message)
  ) {
    return 'structured_output_validation_failed'
  }
  if (failurePhase.includes('plan') || /plan_questions|plan validation/i.test(message)) {
    return 'provider_invoke_failed'
  }
  if (
    /admitted bytes are not valid UTF-8|source read|retrieval iteration|composed retrieval|fetch|discover|empty_body|content.encoding|decompression/i.test(
      message,
    )
  ) {
    return 'source_retrieval_failed'
  }
  return 'pass_aborted'
}

export function limitationsForFailedPass(stoppingReason: ResearchPassStoppingReason): string[] {
  switch (stoppingReason) {
    case 'structured_output_validation_failed':
      return ['structured_model_output_failed_validation']
    case 'provider_invoke_failed':
      return ['provider_model_invoke_failed']
    case 'source_retrieval_failed':
      return ['source_retrieval_or_extraction_failed']
    case 'pass_aborted':
      return ['pass_aborted_before_completion']
    default:
      return ['pass_failed_before_retrieval_or_synthesis']
  }
}

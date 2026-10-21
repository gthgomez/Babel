import { z } from 'zod'

/** Sanitized request-local provider invoke metadata (no payloads, reasoning text, or secrets). */
export const ProviderInvokeDiagnosticsSchema = z
  .object({
    inference_id: z.string().min(1),
    normalized_finish_reason: z.string().min(1).optional(),
    /** Omitted when delivered-output digest is missing or invocation was not delivered. */
    visible_content_present: z.boolean().optional(),
    /** Only set when delivered-output digest proves empty (SHA-256 of empty string). */
    visible_content_byte_length: z.number().int().nonnegative().optional(),
    output_digest: z
      .string()
      .regex(/^[a-f0-9]{64}$/i)
      .optional(),
    input_tokens: z.number().int().nonnegative().optional(),
    output_tokens: z.number().int().nonnegative().optional(),
    reasoning_tokens: z.number().int().nonnegative().optional(),
    requested_output_budget: z.number().int().nonnegative().nullable().optional(),
    effective_output_budget: z.number().int().nonnegative().nullable().optional(),
    provider_request_id: z.string().min(1).nullable().optional(),
  })
  .strict()

export type ProviderInvokeDiagnostics = z.infer<typeof ProviderInvokeDiagnosticsSchema>

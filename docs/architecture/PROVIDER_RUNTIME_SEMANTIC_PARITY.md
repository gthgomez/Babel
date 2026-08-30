# Provider runtime semantic parity checklist

Comparison scope: the extracted DeepInfra implementation and the neutral
`OpenAICompatibleApiRunner`, reviewed for consolidation PR #126.

| Concern | Disposition | Evidence |
|---|---|---|
| Credential loading | PRESERVED | Provider wrappers select credential env vars; neutral transport uses `resolveProviderCredential`. |
| Request timeout and cancellation | PRESERVED | Abort controller and external signal are linked for each request. |
| HTTP retries and Retry-After | PRESERVED | Status policy and `retry-after` parsing remain in the shared transport. |
| Stream retry behavior | REPLACED | Only idle/transport-safe streams may retry; partial output and incomplete streams fail closed. |
| Normal SSE fragmentation | FIXED | Persistent line carry-over plus `TextDecoder(..., { stream: true })`; adversarial test covers arbitrary and UTF-8 splits. |
| Tool streaming | PRESERVED | Native tool accumulation remains in the shared runner; malformed tool JSON produces a failed terminal receipt. |
| VCR playback/recording | PRESERVED | Shared VCR hooks remain around streaming response handling. |
| JSON validation and cost accounting | PRESERVED | Structured output parsing, usage normalization, pricing, and reasoning-token fields remain. |
| Finish-reason normalization | PRESERVED | Shared invocation metadata normalizes finish reasons and attribution. |
| Failure receipts | FIXED | HTTP classes, retryability, request IDs, API codes, budgets, hashes, and partial-output digests are retained where available. |
| OpenRouter metadata | PRESERVED | Content-free router provenance remains provider-specific in the OpenRouter wrapper. |
| DeepInfra default budget | PRESERVED | `DeepInfraApiRunner` explicitly owns the 32000 compatibility default. |
| OpenRouter default budget | FIXED | No envelope, sampling value, or `BABEL_OPENROUTER_TOKENS` means `max_tokens` is omitted. |
| Generic OpenAI-compatible default | REPLACED | Neutral transport has no implicit output budget; callers must provide policy explicitly. |
| Partial output replay | FIXED | A stream with emitted output is not retried automatically and receives a failed receipt. |
| Terminal receipt contract | PRESERVED | Failure paths emit provider or invocation completion evidence; incomplete streams are not marked successful. |

No meaningful dropped behavior remains classified `REGRESSED` in this review.

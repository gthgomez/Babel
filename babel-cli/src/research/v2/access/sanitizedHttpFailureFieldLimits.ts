/** Must match {@link SourceAcquisitionDiagnosticsSchema} `http_failure` max lengths. */
export const HTTP_FAILURE_FIELD_LIMITS = {
  public_message: 512,
  request_id: 128,
  retry_after: 64,
  rate_limit_resource: 64,
  rate_limit_remaining: 32,
  rate_limit_reset: 32,
} as const

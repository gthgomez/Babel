/**
 * Shared test helper: skip condition for tests that require live LLM API keys.
 *
 * Tests that exercise the full governed pipeline need at least one of
 * DEEPSEEK_API_KEY or DEEPINFRA_API_KEY to be set.  This single export
 * replaces three independent copies that had drifted across test files.
 */
export const skipIfNoApiKeys =
  !process.env['DEEPSEEK_API_KEY'] && !process.env['DEEPINFRA_API_KEY'];

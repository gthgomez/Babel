import { z } from 'zod';

const OptionalNonEmptyString = z.string().trim().min(1).optional();

const OptionalPositiveIntegerString = z
  .string()
  .trim()
  .regex(/^\d+$/, 'must be a positive integer')
  .transform((value) => Number.parseInt(value, 10))
  .pipe(z.number().int().positive())
  .optional();

const OptionalNonNegativeIntegerString = z
  .string()
  .trim()
  .regex(/^\d+$/, 'must be a non-negative integer')
  .transform((value) => Number.parseInt(value, 10))
  .pipe(z.number().int().min(0))
  .optional();

const RuntimeEnvSchema = z.object({
  BABEL_ROOT: OptionalNonEmptyString,
  BABEL_RUNS_DIR: OptionalNonEmptyString,
  BABEL_PROJECT_ROOT: OptionalNonEmptyString,
  BABEL_SHADOW_ROOT: OptionalNonEmptyString,
  BABEL_ALLOWED_ROOTS: OptionalNonEmptyString,
  BABEL_CONTEXT_CACHE_PATH: OptionalNonEmptyString,
  BABEL_ORCHESTRATOR_VERSION: z.enum(['v9']).optional(),
  BABEL_DRY_RUN: z.enum(['true', 'false', '1', '0', 'yes', 'no', 'on', 'off']).optional(),
  BABEL_DRY_RUN_SOURCE: z.enum(['session', 'persisted']).optional(),
  BABEL_LIVE: z.enum(['true', 'false', '1', '0', 'yes', 'no', 'on', 'off']).optional(),
  BABEL_RUNTIME_MODE: z.enum(['act', 'plan']).optional(),
  BABEL_ENV: z.enum(['production', 'development', 'test']).optional(),
  BABEL_CLI_TIMEOUT_MS: OptionalPositiveIntegerString,
  BABEL_CODEX_TIMEOUT_MS: OptionalPositiveIntegerString,
  BABEL_WATERFALL_TIMEOUT_MS: OptionalPositiveIntegerString,
  BABEL_DEEPINFRA_TOKENS: OptionalPositiveIntegerString,
  BABEL_DEEPINFRA_REQUEST_TIMEOUT_MS: OptionalPositiveIntegerString,
  BABEL_DEEPINFRA_REQUEST_MAX_RETRIES: OptionalPositiveIntegerString,
  BABEL_DEEPINFRA_STREAM_IDLE_TIMEOUT_MS: OptionalPositiveIntegerString,
  BABEL_DEEPINFRA_STREAM_MAX_RETRIES: OptionalNonNegativeIntegerString,
  BABEL_GEMINI_TOKENS: OptionalPositiveIntegerString,
  BABEL_OPENAI_TOKENS: OptionalPositiveIntegerString,
  BABEL_GROQ_TOKENS: OptionalPositiveIntegerString,
  BABEL_API_TOKENS: OptionalPositiveIntegerString,
  /** Status line format string. Tokens: {model}, {mode}, {project}, {elapsed}, {cost}, {tokens}, {turn} */
  BABEL_STATUS_FORMAT: OptionalNonEmptyString,
});

function formatEnvIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const key = issue.path[0];
      return `- ${String(key)}: ${issue.message}`;
    })
    .join('\n');
}

export function validateRuntimeEnv(
  env: NodeJS.ProcessEnv = process.env,
): z.infer<typeof RuntimeEnvSchema> {
  const parsed = RuntimeEnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid Babel environment configuration:\n${formatEnvIssues(parsed.error)}`);
  }

  return parsed.data;
}

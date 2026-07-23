/**
 * Allowlist of environment variable keys that are safe to pass to child processes.
 * Everything else is stripped to prevent accidental credential leakage.
 *
 * The original blocklist approach (stripping known API keys) was replaced with
 * this allowlist in M10 to provide defense-in-depth against unknown credential
 * patterns or future env vars that might carry secrets.
 *
 * BABEL_* variables are passed through ONLY if they appear in BABEL_SAFE_VARS.
 * Unknown BABEL_* variables (including potential secrets) are stripped.
 * New BABEL_* configuration variables must be explicitly added to this set.
 */
const SAFE_ENV_ALLOWLIST = new Set([
  'PATH',
  'HOME',
  'TMP',
  'TEMP',
  'LANG',
  'NODE_ENV',
  'SYSTEMROOT',
  'ComSpec',
  'PATHEXT',
]);

/**
 * Known-safe BABEL_* configuration variables.
 *
 * Every BABEL_-prefixed environment variable that is safe to forward to child
 * processes MUST appear in this set.  Any BABEL_* variable NOT in this set is
 * stripped — including any future variable that might carry a secret value.
 *
 * When adding a new BABEL_* config variable, add it here or it will be
 * silently absent from child process environments.
 */
const BABEL_SAFE_VARS = new Set([
  'BABEL_ROOT',
  'BABEL_PROJECT_ROOT',
  'BABEL_RUNS_DIR',
  'BABEL_DRY_RUN',
  'BABEL_DRY_RUN_SOURCE',
  'BABEL_LIVE',
  'BABEL_EXECUTION_PROFILE',
  'BABEL_ENV',
  'BABEL_SESSION_ID',
  'BABEL_LOCKED_FILES',
  'BABEL_SHADOW_ROOT',
  'BABEL_ALLOWED_ROOTS',
  'BABEL_ALLOWED_TOOLS',
  'BABEL_DISALLOWED_TOOLS',
  'BABEL_OPENCLAW_APPROVED_ROOTS',
  'BABEL_HEADLESS',
  'BABEL_READ_ONLY',
  'BABEL_ASK',
  'BABEL_TASK',
  'BABEL_TOKEN_BUDGET',
  'BABEL_COST_OPTIMIZE',
  'BABEL_REASONING_EFFORT',
  'BABEL_ROUTING_CONFIDENCE_ENABLE',
  'BABEL_ROUTING_CONFIDENCE_HIGH',
  'BABEL_ROUTING_CONFIDENCE_MEDIUM',
  'BABEL_ROUTING_CONFIDENCE_VALIDATOR_TIER_INDEX',
  'BABEL_ORCHESTRATOR_VERSION',
  'BABEL_STRICT_ENV',
  'BABEL_MCP_TIMEOUT_MS',
  'BABEL_DAEMON_ENABLED',
  'BABEL_DAILY_PROFILE',
  'BABEL_ANCHOR_PATH',
  'BABEL_BIBLE',
  'BABEL_BENCHMARK_DOCKER_IMAGE',
  'BABEL_BENCHMARK_DOCKER_EXTRA_ARGS',
  'BABEL_CLI_ENV_FILE_PATH',
  'BABEL_CLI_PACKAGE_ROOT',
  'BABEL_CONTEXT_CACHE_PATH',
  'BABEL_DEEPINFRA_REQUEST_MAX_RETRIES',
  'BABEL_DEEPINFRA_REQUEST_TIMEOUT_MS',
  'BABEL_DEEPINFRA_STREAM_IDLE_TIMEOUT_MS',
  'BABEL_DEEPINFRA_STREAM_MAX_RETRIES',
  'BABEL_ENTERPRISE_MODEL_OPT_IN',
  'BABEL_ENTERPRISE_POLICY_ADMIN_PATH',
  'BABEL_ENTERPRISE_POLICY_PATH',
  'BABEL_ENTERPRISE_POLICY_USER_PATH',
  'BABEL_LEGACY_PATHS',
  'BABEL_LITE_WORKER_CHAIN',
  'BABEL_REPO_MAP_PATH',
  'BABEL_SESSION_START_PATH',
]);

export function getSafeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => SAFE_ENV_ALLOWLIST.has(key) || BABEL_SAFE_VARS.has(key)),
  ) as NodeJS.ProcessEnv;
}

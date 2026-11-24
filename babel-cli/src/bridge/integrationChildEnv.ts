const CONTROLLER_ENV_PREFIXES = ['BABEL_BRIDGE_', 'HAPPIER_', 'HAPPY_', 'TAILSCALE_'] as const;
const CONTROLLER_ENV_NAMES = new Set([
  'BABEL_DESKTOP_CLIENT_ID',
  'BABEL_DESKTOP_PROOF_KEY',
  'BABEL_REMOTE_TOKEN',
  'BABEL_REMOTE_AUTH_TOKEN',
]);

/** Remove controller authority before an external ACP runtime inherits the host environment. */
export function buildIntegrationChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    const normalized = name.toUpperCase();
    if (
      CONTROLLER_ENV_NAMES.has(normalized) ||
      CONTROLLER_ENV_PREFIXES.some((prefix) => normalized.startsWith(prefix))
    ) {
      continue;
    }
    if (value !== undefined) childEnv[name] = value;
  }
  return childEnv;
}

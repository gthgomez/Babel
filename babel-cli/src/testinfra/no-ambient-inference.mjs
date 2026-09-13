/**
 * Test-safety guard: fail loud on unauthorized external model requests.
 *
 * Wraps globalThis.fetch so that any attempt to reach a real inference provider
 * fails the offending test with a loud, actionable error instead of silently
 * spending money or producing environment-dependent results.
 *
 * - Tests that stub fetch (the sanctioned offline pattern) replace the wrapped
 *   binding entirely and are unaffected.
 * - Local/loopback and relative URLs always pass.
 * - Set BABEL_TESTS_ALLOW_INFERENCE=1 only for explicitly authorized live suites.
 */

const BLOCKED_INFERENCE_HOSTS = new Set([
  'opencode.ai',
  'api.deepinfra.com',
  'deepinfra.com',
  'api.deepseek.com',
  'api.openai.com',
  'openrouter.ai',
  'api.anthropic.com',
  'generativelanguage.googleapis.com',
  'api.mistral.ai',
  'api.x.ai',
  'api.cohere.com',
]);

export const ALLOW_ENV = 'BABEL_TESTS_ALLOW_INFERENCE';

export function isBlockedInferenceHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (BLOCKED_INFERENCE_HOSTS.has(host)) return true;
  for (const blocked of BLOCKED_INFERENCE_HOSTS) {
    if (host.endsWith(`.${blocked}`)) return true;
  }
  return false;
}


export function installNoAmbientInferenceGuard(env = process.env) {
  if (globalThis.__babelNoAmbientInferenceInstalled) return false;
  const originalFetch = globalThis.fetch.bind(globalThis);
  const guarded = async (input, init) => {
    if (env[ALLOW_ENV] !== '1') {
      let url = '';
      try {
        url = typeof input === 'string' || input instanceof URL
          ? String(input)
          : String(input?.url ?? '');
      } catch {
        url = '';
      }
      let hostname = '';
      try {
        hostname = url ? new URL(url, 'http://localhost').hostname : '';
      } catch {
        hostname = '';
      }
      if (hostname && isBlockedInferenceHost(hostname)) {
        throw new Error(
          `AMBIENT_INFERENCE_ATTEMPT_BLOCKED: test attempted a request to inference provider host "${hostname}". ` +
            'Ordinary verification must never reach a real model. Stub fetch in the test, or set ' +
            `${ALLOW_ENV}=1 only in an explicitly authorized live suite.`,
        );
      }
    }
    return originalFetch(input, init);
  };
  globalThis.fetch = guarded;
  globalThis.__babelNoAmbientInferenceInstalled = true;
  return true;
}

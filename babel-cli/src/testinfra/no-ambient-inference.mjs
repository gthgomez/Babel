/**
 * Test-safety guard: fail loud on unauthorized external model requests.
 *
 * Wraps `globalThis.fetch` so that any attempt to reach a real inference
 * provider fails the offending test with a loud, actionable error instead of
 * silently spending money or producing environment-dependent results.
 *
 * Coverage boundary (deliberately documented, not claimed): this guard wraps
 * the global `fetch` binding used by Babel's primary HTTP provider runners. It
 * does NOT intercept `node:http`/`node:https` requests made directly, SDKs that
 * ship their own non-global fetch (for example the Groq SDK's bundled
 * node-fetch), browser `WebSocket`/`wss:` traffic, or provider CLI subprocesses
 * (claude/codex/gemini). Those transports remain covered by the explicit
 * live-suite opt-in and by credential gating, not by this guard.
 *
 * - Tests that stub/replace `fetch` (the sanctioned offline pattern) replace the
 *   wrapped binding entirely and are unaffected.
 * - A trailing-dot absolute FQDN (`api.openai.com.`) and percent-encoded labels
 *   are normalized before classification, so they cannot bypass the blocklist.
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
  'api.groq.com',
  'api.together.xyz',
  'api.fireworks.ai',
  'api.perplexity.ai',
  'api.moonshot.cn',
  'api.cerebras.ai',
  'api.novita.ai',
]);

export const ALLOW_ENV = 'BABEL_TESTS_ALLOW_INFERENCE';

/** Lowercase and strip DNS absolute-FQDN trailing dots before classification. */
export function normalizeInferenceHost(hostname) {
  let host = String(hostname || '').toLowerCase().trim();
  while (host.endsWith('.')) host = host.slice(0, -1);
  return host;
}

export function isBlockedInferenceHost(hostname) {
  const host = normalizeInferenceHost(hostname);
  if (!host) return false;
  if (BLOCKED_INFERENCE_HOSTS.has(host)) return true;
  for (const blocked of BLOCKED_INFERENCE_HOSTS) {
    if (host.endsWith(`.${blocked}`)) return true;
  }
  return false;
}

/** Extract the request hostname without performing any network I/O. */
export function requestHostname(input, base = 'http://localhost') {
  let url = '';
  try {
    url = typeof input === 'string' || input instanceof URL
      ? String(input)
      : String(input?.url ?? '');
  } catch {
    url = '';
  }
  if (!url) return '';
  try {
    return new URL(url, base).hostname;
  } catch {
    return '';
  }
}

/** Pure decision used by the installed wrapper; testable without network I/O. */
export function shouldBlockAmbientInference(input, env = process.env) {
  if (env?.[ALLOW_ENV] === '1') return false;
  return isBlockedInferenceHost(requestHostname(input));
}

export function isNoAmbientInferenceGuardInstalled() {
  return globalThis.__babelNoAmbientInferenceInstalled === true;
}

export function installNoAmbientInferenceGuard(env = process.env) {
  if (globalThis.__babelNoAmbientInferenceInstalled) return false;
  const originalFetch = globalThis.fetch.bind(globalThis);
  const guarded = async (input, init) => {
    const hostname = normalizeInferenceHost(requestHostname(input));
    if (shouldBlockAmbientInference(input, env)) {
      throw new Error(
        `AMBIENT_INFERENCE_ATTEMPT_BLOCKED: test attempted a request to inference provider host "${hostname}". ` +
          'Ordinary verification must never reach a real model. Stub fetch in the test, or set ' +
          `${ALLOW_ENV}=1 only in an explicitly authorized live suite.`,
      );
    }
    return originalFetch(input, init);
  };
  globalThis.fetch = guarded;
  globalThis.__babelNoAmbientInferenceInstalled = true;
  return true;
}

#!/usr/bin/env node
/**
 * CI guard: fail when provider-gated tests would skip without explicit opt-in.
 * Offline governance replay (test:governance-replay) must still pass separately.
 */

const ci = process.env.CI === 'true' || process.env.CI === '1';
const allowSkips =
  process.env.BABEL_ALLOW_TEST_SKIPS === '1' ||
  process.env.BABEL_ALLOW_TEST_SKIPS === 'true';
const hasDeepSeekKey = Boolean(process.env.DEEPSEEK_API_KEY);
const hasDeepInfraKey = Boolean(process.env.DEEPINFRA_API_KEY);
const hasLiveProviderKey = hasDeepSeekKey || hasDeepInfraKey;

const skipProne = [
  { script: 'test:pipeline-v9', reason: 'v9 pipeline regression (live/stub providers)' },
  { script: 'test:otel-tracing', reason: 'OTel pipeline regression' },
];

if (!ci) {
  process.exit(0);
}

if (hasLiveProviderKey) {
  const provider = hasDeepSeekKey ? 'DEEPSEEK_API_KEY' : 'DEEPINFRA_API_KEY';
  console.log(`[check-test-skips] CI: ${provider} set — live provider tests may run.`);
  process.exit(0);
}

if (allowSkips) {
  console.warn(
    '[check-test-skips] CI: DEEPSEEK_API_KEY/DEEPINFRA_API_KEY missing; BABEL_ALLOW_TEST_SKIPS=1 — skip-only live tests allowed.',
  );
  console.warn(
    '  Ensure test:governance-replay passes for PLAN→QA→ACT offline evidence.',
  );
  process.exit(0);
}

console.error('[check-test-skips] CI=true but DEEPSEEK_API_KEY and DEEPINFRA_API_KEY are unset.');
console.error('  These npm scripts will skip without running live governance proof:');
for (const entry of skipProne) {
  console.error(`    - ${entry.script}: ${entry.reason}`);
}
console.error('');
console.error('  Remediation options:');
console.error('    1. Provide DEEPSEEK_API_KEY in CI for preferred test:live-governance / pipeline regressions.');
console.error('       DEEPINFRA_API_KEY remains a compatibility fallback.');
console.error('    2. Set BABEL_ALLOW_TEST_SKIPS=1 only when offline test:governance-replay is the CI gate.');
console.error('    3. Run npm run test:governance-replay (always runs; no network).');
process.exit(1);

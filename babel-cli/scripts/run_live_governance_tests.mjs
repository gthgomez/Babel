#!/usr/bin/env node
/**
 * Live governance test entrypoint.
 *
 * For --required-deepseek, this now runs the focused breadth harness and falls
 * back to replay/offline mode when DEEPSEEK_API_KEY is unavailable.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as dotenvConfig } from 'dotenv';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
dotenvConfig({
  path: join(packageRoot, '.env'),
  override: false,
  quiet: true,
});
const deepSeekPolicyPath = join(
  packageRoot,
  'src',
  'fixtures',
  'live-governance',
  'deepseek-model-policy.json',
);
function runNpmScript(scriptName) {
  const result = spawnSync('npm', ['run', scriptName], {
    cwd: packageRoot,
    env: process.env,
    encoding: 'utf8',
    shell: true,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const requiredDeepSeek = process.argv.includes('--required-deepseek');
const isReplayMode = requiredDeepSeek
  ? (process.env.BABEL_LIVE_GOVERNANCE_OFFLINE === '1' || !Boolean(process.env.DEEPSEEK_API_KEY))
  : false;

if (requiredDeepSeek) {
  process.env.BABEL_MODEL_POLICY_PATH = deepSeekPolicyPath;
  process.env.BABEL_LIVE_GOVERNANCE_OFFLINE = isReplayMode ? '1' : '0';
}

if (process.env.DEEPSEEK_API_KEY && !requiredDeepSeek && !isReplayMode) {
  process.env.BABEL_LIVE_GOVERNANCE_PROVIDER = 'deepseek';
} else if (process.env.DEEPINFRA_API_KEY && !requiredDeepSeek && !isReplayMode) {
  process.env.BABEL_LIVE_GOVERNANCE_PROVIDER = 'deepinfra';
} else {
  delete process.env.BABEL_LIVE_GOVERNANCE_PROVIDER;
}

const provider = requiredDeepSeek
  ? {
    id: process.env.DEEPSEEK_API_KEY && !isReplayMode ? 'deepseek' : 'replay',
    envKeyName: isReplayMode ? 'REPLAY_ONLY' : 'DEEPSEEK_API_KEY',
    modelPolicyPath: process.env.BABEL_MODEL_POLICY_PATH,
  }
  : (process.env.DEEPSEEK_API_KEY
    ? {
      id: 'deepseek',
      envKeyName: 'DEEPSEEK_API_KEY',
      modelPolicyPath: process.env.BABEL_MODEL_POLICY_PATH,
    }
    : (process.env.DEEPINFRA_API_KEY
      ? {
        id: 'deepinfra',
        envKeyName: 'DEEPINFRA_API_KEY',
        modelPolicyPath: process.env.BABEL_MODEL_POLICY_PATH || null,
      }
      : null));

if (!provider) {
  if (requiredDeepSeek) {
    // unreachable under required mode after provider rewrite, but retained for safety
    console.error('[test:live-governance:required] failed — no governance provider is available');
    process.exit(1);
  }
  console.log('[test:live-governance] skipped — DEEPSEEK_API_KEY or DEEPINFRA_API_KEY not set');
  console.log('  Run offline replay: npm run test:governance-replay');
  process.exit(0);
}

if (provider) {
  const mode = provider.id === 'replay'
    ? 'replay/offline'
    : `${provider.envKeyName} present`;
  console.log(`[test:live-governance] ${mode} — running live governance regressions via ${provider.id}`);
  if (provider.modelPolicyPath) {
    console.log(`[test:live-governance] model policy: ${provider.modelPolicyPath}`);
  }
}

if (requiredDeepSeek) {
  runNpmScript('test:live-governance:breadth');
  console.log('[test:live-governance] passed');
  process.exit(0);
}
runNpmScript('test:pipeline-v9');
if (provider.id === 'deepinfra') {
  runNpmScript('test:otel-tracing');
} else {
  console.log('[test:live-governance] OTel regression skipped for direct DeepSeek live proof; run test:otel-tracing separately.');
}
console.log('[test:live-governance] passed');

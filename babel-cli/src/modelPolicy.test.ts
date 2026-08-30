import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  getAvailableModels,
  resolveModelByKey,
  resolveFamilyModelPolicy,
  resolveStagePolicyRoutes,
  validateModelPolicyMetadataFreshness,
  assertDeepSeekLiveModelId,
  assertLiveModelId,
  buildOpenRouterDeepSeekLiveEnv,
  getNormalizedModelCapabilities,
} from './modelPolicy.js';

function createModelPolicyRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'babel-model-policy-'));
  mkdirSync(join(root, 'config'), { recursive: true });
  writeFileSync(
    join(root, 'config', 'model-policy.json'),
    JSON.stringify({
      version: 2,
      default_tier: 'cheap',
      hard_fail_on_unknown_model: true,
      require_explicit_opt_in_for_expensive: true,
      family_defaults: {
        Codex: {
          cheap: 'qwen3',
          triage: 'step-flash',
        },
      },
      models: {
        qwen3: {
          provider: 'deepinfra',
          model_id: 'Qwen/Qwen3-235B-A22B-Instruct-2507',
          tier: 'cheap',
        },
        'step-flash': {
          provider: 'deepinfra',
          model_id: 'stepfun-ai/Step-3.5-Flash',
          tier: 'triage',
        },
      },
      stages: {
        planning: {
          primary_backend_key: 'qwen3',
          ordered_backend_keys: ['qwen3', 'step-flash'],
        },
      },
    }),
    'utf-8',
  );
  return root;
}

function withEnterprisePolicy<T>(root: string, policy: Record<string, unknown>, fn: () => T): T {
  const previous = {
    explicit: process.env['BABEL_ENTERPRISE_POLICY_PATH'],
    user: process.env['BABEL_ENTERPRISE_POLICY_USER_PATH'],
    admin: process.env['BABEL_ENTERPRISE_POLICY_ADMIN_PATH'],
    optIn: process.env['BABEL_ENTERPRISE_MODEL_OPT_IN'],
  };
  const policyPath = join(root, 'enterprise-policy.json');
  writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`, 'utf-8');
  process.env['BABEL_ENTERPRISE_POLICY_PATH'] = policyPath;
  process.env['BABEL_ENTERPRISE_POLICY_USER_PATH'] = join(root, 'missing-user-policy.json');
  delete process.env['BABEL_ENTERPRISE_POLICY_ADMIN_PATH'];
  delete process.env['BABEL_ENTERPRISE_MODEL_OPT_IN'];

  try {
    return fn();
  } finally {
    if (previous.explicit === undefined) delete process.env['BABEL_ENTERPRISE_POLICY_PATH'];
    else process.env['BABEL_ENTERPRISE_POLICY_PATH'] = previous.explicit;
    if (previous.user === undefined) delete process.env['BABEL_ENTERPRISE_POLICY_USER_PATH'];
    else process.env['BABEL_ENTERPRISE_POLICY_USER_PATH'] = previous.user;
    if (previous.admin === undefined) delete process.env['BABEL_ENTERPRISE_POLICY_ADMIN_PATH'];
    else process.env['BABEL_ENTERPRISE_POLICY_ADMIN_PATH'] = previous.admin;
    if (previous.optIn === undefined) delete process.env['BABEL_ENTERPRISE_MODEL_OPT_IN'];
    else process.env['BABEL_ENTERPRISE_MODEL_OPT_IN'] = previous.optIn;
  }
}

test('enterprise model policy blocks disallowed selected backends and filters available models', () => {
  const root = createModelPolicyRoot();

  withEnterprisePolicy(
    root,
    {
      schema_version: 1,
      model_policy: {
        allowed_backends: ['deepinfra'],
        disallowed_backends: ['qwen3'],
      },
    },
    () => {
      assert.throws(
        () =>
          resolveFamilyModelPolicy({ family: 'Codex', requestedTier: 'cheap', babelRoot: root }),
        /ENTERPRISE_POLICY/,
      );
      assert.deepEqual(
        getAvailableModels({ babelRoot: root }).map((model) => model.key),
        ['step-flash'],
      );
    },
  );
});

test('enterprise model policy filters stage waterfalls and honors explicit opt-in', () => {
  const root = createModelPolicyRoot();

  withEnterprisePolicy(
    root,
    {
      schema_version: 1,
      model_policy: {
        allowed_backends: ['deepinfra'],
        require_explicit_opt_in: ['qwen3'],
      },
    },
    () => {
      const routes = resolveStagePolicyRoutes({ babelRoot: root });
      const planning = routes.find((route) => route.stage === 'planning');
      assert.deepEqual(
        planning?.orderedBackends.map((backend) => backend.backendKey),
        ['step-flash'],
      );

      assert.throws(
        () =>
          resolveFamilyModelPolicy({ family: 'Codex', requestedTier: 'cheap', babelRoot: root }),
        /requires enterprise explicit opt-in/,
      );
      process.env['BABEL_ENTERPRISE_MODEL_OPT_IN'] = 'qwen3';
      const resolved = resolveFamilyModelPolicy({
        family: 'Codex',
        requestedTier: 'cheap',
        babelRoot: root,
      });
      assert.equal(resolved.resolvedBackendKey, 'qwen3');
    },
  );
});

test('stage policy routes filter disabled backends', () => {
  const root = createModelPolicyRoot();
  writeFileSync(
    join(root, 'config', 'model-policy.json'),
    JSON.stringify({
      version: 2,
      default_tier: 'cheap',
      hard_fail_on_unknown_model: true,
      models: {
        scout: {
          provider: 'deepinfra',
          model_id: 'meta-llama/Llama-4-Scout-17B-16E-Instruct',
          tier: 'standard',
        },
        qwen3: {
          provider: 'deepinfra',
          model_id: 'Qwen/Qwen3-235B-A22B-Instruct-2507',
          tier: 'cheap',
        },
        'step-flash': {
          provider: 'deepinfra',
          model_id: 'stepfun-ai/Step-3.5-Flash',
          tier: 'triage',
          enabled: false,
        },
      },
      stages: {
        planning: {
          primary_backend_key: 'scout',
          ordered_backend_keys: ['scout', 'step-flash', 'qwen3'],
        },
      },
    }),
    'utf-8',
  );

  const routes = resolveStagePolicyRoutes({ babelRoot: root });
  const planning = routes.find((route) => route.stage === 'planning');
  assert.deepEqual(
    planning?.orderedBackends.map((backend) => backend.backendKey),
    ['scout', 'qwen3'],
  );
});

test('model metadata freshness rejects missing, expired, and future-dated pricing provenance', () => {
  const root = createModelPolicyRoot();
  writeFileSync(
    join(root, 'config', 'model-policy.json'),
    JSON.stringify({
      version: 2,
      models: {
        missing_source: {
          provider: 'deepinfra',
          model_id: 'example/missing-source',
          tier: 'cheap',
          estimated_cost_per_1m_input: 0.1,
          estimated_cost_per_1m_output: 0.2,
          verified_at: '2026-05-04',
          expires_at: '2026-08-04',
        },
        future_verified: {
          provider: 'deepinfra',
          model_id: 'example/future',
          tier: 'cheap',
          source_url: 'https://example.test/future',
          estimated_cost_per_1m_input: 0.1,
          estimated_cost_per_1m_output: 0.2,
          verified_at: '2026-07-01',
          expires_at: '2026-08-04',
        },
        expired: {
          provider: 'deepinfra',
          model_id: 'example/expired',
          tier: 'cheap',
          source_url: 'https://example.test/expired',
          estimated_cost_per_1m_input: 0.1,
          estimated_cost_per_1m_output: 0.2,
          verified_at: '2026-04-01',
          expires_at: '2026-04-30',
        },
      },
    }),
    'utf-8',
  );

  const result = validateModelPolicyMetadataFreshness({
    babelRoot: root,
    now: new Date('2026-05-04T12:00:00.000Z'),
  });

  assert.equal(result.status, 'fail');
  assert.match(result.issues.join('\n'), /missing_source: source_url/);
  assert.match(
    result.issues.join('\n'),
    /future_verified: verified_at 2026-07-01 is in the future/,
  );
  assert.match(result.issues.join('\n'), /expired: expires_at 2026-04-30 is expired/);
});

function createDefaultModelPolicyRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'babel-model-policy-default-'));
  mkdirSync(join(root, 'config'), { recursive: true });
  writeFileSync(
    join(root, 'config', 'model-policy.json'),
    JSON.stringify({
      version: 2,
      default_tier: 'cheap',
      hard_fail_on_unknown_model: true,
      family_defaults: {
        Codex: { cheap: 'scout', standard: 'deepseek-v4-pro' },
        Gemini: { cheap: 'scout', standard: 'deepseek-v4-pro' },
        Claude: { cheap: 'scout', standard: 'deepseek-v4-pro' },
        DeepSeek: { cheap: 'scout', standard: 'deepseek-v4-pro' },
      },
      vendor_aliases: {
        codex: { maps_to: 'scout', notes: 'Aliases to scout.' },
        deepseek: { maps_to: 'deepseek', notes: 'Aliases to direct DeepSeek v4 Pro.' },
      },
      models: {
        scout: {
          provider: 'deepinfra',
          model_id: 'meta-llama/Llama-4-Scout-17B-16E-Instruct',
          tier: 'cheap',
        },
        'deepseek-v4-pro': {
          provider: 'deepseek',
          model_id: 'deepseek-v4-pro',
          tier: 'standard',
        },
        deepseek: {
          provider: 'deepseek',
          model_id: 'deepseek-v4-pro',
          tier: 'standard',
        },
        nemotron: {
          provider: 'deepinfra',
          model_id: 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B',
          tier: 'escalation',
        },
      },
      stages: {
        orchestrator: {
          primary_backend_key: 'scout',
          ordered_backend_keys: ['scout'],
        },
        planning: {
          primary_backend_key: 'scout',
          ordered_backend_keys: ['scout'],
        },
        qa: {
          primary_backend_key: 'deepseek-v4-pro',
          ordered_backend_keys: ['deepseek-v4-pro', 'nemotron'],
        },
        executor: {
          primary_backend_key: 'deepseek-v4-pro',
          ordered_backend_keys: ['deepseek-v4-pro'],
        },
      },
    }),
    'utf-8',
  );
  return root;
}

test('default model policy resolves family tiers to configured backends', () => {
  const root = createDefaultModelPolicyRoot();

  for (const family of ['Codex', 'Gemini', 'Claude', 'DeepSeek']) {
    const cheap = resolveFamilyModelPolicy({ family, requestedTier: 'cheap', babelRoot: root });
    assert.equal(cheap.resolvedBackendKey, 'scout');
    assert.equal(cheap.provider, 'deepinfra');
    assert.equal(cheap.providerModelId, 'meta-llama/Llama-4-Scout-17B-16E-Instruct');

    const standard = resolveFamilyModelPolicy({ family, requestedTier: 'standard', babelRoot: root });
    assert.equal(standard.resolvedBackendKey, 'deepseek-v4-pro');
    assert.equal(standard.provider, 'deepseek');
    assert.equal(standard.providerModelId, 'deepseek-v4-pro');
  }

  const codexAlias = resolveModelByKey({ key: 'codex', babelRoot: root });
  assert.equal(codexAlias.resolvedBackendKey, 'scout');
  assert.equal(codexAlias.provider, 'deepinfra');

  const deepseekCompat = resolveModelByKey({ key: 'deepseek', babelRoot: root });
  assert.equal(deepseekCompat.resolvedBackendKey, 'deepseek');
  assert.equal(deepseekCompat.provider, 'deepseek');
  assert.equal(deepseekCompat.providerModelId, 'deepseek-v4-pro');

  const routes = resolveStagePolicyRoutes({ babelRoot: root });
  const routeByStage = new Map(routes.map((route) => [route.stage, route]));
  assert.equal(routeByStage.get('orchestrator')?.primaryBackendKey, 'scout');
  assert.equal(routeByStage.get('planning')?.primaryBackendKey, 'scout');
  assert.equal(routeByStage.get('qa')?.primaryBackendKey, 'deepseek-v4-pro');
  assert.equal(routeByStage.get('executor')?.primaryBackendKey, 'deepseek-v4-pro');
  assert.equal(routeByStage.get('qa')?.orderedBackends[1]?.backendKey, 'nemotron');
});

function createLiveRoutingPolicyRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'babel-live-model-policy-'));
  mkdirSync(join(root, 'config'), { recursive: true });
  writeFileSync(
    join(root, 'config', 'model-policy.json'),
    JSON.stringify({
      version: 1,
      default_tier: 'cheap',
      family_defaults: { DeepSeek: { cheap: 'deepseek-v4-flash', standard: 'deepseek-v4-pro' } },
      models: {
        qwen3: { provider: 'deepinfra', model_id: 'Qwen/Qwen3', tier: 'cheap' },
        'deepinfra-model': { provider: 'deepinfra', model_id: 'meta/legacy', tier: 'cheap' },
        'deepseek-v4-flash': { provider: 'deepseek', model_id: 'deepseek-v4-flash', tier: 'cheap' },
        'deepseek-v4-pro': { provider: 'deepseek', model_id: 'deepseek-v4-pro', tier: 'standard' },
        deepseek: { provider: 'deepseek', model_id: 'deepseek-v4-pro', tier: 'standard' },
      },
      stages: {
        orchestrator: { primary_backend_key: 'deepseek-v4-flash', ordered_backend_keys: ['deepseek-v4-flash', 'qwen3'] },
        executor: { primary_backend_key: 'deepseek-v4-flash', ordered_backend_keys: ['deepseek-v4-flash', 'qwen3'] },
        planning: { primary_backend_key: 'deepseek-v4-pro', ordered_backend_keys: ['deepseek-v4-pro', 'deepinfra-model'] },
        qa: { primary_backend_key: 'deepseek-v4-pro', ordered_backend_keys: ['deepseek-v4-pro', 'deepinfra-model'] },
      },
    }),
    'utf-8',
  );
  return root;
}

test('DeepSeek live policy accepts Flash/Pro and rejects legacy providers', () => {
  const root = createLiveRoutingPolicyRoot();
  assertDeepSeekLiveModelId('deepseek-v4-flash');
  assertDeepSeekLiveModelId('deepseek-v4-pro');
  assertLiveModelId('z-ai/glm-5.3-flash');
  assertLiveModelId('deepseek/deepseek-v4-flash');
  assertDeepSeekLiveModelId('deepseek/deepseek-v4-flash');
  const glm = resolveModelByKey({ key: 'glm-5.3-flash', liveOnly: true });
  assert.equal(glm.provider, 'openrouter');
  assert.equal(glm.providerModelId, 'z-ai/glm-5.3-flash');
  const deepseekOpenRouter = resolveModelByKey({
    key: 'deepseek-v4-flash-openrouter',
    liveOnly: true,
  });
  assert.equal(deepseekOpenRouter.provider, 'openrouter');
  assert.equal(deepseekOpenRouter.providerModelId, 'deepseek/deepseek-v4-flash-0731');
  const legacyLiveDeepSeek = resolveModelByKey({
    key: 'deepseek-v4-flash',
    liveOnly: true,
  });
  assert.equal(legacyLiveDeepSeek.provider, 'openrouter');
  assert.equal(legacyLiveDeepSeek.providerModelId, 'deepseek/deepseek-v4-flash-0731');
  assert.throws(() => assertDeepSeekLiveModelId('Qwen/Qwen3'), /LIVE_MODEL_POLICY/);

  const routes = resolveStagePolicyRoutes({ babelRoot: root, liveOnly: true });
  const routeByStage = new Map(routes.map((route) => [route.stage, route]));
  assert.equal(routeByStage.get('orchestrator')?.primaryBackendKey, 'deepseek-v4-flash');
  assert.equal(routeByStage.get('executor')?.primaryBackendKey, 'deepseek-v4-flash');
  assert.equal(routeByStage.get('planning')?.primaryBackendKey, 'deepseek-v4-pro');
  assert.equal(routeByStage.get('qa')?.primaryBackendKey, 'deepseek-v4-pro');
  for (const route of routes) {
    assert.ok(route.orderedBackends.every((entry) => entry.provider === 'deepseek'));
  }

  assert.equal(
    resolveModelByKey({ key: 'deepseek', babelRoot: root, liveOnly: true }).providerModelId,
    'deepseek-v4-pro',
  );
  assert.throws(() => resolveModelByKey({ key: 'qwen3', babelRoot: root, liveOnly: true }), /LIVE_MODEL_POLICY/);
  assert.throws(() => resolveModelByKey({ key: 'deepinfra-model', babelRoot: root, liveOnly: true }), /LIVE_MODEL_POLICY/);
});

test('generic live DeepSeek family resolution uses OpenRouter-only backends', () => {
  const policy = resolveFamilyModelPolicy({ family: 'DeepSeek', liveOnly: true });
  assert.equal(policy.provider, 'openrouter');
  assert.equal(policy.resolvedBackendKey, 'deepseek-v4-pro-openrouter');
  assert.equal(policy.providerModelId, 'deepseek/deepseek-v4-pro');
  assert.ok(policy.waterfall.every((entry) => entry.provider === 'openrouter'));
});

test('OpenRouter DeepSeek live environment removes direct credentials and pins auxiliary calls', () => {
  const env = buildOpenRouterDeepSeekLiveEnv(
    {
      OPENROUTER_API_KEY: 'fixture-router-key',
      DEEPSEEK_API_KEY: 'synthetic-direct-key',
      BABEL_BENCHMARK_DEEPSEEK_ONLY: '1',
    },
    'deepseek-v4-pro',
  );

  assert.equal(env.OPENROUTER_API_KEY, 'fixture-router-key');
  assert.equal(env.DEEPSEEK_API_KEY, undefined);
  assert.equal(env.BABEL_BENCHMARK_DEEPSEEK_ONLY, undefined);
  assert.equal(env.BABEL_COMPACTION_API_BASE, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(env.BABEL_COMPACTION_MODEL, 'deepseek/deepseek-v4-pro');
  assert.equal(env.BABEL_DIFF_CRITIC_MODEL, 'deepseek/deepseek-v4-pro');
  assert.equal(env.BABEL_COMPACTION_API_KEY, 'fixture-router-key');
  assert.throws(
    () => buildOpenRouterDeepSeekLiveEnv({}, 'unapproved-model'),
    /OpenRouter DeepSeek live environment requires an approved selector/,
  );
});

test('canonical model capabilities resolve DeepSeek V4 Flash and Pro 1M context / 384k output with true provenance', () => {
  const flashCaps = resolveModelByKey({ key: 'deepseek-v4-flash' });
  assert.equal(flashCaps.contextWindow, 1_000_000);
  assert.equal(flashCaps.maxOutputTokens, 384_000);

  const proCaps = resolveModelByKey({ key: 'deepseek-v4-pro' });
  assert.equal(proCaps.contextWindow, 1_000_000);
  assert.equal(proCaps.maxOutputTokens, 384_000);

  const normFlash = getNormalizedModelCapabilities('deepseek-v4-flash');
  assert.equal(normFlash?.contextWindow, 1_000_000);
  assert.equal(normFlash?.contextWindowSource, 'policy');
  assert.equal(normFlash?.maxOutputTokens, 384_000);
  assert.equal(normFlash?.maxOutputTokensSource, 'policy');

  const normPro = getNormalizedModelCapabilities('deepseek-v4-pro');
  assert.equal(normPro?.contextWindow, 1_000_000);
  assert.equal(normPro?.contextWindowSource, 'policy');

  // qwen3 is registered without context_window / max_output_tokens in policy
  const normQwen = getNormalizedModelCapabilities('qwen3');
  assert.equal(normQwen?.contextWindow, undefined);
  assert.equal(normQwen?.contextWindowSource, 'unknown');
  assert.equal(normQwen?.maxOutputTokens, undefined);
  assert.equal(normQwen?.maxOutputTokensSource, 'unknown');

  // Unknown model returns null
  assert.equal(getNormalizedModelCapabilities('completely-unknown-model-xyz'), null);
});

test('unknown context models like qwen3 have context budget 0 and do not compact prematurely at 1,024', async () => {
  const { resolveProviderCapabilities, contextBudgetForModel, shouldCompactByTokens } =
    await import('./agent/providerCapabilities.js');

  const qwenCaps = resolveProviderCapabilities('qwen3');
  assert.equal(qwenCaps.contextWindow, 0);

  const budget = contextBudgetForModel('qwen3');
  assert.equal(budget.contextWindow, 0);
  assert.equal(budget.contextBudget, 0);

  // An unknown model must not trigger premature token compaction at 1,024 tokens
  assert.equal(shouldCompactByTokens(1_024, 'qwen3'), false);
  assert.equal(shouldCompactByTokens(50_000, 'qwen3'), false);
});

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

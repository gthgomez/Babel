import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { renderOperatorHeader } from '../../ui/renderers.js';
import { getPolicyPath, type ModelPolicyModelEntry, type ResolvedModelPolicy, type ResolvedModelPolicyEntry } from '../../modelPolicy.js';
import { handleModel } from './config.js';
import {
  nextFallbackEntry,
  readLastRouteFacts,
  renderAvailableModelsTable,
  renderModelDetail,
  renderModelHealth,
  renderModelHealthForSnapshot,
  renderModelWhy,
  resolveModelSnapshot,
  resolveStatusBarModelLabel,
  resetModelSnapshotCache,
} from './modelDetail.js';
import type { ReplContext } from '../context.js';

function makeCtx(partial?: Partial<ReplContext>): ReplContext {
  const state: ReplContext['state'] = {
    mode: 'chat',
    router: 'v9',
    costTotals: {
      totalCostUSD: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
    },
    turnCount: 0,
    ...(partial?.state ?? {}),
  };
  return {
    state,
    saveSessionState: () => {},
    printIdleHeader: () => {},
    verboseMode: false,
    resolveCurrentTarget: () => ({
      targetRoot: process.cwd(),
      source: 'cwd',
      workspaceRoot: process.cwd(),
    }),
    ...partial,
  } as ReplContext;
}

function captureConsole(fn: () => void): string[] {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(' '));
  };
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines;
}

function withTempRunDir(files: Record<string, string>, fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'babel-model-detail-'));
  try {
    for (const [name, data] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), data, 'utf-8');
    }
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function jsonFiles(files: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, data] of Object.entries(files)) {
    out[name] = JSON.stringify(data, null, 2);
  }
  return out;
}

function makeEntry(partial: Partial<ResolvedModelPolicyEntry>): ResolvedModelPolicyEntry {
  return {
    backendKey: 'test-backend',
    provider: 'openrouter',
    providerModelId: 'test/model',
    tier: 'standard',
    expensive: false,
    enabled: true,
    experimental: false,
    ...partial,
  } as ResolvedModelPolicyEntry;
}

function makePolicy(partial: Partial<ResolvedModelPolicy>): ResolvedModelPolicy {
  return {
    policyPath: 'test-policy',
    family: 'DeepSeek',
    selectedTier: 'standard',
    resolvedBackendKey: 'test-backend',
    provider: 'openrouter',
    providerModelId: 'test/model',
    expensive: false,
    enabled: true,
    experimental: false,
    blockedWithoutExplicitOptIn: false,
    approximateInputTokens: 3000,
    approximateOutputTokens: 1000,
    warnings: [],
    waterfall: [],
    stagePolicies: [],
    ...partial,
  } as ResolvedModelPolicy;
}

test('resolveModelSnapshot resolves the policy default and caches it', () => {
  resetModelSnapshotCache();
  const first = resolveModelSnapshot();
  assert.ok(first, 'policy default should resolve in this repository');
  assert.equal(first!.source, 'auto');
  assert.ok(first!.policy.resolvedBackendKey.length > 0);
  assert.ok(first!.policy.provider.length > 0);
  assert.ok(first!.policy.providerModelId.length > 0);
  const second = resolveModelSnapshot();
  assert.equal(second, first, 'auto snapshot should be cached between calls');
  resetModelSnapshotCache();
  const third = resolveModelSnapshot();
  assert.notEqual(third, first, 'cache reset should force a fresh resolution');
});

test('resolveModelSnapshot marks explicit session models as session-sourced', () => {
  resetModelSnapshotCache();
  const auto = resolveModelSnapshot();
  assert.ok(auto);
  const session = resolveModelSnapshot(auto!.policy.resolvedBackendKey);
  assert.ok(session);
  assert.equal(session!.source, 'session');
});

test('resolveStatusBarModelLabel prefers the session model, then the resolved default', () => {
  resetModelSnapshotCache();
  assert.equal(resolveStatusBarModelLabel('deepseek-v4-pro'), 'deepseek-v4-pro');
  const auto = resolveModelSnapshot();
  const label = resolveStatusBarModelLabel(undefined);
  assert.equal(label, auto ? auto!.policy.resolvedBackendKey : 'auto');
});

test('renderModelDetail shows provider route, context, cost, and fallback', () => {
  resetModelSnapshotCache();
  const snapshot = resolveModelSnapshot();
  assert.ok(snapshot);
  const output = renderModelDetail(snapshot!);
  assert.match(output, /Model Detail/);
  assert.match(output, /Provider/);
  assert.ok(output.includes(snapshot!.policy.providerModelId));
  assert.match(output, /Context/);
  assert.match(output, /Fallback/);
});

test('nextFallbackEntry returns the tier after the selected backend', () => {
  resetModelSnapshotCache();
  const snapshot = resolveModelSnapshot();
  assert.ok(snapshot);
  const { policy } = snapshot!;
  const fallback = nextFallbackEntry(policy);
  if (policy.waterfall.length > 1) {
    assert.ok(fallback, 'multi-tier waterfall should expose a fallback');
    assert.notEqual(fallback!.backendKey, policy.resolvedBackendKey);
  } else {
    assert.equal(fallback, null);
  }
});

test('renderModelWhy explains auto selection and session override', () => {
  resetModelSnapshotCache();
  const autoWhy = renderModelWhy({ sessionModel: undefined });
  assert.match(autoWhy, /Why This Model/);
  assert.match(autoWhy, /Auto/);

  const sessionWhy = renderModelWhy({ sessionModel: 'deepseek-v4-pro' });
  assert.match(sessionWhy, /You set this model/);
});

test('renderModelWhy surfaces last-turn routing label and run telemetry', () => {
  resetModelSnapshotCache();
  withTempRunDir(
    jsonFiles({
      '05_waterfall_telemetry.json': [
        {
          stage: 'executor',
          tier_succeeded: 'deepseek-v4-flash-openrouter',
          tier_index: 1,
          tiers_skipped: ['glm-5.3-flash'],
          cascade_reason: 'HTTP 429',
        },
      ],
      'debug_dynamic_routing_executor.json': {
        stage: 'executor',
        selectedName: 'deepseek-v4-flash-openrouter',
        selectedIndex: 1,
        telemetryRunsScanned: 12,
        reason: 'Dynamic Routing v1 — scored 30 entries across 12 runs.',
      },
    }),
    (dir) => {
      const why = renderModelWhy({ lastRoutingLabel: 'Flash·mutate', lastRunDir: dir });
      assert.match(why, /Flash·mutate/);
      assert.match(why, /fallback used/);
      assert.match(why, /HTTP 429/);
      assert.match(why, /Dynamic Routing v1/);
      assert.match(why, /stage 'executor'/);
    },
  );
});

test('renderModelWhy reports first-tier success without a fallback', () => {
  resetModelSnapshotCache();
  withTempRunDir(
    jsonFiles({
      '05_waterfall_telemetry.json': [
        {
          stage: 'planning',
          tier_succeeded: 'glm-5.3-flash',
          tier_index: 0,
          tiers_skipped: [],
          cascade_reason: 'none',
        },
      ],
    }),
    (dir) => {
      const why = renderModelWhy({ lastRunDir: dir });
      assert.match(why, /first-tier success/);
      assert.doesNotMatch(why, /fallback used/);
    },
  );
});

test('readLastRouteFacts returns null when no run artifacts exist', () => {
  withTempRunDir({}, (dir) => {
    assert.equal(readLastRouteFacts(dir), null);
  });
  assert.equal(readLastRouteFacts(path.join(os.tmpdir(), 'babel-missing-run-dir')), null);
});

test('renderModelHealth reports credential, metadata, and policy rows', () => {
  resetModelSnapshotCache();
  const snapshot = resolveModelSnapshot();
  assert.ok(snapshot);
  const output = renderModelHealth(undefined, {});
  assert.match(output, /Model Health/);
  assert.match(output, /Credential/);
  assert.match(output, /Metadata/);
  assert.match(output, /Policy/);
  assert.match(output, /models ping/);
});

test('renderAvailableModelsTable lists configured backends', () => {
  const output = renderAvailableModelsTable();
  assert.match(output, /Available Models/);
});

test('/model show prints the model detail without requiring a session model', () => {
  resetModelSnapshotCache();
  const ctx = makeCtx();
  const lines = captureConsole(() => handleModel(ctx, ['show']));
  const output = lines.join('\n');
  assert.match(output, /Model Detail/);
});

test('/model with no args shows the resolved auto default, not a fabricated model', () => {
  resetModelSnapshotCache();
  const ctx = makeCtx();
  const lines = captureConsole(() => handleModel(ctx, []));
  const output = lines.join('\n');
  assert.match(output, /Current model:/);
  assert.doesNotMatch(output, /qwen3-32b/i);
  assert.match(output, /Available Models/);
});

test('idle header never fabricates a model name', () => {
  const emptyHeader = renderOperatorHeader({});
  assert.match(emptyHeader, /auto/);
  assert.doesNotMatch(emptyHeader, /Qwen 3 32B/);
  const modelHeader = renderOperatorHeader({ model: 'deepseek-v4-pro' });
  assert.match(modelHeader, /DeepSeek/);
});

// ═══ Phase-1 acceptance: epistemic honesty of the operator surface ══════════

// ── Finding A: configuration is never presented as health ───────────────────

test('health: credential presence is labeled presence-only and never leaks the secret', () => {
  const snapshot = { source: 'auto' as const, offline: false, policy: makePolicy({}) };
  const secret = 'sk-or-test-NEVER-PRINT-123456';
  const output = renderModelHealthForSnapshot(snapshot, { env: { OPENROUTER_API_KEY: secret } });
  assert.match(output, /presence only/);
  assert.match(output, /validity, quota, and reachability not verified/);
  assert.ok(!output.includes(secret), 'credential value must never be rendered');
  assert.doesNotMatch(output, /\bhealthy\b/i);
  assert.match(output, /live reachability not checked/);
});

test('health: missing credential is reported as a failure condition', () => {
  const snapshot = { source: 'auto' as const, offline: false, policy: makePolicy({}) };
  const output = renderModelHealthForSnapshot(snapshot, { env: {} });
  assert.match(output, /OPENROUTER_API_KEY not set/);
});

test('health: qualification without evidence is reported as unknown, not healthy', () => {
  const snapshot = { source: 'auto' as const, offline: false, policy: makePolicy({}) };
  const output = renderModelHealthForSnapshot(snapshot, { env: {} });
  assert.match(output, /Qualification/);
  assert.match(output, /not recorded/);
  assert.doesNotMatch(output, /qualified/);
});

test('health: no run bundle means "not observed", never inferred health', () => {
  const snapshot = { source: 'auto' as const, offline: false, policy: makePolicy({}) };
  const output = renderModelHealthForSnapshot(snapshot, { env: {}, lastRunDir: null });
  assert.match(output, /not observed/);
  assert.doesNotMatch(output, /success on/);
});

test('health: recent success and recent failure are distinguishable and labeled historical', () => {
  const snapshot = {
    source: 'auto' as const,
    offline: false,
    policy: makePolicy({
      resolvedBackendKey: 'test-backend',
      provider: 'openrouter',
      providerModelId: 'test/model',
      waterfall: [makeEntry({})],
    }),
  };
  withTempRunDir(
    jsonFiles({
      '05_waterfall_telemetry.json': [
        {
          stage: 'chat',
          tier_succeeded: 'test-backend',
          tier_index: 0,
          tiers_skipped: [],
          cascade_reason: 'none',
          ts: '2026-09-05T01:02:03.000Z',
          attempts_detail: [
            {
              tier_name: 'test-backend',
              succeeded: true,
              provider: 'openrouter',
              provider_model_id: 'test/model',
              upstream_provider: 'upstream-provider-x',
            },
          ],
        },
      ],
    }),
    (dir) => {
      const ok = renderModelHealthForSnapshot(snapshot, { env: {}, lastRunDir: dir });
      assert.match(ok, /success on 'test-backend'/);
      assert.match(ok, /\(historical\)/);
      assert.match(ok, /2026-09-05T01:02:03\.000Z/);
      assert.match(ok, /upstream 'upstream-provider-x'/);
      assert.doesNotMatch(ok, /failure on/);
    },
  );
  withTempRunDir(
    jsonFiles({
      '05_waterfall_telemetry.json': [
        {
          stage: 'chat',
          tier_succeeded: 'other-tier',
          tier_index: 0,
          tiers_skipped: [],
          cascade_reason: 'none',
          ts: '2026-09-05T02:00:00.000Z',
          attempts_detail: [
            {
              tier_name: 'test-backend',
              succeeded: false,
              error_summary: 'HTTP 503 from gateway',
            },
          ],
        },
      ],
    }),
    (dir) => {
      const bad = renderModelHealthForSnapshot(snapshot, { env: {}, lastRunDir: dir });
      assert.match(bad, /failure on 'test-backend'/);
      assert.match(bad, /HTTP 503/);
      assert.doesNotMatch(bad, /success on/);
    },
  );
});

test('health: failure receipts for the active route are surfaced with class, not payload', () => {
  const snapshot = {
    source: 'auto' as const,
    offline: false,
    policy: makePolicy({ provider: 'openrouter', providerModelId: 'test/model' }),
  };
  const events = [
    JSON.stringify({
      kind: 'provider_failure_receipt',
      ts: '2026-09-05T03:00:00.000Z',
      receipt: {
        provider: 'openrouter',
        exact_model_id: 'test/model',
        upstream_provider: null,
        normalized_failure_class: 'rate_limited',
        http_status: 429,
        retryable: true,
      },
    }),
    JSON.stringify({
      kind: 'provider_failure_receipt',
      ts: '2026-09-05T03:30:00.000Z',
      receipt: {
        provider: 'openrouter',
        exact_model_id: 'other/model',
        upstream_provider: null,
        normalized_failure_class: 'auth_rejected',
        http_status: 401,
        retryable: false,
      },
    }),
  ].join('\n');
  withTempRunDir({ 'session-events.jsonl': events }, (dir) => {
    const output = renderModelHealthForSnapshot(snapshot, { env: {}, lastRunDir: dir });
    assert.match(output, /failure receipt/);
    assert.match(output, /rate_limited/);
    assert.match(output, /HTTP 429/);
    assert.doesNotMatch(output, /auth_rejected/, 'receipts for other routes must not be attributed');
  });
});

test('health: rendering never performs network access', () => {
  const snapshot = { source: 'auto' as const, offline: false, policy: makePolicy({}) };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('network access attempted during health render');
  }) as typeof fetch;
  try {
    const output = renderModelHealthForSnapshot(snapshot, { env: {} });
    assert.match(output, /Model Health/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── Finding B: a configured fallback is never "ready" ────────────────────────

test('health: configured fallback is never labeled ready without evidence', () => {
  const snapshot = {
    source: 'auto' as const,
    offline: false,
    policy: makePolicy({
      resolvedBackendKey: 'tier-one',
      waterfall: [
        makeEntry({ backendKey: 'tier-one' }),
        makeEntry({ backendKey: 'tier-two', provider: 'openrouter', providerModelId: 'test/fallback' }),
      ],
    }),
  };
  const output = renderModelHealthForSnapshot(snapshot, { env: {} });
  assert.match(output, /tier-two/);
  assert.match(output, /configured/);
  assert.match(output, /readiness not verified/);
  assert.doesNotMatch(output, /\bready\b/);
});

test('health: fallback credential problems are surfaced, not hidden', () => {
  const snapshot = {
    source: 'auto' as const,
    offline: false,
    policy: makePolicy({
      resolvedBackendKey: 'tier-one',
      waterfall: [makeEntry({ backendKey: 'tier-one' }), makeEntry({ backendKey: 'tier-two' })],
    }),
  };
  const output = renderModelHealthForSnapshot(snapshot, { env: {} });
  assert.match(output, /credential missing/);
});

test('health: single-tier route reports no fallback', () => {
  const snapshot = {
    source: 'auto' as const,
    offline: false,
    policy: makePolicy({ waterfall: [makeEntry({ backendKey: 'solo' })] }),
  };
  const output = renderModelHealthForSnapshot(snapshot, { env: {} });
  assert.match(output, /none configured — single-tier route/);
});

// ── Finding C: routing decisions correlate by stage, never filename order ────

test('why: picks the routing decision for the last executed stage, not the alphabetically last file', () => {
  withTempRunDir(
    jsonFiles({
      '05_waterfall_telemetry.json': [
        {
          stage: 'build',
          tier_succeeded: 'build-tier',
          tier_index: 0,
          tiers_skipped: [],
          cascade_reason: 'none',
          ts: '2026-09-05T04:00:00.000Z',
        },
        {
          stage: 'analysis',
          tier_succeeded: 'analysis-tier',
          tier_index: 0,
          tiers_skipped: [],
          cascade_reason: 'none',
          ts: '2026-09-05T04:01:00.000Z',
        },
      ],
      'debug_dynamic_routing_analysis.json': {
        stage: 'analysis',
        selectedName: 'ANALYSIS-MODEL',
        selectedIndex: 0,
        telemetryRunsScanned: 5,
        reason: 'analysis-stage evidence',
      },
      'debug_dynamic_routing_build.json': {
        stage: 'build',
        selectedName: 'BUILD-MODEL',
        selectedIndex: 1,
        telemetryRunsScanned: 5,
        reason: 'build-stage evidence',
      },
    }),
    (dir) => {
      const why = renderModelWhy({ lastRunDir: dir });
      assert.match(why, /ANALYSIS-MODEL/);
      assert.match(why, /stage 'analysis'/);
      assert.ok(!why.includes('BUILD-MODEL'), 'must not mix the build-stage decision into the analysis stage');
    },
  );
});

test('why: missing routing artifact for the last stage is stated, not improvised', () => {
  withTempRunDir(
    jsonFiles({
      '05_waterfall_telemetry.json': [
        {
          stage: 'analysis',
          tier_succeeded: 'analysis-tier',
          tier_index: 0,
          tiers_skipped: [],
          cascade_reason: 'none',
          ts: '2026-09-05T04:01:00.000Z',
        },
      ],
    }),
    (dir) => {
      const why = renderModelWhy({ lastRunDir: dir });
      assert.match(why, /no dynamic-routing decision recorded for stage 'analysis'/);
    },
  );
});

test('why: debug files without waterfall telemetry are not attributed to any stage', () => {
  withTempRunDir(
    jsonFiles({
      'debug_dynamic_routing_build.json': {
        stage: 'build',
        selectedName: 'BUILD-MODEL',
        selectedIndex: 0,
        telemetryRunsScanned: 3,
        reason: 'orphan decision',
      },
    }),
    (dir) => {
      const why = renderModelWhy({ lastRunDir: dir });
      assert.ok(!why.includes('BUILD-MODEL'));
      assert.doesNotMatch(why, /preferred/);
    },
  );
});

test('why: malformed optional artifacts never crash the surface or fabricate facts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'babel-model-detail-malformed-'));
  try {
    fs.writeFileSync(path.join(dir, '05_waterfall_telemetry.json'), '{not valid json', 'utf-8');
    fs.writeFileSync(path.join(dir, 'debug_dynamic_routing_analysis.json'), '{"stage":', 'utf-8');
    fs.writeFileSync(path.join(dir, 'session-events.jsonl'), '{broken line\n', 'utf-8');
    const why = renderModelWhy({ lastRunDir: dir });
    assert.match(why, /no run telemetry yet/);
    assert.ok(!why.includes('undefined'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Finding D: unknown cost metadata stays unknown ──────────────────────────

test('models table: only explicit zero renders as $0/M; missing cost renders n/a', () => {
  const models = [
    {
      key: 'paid-model',
      entry: { provider: 'openrouter', model_id: 'test/paid', tier: 'standard', estimated_cost_per_1m_output: 25 },
    },
    {
      key: 'free-model',
      entry: { provider: 'openrouter', model_id: 'test/free', tier: 'standard', estimated_cost_per_1m_output: 0 },
    },
    {
      key: 'mystery-model',
      entry: { provider: 'openrouter', model_id: 'test/mystery', tier: 'standard' },
    },
  ] as { key: string; entry: ModelPolicyModelEntry }[];
  const output = renderAvailableModelsTable(models);
  const lines = output.split('\n');
  const paid = lines.find((l) => l.includes('paid-model'))!;
  const free = lines.find((l) => l.includes('free-model'))!;
  const mystery = lines.find((l) => l.includes('mystery-model'))!;
  assert.match(paid, /\$25\/M/);
  assert.match(free, /\$0\/M/, 'an explicitly zero cost is a fact and may render as $0/M');
  assert.match(mystery, /n\/a/);
  assert.ok(!mystery.includes('$0'), 'missing cost must never display as $0');
});

test('model detail: a policy without cost metadata says so instead of rendering $0', () => {
  const snapshot = { source: 'auto' as const, offline: false, policy: makePolicy({}) };
  const output = renderModelDetail(snapshot);
  assert.match(output, /cost unknown/);
});

test('model detail: production resolver shape (per-run estimate with no per-M inputs) never renders $0', () => {
  // modelPolicy resolvers compute approximateCostPerRunUsd with `?? 0` inputs
  // and set it unconditionally — this is the shape real policies produce for
  // models with unpublished cost metadata.
  const snapshot = {
    source: 'auto' as const,
    offline: false,
    policy: makePolicy({ approximateCostPerRunUsd: 0 }),
  };
  const output = renderModelDetail(snapshot);
  assert.doesNotMatch(output, /\$0\.0000\/run/);
  assert.doesNotMatch(output, /~\$0/);
  assert.match(output, /cost unknown/);
  // With at least one published per-M cost, the per-run estimate is a fact.
  const withCost = {
    source: 'auto' as const,
    offline: false,
    policy: makePolicy({ approximateCostPerRunUsd: 0.0004, estimatedCostPer1MOutput: 0.18 }),
  };
  assert.match(renderModelDetail(withCost), /~\$0\.0004\/run/);
});

// ── Finding E: provider / gateway / upstream terminology is precise ─────────

test('why: observed upstream is labeled historical; unexposed upstream says not recorded', () => {
  withTempRunDir(
    jsonFiles({
      '05_waterfall_telemetry.json': [
        {
          stage: 'chat',
          tier_succeeded: 'test-tier',
          tier_index: 0,
          tiers_skipped: [],
          cascade_reason: 'none',
          ts: '2026-09-05T05:00:00.000Z',
          attempts_detail: [
            {
              tier_name: 'test-tier',
              succeeded: true,
              provider: 'openrouter',
              provider_model_id: 'test/model',
              upstream_provider: 'upstream-provider-y',
            },
          ],
        },
      ],
    }),
    (dir) => {
      const why = renderModelWhy({ lastRunDir: dir });
      assert.match(why, /Last upstream/);
      assert.match(why, /upstream-provider-y/);
      assert.match(why, /historical/);
    },
  );
  withTempRunDir(
    jsonFiles({
      '05_waterfall_telemetry.json': [
        {
          stage: 'chat',
          tier_succeeded: 'test-tier',
          tier_index: 0,
          tiers_skipped: [],
          cascade_reason: 'none',
          ts: '2026-09-05T05:10:00.000Z',
          attempts_detail: [
            {
              tier_name: 'test-tier',
              succeeded: true,
              provider: 'openrouter',
              provider_model_id: 'test/model',
              upstream_provider: null,
            },
          ],
        },
      ],
    }),
    (dir) => {
      const why = renderModelWhy({ lastRunDir: dir });
      assert.match(why, /not recorded — gateway did not expose a serving upstream/);
    },
  );
});

// ── Cache semantics: stale snapshots must not survive policy/lane changes ───

test('snapshot cache re-resolves when the policy file changes on disk', () => {
  resetModelSnapshotCache();
  const previousPath = process.env['BABEL_MODEL_POLICY_PATH'];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'babel-model-detail-cache-'));
  try {
    const tempPolicy = path.join(dir, 'model-policy.json');
    fs.writeFileSync(tempPolicy, fs.readFileSync(getPolicyPath(), 'utf-8'), 'utf-8');
    process.env['BABEL_MODEL_POLICY_PATH'] = tempPolicy;
    const first = resolveModelSnapshot();
    assert.ok(first, 'redirected policy should resolve');
    const mutated = JSON.parse(fs.readFileSync(tempPolicy, 'utf-8')) as Record<string, unknown>;
    mutated['__cache_probe__'] = 1;
    fs.writeFileSync(tempPolicy, JSON.stringify(mutated, null, 2), 'utf-8');
    const second = resolveModelSnapshot();
    assert.notEqual(second, first, 'policy file change must invalidate the cached snapshot');
  } finally {
    if (previousPath === undefined) delete process.env['BABEL_MODEL_POLICY_PATH'];
    else process.env['BABEL_MODEL_POLICY_PATH'] = previousPath;
    fs.rmSync(dir, { recursive: true, force: true });
    resetModelSnapshotCache();
  }
});

test('snapshot cache re-resolves when the offline lane flips', () => {
  resetModelSnapshotCache();
  const previousOffline = process.env['BABEL_OFFLINE'];
  try {
    const live = resolveModelSnapshot();
    process.env['BABEL_OFFLINE'] = '1';
    const offline = resolveModelSnapshot();
    if (offline === null) {
      assert.ok(live !== null, 'offline resolution may honestly fail, but live must have resolved');
    } else {
      assert.equal(offline.offline, true);
      assert.notEqual(offline, live, 'lane flip must not serve the cached live snapshot');
    }
  } finally {
    if (previousOffline === undefined) delete process.env['BABEL_OFFLINE'];
    else process.env['BABEL_OFFLINE'] = previousOffline;
    resetModelSnapshotCache();
  }
});

// ── Acceptance: the five operator questions without inspecting JSON ─────────

test('acceptance: /model show|why|health answer the five questions honestly', () => {
  resetModelSnapshotCache();
  const snapshot = resolveModelSnapshot();
  assert.ok(snapshot, 'repository policy must resolve');

  // Q1 — what model am I using: a real resolved backend, never fabricated.
  const detail = renderModelDetail(snapshot!);
  assert.ok(detail.includes(snapshot!.policy.resolvedBackendKey));

  // Q3 — which provider/route serves it: gateway plus provider model id.
  assert.ok(detail.includes(snapshot!.policy.provider));
  assert.ok(detail.includes(snapshot!.policy.providerModelId));

  // Q2/Q4/Q5 — why, health, fallback.
  const why = renderModelWhy({});
  assert.match(why, /Why This Model/);
  assert.match(why, /Auto — policy default/);
  const health = renderModelHealth(undefined, {});
  assert.match(health, /live reachability not checked/);
  assert.match(health, /Qualification/);
  assert.doesNotMatch(health, /\bready\b/);
  const fallbackRow = health.split('\n').find((l) => l.includes('Fallback'));
  assert.ok(fallbackRow);
  assert.ok(
    fallbackRow!.includes('configured') || fallbackRow!.includes('none configured'),
    'fallback row must state configuration honestly',
  );
});

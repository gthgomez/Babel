import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { renderOperatorHeader } from '../../ui/renderers.js';
import { handleModel } from './config.js';
import {
  nextFallbackEntry,
  readLastRouteFacts,
  renderAvailableModelsTable,
  renderModelDetail,
  renderModelHealth,
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

function withTempRunDir(files: Record<string, unknown>, fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'babel-model-detail-'));
  try {
    for (const [name, data] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), JSON.stringify(data, null, 2), 'utf-8');
    }
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
    {
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
    },
    (dir) => {
      const why = renderModelWhy({ lastRoutingLabel: 'Flash·mutate', lastRunDir: dir });
      assert.match(why, /Flash·mutate/);
      assert.match(why, /fallback used/);
      assert.match(why, /HTTP 429/);
      assert.match(why, /Dynamic Routing v1/);
    },
  );
});

test('renderModelWhy reports first-tier success without a fallback', () => {
  resetModelSnapshotCache();
  withTempRunDir(
    {
      '05_waterfall_telemetry.json': [
        {
          stage: 'planning',
          tier_succeeded: 'glm-5.3-flash',
          tier_index: 0,
          tiers_skipped: [],
          cascade_reason: 'none',
        },
      ],
    },
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
  if (snapshot!.policy.provider === 'ollama') {
    assert.match(output, /not required/);
  } else {
    assert.match(output, /not set/);
  }
  assert.match(output, /Metadata/);
  assert.match(output, /Policy/);
  assert.match(output, /models ping/);
});

test('renderAvailableModelsTable lists configured backends', () => {
  const output = renderAvailableModelsTable();
  assert.match(output, /Available Models/);
  assert.match(output, /\/M/);
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

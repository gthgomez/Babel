import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_CHAT_ENGINE_LIMITS,
  SWE_CHAT_ENGINE_LIMITS,
  isChatStreamingEnabled,
  isSweChatProfileEnabled,
  resolveChatEngineLimits,
  ChatEngineLimitsConfigurationError,
  createRunAllowanceReport,
  evaluateTimelineLimiter,
  shouldShrinkWallForPostWriteRepair,
  retainTaskWallAllowance,
} from './chatEngineLimits.js';

test('unlimited wall reports and timeline ignore a stale derived repair deadline', () => {
  const limits = { ...resolveChatEngineLimits(), maxWallMs: Infinity };
  delete limits.wallBudget;
  const report = createRunAllowanceReport(limits, { postWriteRepairWallCapMs: 180_000 });
  assert.equal(report.effectiveWallMs, Infinity);
  assert.deepEqual(report.effectiveWallAllowance, { kind: 'unlimited' });
  assert.equal(report.postWriteRepairWallCapMs, null);
  assert.doesNotMatch(JSON.stringify(report), /Infinity/);
  assert.equal(evaluateTimelineLimiter({ limits, elapsedMs: 200_000, spentUsd: 0,
    turns: 1, consecutiveStallTurns: 0, postWriteRepairWallCapMs: 180_000 }).limiter, 'none');
});

test('preparation retains requested versus effective wall evidence for a clamped finite grant', () => {
  const configured = resolveChatEngineLimits({ maxWallMs: 7_200_000 });
  const prepared = retainTaskWallAllowance(resolveChatEngineLimits(), configured.maxWallMs, configured.wallBudget);
  assert.equal(prepared.maxWallMs, 3_600_000);
  assert.equal(prepared.wallBudget?.requestedMs, 7_200_000);
  assert.deepEqual(prepared.runAllowance?.wallAllowance, { kind: 'finite', ms: 7_200_000 });
  assert.deepEqual(prepared.runAllowance?.effectiveWallAllowance, { kind: 'finite', ms: 3_600_000 });
});

test('ordinary task classes remain active beyond their old implicit wall deadlines', () => {
  const previous = process.env['BABEL_CHAT_MAX_WALL_MS'];
  delete process.env['BABEL_CHAT_MAX_WALL_MS'];
  try {
    for (const taskClass of ['default', 'quick_inspect', 'quick_fix', 'general_swe', 'investigate', 'governance', 'ordinary_delivery'] as const) {
      const limits = resolveChatEngineLimits({}, undefined, { taskClass });
      assert.equal(evaluateTimelineLimiter({ limits, elapsedMs: 1_200_000,
        spentUsd: 0, turns: 1, consecutiveStallTurns: 0 }).limiter, 'none', taskClass);
      const record = JSON.parse(JSON.stringify(limits));
      assert.deepEqual(record.wallBudget.allowance, { kind: 'unlimited' });
      assert.deepEqual(record.runAllowance.wallAllowance, { kind: 'unlimited' });
      assert.ok(Number.isFinite(limits.maxTurns));
      assert.ok(Number.isFinite(limits.stallTurns));
      assert.equal(evaluateTimelineLimiter({ limits, elapsedMs: 1_200_000, spentUsd: 0,
        turns: limits.maxTurns, consecutiveStallTurns: 0 }).classification, 'limit_turns');
      assert.equal(evaluateTimelineLimiter({ limits, elapsedMs: 1_200_000, spentUsd: 0,
        turns: 1, consecutiveStallTurns: limits.stallTurns }).classification, 'limit_stall');
    }
  } finally {
    if (previous === undefined) delete process.env['BABEL_CHAT_MAX_WALL_MS'];
    else process.env['BABEL_CHAT_MAX_WALL_MS'] = previous;
  }
});

test('explicit finite wall limits retain expiry and constructor precedence', () => {
  const previous = process.env['BABEL_CHAT_MAX_WALL_MS'];
  process.env['BABEL_CHAT_MAX_WALL_MS'] = '20000';
  try {
    const limits = resolveChatEngineLimits({ maxWallMs: 30_000 });
    assert.equal(limits.maxWallMs, 30_000);
    assert.equal(evaluateTimelineLimiter({ limits, elapsedMs: 30_000,
      spentUsd: 0, turns: 1, consecutiveStallTurns: 0 }).classification, 'limit_wall');
    assert.equal(resolveChatEngineLimits().maxWallMs, 20_000);
  } finally {
    if (previous === undefined) delete process.env['BABEL_CHAT_MAX_WALL_MS'];
    else process.env['BABEL_CHAT_MAX_WALL_MS'] = previous;
  }
});

test('malformed explicit wall settings cannot become an unlimited default', () => {
  const previous = process.env['BABEL_CHAT_MAX_WALL_MS'];
  try {
    for (const raw of ['', ' ', 'NaN', 'Infinity', '-1', '0', '10000ms', '1.5', 'unlimited']) {
      process.env['BABEL_CHAT_MAX_WALL_MS'] = raw;
      assert.throws(() => resolveChatEngineLimits(), { code: 'CHAT_LIMITS_CONFIG' });
    }
    delete process.env['BABEL_CHAT_MAX_WALL_MS'];
    for (const maxWallMs of [NaN, Infinity, -Infinity, -1, 0, 1.5])
      assert.throws(() => resolveChatEngineLimits({ maxWallMs }), { code: 'CHAT_LIMITS_CONFIG' });
  } finally {
    if (previous === undefined) delete process.env['BABEL_CHAT_MAX_WALL_MS'];
    else process.env['BABEL_CHAT_MAX_WALL_MS'] = previous;
  }
});

test('post-write repair wall shrink is disabled only under the long-task profile', () => {
  assert.equal(shouldShrinkWallForPostWriteRepair(undefined), true);
  assert.equal(
    shouldShrinkWallForPostWriteRepair({ effectiveMs: 600_000, requestedMs: 600_000, ceilingMs: 3_600_000, longTaskProfile: false }),
    true,
  );
  assert.equal(
    shouldShrinkWallForPostWriteRepair({ effectiveMs: 600_000, requestedMs: 7_200_000, ceilingMs: 14_400_000, longTaskProfile: true }),
    false,
  );
});

test('explicit unlimited monetary policy retains explicit wall, turn and stall controls', () => {
  const previous = process.env['BABEL_CHAT_MAX_COST'];
  try {
    process.env['BABEL_CHAT_MAX_COST'] = 'unlimited';
    const limits = resolveChatEngineLimits({ maxWallMs: 60_000 });
    assert.equal(limits.maxCostUsd, Infinity);
    assert.ok(Number.isFinite(limits.maxWallMs) && limits.maxWallMs > 0);
    assert.ok(Number.isFinite(limits.maxTurns) && limits.maxTurns > 0);
    assert.ok(Number.isFinite(limits.stallTurns) && limits.stallTurns > 0);
    assert.equal(resolveChatEngineLimits({ maxCostUsd: 1 }).maxCostUsd, 1);
    assert.deepEqual(limits.runAllowance?.costAllowance, { kind: 'unlimited' });
    const persisted = JSON.parse(JSON.stringify(limits.runAllowance));
    assert.deepEqual(persisted.costAllowance, { kind: 'unlimited' });
    assert.notEqual(persisted.costAllowance, null);
  } finally {
    if (previous === undefined) delete process.env['BABEL_CHAT_MAX_COST'];
    else process.env['BABEL_CHAT_MAX_COST'] = previous;
  }
});

test('resolveChatEngineLimits uses defaults when env unset', () => {
  const previous = {
    turns: process.env['BABEL_CHAT_MAX_TURNS'],
    messages: process.env['BABEL_CHAT_MAX_MESSAGES'],
    tokens: process.env['BABEL_CHAT_MAX_TOKENS'],
    cost: process.env['BABEL_CHAT_MAX_COST'],
    wall: process.env['BABEL_CHAT_MAX_WALL_MS'],
    stall: process.env['BABEL_CHAT_STALL_TURNS'],
    longTask: process.env['BABEL_CHAT_LONG_TASK'],
  };
  delete process.env['BABEL_CHAT_MAX_TURNS'];
  delete process.env['BABEL_CHAT_MAX_MESSAGES'];
  delete process.env['BABEL_CHAT_MAX_TOKENS'];
  delete process.env['BABEL_CHAT_MAX_COST'];
  delete process.env['BABEL_CHAT_MAX_WALL_MS'];
  delete process.env['BABEL_CHAT_STALL_TURNS'];
  delete process.env['BABEL_CHAT_LONG_TASK'];
  try {
    const wallBudgetFor = (maxWallMs: number) => ({
      effectiveMs: maxWallMs,
      requestedMs: maxWallMs,
      ceilingMs: 3_600_000,
      longTaskProfile: false,
      allowance: { kind: 'unlimited' },
    });
    const costBudgetFor = (maxCostUsd: number) => ({
      effectiveCostUsd: maxCostUsd,
      requestedCostUsd: maxCostUsd,
      ceilingCostUsd: maxCostUsd,
      explicitCostCeiling: false,
      longTaskProfile: false,
    });
    const expectedBase = resolveChatEngineLimits();
    assert.equal(expectedBase.maxTurns, DEFAULT_CHAT_ENGINE_LIMITS.maxTurns);
    assert.deepEqual(expectedBase.wallBudget, wallBudgetFor(DEFAULT_CHAT_ENGINE_LIMITS.maxWallMs));
    assert.deepEqual(expectedBase.costBudget, costBudgetFor(DEFAULT_CHAT_ENGINE_LIMITS.maxCostUsd));
    assert.ok(expectedBase.runAllowance);
    assert.equal(expectedBase.runAllowance?.declaredWallMs, DEFAULT_CHAT_ENGINE_LIMITS.maxWallMs);
    assert.equal(expectedBase.runAllowance?.declaredCostUsd, Infinity);
    assert.deepEqual(expectedBase.runAllowance?.costAllowance, { kind: 'unlimited' });
    assert.equal(expectedBase.maxCostUsd, Infinity);
    const withTurns = resolveChatEngineLimits({ maxTurns: 12 });
    assert.equal(withTurns.maxTurns, 12);
    assert.deepEqual(withTurns.wallBudget, wallBudgetFor(DEFAULT_CHAT_ENGINE_LIMITS.maxWallMs));
    assert.ok(JSON.parse(JSON.stringify(withTurns)).costBudget);
    assert.ok(JSON.parse(JSON.stringify(withTurns)).runAllowance);
  } finally {
    if (previous.turns === undefined) delete process.env['BABEL_CHAT_MAX_TURNS'];
    else process.env['BABEL_CHAT_MAX_TURNS'] = previous.turns;
    if (previous.messages === undefined) delete process.env['BABEL_CHAT_MAX_MESSAGES'];
    else process.env['BABEL_CHAT_MAX_MESSAGES'] = previous.messages;
    if (previous.tokens === undefined) delete process.env['BABEL_CHAT_MAX_TOKENS'];
    else process.env['BABEL_CHAT_MAX_TOKENS'] = previous.tokens;
    if (previous.cost === undefined) delete process.env['BABEL_CHAT_MAX_COST'];
    else process.env['BABEL_CHAT_MAX_COST'] = previous.cost;
    if (previous.wall === undefined) delete process.env['BABEL_CHAT_MAX_WALL_MS'];
    else process.env['BABEL_CHAT_MAX_WALL_MS'] = previous.wall;
    if (previous.stall === undefined) delete process.env['BABEL_CHAT_STALL_TURNS'];
    else process.env['BABEL_CHAT_STALL_TURNS'] = previous.stall;
    if (previous.longTask === undefined) delete process.env['BABEL_CHAT_LONG_TASK'];
    else process.env['BABEL_CHAT_LONG_TASK'] = previous.longTask;
  }
});

test('run allowance distinguishes finite, unlimited, and unknown cost evidence', () => {
  const finite = resolveChatEngineLimits({ maxCostUsd: 10 });
  assert.deepEqual(finite.runAllowance?.costAllowance, { kind: 'finite', usd: 10 });
  const unknownLimits = { ...finite, maxCostUsd: Number.NaN };
  delete unknownLimits.costBudget;
  const unknown = createRunAllowanceReport(unknownLimits);
  assert.equal(unknown.costAllowance.kind, 'unknown');
  const parsed = JSON.parse(JSON.stringify(unknown));
  assert.equal(parsed.costAllowance.kind, 'unknown');
  assert.notEqual(parsed.costAllowance.kind, 'unlimited');
});

test('resolveChatEngineLimits reads bounded env overrides', () => {
  const previous = {
    turns: process.env['BABEL_CHAT_MAX_TURNS'],
    messages: process.env['BABEL_CHAT_MAX_MESSAGES'],
    tokens: process.env['BABEL_CHAT_MAX_TOKENS'],
    cost: process.env['BABEL_CHAT_MAX_COST'],
    wall: process.env['BABEL_CHAT_MAX_WALL_MS'],
    stall: process.env['BABEL_CHAT_STALL_TURNS'],
  };
  process.env['BABEL_CHAT_MAX_TURNS'] = '16';
  process.env['BABEL_CHAT_MAX_MESSAGES'] = '40';
  process.env['BABEL_CHAT_MAX_TOKENS'] = '64000';
  process.env['BABEL_CHAT_MAX_COST'] = '1.50';
  process.env['BABEL_CHAT_MAX_WALL_MS'] = '300000';
  process.env['BABEL_CHAT_STALL_TURNS'] = '10';
  try {
    const resolved = resolveChatEngineLimits();
    assert.equal(resolved.maxTurns, 16);
    assert.equal(resolved.maxConversationMessages, 40);
    assert.equal(resolved.maxEstimatedTokens, 64_000);
    assert.equal(resolved.maxCostUsd, 1.50);
    assert.equal(resolved.maxWallMs, 300_000);
    assert.equal(resolved.stallTurns, 10);
  } finally {
    if (previous.turns === undefined) delete process.env['BABEL_CHAT_MAX_TURNS'];
    else process.env['BABEL_CHAT_MAX_TURNS'] = previous.turns;
    if (previous.messages === undefined) delete process.env['BABEL_CHAT_MAX_MESSAGES'];
    else process.env['BABEL_CHAT_MAX_MESSAGES'] = previous.messages;
    if (previous.tokens === undefined) delete process.env['BABEL_CHAT_MAX_TOKENS'];
    else process.env['BABEL_CHAT_MAX_TOKENS'] = previous.tokens;
    if (previous.cost === undefined) delete process.env['BABEL_CHAT_MAX_COST'];
    else process.env['BABEL_CHAT_MAX_COST'] = previous.cost;
    if (previous.wall === undefined) delete process.env['BABEL_CHAT_MAX_WALL_MS'];
    else process.env['BABEL_CHAT_MAX_WALL_MS'] = previous.wall;
    if (previous.stall === undefined) delete process.env['BABEL_CHAT_STALL_TURNS'];
    else process.env['BABEL_CHAT_STALL_TURNS'] = previous.stall;
  }
});

test('explicit unlimited override wins over finite env cost', () => {
  const previous = process.env['BABEL_CHAT_MAX_COST'];
  process.env['BABEL_CHAT_MAX_COST'] = '100';
  try {
    const resolved = resolveChatEngineLimits({ maxCostUsd: Infinity });
    assert.equal(resolved.maxCostUsd, Infinity);
  } finally {
    if (previous === undefined) delete process.env['BABEL_CHAT_MAX_COST'];
    else process.env['BABEL_CHAT_MAX_COST'] = previous;
  }
});

test('caller finite cost limits retain the selected amount and nonfinancial controls', () => {
  const previous = process.env['BABEL_CHAT_MAX_COST'];
  delete process.env['BABEL_CHAT_MAX_COST'];
  try {
    const baseline = resolveChatEngineLimits();
    for (const amount of [0.001, 0.00000001, 101, 101.125, 1_000_000.25]) {
      const limits = resolveChatEngineLimits({ maxCostUsd: amount });
      assert.equal(limits.maxCostUsd, amount);
      assert.equal(limits.costBudget?.requestedCostUsd, amount);
      assert.equal(limits.costBudget?.effectiveCostUsd, amount);
      assert.equal(limits.costBudget?.ceilingCostUsd, amount);
      assert.equal(limits.costBudget?.explicitCostCeiling, true);
      assert.deepEqual(limits.runAllowance?.costAllowance, { kind: 'finite', usd: amount });
      assert.equal(limits.maxTurns, baseline.maxTurns);
      assert.equal(limits.maxWallMs, baseline.maxWallMs);
      assert.equal(limits.maxEstimatedTokens, baseline.maxEstimatedTokens);
      assert.equal(limits.maxTokensPerRound, baseline.maxTokensPerRound);
      assert.equal(limits.stallTurns, baseline.stallTurns);
      const runtime = { limits, elapsedMs: 0, turns: 0, consecutiveStallTurns: 0 };
      assert.equal(evaluateTimelineLimiter({ ...runtime, spentUsd: amount / 2 }).limiter, 'none');
      assert.equal(evaluateTimelineLimiter({ ...runtime, spentUsd: amount }).limiter, 'cost');
    }
    assert.equal(baseline.maxCostUsd, Infinity);
  } finally {
    if (previous === undefined) delete process.env['BABEL_CHAT_MAX_COST'];
    else process.env['BABEL_CHAT_MAX_COST'] = previous;
  }
});

test('environment finite cost limits retain decimal precision and the selected ceiling', () => {
  const previous = process.env['BABEL_CHAT_MAX_COST'];
  try {
    for (const raw of ['0.001', '0.00000001', '101', '101.125', '1000000.25']) {
      process.env['BABEL_CHAT_MAX_COST'] = raw;
      const amount = Number(raw);
      const limits = resolveChatEngineLimits();
      assert.equal(limits.maxCostUsd, amount);
      assert.equal(limits.costBudget?.requestedCostUsd, amount);
      assert.equal(limits.costBudget?.effectiveCostUsd, amount);
      assert.equal(limits.costBudget?.ceilingCostUsd, amount);
      assert.deepEqual(limits.runAllowance?.costAllowance, { kind: 'finite', usd: amount });
    }
  } finally {
    if (previous === undefined) delete process.env['BABEL_CHAT_MAX_COST'];
    else process.env['BABEL_CHAT_MAX_COST'] = previous;
  }
});

test('new explicit cost limits reject zero, negative and unrepresentable amounts', () => {
  const previous = process.env['BABEL_CHAT_MAX_COST'];
  delete process.env['BABEL_CHAT_MAX_COST'];
  try {
    for (const amount of [0, -0, -1, Number.NaN, Number.NEGATIVE_INFINITY]) {
      assert.throws(() => resolveChatEngineLimits({ maxCostUsd: amount }),
        { name: 'ChatEngineLimitsConfigurationError', code: 'CHAT_LIMITS_CONFIG' });
    }
    for (const raw of ['0', '0.000', '-1', 'Infinity', 'NaN', '9'.repeat(400), `0.${'0'.repeat(400)}1`]) {
      process.env['BABEL_CHAT_MAX_COST'] = raw;
      assert.throws(() => resolveChatEngineLimits(),
        { name: 'ChatEngineLimitsConfigurationError', code: 'CHAT_LIMITS_CONFIG' });
    }
  } finally {
    if (previous === undefined) delete process.env['BABEL_CHAT_MAX_COST'];
    else process.env['BABEL_CHAT_MAX_COST'] = previous;
  }
});

test('an already granted zero cost allowance remains finite and exhausted', () => {
  // Restored grants can contain zero even though new explicit configuration rejects it.
  const limits = { ...resolveChatEngineLimits({ maxCostUsd: 1 }), maxCostUsd: 0 };
  delete limits.costBudget;
  assert.deepEqual(createRunAllowanceReport(limits).costAllowance, { kind: 'finite', usd: 0 });
  const result = evaluateTimelineLimiter({ limits, elapsedMs: 0, spentUsd: 0, turns: 0, consecutiveStallTurns: 0 });
  assert.equal(result.limiter, 'cost');
  assert.equal(result.classification, 'limit_cost');
});

test('explicit invalid cost overrides fail closed with configuration errors', () => {
  const previous = process.env['BABEL_CHAT_MAX_COST'];
  delete process.env['BABEL_CHAT_MAX_COST'];
  try {
    assert.throws(
      () => resolveChatEngineLimits({ maxCostUsd: Number.NaN }),
      ChatEngineLimitsConfigurationError,
    );
    assert.throws(
      () => resolveChatEngineLimits({ maxCostUsd: Number.NEGATIVE_INFINITY }),
      ChatEngineLimitsConfigurationError,
    );
    assert.throws(
      () => resolveChatEngineLimits({ maxCostUsd: 0 }),
      ChatEngineLimitsConfigurationError,
    );
  } finally {
    if (previous === undefined) delete process.env['BABEL_CHAT_MAX_COST'];
    else process.env['BABEL_CHAT_MAX_COST'] = previous;
  }
});

test('malformed explicit env cost strings reject configuration', () => {
  const previous = process.env['BABEL_CHAT_MAX_COST'];
  delete process.env['BABEL_CHAT_MAX_COST'];
  try {
    for (const raw of ['not-a-number', '1junk', '   ']) {
      process.env['BABEL_CHAT_MAX_COST'] = raw;
      assert.throws(() => resolveChatEngineLimits(), ChatEngineLimitsConfigurationError);
    }
  } finally {
    if (previous === undefined) delete process.env['BABEL_CHAT_MAX_COST'];
    else process.env['BABEL_CHAT_MAX_COST'] = previous;
  }
});

test('evaluateTimelineLimiter ignores critic repair cap when parent cost is unlimited', () => {
  const limits = resolveChatEngineLimits({ maxCostUsd: Infinity });
  const result = evaluateTimelineLimiter({
    limits,
    elapsedMs: 0,
    spentUsd: 50,
    turns: 0,
    consecutiveStallTurns: 0,
    criticRepairCostCapUsd: 1,
  });
  assert.equal(result.limiter, 'none');
});

test('budget fields are clamped to valid ranges', () => {
  const previous = {
    cost: process.env['BABEL_CHAT_MAX_COST'],
    wall: process.env['BABEL_CHAT_MAX_WALL_MS'],
    stall: process.env['BABEL_CHAT_STALL_TURNS'],
    longTask: process.env['BABEL_CHAT_LONG_TASK'],
  };
  delete process.env['BABEL_CHAT_MAX_COST'];
  delete process.env['BABEL_CHAT_MAX_WALL_MS'];
  delete process.env['BABEL_CHAT_STALL_TURNS'];
  delete process.env['BABEL_CHAT_LONG_TASK'];
  try {
    assert.throws(
      () => resolveChatEngineLimits({ maxCostUsd: 0 }),
      ChatEngineLimitsConfigurationError,
    );
    assert.throws(() => resolveChatEngineLimits({ maxWallMs: -1 }), { code: 'CHAT_LIMITS_CONFIG' });
    assert.throws(() => resolveChatEngineLimits({ maxWallMs: Number.NaN }), { code: 'CHAT_LIMITS_CONFIG' });
    // Below-min stall turns should clamp
    const stall = resolveChatEngineLimits({ stallTurns: 0 });
    assert.ok(stall.stallTurns >= 2);
  } finally {
    if (previous.cost === undefined) delete process.env['BABEL_CHAT_MAX_COST'];
    else process.env['BABEL_CHAT_MAX_COST'] = previous.cost;
    if (previous.wall === undefined) delete process.env['BABEL_CHAT_MAX_WALL_MS'];
    else process.env['BABEL_CHAT_MAX_WALL_MS'] = previous.wall;
    if (previous.stall === undefined) delete process.env['BABEL_CHAT_STALL_TURNS'];
    else process.env['BABEL_CHAT_STALL_TURNS'] = previous.stall;
    if (previous.longTask === undefined) delete process.env['BABEL_CHAT_LONG_TASK'];
    else process.env['BABEL_CHAT_LONG_TASK'] = previous.longTask;
  }
});

test('isChatStreamingEnabled defaults on and respects opt-out', () => {
  const previous = process.env['BABEL_STREAM_TOOLS'];
  delete process.env['BABEL_STREAM_TOOLS'];
  try {
    assert.equal(isChatStreamingEnabled(), true);
    process.env['BABEL_STREAM_TOOLS'] = '0';
    assert.equal(isChatStreamingEnabled(), false);
    process.env['BABEL_STREAM_TOOLS'] = '1';
    assert.equal(isChatStreamingEnabled(), true);
  } finally {
    if (previous === undefined) delete process.env['BABEL_STREAM_TOOLS'];
    else process.env['BABEL_STREAM_TOOLS'] = previous;
  }
});

test('SWE profile retains turn tuning without an implicit wall deadline', () => {
  const previous = {
    profile: process.env['BABEL_CHAT_SWE_PROFILE'],
    taskClass: process.env['BABEL_CHAT_TASK_CLASS'],
    wall: process.env['BABEL_CHAT_MAX_WALL_MS'],
    turns: process.env['BABEL_CHAT_MAX_TURNS'],
  };
  delete process.env['BABEL_CHAT_MAX_WALL_MS'];
  delete process.env['BABEL_CHAT_MAX_TURNS'];
  try {
    process.env['BABEL_CHAT_SWE_PROFILE'] = '1';
    assert.equal(isSweChatProfileEnabled(), true);
    const resolved = resolveChatEngineLimits();
    assert.equal(resolved.maxWallMs, Infinity);
    assert.deepEqual(resolved.runAllowance?.wallAllowance, { kind: 'unlimited' });
    assert.equal(SWE_CHAT_ENGINE_LIMITS.maxWallMs, undefined);
    assert.ok((resolved.maxTurns ?? 0) >= (DEFAULT_CHAT_ENGINE_LIMITS.maxTurns));
  } finally {
    if (previous.profile === undefined) delete process.env['BABEL_CHAT_SWE_PROFILE'];
    else process.env['BABEL_CHAT_SWE_PROFILE'] = previous.profile;
    if (previous.taskClass === undefined) delete process.env['BABEL_CHAT_TASK_CLASS'];
    else process.env['BABEL_CHAT_TASK_CLASS'] = previous.taskClass;
    if (previous.wall === undefined) delete process.env['BABEL_CHAT_MAX_WALL_MS'];
    else process.env['BABEL_CHAT_MAX_WALL_MS'] = previous.wall;
    if (previous.turns === undefined) delete process.env['BABEL_CHAT_MAX_TURNS'];
    else process.env['BABEL_CHAT_MAX_TURNS'] = previous.turns;
  }
});

test('resolveChatEngineLimits reads maxTokensPerRound from env', () => {
  const previous = process.env['BABEL_CHAT_MAX_TOKENS_PER_ROUND'];
  try {
    // Default
    delete process.env['BABEL_CHAT_MAX_TOKENS_PER_ROUND'];
    assert.equal(resolveChatEngineLimits().maxTokensPerRound, 200_000);

    // Env override
    process.env['BABEL_CHAT_MAX_TOKENS_PER_ROUND'] = '100000';
    assert.equal(resolveChatEngineLimits().maxTokensPerRound, 100_000);

    // Below-min clamps to 10_000
    process.env['BABEL_CHAT_MAX_TOKENS_PER_ROUND'] = '500';
    assert.equal(resolveChatEngineLimits().maxTokensPerRound, 10_000);

    // Above-max clamps to 2_000_000
    process.env['BABEL_CHAT_MAX_TOKENS_PER_ROUND'] = '5000000';
    assert.equal(resolveChatEngineLimits().maxTokensPerRound, 2_000_000);

    // Caller override takes precedence over env
    process.env['BABEL_CHAT_MAX_TOKENS_PER_ROUND'] = '50000';
    assert.equal(resolveChatEngineLimits({ maxTokensPerRound: 150_000 }).maxTokensPerRound, 150_000);
  } finally {
    if (previous === undefined) delete process.env['BABEL_CHAT_MAX_TOKENS_PER_ROUND'];
    else process.env['BABEL_CHAT_MAX_TOKENS_PER_ROUND'] = previous;
  }
});

test('wall budget: one-hour ceiling without the long-task profile, observable requested value', () => {
  const previousWall = process.env['BABEL_CHAT_MAX_WALL_MS'];
  const previousLong = process.env['BABEL_CHAT_LONG_TASK'];
  try {
    delete process.env['BABEL_CHAT_LONG_TASK'];

    // Default: no env, tune default wall, ceiling recorded, no profile.
    delete process.env['BABEL_CHAT_MAX_WALL_MS'];
    const defaults = resolveChatEngineLimits();
    assert.equal(defaults.wallBudget?.effectiveMs, defaults.maxWallMs);
    assert.equal(defaults.wallBudget?.ceilingMs, 3_600_000);
    assert.equal(defaults.wallBudget?.longTaskProfile, false);
    assert.equal(defaults.wallBudget?.requestedMs, defaults.maxWallMs);

    // Request above one hour clamps to one hour without the profile.
    process.env['BABEL_CHAT_MAX_WALL_MS'] = '7200000';
    const clamped = resolveChatEngineLimits();
    assert.equal(clamped.maxWallMs, 3_600_000);
    assert.equal(clamped.wallBudget?.requestedMs, 7_200_000);
    assert.equal(clamped.wallBudget?.effectiveMs, 3_600_000);
    assert.equal(clamped.wallBudget?.longTaskProfile, false);

    // Caller override clamps the same way.
    const overrideClamped = resolveChatEngineLimits({ maxWallMs: 10_800_000 });
    assert.equal(overrideClamped.maxWallMs, 3_600_000);
    assert.equal(overrideClamped.wallBudget?.requestedMs, 10_800_000);
  } finally {
    if (previousWall === undefined) delete process.env['BABEL_CHAT_MAX_WALL_MS'];
    else process.env['BABEL_CHAT_MAX_WALL_MS'] = previousWall;
    if (previousLong === undefined) delete process.env['BABEL_CHAT_LONG_TASK'];
    else process.env['BABEL_CHAT_LONG_TASK'] = previousLong;
  }
});

test('wall budget: explicit long-task profile supports two-hour-class requests', () => {
  const previousWall = process.env['BABEL_CHAT_MAX_WALL_MS'];
  const previousLong = process.env['BABEL_CHAT_LONG_TASK'];
  try {
    delete process.env['BABEL_CHAT_MAX_WALL_MS'];
    process.env['BABEL_CHAT_LONG_TASK'] = '1';

    // Two-hour request honored under the profile.
    process.env['BABEL_CHAT_MAX_WALL_MS'] = '7200000';
    const twoHours = resolveChatEngineLimits();
    assert.equal(twoHours.maxWallMs, 7_200_000);
    assert.equal(twoHours.wallBudget?.longTaskProfile, true);
    assert.equal(twoHours.wallBudget?.ceilingMs, 14_400_000);
    assert.equal(twoHours.wallBudget?.effectiveMs, 7_200_000);

    // Still finite: above the profile ceiling clamps to four hours.
    process.env['BABEL_CHAT_MAX_WALL_MS'] = '99999999';
    const clampedToCeiling = resolveChatEngineLimits();
    assert.equal(clampedToCeiling.maxWallMs, 14_400_000);
    assert.equal(clampedToCeiling.wallBudget?.requestedMs, 99_999_999);

    // Overrides honor the profile ceiling too.
    const override = resolveChatEngineLimits({ maxWallMs: 7_200_000 });
    assert.equal(override.maxWallMs, 7_200_000);

    // Non-truthy flag values never widen the ceiling.
    process.env['BABEL_CHAT_LONG_TASK'] = '0';
    process.env['BABEL_CHAT_MAX_WALL_MS'] = '7200000';
    assert.equal(resolveChatEngineLimits().maxWallMs, 3_600_000);
  } finally {
    if (previousWall === undefined) delete process.env['BABEL_CHAT_MAX_WALL_MS'];
    else process.env['BABEL_CHAT_MAX_WALL_MS'] = previousWall;
    if (previousLong === undefined) delete process.env['BABEL_CHAT_LONG_TASK'];
    else process.env['BABEL_CHAT_LONG_TASK'] = previousLong;
  }
});

test('wall budget: product defaults unchanged and floor preserved', () => {
  const previousWall = process.env['BABEL_CHAT_MAX_WALL_MS'];
  try {
    delete process.env['BABEL_CHAT_MAX_WALL_MS'];
    const limits = resolveChatEngineLimits();
    assert.equal(limits.maxWallMs, DEFAULT_CHAT_ENGINE_LIMITS.maxWallMs);
    assert.equal(limits.wallBudget?.requestedMs, DEFAULT_CHAT_ENGINE_LIMITS.maxWallMs);

    process.env['BABEL_CHAT_MAX_WALL_MS'] = '50';
    assert.equal(resolveChatEngineLimits().maxWallMs, 10_000);
  } finally {
    if (previousWall === undefined) delete process.env['BABEL_CHAT_MAX_WALL_MS'];
    else process.env['BABEL_CHAT_MAX_WALL_MS'] = previousWall;
  }
});

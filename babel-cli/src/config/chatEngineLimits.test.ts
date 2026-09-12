import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_CHAT_ENGINE_LIMITS,
  SWE_CHAT_ENGINE_LIMITS,
  isChatStreamingEnabled,
  isSweChatProfileEnabled,
  resolveChatEngineLimits,
} from './chatEngineLimits.js';

test('explicit unlimited monetary policy retains wall, turn and stall controls', () => {
  const previous = process.env['BABEL_CHAT_MAX_COST'];
  try {
    process.env['BABEL_CHAT_MAX_COST'] = 'unlimited';
    const limits = resolveChatEngineLimits();
    assert.equal(limits.maxCostUsd, Infinity);
    assert.ok(Number.isFinite(limits.maxWallMs) && limits.maxWallMs > 0);
    assert.ok(Number.isFinite(limits.maxTurns) && limits.maxTurns > 0);
    assert.ok(Number.isFinite(limits.stallTurns) && limits.stallTurns > 0);
    assert.equal(resolveChatEngineLimits({ maxCostUsd: 1 }).maxCostUsd, 1);
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
  };
  delete process.env['BABEL_CHAT_MAX_TURNS'];
  delete process.env['BABEL_CHAT_MAX_MESSAGES'];
  delete process.env['BABEL_CHAT_MAX_TOKENS'];
  delete process.env['BABEL_CHAT_MAX_COST'];
  delete process.env['BABEL_CHAT_MAX_WALL_MS'];
  delete process.env['BABEL_CHAT_STALL_TURNS'];
  try {
    const wallBudgetFor = (maxWallMs: number) => ({
      effectiveMs: maxWallMs,
      requestedMs: maxWallMs,
      ceilingMs: 3_600_000,
      longTaskProfile: false,
    });
    assert.deepEqual(resolveChatEngineLimits(), {
      ...DEFAULT_CHAT_ENGINE_LIMITS,
      wallBudget: wallBudgetFor(DEFAULT_CHAT_ENGINE_LIMITS.maxWallMs),
    });
    assert.deepEqual(resolveChatEngineLimits({ maxTurns: 12 }), {
      ...DEFAULT_CHAT_ENGINE_LIMITS,
      maxTurns: 12,
      wallBudget: wallBudgetFor(DEFAULT_CHAT_ENGINE_LIMITS.maxWallMs),
    });
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

test('budget fields are clamped to valid ranges', () => {
  const previous = {
    cost: process.env['BABEL_CHAT_MAX_COST'],
    wall: process.env['BABEL_CHAT_MAX_WALL_MS'],
    stall: process.env['BABEL_CHAT_STALL_TURNS'],
  };
  delete process.env['BABEL_CHAT_MAX_COST'];
  delete process.env['BABEL_CHAT_MAX_WALL_MS'];
  delete process.env['BABEL_CHAT_STALL_TURNS'];
  try {
    // Below-min cost should clamp to floor
    const low = resolveChatEngineLimits({ maxCostUsd: 0 });
    assert.ok(low.maxCostUsd >= 0.01);
    // Negative wall clock should clamp to floor
    const neg = resolveChatEngineLimits({ maxWallMs: -1 });
    assert.ok(neg.maxWallMs >= 10_000);
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

test('SWE profile raises wall budget into general_swe band (600s+)', () => {
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
    assert.ok(
      resolved.maxWallMs >= 600_000,
      `expected SWE wall >= 600s, got ${resolved.maxWallMs}`,
    );
    assert.ok(
      resolved.maxWallMs <= 3_600_000,
      `wall should stay bounded, got ${resolved.maxWallMs}`,
    );
    assert.equal(resolved.maxWallMs, SWE_CHAT_ENGINE_LIMITS.maxWallMs);
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

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CLAUDE_BENCH_OPT_IN_ENV,
  ClaudeBenchmarkOptInError,
  assertClaudeBenchmarkOptIn,
  observeClaudeVersion,
  runClaudeLiveCase,
  type ClaudeHarnessCase,
} from './claudeHarness.js';

function withEnv(value: string | undefined, run: () => void): void {
  const previous = process.env[CLAUDE_BENCH_OPT_IN_ENV];
  if (value === undefined) delete process.env[CLAUDE_BENCH_OPT_IN_ENV];
  else process.env[CLAUDE_BENCH_OPT_IN_ENV] = value;
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env[CLAUDE_BENCH_OPT_IN_ENV];
    else process.env[CLAUDE_BENCH_OPT_IN_ENV] = previous;
  }
}

test('benchmark opt-in guard names the env var and is strict about its value', () => {
  assert.throws(
    () => assertClaudeBenchmarkOptIn({}),
    (error: unknown) => error instanceof ClaudeBenchmarkOptInError && /BABEL_BENCH_ALLOW_CLAUDE/.test((error as Error).message),
  );
  assert.throws(() => assertClaudeBenchmarkOptIn({ [CLAUDE_BENCH_OPT_IN_ENV]: 'true' }), ClaudeBenchmarkOptInError);
  assert.throws(() => assertClaudeBenchmarkOptIn({ [CLAUDE_BENCH_OPT_IN_ENV]: '0' }), ClaudeBenchmarkOptInError);
  assert.doesNotThrow(() => assertClaudeBenchmarkOptIn({ [CLAUDE_BENCH_OPT_IN_ENV]: '1' }));
});

test('observeClaudeVersion refuses the Claude CLI without explicit opt-in', () => {
  withEnv(undefined, () => {
    assert.throws(() => observeClaudeVersion(), ClaudeBenchmarkOptInError);
  });
});

test('runClaudeLiveCase refuses before spawning the Claude CLI without explicit opt-in', async () => {
  await withEnvAsync(undefined, async () => {
    await assert.rejects(
      runClaudeLiveCase({} as ClaudeHarnessCase),
      (error: unknown) => error instanceof ClaudeBenchmarkOptInError,
    );
  });
});

async function withEnvAsync(value: string | undefined, run: () => Promise<void>): Promise<void> {
  const previous = process.env[CLAUDE_BENCH_OPT_IN_ENV];
  if (value === undefined) delete process.env[CLAUDE_BENCH_OPT_IN_ENV];
  else process.env[CLAUDE_BENCH_OPT_IN_ENV] = value;
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env[CLAUDE_BENCH_OPT_IN_ENV];
    else process.env[CLAUDE_BENCH_OPT_IN_ENV] = previous;
  }
}
